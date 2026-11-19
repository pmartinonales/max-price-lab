import { useEffect, useState } from 'react';
import { api, type RateCardView } from '../api';
import { ErrorBox, Notice, Stat, fmtDate, fmtRate, useAction } from '../ui';

export function RateCardScreen() {
  const [card, setCard] = useState<RateCardView | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState('');
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    run('load', async () => {
      setCard(await api.get<RateCardView>('/api/rate-card'));
      const { files } = await api.get<{ files: string[] }>('/api/rate-card/local-files');
      setFiles(files);
      setFile(files[0] ?? '');
    });
  }, []);

  const importLocal = () => run('import', async () => setCard(await api.post<RateCardView>('/api/rate-card/import-local', { file })));
  const upload = (f: File) =>
    run('upload', async () => setCard(await api.upload<RateCardView>(`/api/rate-card/upload?name=${encodeURIComponent(f.name)}`, f)));

  const countries = card?.markets.reduce((n, m) => n + m.isos.length, 0) ?? 0;

  return (
    <>
      <h1>Rate card</h1>
      <p className="lede">Meta's official marketing rates per market. The max price for each country is set to exactly this rate.</p>

      <ErrorBox error={error} onClose={() => setError(null)} />

      <section>
        <div className="row">
          {files.length > 0 && (
            <>
              <select value={file} onChange={(e) => setFile(e.target.value)} style={{ maxWidth: 360 }}>
                {files.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
              <button onClick={importLocal} disabled={!file || busy !== null}>
                {busy === 'import' ? 'Importing…' : 'Import from data/'}
              </button>
              <span className="muted">or</span>
            </>
          )}
          <label className="secondary" style={{ cursor: 'pointer' }}>
            <span className="tag" style={{ fontSize: 15, padding: '9px 16px', borderRadius: 8, color: 'var(--fg)' }}>
              {busy === 'upload' ? 'Uploading…' : 'Upload a file'}
            </span>
            <input
              type="file"
              accept=".csv,.xlsx"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>
        <p className="muted small">Meta's file has a .csv name but is an Excel workbook; both formats work.</p>
      </section>

      {card?.warnings?.map((w) => (
        <Notice key={w} kind="warn">
          {w}
        </Notice>
      ))}

      {!card?.loaded ? (
        <div className="empty">No rate card imported yet.</div>
      ) : (
        <>
          {!card.currencyMatches && (
            <Notice kind="warn">
              This rate card is in <strong>{card.currency}</strong> but your WABA is billed in <strong>{card.wabaCurrency}</strong>. Max price can't be
              calculated until they match: import Meta's {card.wabaCurrency} rate card, or change the WABA currency in Settings.
            </Notice>
          )}
          {card.unmappedMarkets.length > 0 && (
            <Notice kind="warn">
              Markets with no country mapped: <strong>{card.unmappedMarkets.join(', ')}</strong>. Their rows are highlighted below.
            </Notice>
          )}
          {card.missingMarkets.length > 0 && (
            <Notice kind="warn">
              The country map uses markets this rate card doesn't have: <strong>{card.missingMarkets.join(', ')}</strong>.
            </Notice>
          )}

          <div className="stats">
            <Stat label="Markets" value={card.markets.length} sub={card.currency ?? ''} />
            <Stat label="Countries mapped" value={countries} sub="ISO 3166-1" />
            <Stat label="Effective" value={<span style={{ fontSize: 26 }}>{card.effective ?? '–'}</span>} sub={card.source ?? ''} />
            <Stat label="Imported" value={<span style={{ fontSize: 26 }}>{fmtDate(card.importedAt).split(',')[0]}</span>} sub={fmtDate(card.importedAt).split(', ')[1]} />
          </div>

          {card.title && <p className="muted">{card.title}</p>}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th className="num">Marketing rate</th>
                  <th className="num">Countries</th>
                  <th>ISO codes</th>
                </tr>
              </thead>
              <tbody>
                {card.markets.map((m) => (
                  <tr key={m.market} className={m.isos.length === 0 ? 'highlight' : ''}>
                    <td>
                      <strong>{m.market}</strong>
                    </td>
                    <td className="num">{fmtRate(m.rate, card.currency ?? '')}</td>
                    <td className="num">{m.isos.length}</td>
                    <td>
                      {m.isos.length === 0 ? (
                        <span className="tag warn">Unmapped</span>
                      ) : (
                        <div className="chips">
                          {m.isos.map((i) => (
                            <span key={i} className="chip">
                              {i}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small" style={{ marginTop: 12 }}>
            Mapping from Meta's country calling codes page. Countries Meta doesn't name are billed as "Other". Territories that share a calling code with a
            named market are listed under the cheaper of the two.
          </p>
        </>
      )}
    </>
  );
}
