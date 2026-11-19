import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb, type DB } from '../src/server/db';
import { createApp } from '../src/server/app';
import { messageResults, processWebhook, totals, toCsv } from '../src/server/results';

const RATES = new Map([['BR', 0.0518], ['IN', 0.0099], ['DE', 0.1131]]);

const status = (wamid: string, st: string, extra: object = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses: [{ id: wamid, status: st, timestamp: '1762876800', recipient_id: 'x', ...extra }] } }] }],
});
const priced = (category: string, amount: number, nested = true) =>
  nested
    ? { pricing: { billable: true, pricing_model: 'PMP', category, type: 'regular', cost: { amount, currency: 'EUR' } } }
    : { pricing: { billable: true, pricing_model: 'PMP', category, type: 'regular' }, cost: { amount, currency: 'EUR' } };

function seedMessage(db: DB, wamid: string, country: string, template: string, arm: string | null, response: object = {}) {
  db.prepare('INSERT INTO messages (wamid, to_masked, country, template_id, template_name, arm, sent_at, send_response_json, per_message_multiplier) VALUES (?,?,?,?,?,?,?,?,NULL)')
    .run(wamid, '+551•••321', country, template === 'spring_sale' ? '111' : '999', template, arm, new Date().toISOString(), JSON.stringify(response));
}

describe('webhook processing', () => {
  let db: DB;
  beforeEach(() => (db = openDb(':memory:')));
  afterEach(() => db.close());

  it('is idempotent on (wamid, status) and logs every payload', () => {
    const p = status('wamid.1', 'delivered', priced('marketing_lite_dynamic', 0.0431));
    expect(processWebhook(db, p)).toMatchObject({ statuses: 1, duplicates: 0 });
    expect(processWebhook(db, p)).toMatchObject({ statuses: 0, duplicates: 1 });
    processWebhook(db, status('wamid.1', 'read', priced('marketing_lite_dynamic', 0.0431)));
    expect((db.prepare('SELECT COUNT(*) n FROM statuses').get() as any).n).toBe(2);
    expect((db.prepare('SELECT COUNT(*) n FROM webhook_log').get() as any).n).toBe(3);
  });

  it('logs payloads with no statuses too', () => {
    processWebhook(db, { entry: [{ changes: [{ value: { messages: [{ from: '1' }] } }] }] });
    expect((db.prepare('SELECT COUNT(*) n FROM webhook_log').get() as any).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) n FROM statuses').get() as any).n).toBe(0);
  });
});

describe('results', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    // Arm A (rate card) and arm B (max price), BR and IN.
    seedMessage(db, 'wamid.a1', 'BR', 'spring_sale', 'A');
    seedMessage(db, 'wamid.a2', 'IN', 'spring_sale', 'A');
    seedMessage(db, 'wamid.b1', 'BR', 'spring_sale_maxprice', 'B');
    seedMessage(db, 'wamid.b2', 'IN', 'spring_sale_maxprice', 'B');
    seedMessage(db, 'wamid.b3', 'DE', 'spring_sale_maxprice', 'B');
    seedMessage(db, 'failed:x', 'BR', 'spring_sale_maxprice', 'B', { error: 'POST /marketing_messages failed', api: { status: 400, body: { error: { message: 'Recipient not on WhatsApp', code: 131026 } } } });

    for (const w of ['wamid.a1', 'wamid.a2', 'wamid.b1', 'wamid.b2', 'wamid.b3']) processWebhook(db, status(w, 'sent'));
    processWebhook(db, status('wamid.a1', 'delivered', priced('marketing_lite', 0.0518)));
    processWebhook(db, status('wamid.a2', 'delivered', priced('marketing_lite', 0.0099, false)));
    processWebhook(db, status('wamid.b1', 'delivered', priced('marketing_lite_dynamic', 0.0431)));
    processWebhook(db, status('wamid.b1', 'read', priced('marketing_lite_dynamic', 0.0431)));
    processWebhook(db, status('wamid.b2', 'delivered', priced('marketing_lite_dynamic', 0.0081, false)));
    processWebhook(db, status('wamid.b3', 'failed', { errors: [{ code: 131065, title: 'Max price not available in this country' }] }));
  });
  afterEach(() => db.close());

  it('reads per-message status, pricing category, cost and saving', () => {
    const rows = messageResults(db, RATES, 'EUR');
    const by = (w: string) => rows.find((r) => r.wamid === w)!;
    expect(by('wamid.a1')).toMatchObject({ status: 'delivered', delivered: true, category: 'marketing_lite', cost: 0.0518, saving: 0 });
    expect(by('wamid.a2')).toMatchObject({ cost: 0.0099, saving: 0 });
    expect(by('wamid.b1')).toMatchObject({ status: 'read', delivered: true, category: 'marketing_lite_dynamic', cost: 0.0431 });
    expect(by('wamid.b1').saving).toBeCloseTo((0.0518 - 0.0431) / 0.0518, 10);
    expect(by('wamid.b3')).toMatchObject({ status: 'failed', delivered: false, errorCode: 131065, errorText: 'Max price not available in this country', cost: null });
    const sf = rows.find((r) => r.status === 'send_failed')!;
    expect(sf).toMatchObject({ errorCode: 131026, errorText: 'Recipient not on WhatsApp', delivered: false });
  });

  it('totals per arm: delivery rate, avg cost per delivered, saving', () => {
    const rows = messageResults(db, RATES, 'EUR');
    const [A, B] = totals(rows.filter((r) => r.arm), (r) => r.arm!, (r) => r.arm!).sort((a, b) => a.key.localeCompare(b.key));
    expect(A).toMatchObject({ sent: 2, delivered: 2, deliveryRate: 1, costed: 2, maxPriceApplied: 0, saving: 0 });
    expect(A.avgCostPerDelivered).toBeCloseTo((0.0518 + 0.0099) / 2, 10);
    expect(B).toMatchObject({ sent: 3, sendFailed: 1, delivered: 2, failed: 1, costed: 2, maxPriceApplied: 2 });
    expect(B.deliveryRate).toBeCloseTo(2 / 3, 10);
    expect(B.charged).toBeCloseTo(0.0431 + 0.0081, 10);
    expect(B.rateCardCost).toBeCloseTo(0.0518 + 0.0099, 10);
    expect(B.saved).toBeCloseTo(0.0518 + 0.0099 - 0.0431 - 0.0081, 10);
    expect(B.saving).toBeCloseTo((0.0617 - 0.0512) / 0.0617, 10);
  });

  it('does not compare costs in another currency', () => {
    processWebhook(db, status('wamid.x', 'delivered', { pricing: { billable: true, category: 'marketing_lite', cost: { amount: 0.06, currency: 'USD' } } }));
    seedMessage(db, 'wamid.x', 'BR', 'spring_sale', 'A');
    const r = messageResults(db, RATES, 'EUR').find((m) => m.wamid === 'wamid.x')!;
    expect(r.cost).toBe(0.06);
    expect(r.saving).toBeNull();
  });

  it('exports CSV with masked numbers', () => {
    const csv = toCsv(messageResults(db, RATES, 'EUR'));
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('wamid,number_masked,country,template,arm,sent_at,status,delivered,pricing_category,charged_cost,cost_currency,rate_card,saving_pct,error_code,error,per_message_multiplier');
    expect(lines).toHaveLength(7);
    expect(csv).toContain('marketing_lite_dynamic,0.0431,EUR,0.0518,16.80');
  });
});

