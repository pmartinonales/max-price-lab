// Parses pasted phone numbers: one per line, optionally followed by
// comma-separated variable values for that recipient ("+5511999999999, Ana").
// Country comes from the number (ISO 3166-1 alpha-2); eligibility follows it.
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { COUNTRY_MARKETS } from '../data/market-to-iso';
import { eligibility, type EligibilityStatus } from '../shared/eligibility';

export type RecipientStatus = EligibilityStatus | 'invalid' | 'duplicate' | 'unknown_country';

export interface Recipient {
  line: number;
  /** E.164 without "+", as the API expects in `to`. Never sent to the browser. */
  to: string;
  masked: string;
  country: string | null;
  countryName: string | null;
  status: RecipientStatus;
  canSend: boolean;
  note: string;
  /** Per-recipient variable values from the pasted line, if any. */
  vars: string[];
  arm?: 'A' | 'B';
}

export function maskNumber(e164: string): string {
  const d = e164.replace(/\D/g, '');
  if (d.length <= 6) return `+${d.slice(0, 2)}••••`;
  return `+${d.slice(0, 3)}${'•'.repeat(Math.max(3, d.length - 6))}${d.slice(-3)}`;
}

export function parseRecipients(text: string): Recipient[] {
  const out: Recipient[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [numPart, ...varParts] = line.split(/[,;\t]/).map((s) => s.trim());
    const vars = varParts.filter((v) => v !== '');
    const digits = numPart.replace(/[^\d+]/g, '');
    const withPlus = digits.startsWith('+') ? digits : digits.startsWith('00') ? `+${digits.slice(2)}` : `+${digits}`;
    const parsed = parsePhoneNumberFromString(withPlus);
    const base = { line: i + 1, vars };

    if (!parsed || !parsed.isValid()) {
      const to = withPlus.replace(/\D/g, '');
      out.push({ ...base, to, masked: maskNumber(to), country: parsed?.country ?? null, countryName: null, status: 'invalid', canSend: false, note: 'Not a valid phone number' });
      return;
    }
    const to = parsed.number.replace(/^\+/, '');
    const country = parsed.country ?? null;
    const countryName = country ? (COUNTRY_MARKETS[country]?.name ?? country) : null;
    if (seen.has(to)) {
      out.push({ ...base, to, masked: maskNumber(to), country, countryName, status: 'duplicate', canSend: false, note: `Duplicate of an earlier line` });
      return;
    }
    seen.add(to);
    if (!country) {
      out.push({ ...base, to, masked: maskNumber(to), country, countryName, status: 'unknown_country', canSend: false, note: 'Country could not be detected from the number' });
      return;
    }
    const e = eligibility(country);
    let note = e.note;
    if (country === 'UA') note = 'Messages to Crimea, Donetsk and Luhansk cannot be sent; they share +380 and cannot be told apart here';
    if (e.status === 'flagged') note = 'No delivery optimization here; Meta does not say whether max price applies';
    out.push({ ...base, to, masked: maskNumber(to), country, countryName, status: e.status, canSend: e.canSend, note });
  });
  return out;
}

/**
 * Splits sendable recipients 50/50 into arms A and B, balanced per country:
 * each country's recipients are shuffled and alternated. Countries with an odd
 * count alternate which arm gets the extra one, so totals stay balanced too.
 */
export function splitAB(recipients: Recipient[], rng: () => number = Math.random): Recipient[] {
  const byCountry = new Map<string, Recipient[]>();
  for (const r of recipients) {
    if (!r.canSend) continue;
    const k = r.country ?? '?';
    byCountry.set(k, [...(byCountry.get(k) ?? []), r]);
  }
  let oddStartsWithA = rng() < 0.5;
  for (const [, group] of [...byCountry.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
    const startA = group.length % 2 === 0 ? rng() < 0.5 : oddStartsWithA;
    if (group.length % 2 === 1) oddStartsWithA = !oddStartsWithA;
    group.forEach((r, i) => (r.arm = (i % 2 === 0) === startA ? 'A' : 'B'));
  }
  return recipients;
}
