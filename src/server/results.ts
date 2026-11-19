// Webhook storage and the results maths: charged cost per delivered message
// compared with the rate card, per message, per country and per template/arm.
import type { DB } from './db';
import { parseStatuses } from './webhook-parse';
import { COUNTRY_MARKETS } from '../data/market-to-iso';

// ---- webhook ------------------------------------------------------------------

/** Stores the raw payload and each status. Idempotent on (wamid, status). */
export function processWebhook(db: DB, body: unknown): { logged: number; statuses: number; duplicates: number } {
  const now = new Date().toISOString();
  const events = parseStatuses(body);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO statuses (wamid, status, ts, billable, pricing_model, category, pricing_type, cost_amount, cost_currency, error_code, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let stored = 0;
  db.transaction(() => {
    db.prepare('INSERT INTO webhook_log (received_at, body) VALUES (?, ?)').run(now, JSON.stringify(body ?? null));
    for (const e of events) {
      const r = insert.run(
        e.wamid,
        e.status,
        e.timestamp,
        e.billable === null ? null : e.billable ? 1 : 0,
        e.pricingModel,
        e.category,
        e.pricingType,
        e.costAmount,
        e.costCurrency,
        e.errors[0]?.code ?? null,
        JSON.stringify(e.raw),
      );
      stored += r.changes;
    }
  })();
  return { logged: 1, statuses: stored, duplicates: events.length - stored };
}

// ---- per message ----------------------------------------------------------------

export interface MessageResult {
  wamid: string;
  toMasked: string;
  country: string | null;
  countryName: string | null;
  templateId: string;
  templateName: string;
  arm: string | null;
  sentAt: string;
  /** accepted (no webhook yet) | sent | delivered | read | failed | send_failed */
  status: string;
  delivered: boolean;
  billable: boolean | null;
  /** marketing_lite_dynamic = max price applied; marketing_lite = rate card */
  category: string | null;
  pricingModel: string | null;
  cost: number | null;
  costCurrency: string | null;
  rate: number | null;
  /** (rate - cost) / rate, when both are known and currencies match */
  saving: number | null;
  errorCode: number | null;
  errorText: string | null;
  perMessageMultiplier: number | null;
}

interface MessageRow {
  wamid: string; to_masked: string; country: string | null; template_id: string; template_name: string;
  arm: string | null; sent_at: string; send_response_json: string | null; per_message_multiplier: number | null;
}
interface StatusRow {
  wamid: string; status: string; ts: number | null; billable: number | null; pricing_model: string | null;
  category: string | null; cost_amount: number | null; cost_currency: string | null; error_code: number | null; raw_json: string;
}

const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };
// Cost and pricing come with the billable statuses; prefer delivered, then read.
const PRICING_ORDER = ['delivered', 'read', 'sent', 'failed'];

export interface ResultsFilter {
  templateIds?: string[];
}

export function messageResults(db: DB, rates: Map<string, number>, rateCurrency: string | null, filter: ResultsFilter = {}): MessageResult[] {
  let messages = db.prepare('SELECT * FROM messages ORDER BY sent_at DESC').all() as MessageRow[];
  if (filter.templateIds) {
    const ids = new Set(filter.templateIds);
    messages = messages.filter((m) => ids.has(m.template_id));
  }
  const statuses = db.prepare('SELECT * FROM statuses').all() as StatusRow[];
  const byWamid = new Map<string, StatusRow[]>();
  for (const s of statuses) byWamid.set(s.wamid, [...(byWamid.get(s.wamid) ?? []), s]);

  return messages.map((m) => {
    const rate = m.country ? (rates.get(m.country) ?? null) : null;
    const base = {
      wamid: m.wamid,
      toMasked: m.to_masked,
      country: m.country,
      countryName: m.country ? (COUNTRY_MARKETS[m.country]?.name ?? m.country) : null,
      templateId: m.template_id,
      templateName: m.template_name,
      arm: m.arm,
      sentAt: m.sent_at,
      rate,
      perMessageMultiplier: m.per_message_multiplier,
    };

    if (m.wamid.startsWith('failed:')) {
      const resp = m.send_response_json ? JSON.parse(m.send_response_json) : {};
      const apiErr = resp?.api?.body?.error;
      return {
        ...base,
        wamid: '',
        status: 'send_failed',
        delivered: false,
        billable: null,
        category: null,
        pricingModel: null,
        cost: null,
        costCurrency: null,
        saving: null,
        errorCode: typeof apiErr?.code === 'number' ? apiErr.code : null,
        errorText: (typeof apiErr === 'string' ? apiErr : apiErr?.message) ?? resp?.error ?? 'Send failed',
      };
    }

    const sts = byWamid.get(m.wamid) ?? [];
    const top = sts.reduce<StatusRow | null>((a, s) => ((RANK[s.status] ?? 0) > (RANK[a?.status ?? ''] ?? 0) ? s : a), null);
    const delivered = sts.some((s) => s.status === 'delivered' || s.status === 'read');
    const priced = PRICING_ORDER.map((st) => sts.find((s) => s.status === st && (s.cost_amount !== null || s.category !== null))).find(Boolean) ?? null;
    const failed = sts.find((s) => s.status === 'failed');
    let errorText: string | null = null;
    if (failed) {
      try {
        const e = JSON.parse(failed.raw_json)?.errors?.[0];
        errorText = e?.title ?? e?.message ?? null;
      } catch {
        /* raw kept as is */
      }
    }
    const cost = priced?.cost_amount ?? null;
    const costCurrency = priced?.cost_currency ?? null;
    const comparable = cost !== null && rate !== null && rate > 0 && (!costCurrency || !rateCurrency || costCurrency === rateCurrency);
    return {
      ...base,
      status: top?.status ?? 'accepted',
      delivered,
      billable: priced?.billable === null || priced?.billable === undefined ? null : priced.billable === 1,
      category: priced?.category ?? null,
      pricingModel: priced?.pricing_model ?? null,
      cost,
      costCurrency,
      saving: comparable ? (rate! - cost!) / rate! : null,
      errorCode: failed?.error_code ?? null,
      errorText,
    };
  });
}

