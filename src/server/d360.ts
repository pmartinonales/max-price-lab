// Every API call lives here, for either provider:
// - 360dialog: https://waba-v2.360dialog.io, D360-API-KEY header (raw key).
// - Meta Cloud API: https://graph.facebook.com/<version>, Authorization: Bearer <token>.
// Meta's docs are the source of truth for max price rules.

export const D360_BASE_URL = process.env.D360_BASE_URL ?? 'https://waba-v2.360dialog.io';
export const BID_STRATEGY = 'LOWEST_COST_WITH_BID_CAP' as const;

// ---- types ----------------------------------------------------------------

/** What we send. Overrides: omit = keep current map, {} = clear, map = replace. */
export interface OptimizationSpecWrite {
  bid_strategy: typeof BID_STRATEGY;
  bid_amount: number;
  bid_country_multiplier_overrides?: Record<string, number>;
}

/** Reset to rate card: both null, nothing else (Meta). */
export interface OptimizationSpecReset {
  bid_strategy: null;
  bid_amount: null;
}

/** What we store and show: overrides always as a map. */
export interface OptimizationSpec {
  bid_strategy: string;
  bid_amount: number;
  bid_country_multiplier_overrides: Record<string, number>;
}

export interface TemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: unknown[];
  example?: unknown;
  [k: string]: unknown;
}

/** Template as the API returns it (optimization_spec overrides come back as a list). */
export interface ApiTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components?: TemplateComponent[];
  optimization_spec?: {
    bid_strategy?: string | null;
    bid_amount?: number | string | null;
    bid_country_multiplier_overrides?: { key: string; value: number }[] | Record<string, number> | null;
  } | null;
}

export interface Template extends Omit<ApiTemplate, 'optimization_spec'> {
  optimization_spec: OptimizationSpec | null;
}

export interface CreateTemplateRequest {
  name: string;
  language: string;
  category: 'MARKETING';
  components: TemplateComponent[];
  optimization_spec?: OptimizationSpecWrite;
}

export interface DuplicateTemplateRequest {
  source_template_id: string;
  name: string;
  optimization_spec: OptimizationSpecWrite;
}

export interface CreateTemplateResponse {
  id: string;
  status?: string;
  category?: string;
}

export interface SendMarketingRequest {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: 'template';
  template: {
    name: string;
    language: { code: string };
    components?: unknown[];
  };
  bid_spec?: { per_message_bid_multiplier: number };
}

export interface SendMarketingResponse {
  messaging_product?: string;
  contacts?: { input: string; wa_id?: string; user_id?: string }[];
  messages?: { id: string; message_status?: string }[];
}

export type ReachInterval = 'L1D' | 'L7D' | 'L14D' | 'L28D';

// ---- errors ---------------------------------------------------------------

/** Carries the API's own error body so the UI can show it as-is. */
export class D360Error extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`${method} ${path} failed with ${status}: ${summarise(body)}`);
  }
}

function summarise(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 300);
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const err = b.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      const parts = [e.message, e.error_user_title, e.error_user_msg, e.code ? `code ${e.code}` : null].filter(Boolean);
      if (parts.length) return parts.join(' · ');
    }
    if (Array.isArray(b.meta) || b.meta) return JSON.stringify(b.meta).slice(0, 300);
  }
  return JSON.stringify(body).slice(0, 300);
}

// ---- normalisation ----------------------------------------------------------

/** API -> stored shape. Overrides list [{key, value}] becomes a map. Null when on rate card. */
export function normaliseSpec(spec: ApiTemplate['optimization_spec']): OptimizationSpec | null {
  if (!spec || spec.bid_amount === null || spec.bid_amount === undefined || spec.bid_amount === '') return null;
  const raw = spec.bid_country_multiplier_overrides;
  const overrides: Record<string, number> = {};
  if (Array.isArray(raw)) {
    for (const { key, value } of raw) overrides[String(key).toUpperCase()] = Number(value);
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) overrides[k.toUpperCase()] = Number(v);
  }
  return {
    bid_strategy: spec.bid_strategy ?? BID_STRATEGY,
    bid_amount: Number(spec.bid_amount),
    bid_country_multiplier_overrides: overrides,
  };
}

export function normaliseTemplate(t: ApiTemplate): Template {
  return { ...t, optimization_spec: normaliseSpec(t.optimization_spec) };
}

