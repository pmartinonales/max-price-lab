import express, { type Request, type Response, type NextFunction } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type DB, getSettings, setSetting, getSetting, maskKey } from './db';
import {
  D360Client,
  D360Error,
  META_DEFAULT_API_VERSION,
  PROVIDER_LABEL,
  missingAuth,
  type Provider,
  type ProviderAuth,
  shouldFallBackFromDuplicate,
  type OptimizationSpec,
  type OptimizationSpecWrite,
  type ReachInterval,
  type Template,
  type TemplateComponent,
} from './d360';
import { parseRateCard } from './rate-card';
import { calculate, type CalculatorResult } from '../shared/calculator';
import { COUNTRY_MARKETS } from '../data/market-to-iso';
import { MINOR_UNITS } from '../shared/currency';
import { templateVariables } from './payload';
import { messageResults, processWebhook, toCsv, totals, type MessageResult } from './results';
import { parseStatuses } from './webhook-parse';
import { createPlan, getJob, getPlan, maskedPayload, payloadsFor, startJob, type SendPlan, type TemplateInfo } from './send';

export interface AppOptions {
  db: DB;
  dataDir?: string;
  /** For tests: inject a client factory instead of calling the real API. */
  clientFactory?: (auth: ProviderAuth) => D360Client;
}

export const PROPAGATION_NOTE = 'Max price changes can take up to 1 hour to reach delivery (Meta).';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

