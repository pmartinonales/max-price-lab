import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { eligibility } from '../../shared/eligibility';
import { ErrorBox, Modal, Notice, Stat, flag, fmtAgo, fmtPct, fmtRate, useAction } from '../ui';

interface Totals {
  key: string; label: string; sent: number; sendFailed: number; delivered: number; failed: number;
  deliveryRate: number | null; costed: number; maxPriceApplied: number; charged: number; rateCardCost: number;
  avgCostPerDelivered: number | null; avgRateCard: number | null; saved: number; saving: number | null;
}
interface Msg {
  wamid: string; toMasked: string; country: string | null; countryName: string | null; templateName: string; arm: string | null;
  sentAt: string; status: string; delivered: boolean; category: string | null; cost: number | null; costCurrency: string | null;
  rate: number | null; saving: number | null; errorCode: number | null; errorText: string | null;
}
interface Recent {
  id: string; status: string; category: string | null; cost: number | null; costCurrency: string | null; rate: number | null;
  saving: number | null; errorCode: number | null; ts: number | null; toMasked: string; country: string | null; arm: string | null; templateName: string;
}
interface ResultsView {
  target: string;
  defaultTarget: string;
  recent: Recent[];
  options: { value: string; label: string }[];
  currency: string | null;
  overall: Totals | null;
  byArm: Totals[];
  byTemplate: Totals[];
  byCountry: Totals[];
  messages: Msg[];
  messageCount: number;
  lastWebhookAt: string | null;
}

const money = (n: number | null | undefined, c?: string | null) => fmtRate(n, c ?? '');

/** Countries where Meta doesn't optimise delivery or apply max price: shown so a 0% saving reads as expected. */
function countryNote(iso: string) {
  const e = eligibility(iso);
  if (e.status === 'flagged') return <span className="tag warn">No delivery optimization</span>;
  if (e.status === 'no_max_price') return <span className="tag warn">No max pricing</span>;
  return null;
}

const SavingCell = ({ v }: { v: number | null }) => <strong className={v !== null && v > 0.0005 ? 'good' : ''}>{fmtPct(v)}</strong>;