/**
 * Should a failed duplicate fall back to a plain create with copied content?
 * Yes on 400/404/422 (the gateway didn't accept source_template_id), except a
 * name clash, which a plain create would hit too. Auth (401) and enrollment
 * (403) errors are shown as-is. The caller always reports the original error.
 */
export function shouldFallBackFromDuplicate(err: unknown): boolean {
  if (!(err instanceof D360Error)) return false;
  if (![400, 404, 422].includes(err.status)) return false;
  const text = JSON.stringify(err.body).toLowerCase();
  return !/already exists|name.{0,20}(taken|in use|exists)/.test(text);
}

// ---- providers --------------------------------------------------------------
// The same calls go to 360dialog or straight to Meta's Cloud API. Only the base URL,
// the auth header and the path prefixes differ; bodies and responses are Meta's.

export type Provider = '360dialog' | 'meta';
export const PROVIDER_LABEL: Record<Provider, string> = { '360dialog': '360dialog', meta: 'Meta Cloud API' };

export const META_GRAPH_URL = process.env.META_GRAPH_URL ?? 'https://graph.facebook.com';
export const META_DEFAULT_API_VERSION = 'v27.0';

export type ProviderAuth =
  | { provider: '360dialog'; apiKey: string }
  | { provider: 'meta'; accessToken: string; wabaId: string; phoneNumberId: string; apiVersion?: string };

interface Routes {
  templates: string;
  template: (id: string) => string;
  marketingMessages: string;
  reachEstimate: string;
}

function routesFor(auth: ProviderAuth): Routes {
  if (auth.provider === 'meta') {
    const waba = encodeURIComponent(auth.wabaId);
    return {
      templates: `/${waba}/message_templates`,
      template: (id) => `/${encodeURIComponent(id)}`,
      marketingMessages: `/${encodeURIComponent(auth.phoneNumberId)}/marketing_messages`,
      reachEstimate: `/${waba}/reachestimate`,
    };
  }
  return {
    templates: '/message_templates',
    template: (id) => `/message_templates/${encodeURIComponent(id)}`,
    marketingMessages: '/marketing_messages',
    reachEstimate: '/marketing/reachestimate',
  };
}

/** What's missing before this provider can be called, or null when complete. */
export function missingAuth(auth: Partial<ProviderAuth> & { provider: Provider }): string | null {
  if (auth.provider === 'meta') {
    const a = auth as Partial<Extract<ProviderAuth, { provider: 'meta' }>>;
    const missing = [!a.accessToken && 'access token', !a.wabaId && 'WABA ID', !a.phoneNumberId && 'phone number ID'].filter(Boolean);
    return missing.length ? `Meta Cloud API needs: ${missing.join(', ')}. Add them in Settings.` : null;
  }
  return (auth as { apiKey?: string }).apiKey ? null : 'No 360dialog API key saved. Add it in Settings.';
}

// ---- client ---------------------------------------------------------------

