// Parses message status webhooks as 360dialog forwards them (Meta's format:
// entry[].changes[].value.statuses[]). Cost is read defensively because
// Meta's docs place it either under pricing.cost or directly under cost.
// cost.amount is in the MAIN currency unit (e.g. 0.0476 EUR), unlike bid_amount.

export interface StatusEvent {
  wamid: string;
  status: string; // sent | delivered | read | failed | ...
  recipientId: string | null;
  timestamp: number | null; // unix seconds
  billable: boolean | null;
  pricingModel: string | null;
  /** marketing_lite_dynamic = max price applied; marketing_lite = rate card */
  category: string | null;
  pricingType: string | null;
  costAmount: number | null;
  costCurrency: string | null;
  errors: { code: number | null; title: string | null; message: string | null }[];
  raw: unknown;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const bool = (v: unknown) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null);

function collectStatuses(payload: unknown): unknown[] {
  if (!isObj(payload)) return [];
  const out: unknown[] = [];
  if (Array.isArray(payload.entry)) {
    for (const entry of payload.entry) {
      if (!isObj(entry) || !Array.isArray(entry.changes)) continue;
      for (const change of entry.changes) {
        if (isObj(change) && isObj(change.value) && Array.isArray(change.value.statuses)) {
          out.push(...change.value.statuses);
        }
      }
    }
  }
  // Older flat format: { statuses: [...] }
  if (Array.isArray(payload.statuses)) out.push(...payload.statuses);
  return out;
}

export function parseStatuses(payload: unknown): StatusEvent[] {
  const events: StatusEvent[] = [];
  for (const s of collectStatuses(payload)) {
    if (!isObj(s)) continue;
    const wamid = str(s.id);
    const status = str(s.status);
    if (!wamid || !status) continue;

    const pricing = isObj(s.pricing) ? s.pricing : {};
    const cost = isObj(pricing.cost) ? pricing.cost : isObj(s.cost) ? s.cost : {};

    events.push({
      wamid,
      status,
      recipientId: str(s.recipient_id),
      timestamp: num(s.timestamp),
      billable: bool(pricing.billable),
      pricingModel: str(pricing.pricing_model),
      category: str(pricing.category),
      pricingType: str(pricing.type),
      costAmount: num(cost.amount),
      costCurrency: str(cost.currency),
      errors: Array.isArray(s.errors)
        ? s.errors.filter(isObj).map((e) => ({ code: num(e.code), title: str(e.title), message: str(e.message) }))
        : [],
      raw: s,
    });
  }
  return events;
}