// ---- totals ---------------------------------------------------------------------

export interface Totals {
  key: string;
  label: string;
  /** Accepted by the API (has a wamid) */
  sent: number;
  sendFailed: number;
  delivered: number;
  failed: number;
  deliveryRate: number | null;
  /** Delivered messages with a charged cost we can compare */
  costed: number;
  maxPriceApplied: number;
  charged: number;
  rateCardCost: number;
  avgCostPerDelivered: number | null;
  avgRateCard: number | null;
  saved: number;
  saving: number | null;
}

export function totals(rows: MessageResult[], keyOf: (r: MessageResult) => string, labelOf: (r: MessageResult) => string): Totals[] {
  const groups = new Map<string, MessageResult[]>();
  for (const r of rows) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  return [...groups.entries()]
    .map(([key, g]) => {
      const sent = g.filter((r) => r.status !== 'send_failed').length;
      const delivered = g.filter((r) => r.delivered).length;
      const costed = g.filter((r) => r.delivered && r.saving !== null);
      const charged = costed.reduce((s, r) => s + r.cost!, 0);
      const rateCardCost = costed.reduce((s, r) => s + r.rate!, 0);
      return {
        key,
        label: labelOf(g[0]),
        sent,
        sendFailed: g.length - sent,
        delivered,
        failed: g.filter((r) => r.status === 'failed').length,
        deliveryRate: sent ? delivered / sent : null,
        costed: costed.length,
        maxPriceApplied: g.filter((r) => r.category === 'marketing_lite_dynamic').length,
        charged,
        rateCardCost,
        avgCostPerDelivered: costed.length ? charged / costed.length : null,
        avgRateCard: costed.length ? rateCardCost / costed.length : null,
        saved: rateCardCost - charged,
        saving: rateCardCost > 0 ? (rateCardCost - charged) / rateCardCost : null,
      };
    })
    .sort((a, b) => b.sent - a.sent || a.label.localeCompare(b.label));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: MessageResult[]): string {
  const cols: [string, (r: MessageResult) => unknown][] = [
    ['wamid', (r) => r.wamid],
    ['number_masked', (r) => r.toMasked],
    ['country', (r) => r.country],
    ['template', (r) => r.templateName],
    ['arm', (r) => r.arm],
    ['sent_at', (r) => r.sentAt],
    ['status', (r) => r.status],
    ['delivered', (r) => (r.delivered ? 1 : 0)],
    ['pricing_category', (r) => r.category],
    ['charged_cost', (r) => r.cost],
    ['cost_currency', (r) => r.costCurrency],
    ['rate_card', (r) => r.rate],
    ['saving_pct', (r) => (r.saving === null ? null : (r.saving * 100).toFixed(2))],
    ['error_code', (r) => r.errorCode],
    ['error', (r) => r.errorText],
    ['per_message_multiplier', (r) => r.perMessageMultiplier],
  ];
  return [cols.map(([h]) => h).join(','), ...rows.map((r) => cols.map(([, f]) => csvCell(f(r))).join(','))].join('\n') + '\n';
}
