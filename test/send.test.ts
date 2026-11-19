import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { parseRecipients, splitAB, maskNumber } from '../src/server/recipients';
import { buildPayload, templateVariables } from '../src/server/payload';
import { openDb, type DB } from '../src/server/db';
import { createApp } from '../src/server/app';
import { D360Client } from '../src/server/d360';

// Deterministic RNG for split tests.
function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

describe('recipients', () => {
  it('detects country, eligibility, duplicates and invalid numbers', () => {
    const list = parseRecipients(
      [
        '+5511987654321, Ana',
        '5511987654321', // duplicate without +
        '+919812345678',
        '+14165550123', // Canada
        '+12125550123', // US
        '+79161234567', // Russia
        '+4915112345678', // Germany
        '+5358123456', // Cuba
        '12345',
        '',
        '# comment',
      ].join('\n'),
    );
    const by = (line: number) => list.find((r) => r.line === line)!;
    expect(by(1)).toMatchObject({ country: 'BR', status: 'eligible', canSend: true, vars: ['Ana'], to: '5511987654321' });
    expect(by(2).status).toBe('duplicate');
    expect(by(3)).toMatchObject({ country: 'IN', status: 'eligible' });
    expect(by(4)).toMatchObject({ country: 'CA', status: 'eligible' });
    expect(by(5)).toMatchObject({ country: 'US', status: 'not_delivered', canSend: false });
    expect(by(6)).toMatchObject({ country: 'RU', status: 'no_max_price', canSend: true });
    expect(by(7)).toMatchObject({ country: 'DE', status: 'flagged', canSend: true });
    expect(by(8)).toMatchObject({ country: 'CU', status: 'blocked', canSend: false });
    expect(by(9).status).toBe('invalid');
    expect(list).toHaveLength(9);
  });

  it('masks numbers', () => {
    expect(maskNumber('5511987654321')).toBe('+551•••••••321');
    expect(maskNumber('5511987654321')).not.toContain('98765');
  });

  it('splits 50/50, balanced per country', () => {
    const lines = [
      ...Array.from({ length: 10 }, (_, i) => `+55119876543${String(i).padStart(2, '0')}`),
      ...Array.from({ length: 7 }, (_, i) => `+9198123456${String(i).padStart(2, '0')}`),
      ...Array.from({ length: 3 }, (_, i) => `+52551234567${i}`),
      '+12125550123', // US, not sendable: no arm
    ];
    for (const seed of [1, 2, 3, 42]) {
      const list = splitAB(parseRecipients(lines.join('\n')), seeded(seed));
      const count = (c: string, arm: string) => list.filter((r) => r.country === c && r.arm === arm).length;
      expect(count('BR', 'A')).toBe(5);
      expect(count('BR', 'B')).toBe(5);
      expect(Math.abs(count('IN', 'A') - count('IN', 'B'))).toBe(1);
      expect(Math.abs(count('MX', 'A') - count('MX', 'B'))).toBe(1);
      const a = list.filter((r) => r.arm === 'A').length;
      const b = list.filter((r) => r.arm === 'B').length;
      expect(a + b).toBe(20);
      expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
      expect(list.find((r) => r.country === 'US')!.arm).toBeUndefined();
    }
  });
});

describe('payloads', () => {
  it('fills positional header and body variables', () => {
    const vars = templateVariables([
      { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' },
      { type: 'BODY', text: '{{2}} and {{1}}, code {{3}}' },
    ]);
    expect(vars).toMatchObject({ header: ['1'], body: ['1', '2', '3'], named: false });
    const p = buildPayload({ templateName: 'spring', language: 'en_US', vars, values: ['Ana', 'x', 'y', 'z'], to: '5511987654321' });
    expect(p).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511987654321',
      type: 'template',
      template: {
        name: 'spring',
        language: { code: 'en_US' },
        components: [
          { type: 'header', parameters: [{ type: 'text', text: 'Ana' }] },
          { type: 'body', parameters: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }, { type: 'text', text: 'z' }] },
        ],
      },
    });
  });

  it('uses parameter_name for named variables and adds bid_spec only when set', () => {
    const vars = templateVariables([{ type: 'BODY', text: 'Hi {{first_name}}' }]);
    const p = buildPayload({ templateName: 't', language: 'es', vars, values: ['Ana'], to: '1', perMessageMultiplier: 0.9 });
    expect(p.template.components).toEqual([{ type: 'body', parameters: [{ type: 'text', parameter_name: 'first_name', text: 'Ana' }] }]);
    expect(p.bid_spec).toEqual({ per_message_bid_multiplier: 0.9 });
    expect(buildPayload({ templateName: 't', language: 'es', vars, values: ['Ana'], to: '1' }).bid_spec).toBeUndefined();
  });

  it('omits components for a template with no variables and flags unsupported parts', () => {
    const vars = templateVariables([
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Sale today' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://x.com/{{1}}' }] },
    ]);
    expect(vars.unsupported).toEqual(['image header', 'dynamic URL button']);
    expect(buildPayload({ templateName: 't', language: 'en', vars, values: [], to: '1' }).template.components).toBeUndefined();
  });
});

