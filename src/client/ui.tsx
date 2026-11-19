import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from './api';

export function ErrorBox({ error, onClose }: { error: unknown; onClose?: () => void }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  const api = error instanceof ApiError ? error.api : undefined;
  return (
    <div className="notice error" role="alert">
      <div className="notice-head">
        <strong>{msg}</strong>
        {onClose && (
          <button className="link" onClick={onClose}>
            Dismiss
          </button>
        )}
      </div>
      {api?.body !== undefined && (
        <details open>
          <summary>
            API response{api.status ? ` · HTTP ${api.status}` : ''}
            {api.method ? ` · ${api.method} ${api.path}` : ''}
          </summary>
          <pre>{typeof api.body === 'string' ? api.body : JSON.stringify(api.body, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

export function Notice({ children, kind = 'info', onClose }: { children: ReactNode; kind?: 'info' | 'warn' | 'ok'; onClose?: () => void }) {
  return (
    <div className={`notice ${kind}`}>
      <div className="notice-head">
        <div>{children}</div>
        {onClose && (
          <button className="link" onClick={onClose}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

export function Stat({ label, value, sub, emph }: { label: string; value: ReactNode; sub?: ReactNode; emph?: boolean }) {
  return (
    <div className={emph ? 'stat emph' : 'stat'}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="secondary"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

/** Run an async action with busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, setError, run };
}

export const fmtRate = (n: number | null | undefined, currency?: string) =>
  n === null || n === undefined ? '–' : `${n.toFixed(4)}${currency ? ` ${currency}` : ''}`;

export const fmtPct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? '–' : `${(n * 100).toFixed(digits)}%`);

export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '–');

/** Flag emoji for an ISO country code (shows as two letters where flags aren't supported). */
export const flag = (iso: string | null | undefined) =>
  iso && /^[A-Z]{2}$/i.test(iso) ? String.fromCodePoint(...[...iso.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '';

/** "4 s ago", "3 min ago": for things that update live. */
export const fmtAgo = (iso: string | null | undefined, now = Date.now()) => {
  if (!iso) return '–';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return new Date(iso).toLocaleString();
};
