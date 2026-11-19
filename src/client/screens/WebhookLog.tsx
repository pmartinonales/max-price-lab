import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorBox, fmtDate, useAction } from '../ui';

interface Entry {
  id: number;
  receivedAt: string;
  body: unknown;
  statuses: { wamid: string; status: string; cost: number | null; currency: string | null; category: string | null }[];
}

export function WebhookLogScreen() {
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ total: number; entries: Entry[] } | null>(null);
  const { error, setError, run } = useAction();

  useEffect(() => {
    const load = () => api.get<{ total: number; entries: Entry[] }>(`/api/webhook-log?q=${encodeURIComponent(q.trim())}`).then(setData);
    const t = window.setTimeout(() => run('load', load), 250);
    const live = window.setInterval(() => load().catch(() => undefined), 3000);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(live);
    };
  }, [q]);

  return (
    <>
      <div className="spread">
        <h1>Webhook log</h1>
        <input type="search" placeholder="Search by wamid" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 360 }} />
      </div>
      <p className="lede">Raw status payloads as they arrived, newest first. {data && `${data.total} received.`}</p>
      <ErrorBox error={error} onClose={() => setError(null)} />

      {data && data.entries.length === 0 && <div className="empty">{q ? 'No payload matches.' : 'No webhooks received yet. Register the webhook in Settings.'}</div>}

      {data?.entries.map((e) => (
        <details key={e.id} className="notice" style={{ background: '#fff' }}>
          <summary style={{ cursor: 'pointer' }}>
            <span className="muted small">{fmtDate(e.receivedAt)}</span>{' '}
            {e.statuses.length === 0 ? (
              <span className="muted">no statuses</span>
            ) : (
              e.statuses.map((s, i) => (
                <span key={i} style={{ marginRight: 12 }}>
                  <span className="tag">{s.status}</span> <span className="mono">{s.wamid.slice(0, 28)}…</span>
                  {s.cost !== null && <strong> {s.cost} {s.currency}</strong>}
                  {s.category && <span className="muted small"> {s.category}</span>}
                </span>
              ))
            )}
          </summary>
          <pre>{JSON.stringify(e.body, null, 2)}</pre>
        </details>
      ))}
    </>
  );
}
