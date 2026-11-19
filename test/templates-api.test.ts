// Exercises the 360dialog client and the template routes against a fake 360dialog.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb, type DB } from '../src/server/db';
import { createApp } from '../src/server/app';
import { D360Client, normaliseSpec } from '../src/server/d360';

interface Call { method: string; path: string; headers: Record<string, string>; body: any }

/** Minimal fake of the gateway. `routes` decide each response. */
function fakeGateway(routes: (c: Call) => { status: number; body: unknown } | undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const call: Call = {
      method: init.method ?? 'GET',
      path: u.pathname + u.search,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = routes(call) ?? { status: 404, body: { error: 'no fake route' } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const T_APPROVED = {
  id: '111', name: 'spring_sale', language: 'en_US', status: 'APPROVED', category: 'MARKETING',
  components: [{ type: 'BODY', text: 'Hi {{1}}, sale today.', example: { body_text: [['Ana']] } }],
};
const T_MAXPRICE = {
  id: '222', name: 'promo_capped', language: 'en_US', status: 'APPROVED', category: 'MARKETING',
  components: [{ type: 'BODY', text: 'Promo' }],
  optimization_spec: { bid_strategy: 'LOWEST_COST_WITH_BID_CAP', bid_amount: 5000, bid_country_multiplier_overrides: [{ key: 'IN', value: 0.198 }, { key: 'BR', value: 1.036 }] },
};
const T_UTILITY = { id: '333', name: 'order_update', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [] };

describe('normaliseSpec', () => {
  it('turns the [{key, value}] list into a map', () => {
    expect(normaliseSpec(T_MAXPRICE.optimization_spec)).toEqual({
      bid_strategy: 'LOWEST_COST_WITH_BID_CAP', bid_amount: 5000, bid_country_multiplier_overrides: { IN: 0.198, BR: 1.036 },
    });
  });
  it('returns null for rate card templates', () => {
    expect(normaliseSpec(undefined)).toBeNull();
    expect(normaliseSpec({ bid_strategy: null, bid_amount: null })).toBeNull();
  });
  it('accepts a map too and an empty list', () => {
    expect(normaliseSpec({ bid_amount: '7000', bid_country_multiplier_overrides: { mx: 0.5 } })?.bid_country_multiplier_overrides).toEqual({ MX: 0.5 });
    expect(normaliseSpec({ bid_amount: 7000, bid_country_multiplier_overrides: [] })?.bid_country_multiplier_overrides).toEqual({});
  });
});

describe('D360Client', () => {
  it('sends the raw key in D360-API-KEY and follows pagination', async () => {
    const gw = fakeGateway((c) => {
      if (c.path.startsWith('/message_templates') && !c.path.includes('after=')) {
        return { status: 200, body: { data: [T_APPROVED], paging: { cursors: { after: 'CUR' }, next: 'https://x' } } };
      }
      if (c.path.includes('after=CUR')) return { status: 200, body: { data: [T_MAXPRICE], paging: { cursors: { after: 'END' } } } };
    });
    const client = new D360Client({ apiKey: 'KEY123', fetchImpl: gw.fetchImpl, baseUrl: 'https://gw.test' });
    const list = await client.listTemplates();
    expect(list.map((t) => t.id)).toEqual(['111', '222']);
    expect(gw.calls[0].headers['D360-API-KEY']).toBe('KEY123');
    expect(gw.calls[0].path).toContain('fields=id%2Cname%2Clanguage%2Cstatus%2Ccategory%2Ccomponents%2Coptimization_spec');
  });

  it('carries the API error body and never puts the key in the message', async () => {
    const gw = fakeGateway(() => ({ status: 400, body: { error: { message: 'Invalid parameter', code: 100 } } }));
    const client = new D360Client({ apiKey: 'SECRETKEY', fetchImpl: gw.fetchImpl, baseUrl: 'https://gw.test' });
    const err = await client.setMaxPrice('111', { bid_strategy: 'LOWEST_COST_WITH_BID_CAP', bid_amount: 5000 }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.body).toEqual({ error: { message: 'Invalid parameter', code: 100 } });
    expect(err.message).toContain('Invalid parameter');
    expect(err.message).not.toContain('SECRETKEY');
  });
});

describe('template routes', () => {
  let db: DB;
  let server: Server;
  let base: string;
  let gw: ReturnType<typeof fakeGateway>;
  let duplicateBehaviour: 'ok' | 'reject';

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeEach(async () => {
    duplicateBehaviour = 'ok';
    db = openDb(':memory:');
    gw = fakeGateway((c) => {
      if (c.method === 'GET' && c.path.startsWith('/message_templates')) return { status: 200, body: { data: [T_APPROVED, T_MAXPRICE, T_UTILITY] } };
      if (c.method === 'POST' && c.path === '/message_templates' && c.body.source_template_id) {
        return duplicateBehaviour === 'ok'
          ? { status: 200, body: { id: '999', status: 'APPROVED', category: 'MARKETING' } }
          : { status: 400, body: { error: { message: '(#100) Param source_template_id is not valid' } } };
      }
      if (c.method === 'POST' && c.path === '/message_templates') return { status: 200, body: { id: '888', status: 'PENDING', category: 'MARKETING' } };
      if (c.method === 'POST' && /^\/message_templates\/\d+$/.test(c.path)) return { status: 200, body: { success: true } };
      if (c.method === 'POST' && c.path === '/v1/configs/webhook') return { status: 200, body: { url: c.body.url } };
    });
    const app = createApp({ db, clientFactory: (auth) => new D360Client({ ...auth, fetchImpl: gw.fetchImpl, baseUrl: 'https://gw.test' }) });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await call('PUT', '/api/settings', { apiKey: 'test-key-abcdef123', wabaCurrency: 'EUR' });
    await call('POST', '/api/rate-card/import-local', { file: 'meta-rate-card-eur.csv' });
  });

  afterEach(() => {
    server.close();
    db.close();
  });

  it('masks the API key in settings', async () => {
    const { body } = await call('GET', '/api/settings');
    expect(body.hasApiKey).toBe(true);
    expect(body.apiKeyMasked).toBe('test••••••••f123');
    expect(JSON.stringify(body)).not.toContain('test-key-abcdef123');
  });

  it('syncs and lists only marketing templates, with max price normalised', async () => {
    const { body } = await call('POST', '/api/templates/sync');
    expect(body.templates.map((t: any) => t.name)).toEqual(['promo_capped', 'spring_sale']);
    const capped = body.templates.find((t: any) => t.id === '222');
    expect(capped.maxPrice.bid_country_multiplier_overrides).toEqual({ IN: 0.198, BR: 1.036 });
    expect(body.currentSpec.bid_amount).toBe(5000);
  });

  it('applies the current spec with only optimization_spec in the body', async () => {
    await call('POST', '/api/templates/sync');
    const { status, body } = await call('POST', '/api/templates/111/max-price');
    expect(status).toBe(200);
    expect(body.note).toMatch(/1 hour/);
    const sent = gw.calls.find((c) => c.method === 'POST' && c.path === '/message_templates/111')!;
    expect(Object.keys(sent.body)).toEqual(['optimization_spec']);
    expect(sent.body.optimization_spec.bid_amount).toBe(5000);
    expect(Object.keys(sent.body.optimization_spec.bid_country_multiplier_overrides)).toHaveLength(159);
  });

  it('resets to rate card with both fields null and nothing else', async () => {
    await call('POST', '/api/templates/sync');
    await call('POST', '/api/templates/222/reset');
    const sent = gw.calls.find((c) => c.path === '/message_templates/222')!;
    expect(sent.body).toEqual({ optimization_spec: { bid_strategy: null, bid_amount: null } });
  });

  it('creates an A/B pair with source_template_id', async () => {
    await call('POST', '/api/templates/sync');
    const { body } = await call('POST', '/api/templates/111/ab-pair', { name: 'spring_sale_maxprice' });
    expect(body.method).toBe('duplicate');
    const sent = gw.calls.find((c) => c.body?.source_template_id)!;
    expect(sent.body).toMatchObject({ source_template_id: '111', name: 'spring_sale_maxprice' });
    expect(sent.body.optimization_spec.bid_amount).toBe(5000);
    expect(sent.body.components).toBeUndefined();
    const arms = db.prepare('SELECT id, arm, pair_id FROM templates WHERE pair_id IS NOT NULL ORDER BY arm').all() as any[];
    expect(arms.map((a) => [a.id, a.arm])).toEqual([['111', 'A'], ['999', 'B']]);
    expect(arms[0].pair_id).toBe(arms[1].pair_id);
  });

  it('falls back to a plain create with identical content when source_template_id is refused', async () => {
    duplicateBehaviour = 'reject';
    await call('POST', '/api/templates/sync');
    const { body } = await call('POST', '/api/templates/111/ab-pair', { name: 'spring_sale_maxprice' });
    expect(body.method).toBe('create');
    expect(body.note).toMatch(/approval/);
    expect(body.duplicateError.status).toBe(400);
    const created = gw.calls.filter((c) => c.method === 'POST' && c.path === '/message_templates').at(-1)!;
    expect(created.body.components).toEqual(T_APPROVED.components);
    expect(created.body).toMatchObject({ name: 'spring_sale_maxprice', language: 'en_US', category: 'MARKETING' });
  });

  it('refuses an A/B pair whose arm A already has a max price', async () => {
    await call('POST', '/api/templates/sync');
    const { status, body } = await call('POST', '/api/templates/222/ab-pair', {});
    expect(status).toBe(409);
    expect(body.error).toMatch(/Arm A must be on rate card/);
  });

  it('surfaces the 360dialog error body', async () => {
    duplicateBehaviour = 'reject';
    gw.calls.length = 0;
    const app2 = createApp({
      db,
      clientFactory: (auth) =>
        new D360Client({ ...auth, baseUrl: 'https://gw.test', fetchImpl: fakeGateway(() => ({ status: 403, body: { error: { message: 'Not enrolled in max price' } } })).fetchImpl }),
    });
    const s2 = app2.listen(0);
    const res = await fetch(`http://127.0.0.1:${(s2.address() as AddressInfo).port}/api/settings/test`, { method: 'POST' });
    const body = (await res.json()) as any;
    s2.close();
    expect(res.status).toBe(502);
    expect(body.api.status).toBe(403);
    expect(body.api.body).toEqual({ error: { message: 'Not enrolled in max price' } });
  });

  it('blocks max price when the WABA currency differs from the rate card', async () => {
    await call('PUT', '/api/settings', { wabaCurrency: 'USD' });
    const { body } = await call('GET', '/api/max-price');
    expect(body.result.ok).toBe(false);
    await call('POST', '/api/templates/sync');
    const r = await call('POST', '/api/templates/111/max-price');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/EUR.*USD/);
  });

  it('subset selection drives the spec that gets applied', async () => {
    await call('PUT', '/api/max-price', { countries: ['BR', 'IN', 'MX'] });
    await call('POST', '/api/templates/sync');
    await call('POST', '/api/templates/111/max-price');
    const sent = gw.calls.find((c) => c.path === '/message_templates/111')!;
    expect(sent.body.optimization_spec.bid_country_multiplier_overrides).toEqual({ BR: 1.036, IN: 0.198, MX: 0.658 });
  });

  it('registers the saved webhook URL and answers webhooks with 200', async () => {
    await call('PUT', '/api/settings', { webhookUrl: 'https://abc.trycloudflare.com/webhook' });
    await call('POST', '/api/settings/register-webhook');
    expect(gw.calls.find((c) => c.path === '/v1/configs/webhook')!.body).toEqual({ url: 'https://abc.trycloudflare.com/webhook' });
    const res = await fetch(base + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry: [] }) });
    expect(res.status).toBe(200);
  });
});
