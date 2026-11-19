import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseRateCard } from '../src/server/rate-card';

describe('Meta rate card parser', () => {
  it('reads the .csv-named Excel file', () => {
    const card = parseRateCard(readFileSync('data/meta-rate-card-eur.csv'));
    expect(card.currency).toBe('EUR');
    expect(card.effective).toBe('October 1, 2026');
    expect(card.rows).toHaveLength(47);
    expect(card.rows.find((r) => r.market === 'Other')?.marketingRate).toBe(0.05);
    expect(card.rows.find((r) => r.market === 'India')?.marketingRate).toBe(0.0099);
    expect(card.warnings).toEqual([]);
  });

  it('reads a real CSV export with title rows above the header', () => {
    const csv = [
      'Cost per message in USD on the WhatsApp Business Platform, effective October 1, 2026,,,',
      ',,,',
      'Market,Currency,Marketing,Utility',
      'Brazil,USD,0.0625,0.0068',
      'Other,USD,0.0604,0.0077',
      ',,,',
    ].join('\n');
    const card = parseRateCard(Buffer.from(csv));
    expect(card.currency).toBe('USD');
    expect(card.rows).toEqual([
      { market: 'Brazil', currency: 'USD', marketingRate: 0.0625 },
      { market: 'Other', currency: 'USD', marketingRate: 0.0604 },
    ]);
  });

  it('rejects a file with no header row', () => {
    expect(() => parseRateCard(Buffer.from('a,b\n1,2\n'))).toThrow(/header not found/);
  });
});
