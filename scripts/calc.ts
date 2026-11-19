// Prints the max price table and optimization_spec for a rate card.
// Usage: npm run calc -- [--card data/meta-rate-card-eur.csv] [--currency EUR] [--countries BR,IN,MX] [--json]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseRateCard } from '../src/server/rate-card';
import { calculate } from '../src/shared/calculator';

const { values } = parseArgs({
  options: {
    card: { type: 'string', default: 'data/meta-rate-card-eur.csv' },
    currency: { type: 'string', default: 'EUR' },
    countries: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

const card = parseRateCard(readFileSync(values.card!));
const result = calculate({
  rateCard: card.rows,
  rateCardCurrency: card.currency,
  wabaCurrency: values.currency!,
  countries: values.countries?.split(',').map((s) => s.trim()).filter(Boolean),
});

if (!result.ok) {
  console.error(`Blocked: ${result.error}`);
  process.exit(1);
}

if (values.json) {
  console.log(JSON.stringify({ optimization_spec: result.spec }, null, 2));
  process.exit(0);
}

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
const lpad = (s: string, n: number) => s.padStart(n);

console.log(`Rate card: ${card.title ?? values.card} (${card.rows.length} markets, ${card.currency})`);
console.log(`Base: ${result.baseMarket} = ${result.baseRate} ${result.currency}`);
console.log(`bid_amount: ${result.bidAmountWorking}\n`);

console.log(
  [pad('Country', 28), pad('ISO', 4), pad('Rate card market', 32), lpad('Rate', 8), lpad('Mult.', 7), lpad('Cap', 8), lpad('Cap/rate', 9), '  Note'].join(' '),
);
for (const r of result.rows) {
  console.log(
    [
      pad(r.name, 28),
      pad(r.iso, 4),
      pad(r.market ?? '(unmapped)', 32),
      lpad(r.rate?.toFixed(4) ?? '-', 8),
      lpad(r.multiplier === null ? '-' : String(r.multiplier), 7),
      lpad(r.capPerDelivery?.toFixed(4) ?? '-', 8),
      lpad(r.capVsRate === null ? '-' : `${(r.capVsRate * 100).toFixed(1)}%`, 9),
      '  ' + r.notes.join(' · '),
    ].join(' '),
  );
}

const n = Object.keys(result.spec.bid_country_multiplier_overrides).length;
console.log(`\n${result.rows.length} countries · ${n} overrides in the map (Meta's limit: 240)`);
for (const w of [...card.warnings, ...result.warnings]) console.log(`Warning: ${w}`);
console.log('\nRun with --json for the optimization_spec.');
