import { useEffect, useMemo, useState } from 'react';
import { api, type CountryRow, type MaxPriceView } from '../api';
import { CopyButton, ErrorBox, Notice, Stat, flag, fmtPct, fmtRate, useAction } from '../ui';

const STATUS_LABEL: Record<CountryRow['status'], string> = {
  eligible: '',
  flagged: 'No delivery optimization',
  no_max_price: 'No max pricing',
  blocked: 'Blocked',
  not_delivered: 'Not delivered',
  unmapped: 'Unmapped',
};

interface Reach {
  interval: string;
  results: { iso: string; result?: unknown; error?: unknown }[];
}

/** Pull "lower – upper" bounds out of whatever shape the reach estimate returns. */
function reachSummary(v: unknown): string | null {
  const found: Record<string, number> = {};
  const walk = (o: unknown) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, val] of Object.entries(o)) {
      if (typeof val === 'number' && /lower|upper|estimate|users|reach/i.test(k)) found[k] = val;
      else walk(val);
    }
  };
  walk(v);
  const lower = Object.entries(found).find(([k]) => /lower/i.test(k))?.[1];
  const upper = Object.entries(found).find(([k]) => /upper/i.test(k))?.[1];
  if (lower !== undefined && upper !== undefined) return `${lower.toLocaleString()} – ${upper.toLocaleString()}`;
  const any = Object.values(found)[0];
  return any !== undefined ? any.toLocaleString() : null;
}

