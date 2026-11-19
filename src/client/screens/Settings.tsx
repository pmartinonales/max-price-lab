import { useEffect, useState } from 'react';
import { api, type Provider, type SettingsView } from '../api';
import { CopyButton, ErrorBox, Notice, Stat, useAction } from '../ui';

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: '360dialog', label: '360dialog' },
  { id: 'meta', label: 'Meta Cloud API' },
];

export function SettingsScreen() {
  const [s, setS] = useState<SettingsView | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [metaToken, setMetaToken] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [apiVersion, setApiVersion] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [rate, setRate] = useState('10');
  const [notice, setNotice] = useState<string | null>(null);
  const [test, setTest] = useState<{
    total: number;
    marketing: number;
    names: string[];
    phone: { display_phone_number?: string; verified_name?: string } | null;
  } | null>(null);
  const { busy, error, setError, run } = useAction();

  const load = (v: SettingsView) => {
    setS(v);
    setCurrency(v.wabaCurrency);
    setWebhookUrl(v.webhookUrl);
    setRate(String(v.sendRatePerSecond));
    setWabaId(v.metaWabaId);
    setPhoneNumberId(v.metaPhoneNumberId);
    setApiVersion(v.metaApiVersion);
  };

  useEffect(() => {
    run('load', () => api.get<SettingsView>('/api/settings').then(load));
  }, []);

  const switchProvider = (provider: Provider) =>
    run('provider', async () => {
      load(await api.put<SettingsView>('/api/settings', { provider }));
      setTest(null);
      setNotice(null);
    });

  const save = () =>
    run('save', async () => {
      const v = await api.put<SettingsView>('/api/settings', {
        ...(s?.provider === 'meta'
          ? {
              ...(metaToken.trim() ? { metaAccessToken: metaToken.trim() } : {}),
              metaWabaId: wabaId,
              metaPhoneNumberId: phoneNumberId,
              metaApiVersion: apiVersion,
            }
          : apiKey.trim()
            ? { apiKey: apiKey.trim() }
            : {}),
        wabaCurrency: currency,
        webhookUrl,
        sendRatePerSecond: Number(rate),
      });
      load(v);
      setApiKey('');
      setMetaToken('');
      setNotice('Settings saved.');
    });

  // A full webhook path: if the user pasted only the tunnel origin, add /webhook.
  const normalisedWebhook = () => {
    const u = webhookUrl.trim().replace(/\/$/, '');
    return u && !/\/webhook$/.test(u) ? `${u}/webhook` : u;
  };

  const register = () =>
    run('webhook', async () => {
      const url = normalisedWebhook();
      if (url !== webhookUrl) setWebhookUrl(url);
      load(await api.put<SettingsView>('/api/settings', { webhookUrl: url }));
      await api.post('/api/settings/register-webhook');
      setNotice(`Webhook registered: ${url}`);
    });

  const testConnection = () =>
    run('test', async () => {
      setTest(await api.post('/api/settings/test'));
    });

  if (!s) return <ErrorBox error={error} />;
  const meta = s.provider === 'meta';

  return (
    <>
      <h1>Settings</h1>
      <p className="lede">
        Connect through 360dialog or straight to Meta's Cloud API. Credentials stay on this machine, in the local database. Everything else in the app
        works the same with either.
      </p>

      <ErrorBox error={error} onClose={() => setError(null)} />
      {notice && (
        <Notice kind="ok" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      )}

      <label className="field">
        <span>Provider</span>
        <select
          value={s.provider}
          onChange={(e) => switchProvider(e.target.value as Provider)}
          disabled={busy !== null}
          style={{ maxWidth: 260 }}
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <small>Each provider keeps its own saved credentials, so you can switch back and forth.</small>
      </label>

      <div className="grid2">
        <section>
          <h2>{s.providerLabel}</h2>
          {meta ? (
            <>
              <label className="field">
                <span>Access token</span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={s.hasMetaAccessToken ? `Saved: ${s.metaAccessTokenMasked}  (type to replace)` : 'System user access token'}
                  value={metaToken}
                  onChange={(e) => setMetaToken(e.target.value)}
                />
                <small>
                  {s.hasMetaAccessToken ? `Saved token: ${s.metaAccessTokenMasked}. ` : 'No token saved yet. '}A system user token with{' '}
                  <span className="mono">whatsapp_business_management</span> and <span className="mono">whatsapp_business_messaging</span>.
                </small>
              </label>
              <label className="field">
                <span>WhatsApp Business Account ID</span>
                <input type="text" inputMode="numeric" value={wabaId} onChange={(e) => setWabaId(e.target.value)} placeholder="WABA ID" />
              </label>
              <label className="field">
                <span>Phone number ID</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={phoneNumberId}
                  onChange={(e) => setPhoneNumberId(e.target.value)}
                  placeholder="The sending number's ID, not the number itself"
                />
              </label>
              <label className="field">
                <span>Graph API version</span>
                <input type="text" value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} style={{ maxWidth: 200 }} />
              </label>
            </>
          ) : (
            <label className="field">
              <span>API key</span>
              <input
                type="password"
                autoComplete="off"
                placeholder={s.hasApiKey ? `Saved: ${s.apiKeyMasked}  (type to replace)` : 'Paste your D360-API-KEY'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <small>{s.hasApiKey ? `Saved key: ${s.apiKeyMasked}` : 'No key saved yet.'}</small>
            </label>
          )}

          <label className="field">
            <span>WABA currency</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ maxWidth: 200 }}>
              {s.currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <small>The currency your WhatsApp Business Account is billed in. The rate card must match it.</small>
          </label>

          <label className="field">
            <span>Send rate (messages per second)</span>
            <input type="number" min={1} max={80} value={rate} onChange={(e) => setRate(e.target.value)} style={{ maxWidth: 200 }} />
          </label>

          <div className="row">
            <button onClick={save} disabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button className="secondary" onClick={testConnection} disabled={busy !== null || !s.configured}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
          </div>
          {!s.configured && s.missing && <p className="muted small">{s.missing}</p>}

          {test && (
            <div style={{ marginTop: 28 }}>
              <div className="stats">
                {test.phone && (
                  <Stat label="Phone number" value={test.phone.display_phone_number ?? '—'} sub={test.phone.verified_name} />
                )}
                <Stat label="Marketing templates" value={test.marketing} sub={`${test.total} templates in total`} />
              </div>
              {test.names.length > 0 && <p className="muted small">{test.names.join(' · ')}</p>}
            </div>
          )}
        </section>

        <section>
          <h2>Webhook</h2>
          <label className="field">
            <span>Webhook URL</span>
            <input
              type="text"
              placeholder="https://abc123.ngrok-free.app/webhook"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
            <small>
              Run <span className="mono">ngrok http 3000</span> (or cloudflared) and paste the https URL. <span className="mono">/webhook</span> is
              added if missing.
            </small>
          </label>
          {meta && (
            <div className="field">
              <span>Verify token</span>
              <div className="row">
                <span className="mono">{s.metaVerifyToken}</span>
                <CopyButton text={s.metaVerifyToken} />
              </div>
              <small>Meta sends this back when it checks the URL. Use it too if you set the callback in the App Dashboard instead.</small>
            </div>
          )}
          <button onClick={register} disabled={busy !== null || !s.configured || !webhookUrl.trim()}>
            {busy === 'webhook' ? 'Registering…' : 'Register webhook'}
          </button>
          {meta ? (
            <p className="muted small" style={{ marginTop: 16 }}>
              Sets a callback override for this WABA with <span className="mono">POST /{'{WABA_ID}'}/subscribed_apps</span>. Your app must already be
              subscribed to the WABA, and the tunnel must be running: Meta checks the URL before accepting it. Status updates, with the charged cost per
              message, arrive there.
            </p>
          ) : (
            <p className="muted small" style={{ marginTop: 16 }}>
              Sets the phone number's webhook with <span className="mono">POST /v1/configs/webhook</span>. Status updates, with the charged cost per message,
              arrive there.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