describe('webhook route and results API', () => {
  let db: DB;
  let server: Server;
  let base: string;
  beforeEach(async () => {
    db = openDb(':memory:');
    server = createApp({ db }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await fetch(base + '/api/rate-card/import-local', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'meta-rate-card-eur.csv' }) });
    db.prepare("INSERT INTO templates (id, name, language, status, category, arm, pair_id, synced_at) VALUES ('111','spring_sale','en_US','APPROVED','MARKETING','A','P1',?), ('999','spring_sale_maxprice','en_US','APPROVED','MARKETING','B','P1',?)").run(new Date().toISOString(), new Date().toISOString());
    seedMessage(db, 'wamid.a1', 'BR', 'spring_sale', 'A');
    seedMessage(db, 'wamid.b1', 'BR', 'spring_sale_maxprice', 'B');
  });
  afterEach(() => {
    server.close();
    db.close();
  });

  const post = (body: unknown) => fetch(base + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('answers 200, stores statuses and shows them in results per arm', async () => {
    expect((await post(status('wamid.a1', 'delivered', priced('marketing_lite', 0.0518)))).status).toBe(200);
    expect((await post(status('wamid.b1', 'delivered', priced('marketing_lite_dynamic', 0.0431)))).status).toBe(200);
    await post(status('wamid.b1', 'delivered', priced('marketing_lite_dynamic', 0.0431))); // retry from the gateway
    await settle();
    const r = (await (await fetch(base + '/api/results?target=p:P1')).json()) as any;
    expect(r.byArm.map((t: any) => [t.key, t.delivered, t.avgCostPerDelivered])).toEqual([['A', 1, 0.0518], ['B', 1, 0.0431]]);
    expect(r.byArm[1].saving).toBeCloseTo(0.168, 3);
    expect(r.options[0]).toEqual({ value: 'p:P1', label: 'A/B: spring_sale vs spring_sale_maxprice' });
    expect(r.byCountry[0].label).toBe('Brazil (BR)');
    const log = (await (await fetch(base + '/api/webhook-log?q=wamid.b1')).json()) as any;
    expect(log.entries).toHaveLength(2);
    expect(log.entries[0].statuses[0]).toMatchObject({ wamid: 'wamid.b1', status: 'delivered', cost: 0.0431, category: 'marketing_lite_dynamic' });
    const csv = await (await fetch(base + '/api/results.csv')).text();
    expect(csv.split('\n')[0]).toMatch(/^wamid,number_masked/);
  });

  it('answers 200 even for a malformed payload', async () => {
    expect((await post({ hello: 'world' })).status).toBe(200);
    const res = await fetch(base + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json{' });
    expect(res.status).toBe(200);
    await settle();
    const log = (await (await fetch(base + '/api/webhook-log')).json()) as any;
    expect(log.entries[0].body).toEqual({ unparsed: 'not json{' });
  });

  it('clears results', async () => {
    await fetch(base + '/api/results', { method: 'DELETE' });
    const r = (await (await fetch(base + '/api/results')).json()) as any;
    expect(r.overall).toBeNull();
    expect(r.messageCount).toBe(0);
  });
});