function TotalsTable({ rows, first, currency, countries }: { rows: Totals[]; first: string; currency: string | null; countries?: boolean }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{first}</th>
            <th className="num">Sent</th>
            <th className="num">Delivered</th>
            <th className="num">Delivery rate</th>
            <th className="num">Avg cost / delivered</th>
            <th className="num">Rate card</th>
            <th className="num">Saving</th>
            <th className="num">Total saved</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.key}>
              <td>
                {countries && <span style={{ marginRight: 8 }}>{flag(t.key)}</span>}
                {t.label}
                {countries && t.key.length === 2 && <span style={{ marginLeft: 8 }}>{countryNote(t.key)}</span>}
                {t.sendFailed > 0 && <div className="muted small">{t.sendFailed} failed to send</div>}
              </td>
              <td className="num">{t.sent}</td>
              <td className="num">{t.delivered}</td>
              <td className="num">{fmtPct(t.deliveryRate)}</td>
              <td className="num">
                {money(t.avgCostPerDelivered)}
                {t.costed < t.delivered && <div className="muted small">{t.costed} of {t.delivered} with cost</div>}
              </td>
              <td className="num">{money(t.avgRateCard)}</td>
              <td className="num">
                <SavingCell v={t.saving} />
              </td>
              <td className="num">{money(t.saved, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_CLS: Record<string, string> = { delivered: 'accent', read: 'accent', failed: 'warn', send_failed: 'warn' };

const PricingTag = ({ category }: { category: string | null }) =>
  category === 'marketing_lite_dynamic' ? (
    <span className="tag good">max price</span>
  ) : category === 'marketing_lite' ? (
    <span className="tag">rate card</span>
  ) : (
    <span className="muted">{category ?? '–'}</span>
  );

function ArmCard({ arm, t, title, cur, winner }: { arm: string; t: Totals; title: string; cur: string | null; winner: boolean }) {
  const awaiting = Math.max(0, t.sent - t.delivered - t.failed);
  const ratio = t.avgCostPerDelivered !== null && t.avgRateCard ? Math.min(1, t.avgCostPerDelivered / t.avgRateCard) : null;
  const saves = t.saving !== null && t.saving > 0.0005;
  return (
    <div className={`arm-card ${winner ? 'winner' : ''}`}>
      <div className="arm-head">
        <span className="arm-letter">{arm}</span>
        <strong>{title}</strong>
        <span className="name">{t.label.replace(/ · arm [AB]$/, '')}</span>
      </div>
      <div className="stat-label">Avg cost per delivered message</div>
      <div className="big">
        {t.avgCostPerDelivered === null ? '–' : t.avgCostPerDelivered.toFixed(4)}
        {cur && t.avgCostPerDelivered !== null && <small>{cur}</small>}
      </div>
      <div className={`bar ${saves ? 'good' : ''}`}>
        <span style={{ width: `${(ratio ?? 0) * 100}%` }} />
      </div>
      <div className="bar-legend">
        <span>{ratio === null ? 'Waiting for delivered messages' : `${fmtPct(ratio)} of the rate card`}</span>
        <span>rate card {fmtRate(t.avgRateCard)}</span>
      </div>
      <dl className="kv">
        <dt>Saving vs rate card</dt>
        <dd className={saves ? 'good' : ''}>{fmtPct(t.saving)}</dd>
        <dt>Delivery rate</dt>
        <dd>
          {awaiting > 0 ? (
            <span className="muted">{t.delivered} delivered so far</span>
          ) : (
            <>
              {fmtPct(t.deliveryRate)} <span className="muted small">({t.delivered} of {t.sent})</span>
            </>
          )}
        </dd>
        <dt>Billed with max price</dt>
        <dd>
          {t.maxPriceApplied} <span className="muted small">of {t.delivered}</span>
        </dd>
        {awaiting > 0 && (
          <>
            <dt>Awaiting status</dt>
            <dd className="muted">{awaiting}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

const settled = (t: Totals) => t.sent - t.delivered - t.failed <= 0;

function Headline({ A, B }: { A: Totals; B: Totals }) {
  if (B.saving === null) return <p className="headline muted">Waiting for the first delivered messages…</p>;
  // Delivery rates only mean something once every message has a final status.
  const pts = settled(A) && settled(B) && A.deliveryRate !== null && B.deliveryRate !== null ? (B.deliveryRate - A.deliveryRate) * 100 : null;
  return (
    <p className="headline">
      Max price paid <span className="good">{fmtPct(B.saving)} less</span> than the rate card.{' '}
      <span className="muted">
        {pts === null
          ? 'Statuses still arriving…'
          : `Delivery ${fmtPct(A.deliveryRate)} vs ${fmtPct(B.deliveryRate)} (${pts >= 0 ? '+' : '−'}${Math.abs(pts).toFixed(1)} pts).`}
      </span>
    </p>
  );
}

const fmtTime = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleTimeString() : '–');

function LiveFeed({ items, lastAt, now }: { items: Recent[]; lastAt: string | null; now: number }) {
  const live = lastAt !== null && now - new Date(lastAt).getTime() < 15_000;
  return (
    <section>
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Latest webhooks</h2>
        <span className={`live ${live ? 'on' : ''}`}>{lastAt ? `Last webhook ${fmtAgo(lastAt, now)}` : 'No webhooks yet'}</span>
      </div>
      <div className="table-wrap">
        <table className="feed">
          <thead>
            <tr>
              <th>Time</th>
              <th>Arm</th>
              <th>Country</th>
              <th>Status</th>
              <th>Billed as</th>
              <th className="num">Charged</th>
              <th className="num">Rate card</th>
              <th className="num">Saving</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td className="mono muted">{fmtTime(r.ts)}</td>
                <td>{r.arm ? <span className="tag solid">{r.arm}</span> : '–'}</td>
                <td>
                  {flag(r.country)} <span className="muted small">{r.country ?? '–'}</span>
                </td>
                <td>
                  <span className={`tag ${STATUS_CLS[r.status] ?? ''}`}>{r.status}</span>
                  {r.errorCode && <span className="mono small muted"> {r.errorCode}</span>}
                </td>
                <td>{r.status === 'sent' || r.status === 'failed' ? <span className="muted">–</span> : <PricingTag category={r.category} />}</td>
                <td className="num">{r.cost === null ? '–' : fmtRate(r.cost)}</td>
                <td className="num muted">{r.cost === null ? '' : fmtRate(r.rate)}</td>
                <td className="num">{r.cost === null ? '' : <SavingCell v={r.saving} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ marginTop: 10 }}>
        Each delivered status carries what Meta charged for that message. <span className="mono">marketing_lite_dynamic</span> means max price was applied.
      </p>
    </section>
  );
}

export function ResultsScreen() {
  const [view, setView] = useState<ResultsView | null>(null);
  // null until the server says which A/B pair was sent last: Results opens on it.
  const [target, setTarget] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [now, setNow] = useState(Date.now());
  const { busy, error, setError, run } = useAction();
  const targetRef = useRef(target);
  targetRef.current = target;

  const load = async (t = targetRef.current ?? 'all') => {
    const v = await api.get<ResultsView>(`/api/results?target=${encodeURIComponent(t)}`);
    if (targetRef.current === null && v.defaultTarget !== t) return setTarget(v.defaultTarget);
    setView(v);
  };

  useEffect(() => {
    run('load', () => load(target ?? 'all'));
  }, [target]);

  // Live: statuses arrive by webhook.
  useEffect(() => {
    const id = window.setInterval(() => load().catch(() => undefined), 2000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(id);
      window.clearInterval(clock);
    };
  }, []);

  const o = view?.overall;
  const cur = view?.currency ?? null;
  const [A, B] = [view?.byArm.find((t) => t.key === 'A'), view?.byArm.find((t) => t.key === 'B')];

  return (
    <>
      <div className="spread">
        <h1>Results</h1>
        <div className="row">
          <select value={target ?? 'all'} onChange={(e) => setTarget(e.target.value)} style={{ width: 320 }}>
            <option value="all">All messages</option>
            {view?.options.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </select>
          <a href={`/api/results.csv?target=${encodeURIComponent(target ?? 'all')}`} download>
            <button className="secondary">Export CSV</button>
          </a>
        </div>
      </div>
      <p className="lede">What each delivered message cost, from the status webhooks, against the rate card. Updates live.</p>

      <ErrorBox error={error} onClose={() => setError(null)} />

      {A && B && (
        <section>
          <Headline A={A} B={B} />
          <div className="arms">
            <ArmCard arm="A" t={A} title="Rate card" cur={cur} winner={false} />
            <ArmCard arm="B" t={B} title="Max price" cur={cur} winner={(B.saving ?? 0) > 0.0005} />
          </div>
          <p className="muted small">
            Same content, recipients split 50/50 and balanced per country. "Billed with max price" counts deliveries billed as{' '}
            <span className="mono">marketing_lite_dynamic</span>.
          </p>
        </section>
      )}

      {view && view.recent.length > 0 && <LiveFeed items={view.recent} lastAt={view.lastWebhookAt} now={now} />}

      {o && A && B ? null : o ? (
        <div className="stats">
          <Stat label="Sent" value={o.sent} sub={o.sendFailed ? `${o.sendFailed} failed to send` : `${view!.messageCount} messages`} />
          <Stat label="Delivery rate" value={fmtPct(o.deliveryRate)} sub={`${o.delivered} delivered`} />
          <Stat label="Avg cost per delivered" value={<span style={{ fontSize: 32 }}>{money(o.avgCostPerDelivered)}</span>} sub={`rate card ${money(o.avgRateCard, cur)}`} />
          <Stat label="Saving vs rate card" value={fmtPct(o.saving)} sub={`${money(o.saved, cur)} saved on ${o.costed} messages`} emph={(o.saving ?? 0) > 0.0005} />
        </div>
      ) : (
        view && <div className="empty">No messages sent yet. Send some from the Send tab.</div>
      )}

      {o && (
        <>
          <section>
            <h2>By template</h2>
            <TotalsTable rows={view!.byTemplate} first="Template · arm" currency={cur} />
          </section>

          <section>
            <h2>By country</h2>
            <TotalsTable rows={view!.byCountry} first="Country" currency={cur} countries />
          </section>

          <section>
            <div className="spread" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>Messages</h2>
              <button className="link" onClick={() => setConfirmClear(true)}>
                Clear results
              </button>
            </div>
            <div className="table-wrap table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Country</th>
                    <th>Template</th>
                    <th>Arm</th>
                    <th>Status</th>
                    <th>Pricing</th>
                    <th className="num">Charged</th>
                    <th className="num">Rate card</th>
                    <th className="num">Saving</th>
                  </tr>
                </thead>
                <tbody>
                  {view!.messages.map((m, i) => (
                    <tr key={m.wamid || `f${i}`}>
                      <td className="mono">{m.toMasked}</td>
                      <td>
                        {flag(m.country)} <span className="muted small">{m.country ?? '–'}</span>
                      </td>
                      <td>{m.templateName}</td>
                      <td>{m.arm ? <span className="tag solid">{m.arm}</span> : '–'}</td>
                      <td>
                        <span className={`tag ${STATUS_CLS[m.status] ?? ''}`}>{m.status === 'send_failed' ? 'send failed' : m.status}</span>
                        {(m.errorCode || m.errorText) && (
                          <div className="small muted" style={{ marginTop: 4 }}>
                            {m.errorCode ? <span className="mono">{m.errorCode}</span> : null} {m.errorText}
                            {m.errorCode === 131065 && <div>Max price isn't available in this country.</div>}
                          </div>
                        )}
                      </td>
                      <td className="small">
                        <PricingTag category={m.category} />
                      </td>
                      <td className="num">{m.cost === null ? '–' : fmtRate(m.cost, m.costCurrency ?? '')}</td>
                      <td className="num">{fmtRate(m.rate)}</td>
                      <td className="num">
                        <SavingCell v={m.saving} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {view!.messageCount > view!.messages.length && <p className="muted small">Showing the latest {view!.messages.length} of {view!.messageCount}. Export CSV for all.</p>}
          </section>
        </>
      )}

      <Notice>Webhook cost can differ slightly from the invoice; the invoice is final.</Notice>

      {confirmClear && (
        <Modal title="Clear results?" onClose={() => setConfirmClear(false)}>
          <p>Deletes every sent message and status from the local database, so the next test starts from zero. Webhook log and templates stay. This can't be undone.</p>
          <div className="actions">
            <button className="secondary" onClick={() => setConfirmClear(false)}>
              Cancel
            </button>
            <button
              disabled={busy !== null}
              onClick={() =>
                run('clear', async () => {
                  await api.del('/api/results');
                  setConfirmClear(false);
                  setTarget('all');
                  await load('all');
                })
              }
            >
              Clear
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
