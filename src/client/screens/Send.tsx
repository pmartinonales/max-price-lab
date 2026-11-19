import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ErrorBox, Modal, Notice, Stat, flag, fmtRate, useAction } from '../ui';

interface Vars { header: string[]; body: string[]; named: boolean; unsupported: string[] }
interface TargetTemplate { id: string; name: string; language: string; status: string; hasMaxPrice: boolean; vars: Vars; body: string }
interface Targets { templates: TargetTemplate[]; pairs: { pairId: string; A: TargetTemplate; B: TargetTemplate }[]; sendRatePerSecond: number }

interface PreviewRecipient {
  line: number; masked: string; country: string | null; countryName: string | null;
  status: string; canSend: boolean; note: string; vars: string[]; arm?: 'A' | 'B'; rate: number | null;
}
interface Preview {
  planId: string;
  kind: 'template' | 'pair';
  arms: Record<string, { name: string; status: string; hasMaxPrice: boolean }>;
  template: { name: string; status: string; hasMaxPrice: boolean } | null;
  recipients: PreviewRecipient[];
  counts: { lines: number; sendable: number; skipped: number; A: number; B: number };
  estimatedRateCardCost: number;
  currency: string | null;
  samplePayload: unknown;
  ratePerSecond: number;
}
interface Job {
  id: string; total: number; done: number; ok: number; failed: number; finished: boolean; ratePerSecond: number;
  errors: { masked: string; country: string | null; arm: string | null; error: string; api?: unknown }[];
}
interface DryRun { count: number; payloads: { masked: string; country: string | null; arm: string | null; template: string; payload: unknown }[] }

const STATUS_TAG: Record<string, { label: string; cls: string }> = {
  eligible: { label: 'Eligible', cls: 'accent' },
  flagged: { label: 'No delivery optimization', cls: 'warn' },
  no_max_price: { label: 'No max pricing', cls: 'warn' },
  blocked: { label: 'Blocked', cls: '' },
  not_delivered: { label: 'Not delivered (US)', cls: '' },
  invalid: { label: 'Invalid', cls: '' },
  duplicate: { label: 'Duplicate', cls: '' },
  unknown_country: { label: 'Unknown country', cls: '' },
};