describe('send routes', () => {
  let db: DB;
  let server: Server;
  let base: string;
  const sent: any[] = [];

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const waitForJob = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const { body } = await call('GET', `/api/send/jobs/${id}`);
      if (body.finished) return body;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('job did not finish');
  };

  beforeEach(async () => {
    sent.length = 0;
    db = openDb(':memory:');
    let n = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
      if (u.pathname === '/marketing_messages') {
        sent.push(body);
        if (body.to.startsWith('91')) return json(400, { error: { message: 'Recipient not on WhatsApp', code: 131026 } });
        return json(200, { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.${++n}`, message_status: 'accepted' }] });
      }
      if (u.pathname === '/message_templates') {
        return json(200, {
          data: [
            { id: '111', name: 'spring_sale', language: 'en_US', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hi {{1}}' }] },
            { id: '999', name: 'spring_sale_maxprice', language: 'en_US', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hi {{1}}' }], optimization_spec: { bid_strategy: 'LOWEST_COST_WITH_BID_CAP', bid_amount: 5000 } },
            { id: '555', name: 'pending_one', language: 'en_US', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hello' }] },
          ],
        });
      }
      return json(404, { error: 'no route' });
    }) as typeof fetch;
    const app = createApp({ db, clientFactory: (auth) => new D360Client({ ...auth, fetchImpl, baseUrl: 'https://gw.test' }) });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await call('PUT', '/api/settings', { apiKey: 'k-123456789', sendRatePerSecond: 80 });
    await call('POST', '/api/rate-card/import-local', { file: 'meta-rate-card-eur.csv' });
    await call('POST', '/api/templates/sync');
    db.prepare("UPDATE templates SET arm = 'A', pair_id = 'P1' WHERE id = '111'").run();
    db.prepare("UPDATE templates SET arm = 'B', pair_id = 'P1' WHERE id = '999'").run();
  });

  afterEach(() => {
    server.close();
    db.close();
  });

  const NUMBERS = ['+5511987654321', '+5511987654322', '+919812345678', '+12125550123', '+5511987654321'].join('\n');

  it('previews with masked numbers, skips and a rate card estimate', async () => {
    const { status, body } = await call('POST', '/api/send/preview', { pairId: 'P1', numbers: NUMBERS, values: ['Ana'] });
    expect(status).toBe(200);
    expect(body.counts).toMatchObject({ lines: 5, sendable: 3, skipped: 2 });
    expect(body.counts.A + body.counts.B).toBe(3);
    expect(JSON.stringify(body)).not.toContain('5511987654321');
    expect(body.estimatedRateCardCost).toBeCloseTo(0.0518 * 2 + 0.0099, 10);
    expect(body.samplePayload.to).toMatch(/•/);
  });

  it('dry run builds payloads without calling the API and keeps the plan', async () => {
    const { body: p } = await call('POST', '/api/send/preview', { templateId: '999', numbers: NUMBERS, values: ['Ana'] });
    const { body } = await call('POST', `/api/send/${p.planId}`, { dryRun: true });
    expect(body.count).toBe(3);
    expect(body.payloads[0].payload.template).toEqual({ name: 'spring_sale_maxprice', language: { code: 'en_US' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }] }] });
    expect(sent).toHaveLength(0);
    const again = await call('POST', `/api/send/${p.planId}`, { dryRun: true });
    expect(again.status).toBe(200);
  });

  it('sends an A/B pair to /marketing_messages and stores each message', async () => {
    const { body: p } = await call('POST', '/api/send/preview', { pairId: 'P1', numbers: NUMBERS, values: ['Ana'] });
    const { body } = await call('POST', `/api/send/${p.planId}`, { dryRun: false });
    const job = await waitForJob(body.job.id);
    expect(job).toMatchObject({ total: 3, done: 3, ok: 2, failed: 1 });
    expect(job.errors[0].api.body.error.code).toBe(131026);
    expect(new Set(sent.map((s) => s.template.name))).toEqual(new Set(p.recipients.filter((r: any) => r.arm).map((r: any) => (r.arm === 'A' ? 'spring_sale' : 'spring_sale_maxprice'))));
    const rows = db.prepare('SELECT * FROM messages ORDER BY sent_at').all() as any[];
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.wamid.startsWith('wamid.'))).toHaveLength(2);
    expect(rows.every((r) => ['A', 'B'].includes(r.arm))).toBe(true);
    expect(rows.every((r) => !r.to_masked.includes('98765'))).toBe(true);
    // A plan is sent once.
    expect((await call('POST', `/api/send/${p.planId}`, { dryRun: false })).status).toBe(404);
  });

  it('refuses to send a template that is not approved, but allows a dry run', async () => {
    const { body: p } = await call('POST', '/api/send/preview', { templateId: '555', numbers: '+5511987654321' });
    expect((await call('POST', `/api/send/${p.planId}`, { dryRun: true })).status).toBe(200);
    const r = await call('POST', `/api/send/${p.planId}`, { dryRun: false });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Not approved/);
    expect(sent).toHaveLength(0);
  });

  it('requires variable values', async () => {
    const r = await call('POST', '/api/send/preview', { templateId: '111', numbers: '+5511987654321' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/1 variable/);
    const ok = await call('POST', '/api/send/preview', { templateId: '111', numbers: '+5511987654321, Ana' });
    expect(ok.status).toBe(200);
  });

  it('adds the per-message multiplier only when given', async () => {
    const { body: p } = await call('POST', '/api/send/preview', { templateId: '999', numbers: '+5511987654321', values: ['Ana'], perMessageMultiplier: 0.9 });
    const { body } = await call('POST', `/api/send/${p.planId}`, { dryRun: true });
    expect(body.payloads[0].payload.bid_spec).toEqual({ per_message_bid_multiplier: 0.9 });
  });
});
