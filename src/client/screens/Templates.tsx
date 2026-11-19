import { useEffect, useMemo, useState } from 'react';
import { api, type Spec, type TemplatesView, type TemplateView } from '../api';
import { ErrorBox, Modal, Notice, Stat, fmtDate, useAction } from '../ui';

type Dialog =
  | { kind: 'new' }
  | { kind: 'apply'; t: TemplateView }
  | { kind: 'reset'; t: TemplateView }
  | { kind: 'pair'; t: TemplateView };

function specSummary(spec: Spec | null) {
  if (!spec) return null;
  const n = Object.keys(spec.bid_country_multiplier_overrides).length;
  return `bid ${spec.bid_amount.toLocaleString('en-US')} · ${n} country ${n === 1 ? 'override' : 'overrides'}`;
}

export function TemplatesScreen() {
  const [view, setView] = useState<TemplatesView | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'ok' | 'info' | 'warn'; detail?: unknown } | null>(null);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    run('load', async () => setView(await api.get<TemplatesView>('/api/templates')));
  }, []);

  const refresh = async () => setView(await api.get<TemplatesView>('/api/templates'));
  const sync = () => run('sync', async () => setView(await api.post<TemplatesView>('/api/templates/sync')));

  const act = (key: string, fn: () => Promise<{ note?: string; duplicateError?: unknown; method?: string }>) =>
    run(key, async () => {
      const res = await fn();
      setDialog(null);
      await refresh();
      if (res.note) setNotice({ text: res.note, kind: res.method === 'create' ? 'warn' : 'ok', detail: res.duplicateError ?? undefined });
    });

  const pairs = useMemo(() => {
    const m = new Map<string, { A?: TemplateView; B?: TemplateView }>();
    for (const t of view?.templates ?? []) if (t.pairId && t.arm) m.set(t.pairId, { ...m.get(t.pairId), [t.arm]: t });
    return [...m.entries()];
  }, [view]);

  const withMaxPrice = view?.templates.filter((t) => t.maxPrice).length ?? 0;
  const spec = view?.currentSpec ?? null;

  return (
    <>
      <div className="spread">
        <h1>Templates</h1>
        <div className="row">
          <button className="secondary" onClick={sync} disabled={busy !== null}>
            {busy === 'sync' ? 'Syncing…' : 'Sync templates'}
          </button>
          <button onClick={() => setDialog({ kind: 'new' })} disabled={busy !== null}>
            New template
          </button>
        </div>
      </div>
      <p className="lede">Marketing templates on your account, and the max price each one carries.</p>

      <ErrorBox error={error} onClose={() => setError(null)} />
      {notice && (
        <Notice kind={notice.kind} onClose={() => setNotice(null)}>
          {notice.text}
          {notice.detail !== undefined && (
            <details>
              <summary>Why: the API's answer to source_template_id</summary>
              <pre>{JSON.stringify(notice.detail, null, 2)}</pre>
            </details>
          )}
        </Notice>
      )}

      <div className="stats">
        <Stat label="Marketing templates" value={view?.templates.length ?? '–'} sub={`Synced ${fmtDate(view?.syncedAt)}`} />
        <Stat label="With max price" value={withMaxPrice} sub={`${(view?.templates.length ?? 0) - withMaxPrice} on rate card`} />
        <Stat
          label="Max price to apply"
          value={spec ? spec.bid_amount.toLocaleString('en-US') : '–'}
          sub={spec ? `bid_amount · ${Object.keys(spec.bid_country_multiplier_overrides).length} country overrides` : (view?.currentSpecError ?? '')}
        />
      </div>

      {!spec && view?.currentSpecError && (
        <Notice kind="warn">
          {view.currentSpecError} Set it up on the <a href="#/max-price">Max price</a> tab.
        </Notice>
      )}

      {pairs.length > 0 && (
        <section>
          <h2>A/B pairs</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Arm A · rate card</th>
                  <th>Arm B · max price</th>
                  <th>Arm B status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pairs.map(([id, p]) => (
                  <tr key={id}>
                    <td>
                      <strong>{p.A?.name ?? '(missing)'}</strong>
                      <div className="muted small">{p.A ? (p.A.maxPrice ? specSummary(p.A.maxPrice) : 'Rate card') : ''}</div>
                    </td>
                    <td>
                      <strong>{p.B?.name ?? '(missing)'}</strong>
                      <div className="muted small">{specSummary(p.B?.maxPrice ?? null) ?? 'Rate card'}</div>
                    </td>
                    <td>
                      <span className={`tag ${p.B?.status === 'APPROVED' ? 'good' : 'warn'}`}>{p.B?.status ?? '–'}</span>
                    </td>
                    <td className="num">
                      <button className="link" onClick={() => run('unpair', async () => setView(await api.del<TemplatesView>(`/api/templates/pairs/${id}`)))}>
                        Unpair
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        {!view || view.templates.length === 0 ? (
          <div className="empty">No marketing templates yet. Save your API key in Settings, then sync.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Template</th>
                  <th>Status</th>
                  <th>Pricing</th>
                  <th style={{ width: 360 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {view.templates.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.name}</strong> <span className="muted small">{t.language}</span>
                      {t.arm && (
                        <span className={`tag ${t.arm === 'B' ? 'good' : 'solid'}`} style={{ marginLeft: 8 }}>
                          Arm {t.arm} · {t.arm === 'B' ? 'max price' : 'rate card'}
                        </span>
                      )}
                      <div className="muted small" style={{ maxWidth: 420, marginTop: 4 }}>
                        {t.body.length > 140 ? `${t.body.slice(0, 140)}…` : t.body}
                      </div>
                    </td>
                    <td>
                      <span className={`tag ${t.status === 'APPROVED' ? 'accent' : 'warn'}`}>{t.status}</span>
                    </td>
                    <td>
                      {t.maxPrice ? (
                        <>
                          <strong>Max price</strong>
                          <div className="muted small">{specSummary(t.maxPrice)}</div>
                          {t.matchesCurrentSpec && <span className="tag accent">At rate card per country</span>}
                        </>
                      ) : (
                        <span className="muted">Rate card</span>
                      )}
                    </td>
                    <td>
                      <div className="row">
                        <button className="small" disabled={busy !== null || !spec} onClick={() => setDialog({ kind: 'apply', t })}>
                          {t.maxPrice ? 'Update max price' : 'Apply max price'}
                        </button>
                        {t.maxPrice && (
                          <button className="small secondary" disabled={busy !== null} onClick={() => setDialog({ kind: 'reset', t })}>
                            Reset to rate card
                          </button>
                        )}
                        {!t.pairId && !t.maxPrice && (
                          <button className="small secondary" disabled={busy !== null || !spec} onClick={() => setDialog({ kind: 'pair', t })}>
                            Create A/B pair
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dialog?.kind === 'new' && (
        <NewTemplateDialog
          spec={spec}
          busy={busy === 'create'}
          error={error}
          onClose={() => setDialog(null)}
          onCreate={(body) => act('create', () => api.post('/api/templates', body))}
        />
      )}

      {dialog?.kind === 'apply' && spec && (
        <Modal title={`${dialog.t.maxPrice ? 'Update' : 'Apply'} max price`} onClose={() => setDialog(null)}>
          <p>
            Set <strong>{dialog.t.name}</strong> to bid_amount <strong>{spec.bid_amount.toLocaleString('en-US')}</strong> with{' '}
            <strong>{Object.keys(spec.bid_country_multiplier_overrides).length}</strong> country overrides, so each country is capped at its rate card.
          </p>
          <p className="muted small">
            No re-review needed. The override map replaces the current one in full. Approved templates allow 100 updates per hour and 2,400 per day. Changes can
            take up to 1 hour to reach delivery.
          </p>
          <ErrorBox error={error} />
          <div className="actions">
            <button className="secondary" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button disabled={busy !== null} onClick={() => act('apply', () => api.post(`/api/templates/${dialog.t.id}/max-price`))}>
              {busy === 'apply' ? 'Applying…' : 'Apply'}
            </button>
          </div>
        </Modal>
      )}

      {dialog?.kind === 'reset' && (
        <Modal title="Reset to rate card" onClose={() => setDialog(null)}>
          <p>
            <strong>{dialog.t.name}</strong> goes back to rate card pricing. Its country overrides are cleared too.
          </p>
          <p className="muted small">Sends optimization_spec with bid_strategy and bid_amount set to null. Can take up to 1 hour to reach delivery.</p>
          <ErrorBox error={error} />
          <div className="actions">
            <button className="secondary" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button disabled={busy !== null} onClick={() => act('reset', () => api.post(`/api/templates/${dialog.t.id}/reset`))}>
              {busy === 'reset' ? 'Resetting…' : 'Reset'}
            </button>
          </div>
        </Modal>
      )}

      {dialog?.kind === 'pair' && spec && (
        <PairDialog
          t={dialog.t}
          spec={spec}
          busy={busy === 'pair'}
          error={error}
          onClose={() => setDialog(null)}
          onCreate={(name) => act('pair', () => api.post(`/api/templates/${dialog.t.id}/ab-pair`, { name }))}
        />
      )}
    </>
  );
}

function PairDialog(props: { t: TemplateView; spec: Spec; busy: boolean; error: unknown; onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState(`${props.t.name}_maxprice`);
  return (
    <Modal title="Create A/B pair" onClose={props.onClose}>
      <p>Same content, two prices:</p>
      <div className="table-wrap" style={{ marginBottom: 20 }}>
        <table>
          <tbody>
            <tr>
              <td style={{ width: 90 }}>
                <span className="tag solid">Arm A</span>
              </td>
              <td>
                <strong>{props.t.name}</strong>
                <div className="muted small">Rate card, unchanged</div>
              </td>
            </tr>
            <tr>
              <td>
                <span className="tag solid">Arm B</span>
              </td>
              <td>
                <strong>{name || '…'}</strong>
                <div className="muted small">
                  Copy with max price: bid {props.spec.bid_amount.toLocaleString('en-US')} · {Object.keys(props.spec.bid_country_multiplier_overrides).length} country
                  overrides
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <label className="field">
        <span>Arm B name</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
        <small>
          Tries Meta's duplicate call (<span className="mono">source_template_id</span>): the copy is approved at once. If the gateway refuses it, arm B is
          created as a new template with the same content and needs Meta approval.
        </small>
      </label>
      <ErrorBox error={props.error} />
      <div className="actions">
        <button className="secondary" onClick={props.onClose}>
          Cancel
        </button>
        <button disabled={props.busy || !name} onClick={() => props.onCreate(name)}>
          {props.busy ? 'Creating…' : 'Create pair'}
        </button>
      </div>
    </Modal>
  );
}

function NewTemplateDialog(props: {
  spec: Spec | null;
  busy: boolean;
  error: unknown;
  onClose: () => void;
  onCreate: (body: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('en_US');
  const [headerText, setHeaderText] = useState('');
  const [bodyText, setBodyText] = useState('Hi {{1}}, our spring sale starts today: 20% off everything. Reply STOP to opt out.');
  const [footerText, setFooterText] = useState('');
  const [examples, setExamples] = useState<string[]>(['Ana']);
  const [withMaxPrice, setWithMaxPrice] = useState(Boolean(props.spec));

  const nVars = Math.max(0, ...[...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));

  return (
    <Modal title="New marketing template" onClose={props.onClose}>
      <label className="field">
        <span>Name</span>
        <input type="text" value={name} placeholder="spring_sale" onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
      </label>
      <label className="field">
        <span>Language</span>
        <input type="text" value={language} onChange={(e) => setLanguage(e.target.value)} style={{ maxWidth: 200 }} />
      </label>
      <label className="field">
        <span>Header (optional)</span>
        <input type="text" value={headerText} onChange={(e) => setHeaderText(e.target.value)} />
      </label>
      <label className="field">
        <span>Body</span>
        <textarea value={bodyText} onChange={(e) => setBodyText(e.target.value)} />
        <small>Use {'{{1}}'}, {'{{2}}'}… for variables.</small>
      </label>
      {Array.from({ length: nVars }, (_, i) => (
        <label className="field" key={i}>
          <span>Example for {`{{${i + 1}}}`}</span>
          <input
            type="text"
            value={examples[i] ?? ''}
            onChange={(e) => {
              const next = [...examples];
              next[i] = e.target.value;
              setExamples(next);
            }}
          />
        </label>
      ))}
      <label className="field">
        <span>Footer (optional)</span>
        <input type="text" value={footerText} onChange={(e) => setFooterText(e.target.value)} />
      </label>
      <label className="check" style={{ marginBottom: 8 }}>
        <input type="checkbox" checked={withMaxPrice} disabled={!props.spec} onChange={(e) => setWithMaxPrice(e.target.checked)} />
        <span>
          With max price
          {props.spec && (
            <span className="muted">
              {' '}
              · bid {props.spec.bid_amount.toLocaleString('en-US')}, {Object.keys(props.spec.bid_country_multiplier_overrides).length} country overrides
            </span>
          )}
        </span>
      </label>
      <p className="muted small">Category MARKETING. New templates go to Meta review before they can be sent.</p>
      <ErrorBox error={props.error} />
      <div className="actions">
        <button className="secondary" onClick={props.onClose}>
          Cancel
        </button>
        <button
          disabled={props.busy || !name || !bodyText.trim()}
          onClick={() => props.onCreate({ name, language, headerText, bodyText, footerText, bodyExamples: examples.slice(0, nVars), withMaxPrice })}
        >
          {props.busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </Modal>
  );
}
