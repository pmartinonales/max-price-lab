// Max price calculator: one bid_amount plus per-country multipliers so that
// every country's cap (bid_amount x multiplier) lands on, never above, its
// own rate card. All maths is done in integers (BigInt) to stay exact.
import { COUNTRY_MARKETS, OTHER_MARKET, type CountryMarket } from '../data/market-to-iso';
import { eligibility, type EligibilityStatus } from './eligibility';
import { minorUnits, toScaled, RATE_SCALE } from './currency';

export const BID_STRATEGY = 'LOWEST_COST_WITH_BID_CAP';
export const MAX_OVERRIDES = 240; // Meta's limit per template
export const MAX_MULTIPLIER = 10;
const MULT_DECIMALS = 4;
const MULT_SCALE = 10n ** BigInt(MULT_DECIMALS);
const DELIVERIES = 1000n; // bid_amount is per 1,000 deliveries

export interface MarketRate {
  market: string;
  marketingRate: number;
}

export interface CalculatorInput {
  rateCard: MarketRate[];
  rateCardCurrency: string;
  wabaCurrency: string;
  /** Subset mode: only these ISO codes. Omit for every country. */
  countries?: string[];
  baseMarket?: string;
  /** For tests; defaults to Meta's full country map. */
  countryMarkets?: Record<string, CountryMarket>;
}

export interface CountryRow {
  iso: string;
  name: string;
  /** Market the country is billed at (the cheaper one for shared calling codes) */
  market: string | null;
  rate: number | null;
  status: EligibilityStatus | 'unmapped';
  multiplier: number | null;
  inMap: boolean;
  /** bid_amount x multiplier, per delivery, in the main currency unit */
  capPerDelivery: number | null;
  /** capPerDelivery / rate, must be <= 1 */
  capVsRate: number | null;
  notes: string[];
}

export interface OptimizationSpec {
  bid_strategy: typeof BID_STRATEGY;
  bid_amount: number;
  bid_country_multiplier_overrides: Record<string, number>;
}

export type CalculatorResult =
  | {
      ok: true;
      currency: string;
      minorUnits: number;
      baseMarket: string;
      baseRate: number;
      bidAmount: number;
      /** Human-readable conversion, e.g. "0.05 EUR × 10^2 × 1,000 = 5000" */
      bidAmountWorking: string;
      rows: CountryRow[];
      spec: OptimizationSpec;
      sharedCallingCode: string[];
      warnings: string[];
    }
  | { ok: false; error: string };

const fmtInt = (n: bigint) => n.toLocaleString('en-US');

