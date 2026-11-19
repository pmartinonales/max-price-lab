import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { parseRateCard } from '../src/server/rate-card';
import { calculate, capWithinRate, MAX_OVERRIDES } from '../src/shared/calculator';
import { COUNTRY_MARKETS } from '../src/data/market-to-iso';
import { eligibility, EXCLUDED_FROM_MAP } from '../src/shared/eligibility';

const card = parseRateCard(readFileSync('data/meta-rate-card-eur.csv'));
const fixture = JSON.parse(readFileSync('data/optimization_spec_eur.json', 'utf8')).optimization_spec;
const sheet = XLSX.utils.sheet_to_json<Record<string, unknown>>(
  XLSX.read(readFileSync('data/max-price-multipliers-eur.xlsx')).Sheets['Multipliers'],
);

const run = (extra: Partial<Parameters<typeof calculate>[0]> = {}) =>
  calculate({
    rateCard: card.rows,
    rateCardCurrency: card.currency,
    wabaCurrency: 'EUR',
    ...extra,
  });

const eur = run();
if (!eur.ok) throw new Error(eur.error);

describe('EUR rate card, every country', () => {
  it('reproduces data/optimization_spec_eur.json exactly', () => {
    expect(eur.spec).toEqual(fixture);
    expect(Object.keys(eur.spec.bid_country_multiplier_overrides)).toEqual(
      Object.keys(fixture.bid_country_multiplier_overrides),
    );
  });

  it('uses Meta\'s "Other" rate as the base: EUR 0.05 -> 5000', () => {
    expect(eur.baseMarket).toBe('Other');
    expect(eur.bidAmount).toBe(5000);
    expect(eur.bidAmountWorking).toBe('0.05 EUR × 10^2 × 1,000 = 5000');
  });

  it('keeps every cap at or below its rate card: bid_amount × multiplier ≤ rate × 10^minor × 1000', () => {
    const priced = eur.rows.filter((r) => r.multiplier !== null);
    expect(priced.length).toBeGreaterThan(200);
    for (const r of priced) {
      expect(capWithinRate(eur.bidAmount, r.multiplier!, r.rate!, eur.minorUnits), r.iso).toBe(true);
      expect(r.capVsRate!).toBeLessThanOrEqual(1);
    }
  });

  it('keeps every multiplier > 0 and ≤ 10', () => {
    for (const m of Object.values(eur.spec.bid_country_multiplier_overrides)) {
      expect(m).toBeGreaterThan(0);
      expect(m).toBeLessThanOrEqual(10);
    }
  });

  it('leaves out countries at 1.0 and countries where max price cannot apply', () => {
    const map = eur.spec.bid_country_multiplier_overrides;
    expect(Object.values(map)).not.toContain(1);
    for (const iso of EXCLUDED_FROM_MAP) expect(map[iso], iso).toBeUndefined();
    expect(Object.keys(map).length).toBeLessThanOrEqual(MAX_OVERRIDES);
  });

  it('bills each country at the same market as the reference sheet', () => {
    expect(eur.rows).toHaveLength(sheet.length);
    for (const s of sheet) {
      const row = eur.rows.find((r) => r.iso === s.ISO)!;
      expect(row.market, String(s.ISO)).toBe(s['Rate card market']);
      expect(row.rate, String(s.ISO)).toBe(s['Marketing rate (EUR)']);
    }
  });

  it('flags the same countries as the reference sheet', () => {
    for (const s of sheet) {
      const iso = String(s.ISO);
      expect(eligibility(iso).inMap, iso).toBe(s['Max price eligible'] === 'Yes');
      expect(eligibility(iso).status === 'flagged', iso).toBe(/no delivery optimization/.test(String(s.Note ?? '')));
    }
  });

  it('lists the territories that share a calling code', () => {
    const fromSheet = sheet.filter((s) => /Shares a calling code/.test(String(s.Note ?? ''))).map((s) => s.ISO);
    expect([...eur.sharedCallingCode].sort()).toEqual([...fromSheet].sort());
  });
});

describe('guards', () => {
  it('blocks the calculation when the rate card currency differs from the WABA currency', () => {
    const r = run({ wabaCurrency: 'USD' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/EUR.*USD/);
  });

  it('refuses more than 240 overrides', () => {
    const countryMarkets = Object.fromEntries(
      Array.from({ length: 241 }, (_, i) => [`Q${i}`, { name: `Test ${i}`, markets: ['Argentina'] }]),
    );
    const r = run({ countryMarkets });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/241.*240/);
  });

  it('clamps multipliers to 10 and stays under the rate card', () => {
    const r = calculate({
      rateCard: [
        { market: 'Other', marketingRate: 0.01 },
        { market: 'Germany', marketingRate: 0.1131 },
      ],
      rateCardCurrency: 'EUR',
      wabaCurrency: 'EUR',
      countries: ['DE'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.bid_country_multiplier_overrides.DE).toBe(10);
      expect(r.rows[0].capVsRate!).toBeLessThan(1);
    }
  });

  it('floors bid_amount for zero-decimal currencies and keeps caps under the rate card', () => {
    const r = calculate({
      rateCard: [
        { market: 'Other', marketingRate: 7.3456 },
        { market: 'India', marketingRate: 1.4567 },
      ],
      rateCardCurrency: 'JPY',
      wabaCurrency: 'JPY',
      countries: ['IN'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bidAmount).toBe(7345); // floor(7.3456 × 1 × 1000)
      const m = r.spec.bid_country_multiplier_overrides.IN;
      expect(capWithinRate(r.bidAmount, m, 1.4567, 0)).toBe(true);
    }
  });
});

describe('subset mode', () => {
  it('uses the same maths for a few countries', () => {
    const r = run({ countries: ['BR', 'IN', 'MX', 'US'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.bid_amount).toBe(5000);
    expect(r.spec.bid_country_multiplier_overrides).toEqual({ BR: 1.036, IN: 0.198, MX: 0.658 });
    expect(r.rows.map((x) => x.iso).sort()).toEqual(['BR', 'IN', 'MX', 'US']);
    expect(r.warnings.join(' ')).toMatch(/outside your selection/);
  });
});

describe('market map', () => {
  it('covers 249 countries and every market in the rate card', () => {
    expect(Object.keys(COUNTRY_MARKETS)).toHaveLength(249);
    const used = new Set(Object.values(COUNTRY_MARKETS).flatMap((c) => c.markets));
    const unmapped = card.rows.map((r) => r.market).filter((m) => !used.has(m));
    expect(unmapped).toEqual([]);
  });
});
