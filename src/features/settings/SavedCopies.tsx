import { useEffect, useState } from 'react';
import { Section } from '../../ui/components';
import { useBudget } from '../../state/store';
import { KEEP_DAYS, listCopies, readCopy, type CopyInfo } from '../../state/versions';

/** Put back a saved copy of everything: one is kept each day, for 3 months (see versions.ts). */
export function SavedCopies() {
  const { restoreVersion } = useBudget();
  const [copies, setCopies] = useState<CopyInfo[] | null>(null);
  const [all, setAll] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { void listCopies().then(setCopies); }, []);
  const when = (at: string) => new Date(at).toLocaleString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  async function restore(c: CopyInfo) {
    if (!confirm(`Put everything back as it was on ${when(c.at)}? What you have now is saved first, so you can switch back.`)) return;
    const v = await readCopy(c.at);
    if (!v) { setMsg({ ok: false, text: 'That copy couldn’t be opened.' }); return; }
    restoreVersion(v);
    setMsg({ ok: true, text: `Put back as it was on ${when(c.at)}.` });
    setTimeout(() => { void listCopies().then(setCopies); }, 300);
  }
  const last = copies?.[0];
  const older = (copies ?? []).slice(1);
  return (
    <Section title="Saved copies" summary={last ? `Last saved ${when(last.at)}` : copies ? 'None yet: one is saved each day you make a change' : ''}>
      <p className="small muted">A copy of everything is saved once a day, just before that day’s first change, and kept for {Math.round(KEEP_DAYS / 30)} months. If an upload or a change goes wrong, put the last saved copy back. What you have now is saved first, so you can switch back.</p>
      {copies && copies.length === 0 && <p className="small muted">No saved copies yet{typeof indexedDB === 'undefined' ? ': this browser can’t keep them' : ''}.</p>}
      {last && (
        <div className="list-row">
          <span className="grow"><b>{when(last.at)}</b><span className="small muted block">{last.summary}</span></span>
          <button className="btn primary small" onClick={() => void restore(last)}>Restore last saved</button>
        </div>
      )}
      {older.length > 0 && (
        <>
          {(all ? older : older.slice(0, 6)).map((c) => (
            <div key={c.at} className="list-row">
              <span className="grow"><b>{when(c.at)}</b><span className="small muted block">{c.summary}</span></span>
              <button className="btn small" onClick={() => void restore(c)}>Restore</button>
            </div>
          ))}
          {!all && older.length > 6 && <button className="btn small" onClick={() => setAll(true)}>Show all {copies!.length} copies</button>}
        </>
      )}
      {msg && <p className={`small${msg.ok ? '' : ' error'}`} role="status">{msg.text}</p>}
    </Section>
  );
}