export function MaxPriceScreen() {
  const [view, setView] = useState<MaxPriceView | null>(null);
  const [countries, setCountries] = useState<{ iso: string; name: string }[]>([]);
  const [mode, setMode] = useState<'all' | 'pick'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickerFilter, setPickerFilter] = useState('');
  const [tableFilter, setTableFilter] = useState('');
  const [onlyMap, setOnlyMap] = useState(false);
  const [reach, setReach] = useState<Reach | null>(null);
  const [reachInterval, setReachInterval] = useState('L7D');
  const { busy, error, setError, run } = useAction();

  const load = (v: MaxPriceView) => {
    setView(v);
    setMode(v.countries ? 'pick' : 'all');
    if (v.countries) setPicked(new Set(v.countries));
  };

  useEffect(() => {
    run('load', async () => {
      load(await api.get<MaxPriceView>('/api/max-price'));
      setCountries(await api.get('/api/countries'));
    });
  }, []);

  const apply = (next: 'all' | 'pick', set = picked) =>
    run('apply', async () => {
      setReach(null);
      load(await api.put<MaxPriceView>('/api/max-price', { countries: next === 'all' ? null : [...set] }));
    });

  const getReach = () =>
    run('reach', async () => {
      const isos = view?.countries ?? [];
      setReach(await api.get<Reach>(`/api/max-price/reach?countries=${isos.join(',')}&interval=${reachInterval}`));
    });

  const r = view?.result;
  const rows = useMemo(() => {
    if (!r?.ok) return [];
    const q = tableFilter.trim().toLowerCase();
    return r.rows.filter(
      (x) => (!onlyMap || x.inMap) && (!q || x.name.toLowerCase().includes(q) || x.iso.toLowerCase() === q || (x.market ?? '').toLowerCase().includes(q)),
    );
  }, [r, tableFilter, onlyMap]);

  const json = r?.ok ? JSON.stringify({ optimization_spec: r.spec }, null, 2) : '';
  const nOverrides = r?.ok ? Object.keys(r.spec.bid_country_multiplier_overrides).length : 0;
  const capped = r?.ok ? r.rows.filter((x) => x.capVsRate !== null).length : 0;
  // Where max price can actually lower the bill: capped, and Meta optimises delivery there.
  const working = r?.ok ? r.rows.filter((x) => x.capVsRate !== null && x.status === 'eligible').length : 0;
  const above = r?.ok ? r.rows.filter((x) => x.capVsRate !== null && x.capVsRate > 1).length : 0;
  const noOptimization = r?.ok ? r.rows.filter((x) => x.status === 'flagged').length : 0;

  const pickerList = countries.filter((c) => {
    const q = pickerFilter.trim().toLowerCase();
    return !q || c.name.toLowerCase().includes(q) || c.iso.toLowerCase() === q;
  });

  return (
    <>
      <h1>Max price</h1>
      <p className="lede">
        One <span className="mono">bid_amount</span> at Meta's "Other" rate, plus a multiplier per country so every cap lands exactly on that country's rate
        card. Never above it.
      </p>

      <ErrorBox error={error} onClose={() => setError(null)} />

      <section>
        <div className="row" style={{ marginBottom: 16 }}>
          <div className="segmented">
            <button className={mode === 'all' ? 'on' : ''} onClick={() => (setMode('all'), apply('all'))} disabled={busy !== null}>
              Every country
            </button>
            <button className={mode === 'pick' ? 'on' : ''} onClick={() => setMode('pick')} disabled={busy !== null}>
              Pick countries
            </button>
          </div>
          {mode === 'pick' && (
            <>
              <span className="muted">{picked.size} selected</span>
              <button onClick={() => apply('pick')} disabled={busy !== null || picked.size === 0}>
                {busy === 'apply' ? 'Calculating…' : 'Calculate'}
              </button>
              <button className="link" onClick={() => setPicked(new Set())}>
                Clear
              </button>
            </>
          )}
        </div>

        {mode === 'pick' && (
          <>
            <input type="search" placeholder="Search countries" value={pickerFilter} onChange={(e) => setPickerFilter(e.target.value)} style={{ marginBottom: 12 }} />
            <div className="picker">
              {pickerList.map((c) => (
                <label key={c.iso}>
                  <input
                    type="checkbox"
                    checked={picked.has(c.iso)}
                    onChange={(e) => {
                      const s = new Set(picked);
                      if (e.target.checked) s.add(c.iso);
                      else s.delete(c.iso);
                      setPicked(s);
                    }}
                  />
                  {c.name} <span className="muted small">{c.iso}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </section>

      {r && !r.ok && <Notice kind="warn">{r.error}</Notice>}

      {r?.ok && (
        <>
          <p className="headline">
            One template, <span className="good">{working} countries</span> where max price can lower the bill,{' '}
            <span className={above === 0 ? 'good' : ''}>{above === 0 ? 'zero' : above}</span> caps above the rate card.
          </p>
          <div className="stats">
            <Stat label="Countries where max price works" value={working} sub={`${capped} capped in total · ${noOptimization} with no delivery optimization`} emph />
            <Stat label="Caps above rate card" value={above} sub="every cap ≤ that country's rate card" emph={above === 0} />
            <Stat label="bid_amount" value={r.bidAmount.toLocaleString('en-US')} sub={`${r.baseMarket} rate: ${fmtRate(r.baseRate, r.currency)} per delivery`} />
            <Stat label="Country overrides" value={nOverrides} sub="Meta allows up to 240" />
          </div>

          <Notice>
            <strong>Conversion:</strong> <span className="mono">{r.bidAmountWorking}</span>
            <div className="muted small">
              bid_amount is in the smallest unit of {r.currency} ({r.minorUnits} decimals), per 1,000 deliveries. Each country's cap = bid_amount × multiplier.
            </div>
          </Notice>

          {r.warnings.map((w) => (
            <Notice key={w} kind="warn">
              {w}
            </Notice>
          ))}

          <section>
            <div className="spread" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>Countries</h2>
              <div className="row">
                <label className="check small">
                  <input type="checkbox" checked={onlyMap} onChange={(e) => setOnlyMap(e.target.checked)} /> Only countries in the map
                </label>
                <input type="search" placeholder="Filter" value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} style={{ width: 220 }} />
              </div>
            </div>
            <div className="table-wrap table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Country</th>
                    <th>ISO</th>
                    <th>Rate card market</th>
                    <th className="num">Rate</th>
                    <th className="num">Multiplier</th>
                    <th className="num">Cap per delivery</th>
                    <th className="num">Cap ÷ rate card</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x) => (
                    <tr key={x.iso} className={x.multiplier === null ? 'dim' : ''}>
                      <td>
                        <span style={{ marginRight: 8 }}>{flag(x.iso)}</span>
                        {x.name}
                      </td>
                      <td className="mono">{x.iso}</td>
                      <td>{x.market ?? '–'}</td>
                      <td className="num">{fmtRate(x.rate)}</td>
                      <td className="num">
                        {x.multiplier === null ? '–' : x.inMap ? <strong>{x.multiplier}</strong> : <span className="muted">1 (default)</span>}
                      </td>
                      <td className="num">{fmtRate(x.capPerDelivery)}</td>
                      <td className="num">{fmtPct(x.capVsRate)}</td>
                      <td className="small">
                        {STATUS_LABEL[x.status] && (
                          <span className={`tag ${x.status === 'flagged' ? 'warn' : ''}`} style={{ marginRight: 6 }}>
                            {STATUS_LABEL[x.status]}
                          </span>
                        )}
                        <span className="muted">{x.notes.filter((n) => !n.startsWith('Multiplier 1.0')).join(' ')}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ marginTop: 12 }}>
              {rows.length} rows. Every multiplier is rounded down to 4 decimals, so no cap ends above its rate card.
            </p>
          </section>

          <section>
            <div className="spread" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>optimization_spec</h2>
              <CopyButton text={json} />
            </div>
            <pre className="json">{json}</pre>
            <p className="muted small">Templates tab applies this exact spec.</p>
          </section>

          {view?.countries && (
            <section>
              <h2>Reach estimate</h2>
              <div className="row" style={{ marginBottom: 16 }}>
                <select value={reachInterval} onChange={(e) => setReachInterval(e.target.value)} style={{ width: 140 }}>
                  {['L1D', 'L7D', 'L14D', 'L28D'].map((i) => (
                    <option key={i}>{i}</option>
                  ))}
                </select>
                <button className="secondary" onClick={getReach} disabled={busy !== null}>
                  {busy === 'reach' ? 'Asking Meta…' : `Estimate reach for ${view.countries.length} countries`}
                </button>
                <span className="muted small">Optional. Up to 25 countries, one call each.</span>
              </div>
              {reach && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Country</th>
                        <th className="num">Estimate ({reach.interval})</th>
                        <th>Response</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reach.results.map((x) => (
                        <tr key={x.iso}>
                          <td className="mono">{x.iso}</td>
                          <td className="num">{x.error ? <span className="tag warn">Error</span> : (reachSummary(x.result) ?? '–')}</td>
                          <td>
                            <details>
                              <summary className="muted small">Raw</summary>
                              <pre>{JSON.stringify(x.error ?? x.result, null, 2)}</pre>
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}