export function calculate(input: CalculatorInput): CalculatorResult {
  const wabaCurrency = input.wabaCurrency.toUpperCase();
  const cardCurrency = input.rateCardCurrency.toUpperCase();
  if (wabaCurrency !== cardCurrency) {
    return {
      ok: false,
      error: `Rate card is in ${cardCurrency} but the WABA is billed in ${wabaCurrency}. bid_amount must be in the WABA currency, and this app doesn't convert currencies: import Meta's ${wabaCurrency} rate card.`,
    };
  }

  let minor: number;
  try {
    minor = minorUnits(wabaCurrency);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const minorScale = 10n ** BigInt(minor);

  const rates = new Map<string, bigint>();
  const rateNum = new Map<string, number>();
  for (const r of input.rateCard) {
    rates.set(r.market, toScaled(r.marketingRate));
    rateNum.set(r.market, r.marketingRate);
  }

  const baseMarket = input.baseMarket ?? OTHER_MARKET;
  const baseScaled = rates.get(baseMarket);
  if (baseScaled === undefined) {
    return { ok: false, error: `Rate card has no "${baseMarket}" market, needed as the base rate` };
  }

  // bid_amount = floor(base_rate × 10^minor × 1000), in integers.
  const bidAmount = (baseScaled * minorScale * DELIVERIES) / RATE_SCALE;
  if (bidAmount <= 0n) return { ok: false, error: 'Base rate is too small to express as bid_amount' };
  const baseRate = rateNum.get(baseMarket)!;
  const bidAmountWorking = `${baseRate} ${wabaCurrency} × 10^${minor} × ${fmtInt(DELIVERIES)} = ${bidAmount}`;

  const countryMarkets = input.countryMarkets ?? COUNTRY_MARKETS;
  const warnings: string[] = [];
  let isos = Object.keys(countryMarkets);
  if (input.countries) {
    const wanted = input.countries.map((c) => c.toUpperCase());
    const unknown = wanted.filter((c) => !countryMarkets[c]);
    if (unknown.length) warnings.push(`Unknown ISO codes ignored: ${unknown.join(', ')}`);
    isos = wanted.filter((c) => countryMarkets[c]);
  }

  const rows: CountryRow[] = [];
  const overrides: Record<string, number> = {};
  const sharedCallingCode: string[] = [];

  for (const iso of isos) {
    const cm = countryMarkets[iso];
    const elig = eligibility(iso);
    const notes: string[] = [];
    if (elig.note) notes.push(elig.note);

    // Pick the cheapest market the country may be billed as.
    const priced = cm.markets.filter((m) => rates.has(m));
    if (priced.length === 0) {
      rows.push({
        iso, name: cm.name, market: null, rate: null, status: 'unmapped', multiplier: null, inMap: false,
        capPerDelivery: null, capVsRate: null,
        notes: [...notes, `Market "${cm.markets.join('" / "')}" is not in the rate card`],
      });
      continue;
    }
    const market = priced.reduce((a, b) => (rates.get(b)! < rates.get(a)! ? b : a));
    const rateScaled = rates.get(market)!;
    if (cm.markets.length > 1) {
      sharedCallingCode.push(iso);
      notes.push(`Shares a calling code with ${cm.markets[0]}: may bill as ${cm.markets.join(' or ')}; capped at the lower rate`);
    }

    const row: CountryRow = {
      iso, name: cm.name, market, rate: rateNum.get(market)!, status: elig.status,
      multiplier: null, inMap: false, capPerDelivery: null, capVsRate: null, notes,
    };

    if (elig.inMap) {
      // multiplier = floor(rate_in_bid_units / bid_amount, 4 decimals).
      // When bid_amount is exact (EUR, USD, ...) this equals rate / base_rate;
      // when the base had to be floored it keeps the cap as close to the rate
      // card as possible, still never above it.
      // rate_in_bid_units = rateScaled × 10^minor × 1000 / 10^8
      let m4 = (rateScaled * minorScale * DELIVERIES * MULT_SCALE) / (bidAmount * RATE_SCALE);
      if (m4 > BigInt(MAX_MULTIPLIER) * MULT_SCALE) {
        m4 = BigInt(MAX_MULTIPLIER) * MULT_SCALE;
        notes.push(`Multiplier capped at ${MAX_MULTIPLIER} (Meta's limit): cap is below the rate card`);
      }
      if (m4 <= 0n) {
        notes.push('Rate too small for a 4-decimal multiplier: left out of the map');
      } else {
        const multiplier = Number(m4) / Number(MULT_SCALE);
        row.multiplier = multiplier;
        // cap per delivery in main units = bid_amount × m / 1000 / 10^minor,
        // kept as an integer scaled by 10^8 (floored) so it is never shown above the rate.
        const capScaled = (bidAmount * m4 * RATE_SCALE) / (MULT_SCALE * DELIVERIES * minorScale);
        row.capPerDelivery = Number(capScaled) / Number(RATE_SCALE);
        // cap ÷ rate, floored to 6 decimals
        row.capVsRate = Number((capScaled * 1_000_000n) / rateScaled) / 1_000_000;
        if (m4 !== MULT_SCALE) {
          row.inMap = true;
          overrides[iso] = multiplier;
        } else {
          notes.push('Multiplier 1.0 is the default: left out of the map');
        }
      }
    } else if (elig.canSend) {
      notes.push('Left out of the map');
    }
    rows.push(row);
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  const sortedOverrides = Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)));
  const count = Object.keys(sortedOverrides).length;
  if (count > MAX_OVERRIDES) {
    return { ok: false, error: `The override map has ${count} countries; Meta allows at most ${MAX_OVERRIDES}. Pick fewer countries.` };
  }

  if (input.countries) {
    // Countries outside the subset fall back to multiplier 1.0 = the base cap.
    const selected = new Set(isos);
    const above = Object.keys(countryMarkets).filter((iso) => {
      if (selected.has(iso) || !eligibility(iso).inMap) return false;
      const r = countryMarkets[iso].markets.map((m) => rates.get(m)).filter((x): x is bigint => x !== undefined);
      return r.length > 0 && r.reduce((a, b) => (b < a ? b : a)) < baseScaled;
    });
    if (above.length) {
      warnings.push(
        `${above.length} countries outside your selection have a rate card below the ${baseMarket} rate; a message sent there would be capped at ${baseRate} ${wabaCurrency}, above its rate card.`,
      );
    }
  }

  return {
    ok: true,
    currency: wabaCurrency,
    minorUnits: minor,
    baseMarket,
    baseRate,
    bidAmount: Number(bidAmount),
    bidAmountWorking,
    rows,
    spec: { bid_strategy: BID_STRATEGY, bid_amount: Number(bidAmount), bid_country_multiplier_overrides: sortedOverrides },
    sharedCallingCode,
    warnings,
  };
}

/** Exact check used by tests and the UI: bid_amount × multiplier ≤ rate × 10^minor × 1000. */
export function capWithinRate(bidAmount: number, multiplier: number, rate: number, minor: number): boolean {
  const m4 = BigInt(Math.round(multiplier * Number(MULT_SCALE)));
  const lhs = BigInt(bidAmount) * m4 * RATE_SCALE;
  const rhs = toScaled(rate) * 10n ** BigInt(minor) * DELIVERIES * MULT_SCALE;
  return lhs <= rhs;
}
