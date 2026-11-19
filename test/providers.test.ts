// The same client against Meta's Cloud API: auth header, path prefixes, webhook
// override and verification, and the provider switch in Settings.
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/server/db';
import { createApp } from '../src/server/app';
import { D360Client, D360Error } from '../src/server/d360';

interface Call { method: string; url: URL; headers: Record<string, string>; body: any }

function fakeGraph(routes: (c: Call) => { status: number; body: unknown } | undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url: new URL(url),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = routes(call) ?? { status: 404, body: { error: { message: 'no fake route' } } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const META = { provider: 'meta' as const, accessToken: 'EAAGsecrettoken', wabaId: '1001', phoneNumberId: '2002' };
const SPEC = { bid_strategy: 'LOWEST_COST_WITH_BID_CAP' as const, bid_amount: 5000 };
const MKT = { id: '111', name: 'spring_sale', language: 'en_US', status: 'APPROVED', category: 'MARKETING', components: [] };

describe('Meta Cloud API client', () => {
  it('uses the Graph base URL, a Bearer token and WABA / phone number paths', async () => {
    const g = fakeGraph(() => ({ status: 200, body: { data: [], success: true, id: '9', messages: [{ id: 'wamid.X' }] } }));
    const c = new D360Client({ ...META, fetchImpl: g.fetchImpl });

    await c.listTemplates();
    await c.setMaxPrice('111', SPEC);
    await c.resetToRateCard('111');
    await c.duplicateTemplate({ source_template_id: '111', name: 'spring_sale_b', optimization_spec: SPEC });
    await c.sendMarketing({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '+491701234567', type: 'template',
      template: { name: 'spring_sale', language: { code: 'en_US' } },
    });
    await c.setWebhook('https://x.ngrok-free.app/webhook', 'vt');
    await c.reachEstimate(['IN']);

    expect(g.calls.map((x) => `${x.method} ${x.url.origin}${x.url.pathname}`)).toEqual([
      'GET https://graph.facebook.com/v27.0/1001/message_templates',
      'POST https://graph.facebook.com/v27.0/111',
      'POST https://graph.facebook.com/v27.0/111',
      'POST https://graph.facebook.com/v27.0/1001/message_templates',
      'POST https://graph.facebook.com/v27.0/2002/marketing_messages',
      'POST https://graph.facebook.com/v27.0/1001/subscribed_apps',
      'GET https://graph.facebook.com/v27.0/1001/reachestimate',
    ]);
    for (const call of g.calls) {
      expect(call.headers.Authorization).toBe('Bearer EAAGsecrettoken');
      expect(call.headers['D360-API-KEY']).toBeUndefined();
    }
    expect(g.calls[2].body).toEqual({ optimization_spec: { bid_strategy: null, bid_amount: null } });
    expect(g.calls[5].body).toEqual({ override_callback_uri: 'https://x.ngrok-free.app/webhook', verify_token: 'vt' });
  });

  it('honours the API version setting', async () => {
    const g = fakeGraph(() => ({ status: 200, body: { data: [] } }));
    await new D360Client({ ...META, apiVersion: '25.0', fetchImpl: g.fetchImpl }).listTemplates();
    expect(g.calls[0].url.pathname).toBe('/v25.0/1001/message_templates');
  });

  it('reads optimization_spec per template when the list leaves it out', async () => {
    const g = fakeGraph((c) => {
      if (c.url.pathname.endsWith('/message_templates')) {
        return { status: 200, body: { data: [MKT, { ...MKT, id: '333', name: 'order_update', category: 'UTILITY' }] } };
      }
      if (c.url.pathname === '/v27.0/111') {
        return { status: 200, body: { id: '111', optimization_spec: { ...SPEC, bid_country_multiplier_overrides: [{ key: 'IN', value: 0.2 }] } } };
      }
    });
    const templates = await new D360Client({ ...META, fetchImpl: g.fetchImpl }).listTemplates();
    expect(templates[0].optimization_spec).toEqual({ ...SPEC, bid_country_multiplier_overrides: { IN: 0.2 } });
    expect(templates[1].optimization_spec).toBeNull();
    // Only the approved marketing template was looked up.
    expect(g.calls.filter((c) => c.url.searchParams.get('fields') === 'optimization_spec')).toHaveLength(1);
  });

  it('lists without optimization_spec if Meta rejects the field', async () => {
    const g = fakeGraph((c) => {
      if (c.url.pathname.endsWith('/message_templates')) {
        return (c.url.searchParams.get('fields') ?? '').includes('optimization_spec')
          ? { status: 400, body: { error: { message: '(#100) Tried accessing nonexisting field (optimization_spec)', code: 100 } } }
          : { status: 200, body: { data: [MKT] } };
      }
      if (c.url.pathname === '/v27.0/111') return { status: 200, body: { id: '111', optimization_spec: SPEC } };
    });
    const templates = await new D360Client({ ...META, fetchImpl: g.fetchImpl }).listTemplates();
    expect(templates[0].optimization_spec).toMatchObject(SPEC);
  });

  it('never puts the token in an error message', async () => {
    const g = fakeGraph(() => ({ status: 401, body: { error: { message: 'Invalid OAuth access token', code: 190 } } }));
    const err = await new D360Client({ ...META, fetchImpl: g.fetchImpl }).listTemplates().catch((e) => e);
    expect(err).toBeInstanceOf(D360Error);
    expect(err.message).toContain('code 190');
    expect(err.message).not.toContain('EAAGsecrettoken');
  });

  it('refuses to build without the IDs', () => {
    expect(() => new D360Client({ provider: 'meta', accessToken: 't', wabaId: '', phoneNumberId: '' })).toThrow(/WABA ID, phone number ID/);
  });
});

describe('provider switch and webhook verification', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function start(fetchImpl: typeof fetch) {
    const db = openDb(':memory:');
    const app = createApp({ db, clientFactory: (auth) => new D360Client({ ...auth, fetchImpl }) });
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const put = (body: unknown) =>
      fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    return { base, put };
  }

  it('switches to Meta, keeps each provider\'s credentials, and calls Graph', async () => {
    const g = fakeGraph((c) => {
      if (c.url.pathname.endsWith('/message_templates')) return { status: 200, body: { data: [{ ...MKT, optimization_spec: null }] } };
      if (c.url.pathname === '/v27.0/2002') return { status: 200, body: { display_phone_number: '+49 30 1234567', verified_name: 'Shop' } };
    });
    const { base, put } = await start(g.fetchImpl);

    await put({ apiKey: 'D360KEYVALUE1234' });
    let s = await put({ provider: 'meta' });
    expect(s).toMatchObject({ provider: 'meta', providerLabel: 'Meta Cloud API', configured: false, hasApiKey: true });
    expect(s.missing).toMatch(/access token, WABA ID, phone number ID/);

    s = await put({ metaAccessToken: 'EAAGsecrettoken', metaWabaId: '1001', metaPhoneNumberId: '2002' });
    expect(s).toMatchObject({ configured: true, metaAccessTokenMasked: 'EAAG••••••••oken', metaApiVersion: 'v27.0' });
    expect(JSON.stringify(s)).not.toContain('EAAGsecrettoken');

    const test = await fetch(`${base}/api/settings/test`, { method: 'POST' }).then((r) => r.json());
    expect(test).toMatchObject({ ok: true, marketing: 1, phone: { verified_name: 'Shop' } });
    expect(g.calls.every((c) => c.headers.Authorization === 'Bearer EAAGsecrettoken')).toBe(true);

    s = await put({ provider: '360dialog' });
    expect(s).toMatchObject({ provider: '360dialog', configured: true, hasMetaAccessToken: true });
  });

  it('rejects IDs that are not digits', async () => {
    const { base } = await start(fakeGraph(() => undefined).fetchImpl);
    const res = await fetch(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metaWabaId: '+4930' }),
    });
    expect(res.status).toBe(400);
  });

  it('answers Meta\'s GET check only with the right verify token', async () => {
    const { base, put } = await start(fakeGraph(() => undefined).fetchImpl);
    const { metaVerifyToken } = await put({});
    expect(metaVerifyToken).toMatch(/^[0-9a-f]{32}$/);

    const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${metaVerifyToken}&hub.challenge=1158201444`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('1158201444');

    const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1158201444`);
    expect(bad.status).toBe(403);
  });

  it('registers the webhook as a WABA callback override with the verify token', async () => {
    const g = fakeGraph((c) => (c.url.pathname.endsWith('/subscribed_apps') ? { status: 200, body: { success: true } } : undefined));
    const { base, put } = await start(g.fetchImpl);
    const s = await put({
      provider: 'meta', metaAccessToken: 'EAAGsecrettoken', metaWabaId: '1001', metaPhoneNumberId: '2002', webhookUrl: 'https://x.ngrok-free.app/webhook',
    });
    const res = await fetch(`${base}/api/settings/register-webhook`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(g.calls[0].body).toEqual({ override_callback_uri: 'https://x.ngrok-free.app/webhook', verify_token: s.metaVerifyToken });
  });
});