/** Counts per eligibility group, with a few example countries: the "who can't get max price" catch at a glance. */
function EligibilitySummary({ recipients }: { recipients: PreviewRecipient[] }) {
  const groups: { key: string; label: string; cls: string; match: (r: PreviewRecipient) => boolean }[] = [
    { key: 'eligible', label: 'Max price applies', cls: 'ok', match: (r) => r.status === 'eligible' },
    { key: 'flagged', label: 'No delivery optimization: rate card', cls: 'warn', match: (r) => r.status === 'flagged' },
    { key: 'no_max_price', label: 'No max pricing (RU, BY)', cls: 'warn', match: (r) => r.status === 'no_max_price' },
    { key: 'not_sendable', label: 'Not sent (US, blocked)', cls: '', match: (r) => r.status === 'not_delivered' || r.status === 'blocked' },
    { key: 'invalid', label: 'Invalid or duplicate', cls: '', match: (r) => ['invalid', 'duplicate', 'unknown_country'].includes(r.status) },
  ];
  return (
    <div className="summary">
      {groups.map((g) => {
        const rs = recipients.filter(g.match);
        if (rs.length === 0) return null;
        const countries = [...new Set(rs.map((r) => r.country).filter(Boolean))] as string[];
        return (
          <div key={g.key} className={`item ${g.cls}`}>
            <b>{rs.length}</b>
            <span>{g.label}</span>
            {countries.length > 0 && (
              <div className="small" style={{ marginTop: 4 }}>
                {countries.slice(0, 6).map((c) => `${flag(c)} ${c}`).join('  ')}
                {countries.length > 6 && <span className="muted"> +{countries.length - 6}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function SendScreen() {
  const [targets, setTargets] = useState<Targets | null>(null);
  const [target, setTarget] = useState(''); // "t:<id>" or "p:<pairId>"
  const [values, setValues] = useState<string[]>([]);
  const [numbers, setNumbers] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [multiplier, setMultiplier] = useState('1');
  const [dryRun, setDryRun] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [dry, setDry] = useState<DryRun | null>(null);
  const { busy, error, setError, run } = useAction();
  const poll = useRef<number | null>(null);

  useEffect(() => {
    run('load', async () => {
      const t = await api.get<Targets>('/api/send/targets');
      setTargets(t);
      const first = t.pairs[0] ? `p:${t.pairs[0].pairId}` : t.templates.find((x) => x.status === 'APPROVED') ? `t:${t.templates.find((x) => x.status === 'APPROVED')!.id}` : '';
      setTarget(first);
    });
    return () => {
      if (poll.current) window.clearInterval(poll.current);
    };
  }, []);

  const selected = useMemo(() => {
    if (!targets || !target) return null;
    if (target.startsWith('p:')) {
      const p = targets.pairs.find((x) => x.pairId === target.slice(2));
      return p ? { kind: 'pair' as const, ref: p.A, pair: p } : null;
    }
    const t = targets.templates.find((x) => x.id === target.slice(2));
    return t ? { kind: 'template' as const, ref: t, pair: null } : null;
  }, [targets, target]);

  const varNames = selected ? [...selected.ref.vars.header.map((v) => `Header {{${v}}}`), ...selected.ref.vars.body.map((v) => `Body {{${v}}}`)] : [];

  useEffect(() => {
    setValues(varNames.map((_, i) => values[i] ?? ''));
    setPreview(null);
    setDry(null);
  }, [target]);

  const check = () =>
    run('check', async () => {
      setDry(null);
      setJob(null);
      const body = {
        ...(selected?.kind === 'pair' ? { pairId: selected.pair!.pairId } : { templateId: selected?.ref.id }),
        numbers,
        values,
        perMessageMultiplier: advanced ? multiplier : null,
      };
      setPreview(await api.post<Preview>('/api/send/preview', body));
    });

  const send = () =>
    run('send', async () => {
      if (!preview) return;
      const res = await api.post<{ dryRun: boolean; job?: Job; count?: number; payloads?: DryRun['payloads'] }>(`/api/send/${preview.planId}`, { dryRun });
      setConfirm(false);
      if (res.dryRun) {
        setDry({ count: res.count!, payloads: res.payloads! });
        // A dry run doesn't use up the plan; keep the preview so it can be sent for real.
        return;
      }
      setPreview(null);
      setJob(res.job!);
      if (poll.current) window.clearInterval(poll.current);
      poll.current = window.setInterval(async () => {
        const j = await api.get<Job>(`/api/send/jobs/${res.job!.id}`);
        setJob(j);
        if (j.finished && poll.current) {
          window.clearInterval(poll.current);
          poll.current = null;
        }
      }, 700);
    });

  const notApproved = preview
    ? (preview.kind === 'pair' ? Object.values(preview.arms) : [preview.template!]).filter((t) => t.status !== 'APPROVED')
    : [];
  const seconds = preview ? Math.ceil(preview.counts.sendable / preview.ratePerSecond) : 0;

  return (
    <>
      <h1>Send</h1>
      <p className="lede">
        Marketing template messages via <span className="mono">/marketing_messages</span>. Each number's country decides whether max price can apply.
      </p>

      <ErrorBox error={error} onClose={() => setError(null)} />

      {targets && targets.templates.length === 0 && (
        <Notice kind="warn">
          No marketing templates synced yet. Sync them on the <a href="#/templates">Templates</a> tab.
        </Notice>
      )}

      <div className="grid2">
        <section>
          <label className="field">
            <span>Template</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {targets && targets.pairs.length > 0 && (
                <optgroup label="A/B pairs (50/50 split)">
                  {targets.pairs.map((p) => (
                    <option key={p.pairId} value={`p:${p.pairId}`}>
                      A/B: {p.A.name} vs {p.B.name} ({p.A.language})
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Single template">
                {targets?.templates.map((t) => (
                  <option key={t.id} value={`t:${t.id}`}>
                    {t.name} ({t.language}) · {t.hasMaxPrice ? 'max price' : 'rate card'}
                    {t.status !== 'APPROVED' ? ` · ${t.status}` : ''}
                  </option>
                ))}
              </optgroup>
            </select>
            {selected && (
              <small>
                {selected.kind === 'pair'
                  ? `Arm A: ${selected.pair!.A.name} (${selected.pair!.A.hasMaxPrice ? 'max price' : 'rate card'}) · Arm B: ${selected.pair!.B.name} (${selected.pair!.B.hasMaxPrice ? 'max price' : 'rate card'})`
                  : `Language ${selected.ref.language} · ${selected.ref.status}`}
              </small>
            )}
          </label>

          {selected && (
            <>
              <div className="notice" style={{ whiteSpace: 'pre-wrap' }}>
                {selected.ref.body || <span className="muted">No body text</span>}
              </div>
              {selected.ref.vars.unsupported.length > 0 && (
                <Notice kind="warn">This template has parts the demo can't fill: {selected.ref.vars.unsupported.join(', ')}. Sends may be rejected.</Notice>
              )}
              {varNames.map((name, i) => (
                <label className="field" key={name}>
                  <span>{name}</span>
                  <input
                    type="text"
                    value={values[i] ?? ''}
                    onChange={(e) => {
                      const next = [...values];
                      next[i] = e.target.value;
                      setValues(next);
                    }}
                  />
                </label>
              ))}
            </>
          )}

          <label className="check" style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
            <span>Per-message multiplier (advanced)</span>
          </label>
          {advanced && (
            <label className="field">
              <input type="number" step="0.01" min="0.01" max="10" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} style={{ maxWidth: 160 }} />
              <small>
                Adds <span className="mono">bid_spec.per_message_bid_multiplier</span>: this message's cap = template cap × this value. Meta flags it as subject to
                change during the beta.
              </small>
            </label>
          )}
        </section>

        <section>
          <label className="field">
            <span>Phone numbers</span>
            <textarea
              value={numbers}
              onChange={(e) => setNumbers(e.target.value)}
              placeholder={'+5511987654321\n+919812345678, Priya\n+525512345678'}
              style={{ minHeight: 240, maxWidth: '100%', fontFamily: 'var(--mono)', fontSize: 14 }}
            />
            <small>One per line, with country code. Optional per-recipient variables after a comma.</small>
          </label>
          <button onClick={check} disabled={busy !== null || !selected || !numbers.trim()}>
            {busy === 'check' ? 'Checking…' : 'Check numbers'}
          </button>
        </section>
      </div>

      {preview && (
        <section>
          <div className="stats">
            <Stat label="Will send" value={preview.counts.sendable} sub={`${preview.counts.lines} lines pasted`} />
            {preview.kind === 'pair' ? (
              <Stat label="Arm A / Arm B" value={`${preview.counts.A} / ${preview.counts.B}`} sub="balanced per country" />
            ) : (
              <Stat label="Pricing" value={<span style={{ fontSize: 28 }}>{preview.template?.hasMaxPrice ? 'Max price' : 'Rate card'}</span>} sub={preview.template?.name} />
            )}
            <Stat label="Skipped" value={preview.counts.skipped} sub="invalid, duplicate or not sendable" />
            <Stat
              label="Cost at rate card"
              value={<span style={{ fontSize: 30 }}>{fmtRate(preview.estimatedRateCardCost, preview.currency ?? '')}</span>}
              sub="if every message is delivered"
            />
          </div>

          {notApproved.length > 0 && (
            <Notice kind="warn">
              Not approved yet: {notApproved.map((t) => `${t.name} (${t.status})`).join(', ')}. Dry run works; sending waits for Meta approval.
            </Notice>
          )}

          <EligibilitySummary recipients={preview.recipients} />

          <div className="table-wrap table-scroll" style={{ marginBottom: 20 }}>
            <table>
              <thead>
                <tr>
                  <th className="num">Line</th>
                  <th>Number</th>
                  <th>Country</th>
                  <th>Eligibility</th>
                  {preview.kind === 'pair' && <th>Arm</th>}
                  <th className="num">Rate card</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {preview.recipients.map((r) => (
                  <tr key={r.line} className={r.canSend ? '' : 'dim'}>
                    <td className="num muted">{r.line}</td>
                    <td className="mono">{r.masked}</td>
                    <td>
                      {r.country && <span style={{ marginRight: 6 }}>{flag(r.country)}</span>}
                      {r.countryName ?? '–'} {r.country && <span className="muted small">{r.country}</span>}
                    </td>
                    <td>
                      <span className={`tag ${STATUS_TAG[r.status]?.cls ?? ''}`}>{STATUS_TAG[r.status]?.label ?? r.status}</span>
                    </td>
                    {preview.kind === 'pair' && <td>{r.arm ? <span className="tag solid">{r.arm}</span> : '–'}</td>}
                    <td className="num">{fmtRate(r.rate)}</td>
                    <td className="small muted">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="row">
            <label className="check">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              <span>Dry run (build payloads, send nothing)</span>
            </label>
            <button onClick={() => setConfirm(true)} disabled={busy !== null || preview.counts.sendable === 0}>
              {dryRun ? `Build ${preview.counts.sendable} payloads` : `Send ${preview.counts.sendable} messages`}
            </button>
          </div>
        </section>
      )}

      {confirm && preview && (
        <Modal title={dryRun ? 'Dry run' : `Send ${preview.counts.sendable} messages?`} onClose={() => setConfirm(false)}>
          {dryRun ? (
            <p>Builds the {preview.counts.sendable} payloads without calling the API.</p>
          ) : (
            <>
              <p>
                <strong>{preview.counts.sendable}</strong> marketing messages to real WhatsApp numbers
                {preview.kind === 'pair' && (
                  <>
                    : <strong>{preview.counts.A}</strong> on arm A ({preview.arms.A?.name}) and <strong>{preview.counts.B}</strong> on arm B ({preview.arms.B?.name})
                  </>
                )}
                .
              </p>
              <p className="muted">
                About {seconds} s at {preview.ratePerSecond} per second. Up to {fmtRate(preview.estimatedRateCardCost, preview.currency ?? '')} at rate card if all
                are delivered. This can't be undone.
              </p>
            </>
          )}
          <ErrorBox error={error} />
          <div className="actions">
            <button className="secondary" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button onClick={send} disabled={busy !== null || (!dryRun && notApproved.length > 0)}>
              {busy === 'send' ? 'Working…' : dryRun ? 'Build payloads' : `Send ${preview.counts.sendable}`}
            </button>
          </div>
        </Modal>
      )}

      {job && (
        <section>
          <h2>{job.finished ? 'Sent' : 'Sending…'}</h2>
          <div className="stats">
            <Stat label="Progress" value={`${job.done} / ${job.total}`} sub={`${job.ratePerSecond} per second`} />
            <Stat label="Accepted" value={job.ok} sub="by the API" />
            <Stat label="Failed" value={job.failed} sub="see below" />
          </div>
          <div className="progress" aria-label="Send progress">
            <span style={{ width: `${job.total ? (job.done / job.total) * 100 : 0}%` }} />
          </div>
          {job.finished && (
            <Notice kind="ok">
              Done. Delivery statuses and charged cost arrive by webhook; the Results tab follows them live.
            </Notice>
          )}
          {job.errors.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Country</th>
                    <th>Arm</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {job.errors.map((e, i) => (
                    <tr key={i}>
                      <td className="mono">{e.masked}</td>
                      <td>{e.country ?? '–'}</td>
                      <td>{e.arm ?? '–'}</td>
                      <td className="small">
                        {e.error}
                        {e.api !== undefined && (
                          <details>
                            <summary className="muted">API response</summary>
                            <pre>{JSON.stringify(e.api, null, 2)}</pre>
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {dry && (
        <section>
          <h2>Dry run · {dry.count} payloads</h2>
          <p className="muted small">Numbers are masked here; the real request carries the full number. Nothing was sent.</p>
          <pre className="json">{JSON.stringify(dry.payloads.slice(0, 25), null, 2)}</pre>
          {dry.count > 25 && <p className="muted small">Showing the first 25.</p>}
        </section>
      )}
    </>
  );
}
