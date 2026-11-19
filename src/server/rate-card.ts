// Parses Meta's rate card. Meta ships it with a .csv name but it is really an
// Excel workbook (sheet "List rates", title rows above the header). A genuine
// CSV export is accepted too.
import * as XLSX from 'xlsx';
import { parse as parseCsv } from 'csv-parse/sync';

export interface RateCardRow {
  market: string;
  currency: string;
  marketingRate: number;
}

export interface ParsedRateCard {
  currency: string;
  /** e.g. "October 1, 2026", from the title row when present */
  effective?: string;
  title?: string;
  rows: RateCardRow[];
  warnings: string[];
}

const SHEET = 'List rates';

function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
}

function readGrid(buf: Buffer): unknown[][] {
  if (isZip(buf)) {
    const wb = XLSX.read(buf);
    const sheet = wb.Sheets[SHEET] ?? wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  }
  return parseCsv(buf.toString('utf8').replace(/^﻿/, ''), {
    relax_column_count: true,
    skip_empty_lines: false,
  }) as unknown[][];
}

const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

export function parseRateCard(buf: Buffer): ParsedRateCard {
  const grid = readGrid(buf);
  const warnings: string[] = [];

  const headerIdx = grid.findIndex(
    (r) => clean(r[0]).toLowerCase() === 'market' && r.some((c) => clean(c).toLowerCase() === 'marketing'),
  );
  if (headerIdx < 0) {
    throw new Error('Rate card header not found: expected a row starting with "Market" and a "Marketing" column');
  }
  const header = grid[headerIdx].map((c) => clean(c).toLowerCase());
  const colCurrency = header.indexOf('currency');
  const colMarketing = header.indexOf('marketing');
  if (colCurrency < 0) throw new Error('Rate card has no "Currency" column');

  const title = grid.slice(0, headerIdx).map((r) => clean(r[0])).find((t) => /cost per message/i.test(t));
  const effective = title?.match(/effective (.+)$/i)?.[1];

  const rows: RateCardRow[] = [];
  for (const r of grid.slice(headerIdx + 1)) {
    const market = clean(r[0]);
    if (!market) continue;
    const currency = clean(r[colCurrency]).toUpperCase();
    const raw = r[colMarketing];
    const rate = typeof raw === 'number' ? raw : Number(clean(raw));
    if (!Number.isFinite(rate) || rate <= 0) {
      warnings.push(`Skipped "${market}": marketing rate "${clean(raw)}" is not a positive number`);
      continue;
    }
    rows.push({ market, currency, marketingRate: rate });
  }
  if (rows.length === 0) throw new Error('Rate card has no market rows');

  const currencies = [...new Set(rows.map((r) => r.currency))];
  if (currencies.length !== 1) {
    throw new Error(`Rate card mixes currencies (${currencies.join(', ')}); expected one`);
  }
  const markets = rows.map((r) => r.market);
  const dupes = markets.filter((m, i) => markets.indexOf(m) !== i);
  if (dupes.length) throw new Error(`Rate card lists these markets twice: ${[...new Set(dupes)].join(', ')}`);

  return { currency: currencies[0], effective, title, rows, warnings };
}
