export interface ApiErrorDetail {
  method?: string;
  path?: string;
  status?: number;
  body?: unknown;
}

/** Error from our server; `api` holds the API's own response when 360dialog or Meta refused. */
export class ApiError extends Error {
  constructor(message: string, public readonly api?: ApiErrorDetail) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, raw?: { data: Blob | ArrayBuffer; type?: string }): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: raw ? { 'Content-Type': raw.type || 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: raw ? raw.data : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; api?: ApiErrorDetail };
    throw new ApiError(d.error ?? `${method} ${path} failed (${res.status})`, d.api);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, file: File) => request<T>('POST', path, undefined, { data: file, type: 'application/octet-stream' }),
};

// ---- response types -----------------------------------------------------------

export type Provider = '360dialog' | 'meta';

export interface SettingsView {
  provider: Provider;
  providerLabel: string;
  /** Credentials for the selected provider are complete. */
  configured: boolean;
  missing: string | null;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  hasMetaAccessToken: boolean;
  metaAccessTokenMasked: string | null;
  metaWabaId: string;
  metaPhoneNumberId: string;
  metaApiVersion: string;
  metaVerifyToken: string;
  wabaCurrency: string;
  webhookUrl: string;
  sendRatePerSecond: number;
  currencies: string[];
}

export interface RateCardView {
  loaded: boolean;
  title: string | null;
  effective: string | null;
  source: string | null;
  importedAt: string | null;
  currency: string | null;
  wabaCurrency: string;
  currencyMatches: boolean;
  markets: { market: string; rate: number; isos: string[] }[];
  unmappedMarkets: string[];
  missingMarkets: string[];
  warnings?: string[];
}

export interface Spec {
  bid_strategy: string;
  bid_amount: number;
  bid_country_multiplier_overrides: Record<string, number>;
}

export interface CountryRow {
  iso: string;
  name: string;
  market: string | null;
  rate: number | null;
  status: 'eligible' | 'flagged' | 'no_max_price' | 'blocked' | 'not_delivered' | 'unmapped';
  multiplier: number | null;
  inMap: boolean;
  capPerDelivery: number | null;
  capVsRate: number | null;
  notes: string[];
}

export type CalcResult =
  | {
      ok: true;
      currency: string;
      minorUnits: number;
      baseMarket: string;
      baseRate: number;
      bidAmount: number;
      bidAmountWorking: string;
      rows: CountryRow[];
      spec: Spec;
      sharedCallingCode: string[];
      warnings: string[];
    }
  | { ok: false; error: string };

export interface MaxPriceView {
  countries: string[] | null;
  result: CalcResult;
}

export interface TemplateView {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  arm: 'A' | 'B' | null;
  pairId: string | null;
  body: string;
  maxPrice: Spec | null;
  matchesCurrentSpec: boolean;
}

export interface TemplatesView {
  syncedAt: string | null;
  currentSpec: Spec | null;
  currentSpecError: string | null;
  currency: string;
  templates: TemplateView[];
}