export type D360ClientOptions = (ProviderAuth | { apiKey: string; provider?: undefined }) & {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

/** Client for 360dialog or Meta's Cloud API (named after the first; kept for compatibility). */
export class D360Client {
  readonly provider: Provider;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader: Record<string, string>;
  private readonly routes: Routes;
  private readonly auth: ProviderAuth;

  constructor(opts: D360ClientOptions) {
    const auth: ProviderAuth = opts.provider === 'meta' ? opts : { provider: '360dialog', apiKey: (opts as { apiKey: string }).apiKey };
    const missing = missingAuth(auth);
    if (missing) throw new Error(missing);
    this.auth = auth;
    this.provider = auth.provider;
    this.routes = routesFor(auth);
    if (auth.provider === 'meta') {
      const version = (auth.apiVersion || META_DEFAULT_API_VERSION).replace(/^v?/, 'v');
      this.baseUrl = (opts.baseUrl ?? `${META_GRAPH_URL}/${version}`).replace(/\/$/, '');
      this.authHeader = { Authorization: `Bearer ${auth.accessToken}` };
    } else {
      this.baseUrl = (opts.baseUrl ?? D360_BASE_URL).replace(/\/$/, '');
      this.authHeader = { 'D360-API-KEY': auth.apiKey };
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: { ...this.authHeader, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    if (!res.ok) throw new D360Error(method, path.split('?')[0], res.status, parsed);
    return parsed as T;
  }

  /** All templates, following cursor pagination. */
  async listTemplates(): Promise<Template[]> {
    try {
      return await this.listTemplatesWith('id,name,language,status,category,components,optimization_spec');
    } catch (e) {
      // Meta documents optimization_spec on the single-template GET only. If the list
      // rejects the field, list without it; the per-template reads below fill it in.
      if (this.provider === 'meta' && e instanceof D360Error && e.status === 400) {
        return this.listTemplatesWith('id,name,language,status,category,components');
      }
      throw e;
    }
  }

  private async listTemplatesWith(fields: string): Promise<Template[]> {
    const raw: ApiTemplate[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const qs = new URLSearchParams({ fields, limit: '100' });
      if (after) qs.set('after', after);
      const res = await this.request<{
        data?: ApiTemplate[];
        waba_templates?: ApiTemplate[];
        paging?: { cursors?: { after?: string }; next?: string };
      }>('GET', `${this.routes.templates}?${qs}`);
      const items = res.data ?? res.waba_templates ?? [];
      raw.push(...items);
      after = res.paging?.next ? res.paging.cursors?.after : undefined;
      if (!after || items.length === 0) break;
    }
    // Meta documents optimization_spec on the single-template GET only. If the list
    // left it out everywhere, read it per approved marketing template.
    if (this.provider === 'meta' && !raw.some((t) => 'optimization_spec' in t)) {
      const need = raw.filter((t) => t.category === 'MARKETING' && t.status === 'APPROVED');
      for (let i = 0; i < need.length; i += 10) {
        await Promise.all(
          need.slice(i, i + 10).map(async (t) => {
            const r = await this.request<{ optimization_spec?: ApiTemplate['optimization_spec'] }>(
              'GET',
              `${this.routes.template(t.id)}?fields=optimization_spec`,
            );
            t.optimization_spec = r.optimization_spec ?? null;
          }),
        );
      }
    }
    return raw.map(normaliseTemplate);
  }

  /** Cheap credentials check. Meta: the phone number's name; 360dialog: nothing extra. */
  async phoneNumber(): Promise<{ display_phone_number?: string; verified_name?: string } | null> {
    if (this.auth.provider !== 'meta') return null;
    return this.request('GET', `/${encodeURIComponent(this.auth.phoneNumberId)}?fields=display_phone_number,verified_name`);
  }

  createTemplate(req: CreateTemplateRequest) {
    return this.request<CreateTemplateResponse>('POST', this.routes.templates, req);
  }

  /** Set or change max price on an approved template; no re-review. */
  setMaxPrice(templateId: string, spec: OptimizationSpecWrite) {
    return this.request<{ success?: boolean }>('POST', this.routes.template(templateId), { optimization_spec: spec });
  }

  /** Back to rate card. Also clears the country overrides (Meta). */
  resetToRateCard(templateId: string) {
    const reset: OptimizationSpecReset = { bid_strategy: null, bid_amount: null };
    return this.request<{ success?: boolean }>('POST', this.routes.template(templateId), { optimization_spec: reset });
  }

  /** Meta's duplicate-template call (source_template_id). */
  duplicateTemplate(req: DuplicateTemplateRequest) {
    return this.request<CreateTemplateResponse>('POST', this.routes.templates, req);
  }

  /** Send to /marketing_messages: /messages rejects max price templates with 131061. */
  sendMarketing(req: SendMarketingRequest) {
    return this.request<SendMarketingResponse>('POST', this.routes.marketingMessages, req);
  }

  /**
   * Point status webhooks at `url`.
   * 360dialog: the channel's webhook. Meta: a callback override for this WABA on the
   * app that owns the token; Meta checks it with a GET carrying `verifyToken` first.
   */
  setWebhook(url: string, verifyToken?: string) {
    if (this.auth.provider === 'meta') {
      return this.request<{ success?: boolean }>('POST', `/${encodeURIComponent(this.auth.wabaId)}/subscribed_apps`, {
        override_callback_uri: url,
        verify_token: verifyToken,
      });
    }
    return this.request<{ url?: string }>('POST', '/v1/configs/webhook', { url });
  }

  reachEstimate(countries: string[], interval: ReachInterval = 'L7D') {
    const qs = new URLSearchParams({
      targeting_spec: JSON.stringify({ geo_locations: { countries } }),
      date_interval: interval,
    });
    return this.request<unknown>('GET', `${this.routes.reachEstimate}?${qs}`);
  }
}