export function createApp({ db, dataDir = 'data', clientFactory }: AppOptions) {
  const app = express();

  /** Credentials for the selected provider, or what's missing. */
  const currentAuth = (): { auth: ProviderAuth | null; missing: string | null } => {
    const s = getSettings(db);
    const draft =
      s.provider === 'meta'
        ? { provider: 'meta' as const, accessToken: s.metaAccessToken ?? '', wabaId: s.metaWabaId, phoneNumberId: s.metaPhoneNumberId, apiVersion: s.metaApiVersion }
        : { provider: '360dialog' as const, apiKey: s.apiKey ?? '' };
    const missing = missingAuth(draft);
    return { auth: missing ? null : draft, missing };
  };

  const client = () => {
    const { auth, missing } = currentAuth();
    if (!auth) throw new HttpError(400, missing!);
    return clientFactory ? clientFactory(auth) : new D360Client(auth);
  };

  /** Token Meta echoes back when it checks the webhook URL. Made once, kept locally. */
  const verifyToken = () => {
    let t = getSetting(db, 'meta_verify_token');
    if (!t) {
      t = randomBytes(16).toString('hex');
      setSetting(db, 'meta_verify_token', t);
    }
    return t;
  };

  // ---- webhook: answer 200 at once, process after --------------------------------
  // Meta checks a new callback URL with a GET: echo hub.challenge if the token matches.
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && typeof token === 'string' && token === verifyToken() && typeof challenge === 'string') {
      return res.type('text/plain').send(challenge);
    }
    res.sendStatus(403);
  });

  // Idempotent on (wamid, status). Nothing here touches the API key.
  app.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
    res.sendStatus(200);
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    setImmediate(() => {
      try {
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = { unparsed: raw.slice(0, 10_000) };
        }
        processWebhook(db, body);
      } catch (e) {
        console.error('webhook processing failed:', (e as Error).message);
      }
    });
  });

  app.use('/api', express.json({ limit: '1mb' }));

  // ---- settings -----------------------------------------------------------------

  const publicSettings = () => {
    const s = getSettings(db);
    const { missing } = currentAuth();
    return {
      provider: s.provider,
      providerLabel: PROVIDER_LABEL[s.provider],
      configured: !missing,
      missing,
      hasApiKey: Boolean(s.apiKey),
      apiKeyMasked: maskKey(s.apiKey),
      hasMetaAccessToken: Boolean(s.metaAccessToken),
      metaAccessTokenMasked: maskKey(s.metaAccessToken),
      metaWabaId: s.metaWabaId,
      metaPhoneNumberId: s.metaPhoneNumberId,
      metaApiVersion: s.metaApiVersion,
      metaVerifyToken: verifyToken(),
      wabaCurrency: s.wabaCurrency,
      webhookUrl: s.webhookUrl,
      sendRatePerSecond: s.sendRatePerSecond,
      currencies: Object.keys(MINOR_UNITS).sort(),
    };
  };

  app.get('/api/settings', (_req, res) => res.json(publicSettings()));

  app.put(
    '/api/settings',
    route((req, res) => {
      const { provider, apiKey, metaAccessToken, metaWabaId, metaPhoneNumberId, metaApiVersion, wabaCurrency, webhookUrl, sendRatePerSecond } =
        req.body ?? {};
      if (provider !== undefined) {
        if (provider !== '360dialog' && provider !== 'meta') throw new HttpError(400, 'provider must be 360dialog or meta');
        setSetting(db, 'provider', provider satisfies Provider);
      }
      for (const [field, key] of [[apiKey, 'api_key'], [metaAccessToken, 'meta_access_token']] as const) {
        if (typeof field === 'string' && field.trim()) setSetting(db, key, field.trim());
        if (field === null) setSetting(db, key, null);
      }
      for (const [field, key, label] of [[metaWabaId, 'meta_waba_id', 'WABA ID'], [metaPhoneNumberId, 'meta_phone_number_id', 'Phone number ID']] as const) {
        if (typeof field !== 'string') continue;
        const v = field.trim();
        if (v && !/^\d+$/.test(v)) throw new HttpError(400, `${label} must be digits only`);
        setSetting(db, key, v);
      }
      if (typeof metaApiVersion === 'string') {
        const v = metaApiVersion.trim() || META_DEFAULT_API_VERSION;
        if (!/^v?\d+\.\d+$/.test(v)) throw new HttpError(400, 'API version looks like v27.0');
        setSetting(db, 'meta_api_version', v.startsWith('v') ? v : `v${v}`);
      }
      if (typeof wabaCurrency === 'string') {
        const c = wabaCurrency.trim().toUpperCase();
        if (!MINOR_UNITS[c]) throw new HttpError(400, `Unknown currency ${c}`);
        setSetting(db, 'waba_currency', c);
      }
      if (typeof webhookUrl === 'string') {
        const u = webhookUrl.trim();
        if (u && !/^https:\/\//.test(u)) throw new HttpError(400, 'Webhook URL must start with https://');
        setSetting(db, 'webhook_url', u);
      }
      if (sendRatePerSecond !== undefined) {
        const n = Number(sendRatePerSecond);
        if (!Number.isFinite(n) || n <= 0 || n > 80) throw new HttpError(400, 'Send rate must be between 0 and 80 per second');
        setSetting(db, 'send_rate_per_second', String(n));
      }
      res.json(publicSettings());
    }),
  );

  app.post(
    '/api/settings/test',
    route(async (_req, res) => {
      const phone = await client().phoneNumber();
      const templates = await syncTemplates();
      const marketing = templates.filter((t) => t.category === 'MARKETING');
      res.json({ ok: true, phone, total: templates.length, marketing: marketing.length, names: marketing.map((t) => t.name) });
    }),
  );

  app.post(
    '/api/settings/register-webhook',
    route(async (_req, res) => {
      const url = getSetting(db, 'webhook_url');
      if (!url) throw new HttpError(400, 'Save a webhook URL first');
      const result = await client().setWebhook(url, verifyToken());
      res.json({ ok: true, url, result });
    }),
  );

  // ---- rate card ------------------------------------------------------------

  const importRateCard = (buf: Buffer, source: string) => {
    const card = parseRateCard(buf);
    const now = new Date().toISOString();
    // ISO codes billed at each market (cheapest candidate, like the calculator).
    const calc = calculate({ rateCard: card.rows, rateCardCurrency: card.currency, wabaCurrency: card.currency });
    const isosByMarket = new Map<string, string[]>();
    if (calc.ok) for (const r of calc.rows) if (r.market) isosByMarket.set(r.market, [...(isosByMarket.get(r.market) ?? []), r.iso]);

    db.transaction(() => {
      db.prepare('DELETE FROM rate_card').run();
      const ins = db.prepare('INSERT INTO rate_card (market, iso, currency, marketing_rate, imported_at) VALUES (?, ?, ?, ?, ?)');
      for (const r of card.rows) ins.run(r.market, (isosByMarket.get(r.market) ?? []).sort().join(','), r.currency, r.marketingRate, now);
      setSetting(db, 'rate_card_title', card.title ?? null);
      setSetting(db, 'rate_card_effective', card.effective ?? null);
      setSetting(db, 'rate_card_source', source);
    })();
    return card;
  };

  const rateCardRows = () =>
    db.prepare('SELECT market, iso, currency, marketing_rate AS rate, imported_at AS importedAt FROM rate_card').all() as {
      market: string; iso: string; currency: string; rate: number; importedAt: string;
    }[];

  const rateCardView = () => {
    const rows = rateCardRows();
    const s = getSettings(db);
    const currency = rows[0]?.currency ?? null;
    const referenced = new Set(Object.values(COUNTRY_MARKETS).flatMap((c) => c.markets));
    const inCard = new Set(rows.map((r) => r.market));
    return {
      loaded: rows.length > 0,
      title: s.rateCardTitle,
      effective: s.rateCardEffective,
      source: getSetting(db, 'rate_card_source'),
      importedAt: rows[0]?.importedAt ?? null,
      currency,
      wabaCurrency: s.wabaCurrency,
      currencyMatches: currency === null || currency === s.wabaCurrency,
      markets: rows.map((r) => ({ market: r.market, rate: r.rate, isos: r.iso ? r.iso.split(',') : [] })),
      // Markets in the card that no country maps to, and markets the map needs that the card lacks.
      unmappedMarkets: rows.filter((r) => !referenced.has(r.market)).map((r) => r.market),
      missingMarkets: [...referenced].filter((m) => !inCard.has(m) && rows.length > 0),
    };
  };

  app.get('/api/rate-card', (_req, res) => res.json(rateCardView()));

  app.get('/api/rate-card/local-files', (_req, res) => {
    let files: string[] = [];
    try {
      files = readdirSync(dataDir).filter((f) => /\.(csv|xlsx)$/i.test(f) && !/multipliers/i.test(f));
    } catch {
      /* no data dir */
    }
    res.json({ files });
  });

  app.post(
    '/api/rate-card/import-local',
    route((req, res) => {
      const file = basename(String(req.body?.file ?? ''));
      if (!/\.(csv|xlsx)$/i.test(file)) throw new HttpError(400, 'Pick a .csv or .xlsx file from data/');
      const card = importRateCard(readFileSync(join(dataDir, file)), file);
      res.json({ ...rateCardView(), warnings: card.warnings });
    }),
  );

  app.post(
    '/api/rate-card/upload',
    express.raw({ type: '*/*', limit: '10mb' }),
    route((req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Empty upload');
      const name = basename(String(req.query.name ?? 'upload'));
      const card = importRateCard(req.body, name);
      res.json({ ...rateCardView(), warnings: card.warnings });
    }),
  );

  // ---- max price ------------------------------------------------------------

  const selectedCountries = (): string[] | null => {
    const raw = getSetting(db, 'max_price_countries');
    return raw ? (JSON.parse(raw) as string[]) : null;
  };

  const currentCalc = (): CalculatorResult => {
    const rows = rateCardRows();
    if (rows.length === 0) return { ok: false, error: 'Import a rate card first (Rate card tab).' };
    return calculate({
      rateCard: rows.map((r) => ({ market: r.market, marketingRate: r.rate })),
      rateCardCurrency: rows[0].currency,
      wabaCurrency: getSettings(db).wabaCurrency,
      countries: selectedCountries() ?? undefined,
    });
  };

  const currentSpec = (): OptimizationSpecWrite => {
    const calc = currentCalc();
    if (!calc.ok) throw new HttpError(400, calc.error);
    return calc.spec;
  };

  const maxPriceView = () => ({ countries: selectedCountries(), result: currentCalc() });

  app.get('/api/max-price', (_req, res) => res.json(maxPriceView()));

  app.put(
    '/api/max-price',
    route((req, res) => {
      const countries = req.body?.countries;
      if (countries === null || countries === undefined) setSetting(db, 'max_price_countries', null);
      else if (Array.isArray(countries)) {
        const clean = [...new Set(countries.map((c: unknown) => String(c).toUpperCase()))].filter((c) => COUNTRY_MARKETS[c]);
        if (clean.length === 0) throw new HttpError(400, 'Pick at least one country, or switch to every country');
        setSetting(db, 'max_price_countries', JSON.stringify(clean.sort()));
      } else throw new HttpError(400, 'countries must be a list of ISO codes or null');
      res.json(maxPriceView());
    }),
  );

  app.get('/api/countries', (_req, res) =>
    res.json(Object.entries(COUNTRY_MARKETS).map(([iso, c]) => ({ iso, name: c.name })).sort((a, b) => a.name.localeCompare(b.name))),
  );

  app.get(
    '/api/max-price/reach',
    route(async (req, res) => {
      const countries = String(req.query.countries ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 25);
      const interval = String(req.query.interval ?? 'L7D') as ReachInterval;
      if (!['L1D', 'L7D', 'L14D', 'L28D'].includes(interval)) throw new HttpError(400, 'interval must be L1D, L7D, L14D or L28D');
      const c = client();
      const results = [];
      for (const iso of countries) {
        try {
          results.push({ iso, result: await c.reachEstimate([iso], interval) });
        } catch (e) {
          results.push({ iso, error: e instanceof D360Error ? { status: e.status, body: e.body } : { message: (e as Error).message } });
        }
      }
      res.json({ interval, results });
    }),
  );

  // ---- templates ------------------------------------------------------------

  const upsertTemplate = db.prepare(`
    INSERT INTO templates (id, name, language, status, category, components_json, optimization_spec_json, synced_at)
    VALUES (@id, @name, @language, @status, @category, @components_json, @optimization_spec_json, @synced_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, language = excluded.language, status = excluded.status, category = excluded.category,
      components_json = excluded.components_json, optimization_spec_json = excluded.optimization_spec_json,
      synced_at = excluded.synced_at
  `);

  async function syncTemplates(): Promise<Template[]> {
    const templates = await client().listTemplates();
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const t of templates) {
        upsertTemplate.run({
          id: t.id,
          name: t.name,
          language: t.language,
          status: t.status,
          category: t.category,
          components_json: JSON.stringify(t.components ?? []),
          optimization_spec_json: t.optimization_spec ? JSON.stringify(t.optimization_spec) : null,
          synced_at: now,
        });
      }
      // Drop templates deleted on the account. Keep ones created here in the
      // last 10 minutes: a fresh template can be missing from the list for a while.
      const ids = new Set(templates.map((t) => t.id));
      const graceStart = new Date(Date.now() - 10 * 60_000).toISOString();
      for (const { id, synced_at } of db.prepare('SELECT id, synced_at FROM templates').all() as { id: string; synced_at: string }[]) {
        if (!ids.has(id) && synced_at < graceStart) db.prepare('DELETE FROM templates WHERE id = ?').run(id);
      }
    })();
    setSetting(db, 'templates_synced_at', now);
    return templates;
  }

  interface TemplateRow {
    id: string; name: string; language: string; status: string; category: string;
    components_json: string | null; optimization_spec_json: string | null; arm: string | null; pair_id: string | null; synced_at: string;
  }

  const getTemplate = (id: string) => {
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
    if (!row) throw new HttpError(404, `Template ${id} not found. Sync templates first.`);
    return row;
  };

  const sameSpec = (a: OptimizationSpec | null, b: OptimizationSpecWrite) => {
    if (!a || a.bid_amount !== b.bid_amount) return false;
    const ao = a.bid_country_multiplier_overrides;
    const bo = b.bid_country_multiplier_overrides ?? {};
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    return [...keys].every((k) => ao[k] === bo[k]);
  };

  const templatesView = () => {
    const rows = db.prepare("SELECT * FROM templates WHERE category = 'MARKETING' ORDER BY name, language").all() as TemplateRow[];
    const calc = currentCalc();
    return {
      syncedAt: getSetting(db, 'templates_synced_at'),
      currentSpec: calc.ok ? calc.spec : null,
      currentSpecError: calc.ok ? null : calc.error,
      currency: getSettings(db).wabaCurrency,
      templates: rows.map((r) => {
        const spec = r.optimization_spec_json ? (JSON.parse(r.optimization_spec_json) as OptimizationSpec) : null;
        const components = (r.components_json ? JSON.parse(r.components_json) : []) as TemplateComponent[];
        return {
          id: r.id,
          name: r.name,
          language: r.language,
          status: r.status,
          category: r.category,
          arm: r.arm,
          pairId: r.pair_id,
          body: components.find((c) => c.type?.toUpperCase() === 'BODY')?.text ?? '',
          components,
          maxPrice: spec,
          matchesCurrentSpec: calc.ok ? sameSpec(spec, calc.spec) : false,
        };
      }),
    };
  };

  app.get('/api/templates', (_req, res) => res.json(templatesView()));

  app.post(
    '/api/templates/sync',
    route(async (_req, res) => {
      await syncTemplates();
      res.json(templatesView());
    }),
  );

  const afterChange = async () => {
    try {
      await syncTemplates();
    } catch {
      /* the change itself succeeded; the list refreshes on the next sync */
    }
  };

  // Create a new marketing template, with or without the current max price.
  app.post(
    '/api/templates',
    route(async (req, res) => {
      const { name, language, headerText, bodyText, bodyExamples, footerText, withMaxPrice } = req.body ?? {};
      if (!/^[a-z0-9_]{1,512}$/.test(String(name ?? ''))) throw new HttpError(400, 'Name: lowercase letters, numbers and underscores only');
      if (!String(bodyText ?? '').trim()) throw new HttpError(400, 'Body text is required');
      const vars = [...String(bodyText).matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      const examples: string[] = Array.isArray(bodyExamples) ? bodyExamples.map(String) : [];
      const nVars = vars.length ? Math.max(...vars) : 0;
      if (examples.length < nVars) throw new HttpError(400, `Add an example value for each of the ${nVars} variables`);

      const components: TemplateComponent[] = [];
      if (String(headerText ?? '').trim()) components.push({ type: 'HEADER', format: 'TEXT', text: String(headerText).trim() });
      components.push({
        type: 'BODY',
        text: String(bodyText).trim(),
        ...(nVars ? { example: { body_text: [examples.slice(0, nVars)] } } : {}),
      });
      if (String(footerText ?? '').trim()) components.push({ type: 'FOOTER', text: String(footerText).trim() });

      const created = await client().createTemplate({
        name,
        language: String(language || 'en_US'),
        category: 'MARKETING',
        components,
        ...(withMaxPrice ? { optimization_spec: currentSpec() } : {}),
      });
      await afterChange();
      res.json({ ok: true, created, note: 'New templates go to Meta review before they can be sent.' });
    }),
  );

  app.post(
    '/api/templates/:id/max-price',
    route(async (req, res) => {
      const t = getTemplate(String(req.params.id));
      const spec = currentSpec();
      const result = await client().setMaxPrice(t.id, spec);
      await afterChange();
      res.json({ ok: true, result, spec, note: PROPAGATION_NOTE });
    }),
  );

  app.post(
    '/api/templates/:id/reset',
    route(async (req, res) => {
      const t = getTemplate(String(req.params.id));
      const result = await client().resetToRateCard(t.id);
      await afterChange();
      res.json({ ok: true, result, note: `Back to rate card; country overrides cleared. ${PROPAGATION_NOTE}` });
    }),
  );

  // A/B pair: arm A = the source on rate card, arm B = a copy with the current max price.
  app.post(
    '/api/templates/:id/ab-pair',
    route(async (req, res) => {
      const source = getTemplate(String(req.params.id));
      if (source.optimization_spec_json) {
        throw new HttpError(409, `Arm A must be on rate card, but "${source.name}" has a max price. Reset it to rate card first, or pick another template.`);
      }
      const name = String(req.body?.name ?? `${source.name}_maxprice`);
      if (!/^[a-z0-9_]{1,512}$/.test(name)) throw new HttpError(400, 'Name: lowercase letters, numbers and underscores only');
      const spec = currentSpec();
      const c = client();

      let created;
      let method: 'duplicate' | 'create';
      let duplicateError: unknown = null;
      try {
        created = await c.duplicateTemplate({ source_template_id: source.id, name, optimization_spec: spec });
        method = 'duplicate';
      } catch (e) {
        if (!shouldFallBackFromDuplicate(e)) throw e;
        duplicateError = e instanceof D360Error ? { status: e.status, body: e.body } : String(e);
        created = await c.createTemplate({
          name,
          language: source.language,
          category: 'MARKETING',
          components: JSON.parse(source.components_json ?? '[]'),
          optimization_spec: spec,
        });
        method = 'create';
      }

      const pairId = randomUUID();
      db.transaction(() => {
        db.prepare("UPDATE templates SET arm = 'A', pair_id = ? WHERE id = ?").run(pairId, source.id);
        db.prepare(`
          INSERT INTO templates (id, name, language, status, category, components_json, optimization_spec_json, arm, pair_id, synced_at)
          VALUES (?, ?, ?, ?, 'MARKETING', ?, ?, 'B', ?, ?)
          ON CONFLICT(id) DO UPDATE SET arm = 'B', pair_id = excluded.pair_id
        `).run(created.id, name, source.language, created.status ?? (method === 'duplicate' ? 'APPROVED' : 'PENDING'),
          source.components_json, JSON.stringify(spec), pairId, new Date().toISOString());
      })();
      await afterChange();

      res.json({
        ok: true,
        method,
        pairId,
        armA: { id: source.id, name: source.name },
        armB: { id: created.id, name, status: created.status },
        duplicateError,
        note:
          method === 'duplicate'
            ? `Copied with source_template_id: arm B is approved and ready to send. ${PROPAGATION_NOTE}`
            : 'The gateway did not accept source_template_id, so arm B was created as a new template with the same content. It needs Meta approval before you can send it.',
      });
    }),
  );

  app.delete(
    '/api/templates/pairs/:pairId',
    route((req, res) => {
      db.prepare('UPDATE templates SET arm = NULL, pair_id = NULL WHERE pair_id = ?').run(String(req.params.pairId));
      res.json(templatesView());
    }),
  );

  // ---- send -----------------------------------------------------------------

  /** Rate card price per country (cheapest market), for estimates and results. */
  const ratesByCountry = (): Map<string, number> => {
    const rows = rateCardRows();
    const m = new Map<string, number>();
    if (rows.length === 0) return m;
    const calc = calculate({
      rateCard: rows.map((r) => ({ market: r.market, marketingRate: r.rate })),
      rateCardCurrency: rows[0].currency,
      wabaCurrency: rows[0].currency,
    });
    if (calc.ok) for (const r of calc.rows) if (r.rate !== null) m.set(r.iso, r.rate);
    return m;
  };

  const templateInfo = (r: TemplateRow): TemplateInfo => ({
    id: r.id,
    name: r.name,
    language: r.language,
    status: r.status,
    hasMaxPrice: Boolean(r.optimization_spec_json),
    components: JSON.parse(r.components_json ?? '[]'),
  });

  app.get('/api/send/targets', (_req, res) => {
    const rows = db.prepare("SELECT * FROM templates WHERE category = 'MARKETING' ORDER BY name, language").all() as TemplateRow[];
    const pairs = new Map<string, { A?: TemplateInfo; B?: TemplateInfo }>();
    for (const r of rows) if (r.pair_id && r.arm) pairs.set(r.pair_id, { ...pairs.get(r.pair_id), [r.arm]: templateInfo(r) });
    const describe = (t: TemplateInfo) => ({ ...t, vars: templateVariables(t.components), body: t.components.find((c) => c.type?.toUpperCase() === 'BODY')?.text ?? '' });
    res.json({
      templates: rows.map((r) => describe(templateInfo(r))),
      pairs: [...pairs.entries()].filter(([, p]) => p.A && p.B).map(([pairId, p]) => ({ pairId, A: describe(p.A!), B: describe(p.B!) })),
      sendRatePerSecond: getSettings(db).sendRatePerSecond,
    });
  });

  const planView = (plan: SendPlan) => {
    const rates = ratesByCountry();
    const sendable = plan.recipients.filter((r) => r.canSend);
    const byArm = { A: sendable.filter((r) => r.arm === 'A').length, B: sendable.filter((r) => r.arm === 'B').length };
    const estimate = sendable.reduce((s, r) => s + (rates.get(r.country ?? '') ?? 0), 0);
    const payloads = payloadsFor(plan);
    return {
      planId: plan.id,
      kind: plan.kind,
      arms: Object.fromEntries(Object.entries(plan.arms).map(([k, t]) => [k, { id: t!.id, name: t!.name, status: t!.status, hasMaxPrice: t!.hasMaxPrice }])),
      template: plan.template ? { id: plan.template.id, name: plan.template.name, status: plan.template.status, hasMaxPrice: plan.template.hasMaxPrice } : null,
      recipients: plan.recipients.map(({ to: _to, ...r }) => ({ ...r, rate: r.country ? (rates.get(r.country) ?? null) : null })),
      counts: { lines: plan.recipients.length, sendable: sendable.length, skipped: plan.recipients.length - sendable.length, ...byArm },
      estimatedRateCardCost: estimate,
      currency: rateCardRows()[0]?.currency ?? null,
      samplePayload: payloads[0] ? maskedPayload(payloads[0].payload, payloads[0].recipient.masked) : null,
      ratePerSecond: getSettings(db).sendRatePerSecond,
    };
  };

  app.post(
    '/api/send/preview',
    route((req, res) => {
      const { templateId, pairId, numbers, values, perMessageMultiplier } = req.body ?? {};
      const mult = perMessageMultiplier === null || perMessageMultiplier === undefined || perMessageMultiplier === '' ? null : Number(perMessageMultiplier);
      if (mult !== null && !(Number.isFinite(mult) && mult > 0 && mult <= 10)) throw new HttpError(400, 'Per-message multiplier must be above 0 and at most 10');
      if (!String(numbers ?? '').trim()) throw new HttpError(400, 'Paste at least one phone number');
      let plan: SendPlan;
      if (pairId) {
        const arms = db.prepare('SELECT * FROM templates WHERE pair_id = ?').all(String(pairId)) as TemplateRow[];
        const A = arms.find((r) => r.arm === 'A');
        const B = arms.find((r) => r.arm === 'B');
        if (!A || !B) throw new HttpError(404, 'A/B pair not found. Sync templates and try again.');
        plan = createPlan({ kind: 'pair', pairId: String(pairId), arms: { A: templateInfo(A), B: templateInfo(B) }, template: null, numbers, values: Array.isArray(values) ? values.map(String) : [], perMessageMultiplier: mult });
      } else {
        const t = getTemplate(String(templateId ?? ''));
        plan = createPlan({ kind: 'template', pairId: null, arms: {}, template: templateInfo(t), numbers, values: Array.isArray(values) ? values.map(String) : [], perMessageMultiplier: mult });
      }
      const needed = plan.vars.header.length + plan.vars.body.length;
      if (plan.values.filter((v) => v.trim()).length < needed && plan.recipients.some((r) => r.canSend && r.vars.length < needed)) {
        throw new HttpError(400, `This template has ${needed} variable${needed === 1 ? '' : 's'}: fill them in, or add values after each number`);
      }
      res.json(planView(plan));
    }),
  );

  app.post(
    '/api/send/:planId',
    route((req, res) => {
      const plan = getPlan(String(req.params.planId));
      if (!plan) throw new HttpError(404, 'This check has expired or was already sent. Check the numbers again.');
      if (req.body?.dryRun) {
        const payloads = payloadsFor(plan).map((p) => ({
          masked: p.recipient.masked,
          country: p.recipient.country,
          arm: p.recipient.arm ?? null,
          template: p.template.name,
          payload: maskedPayload(p.payload, p.recipient.masked),
        }));
        return res.json({ dryRun: true, count: payloads.length, payloads });
      }
      const templates = plan.kind === 'pair' ? Object.values(plan.arms) : [plan.template!];
      const notReady = templates.filter((t) => t!.status !== 'APPROVED');
      if (notReady.length) throw new HttpError(409, `Not approved yet: ${notReady.map((t) => `${t!.name} (${t!.status})`).join(', ')}. Use dry run until Meta approves it.`);
      const job = startJob(db, client(), plan, getSettings(db).sendRatePerSecond);
      res.json({ dryRun: false, job });
    }),
  );

  app.get(
    '/api/send/jobs/:id',
    route((req, res) => {
      const job = getJob(String(req.params.id));
      if (!job) throw new HttpError(404, 'Job not found');
      res.json(job);
    }),
  );

  // ---- results ----------------------------------------------------------------

  /** target: "all", "p:<pairId>" or "t:<templateId>" */
  const targetTemplateIds = (target: string): string[] | undefined => {
    if (target.startsWith('p:')) return (db.prepare('SELECT id FROM templates WHERE pair_id = ?').all(target.slice(2)) as { id: string }[]).map((r) => r.id);
    if (target.startsWith('t:')) return [target.slice(2)];
    return undefined;
  };

  const resultRows = (target: string): MessageResult[] =>
    messageResults(db, ratesByCountry(), rateCardRows()[0]?.currency ?? null, { templateIds: targetTemplateIds(target) });

  /** The latest status webhooks, newest first, with what each message was compared against. */
  const recentStatuses = (target: string, rates: Map<string, number>, limit = 12) => {
    const ids = targetTemplateIds(target);
    const keep = ids ? new Set(ids) : null;
    const rows = db
      .prepare(
        `SELECT s.status, s.category, s.cost_amount, s.cost_currency, s.error_code, s.ts,
                m.wamid, m.to_masked, m.country, m.arm, m.template_id, m.template_name
         FROM statuses s JOIN messages m ON m.wamid = s.wamid
         ORDER BY s.rowid DESC LIMIT 400`,
      )
      .all() as {
      status: string; category: string | null; cost_amount: number | null; cost_currency: string | null; error_code: number | null; ts: number | null;
      wamid: string; to_masked: string; country: string | null; arm: string | null; template_id: string; template_name: string;
    }[];
    return rows
      .filter((r) => !keep || keep.has(r.template_id))
      .slice(0, limit)
      .map((r) => {
        const rate = r.country ? (rates.get(r.country) ?? null) : null;
        return {
          id: `${r.wamid}|${r.status}`,
          status: r.status,
          category: r.category,
          cost: r.cost_amount,
          costCurrency: r.cost_currency,
          rate,
          saving: r.cost_amount !== null && rate ? (rate - r.cost_amount) / rate : null,
          errorCode: r.error_code,
          ts: r.ts,
          toMasked: r.to_masked,
          country: r.country,
          arm: r.arm,
          templateName: r.template_name,
        };
      });
  };

  app.get('/api/results', (req, res) => {
    const target = String(req.query.target ?? 'all');
    const rows = resultRows(target);
    const pairs = db.prepare("SELECT pair_id, arm, name FROM templates WHERE pair_id IS NOT NULL ORDER BY arm").all() as { pair_id: string; arm: string; name: string }[];
    const pairOptions = new Map<string, string[]>();
    for (const p of pairs) pairOptions.set(p.pair_id, [...(pairOptions.get(p.pair_id) ?? []), p.name]);
    const sentTemplates = db.prepare('SELECT DISTINCT template_id AS id, template_name AS name FROM messages ORDER BY template_name').all() as { id: string; name: string }[];
    const armLabel = (r: MessageResult) => (r.arm ? `${r.templateName} · arm ${r.arm}` : r.templateName);
    // The pair the latest send went to: what Results opens on.
    const latestPair = db
      .prepare('SELECT t.pair_id AS p FROM messages m JOIN templates t ON t.id = m.template_id WHERE t.pair_id IS NOT NULL ORDER BY m.sent_at DESC LIMIT 1')
      .get() as { p: string } | undefined;
    res.json({
      target,
      defaultTarget: latestPair ? `p:${latestPair.p}` : 'all',
      recent: recentStatuses(target, ratesByCountry()),
      options: [
        ...[...pairOptions.entries()].map(([id, names]) => ({ value: `p:${id}`, label: `A/B: ${names.join(' vs ')}` })),
        ...sentTemplates.map((t) => ({ value: `t:${t.id}`, label: t.name })),
      ],
      currency: rateCardRows()[0]?.currency ?? null,
      overall: totals(rows, () => 'all', () => 'All')[0] ?? null,
      byArm: target.startsWith('p:') ? totals(rows.filter((r) => r.arm), (r) => r.arm!, armLabel).sort((a, b) => a.key.localeCompare(b.key)) : [],
      byTemplate: totals(rows, (r) => `${r.templateId}|${r.arm ?? ''}`, armLabel),
      byCountry: totals(rows, (r) => r.country ?? '?', (r) => (r.countryName ? `${r.countryName} (${r.country})` : 'Unknown')),
      messages: rows.slice(0, 500),
      messageCount: rows.length,
      lastWebhookAt: (db.prepare('SELECT MAX(received_at) AS t FROM webhook_log').get() as { t: string | null }).t,
    });
  });

  app.get('/api/results.csv', (req, res) => {
    const rows = resultRows(String(req.query.target ?? 'all'));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="max-price-results-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(rows));
  });

  app.delete('/api/results', (_req, res) => {
    db.transaction(() => {
      db.prepare('DELETE FROM messages').run();
      db.prepare('DELETE FROM statuses').run();
    })();
    res.json({ ok: true });
  });

  app.get('/api/webhook-log', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const rows = (
      q
        ? db.prepare('SELECT * FROM webhook_log WHERE body LIKE ? ORDER BY id DESC LIMIT ?').all(`%${q}%`, limit)
        : db.prepare('SELECT * FROM webhook_log ORDER BY id DESC LIMIT ?').all(limit)
    ) as { id: number; received_at: string; body: string }[];
    const total = (db.prepare('SELECT COUNT(*) AS n FROM webhook_log').get() as { n: number }).n;
    res.json({
      total,
      entries: rows.map((r) => {
        const body = JSON.parse(r.body);
        return { id: r.id, receivedAt: r.received_at, body, statuses: parseStatuses(body).map((s) => ({ wamid: s.wamid, status: s.status, cost: s.costAmount, currency: s.costCurrency, category: s.category })) };
      }),
    });
  });

  // ---- errors: surface the API's own body ---------------------------------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof D360Error) {
      return res.status(502).json({ error: err.message, api: { method: err.method, path: err.path, status: err.status, body: err.body } });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err instanceof Error ? err.message : err);
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  });

  return app;
}
