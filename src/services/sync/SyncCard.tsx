import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Section } from '../../ui/components';
import { useBudget } from '../../state/store';
import { pairingLink, readSyncConfig, SyncError, type SyncConfig } from './sync';
import { readBankConfig } from '../bank/bankConfig';
import { readReaderConfig } from '../reader/config';

/** Connect this browser to a private GitHub repo, so every browser has the same budget. */
export function SyncCard() {
  const { sync, connectSync, disconnectSync, syncNow } = useBudget();
  const saved = readSyncConfig();
  // On <you>.github.io, the data repo is most likely <you>/budget-data, so start with that.
  const [repo, setRepo] = useState(saved?.repo ?? guessRepo());
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  async function connect() {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo.trim())) return setErr('Enter the repo as owner/name, e.g. you/budget-data.');
    if (!token.trim()) return setErr('Paste the token from GitHub.');
    setBusy(true); setErr('');
    try {
      await connectSync({ repo: repo.trim(), path: 'budget.json', token: token.trim() });
      setToken('');
    } catch (e) {
      setErr(e instanceof SyncError ? e.message : 'Couldn\u2019t connect.');
    } finally { setBusy(false); }
  }

  return (
    <Section title="Sync across browsers" forceOpen={sync.state === 'error' || !!err}
      summary={sync.state === 'off' ? 'Off: saved in this browser only' : `With ${saved?.repo ?? 'your repo'}`}
      action={sync.state !== 'off' ? (
        <span className={`pill ${sync.state === 'error' ? 'bad' : 'good'}`} role="status">
          {sync.state === 'syncing' ? 'Syncing\u2026' : sync.state === 'synced' ? `Synced ${new Date(sync.at).toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' })}` : 'Not synced'}
        </span>
      ) : undefined}>
      {sync.state === 'off' ? (
        <>
          <p className="small muted">
            Keep your budget in a <b>private</b> GitHub repo, so it's the same in every browser and on your phone. Do this once in each browser.
          </p>
          <ol className="small stack gap-4" style={{ margin: 0, paddingLeft: 18 }}>
            {!guessRepo() && <li>Make a private repo on GitHub (e.g. <i>budget-data</i>).</li>}
            <li>
              <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Create a fine-grained token</a>:
              {' '}Repository access → Only select repositories → that repo. Permissions → Contents: Read and write.
            </li>
            <li>Paste the token here and connect. This browser stays connected after that.</li>
          </ol>
          <label className="field">Private repo
            <input value={repo} onChange={(e) => { setRepo(e.target.value); setErr(''); }} placeholder="you/budget-data" autoComplete="off" />
          </label>
          <label className="field">GitHub token
            <input type="password" value={token} onChange={(e) => { setToken(e.target.value); setErr(''); }} placeholder="github_pat_…" autoComplete="off" />
          </label>
          {err && <p className="small error" role="alert">{err}</p>}
          <p className="small muted">The token is kept in this browser only, and can only read and write that one repo.</p>
          <div className="row"><button className="btn primary" onClick={connect} disabled={busy}>{busy ? 'Connecting\u2026' : 'Connect'}</button></div>
        </>
      ) : (
        <>
          <p className="small muted">
            Synced with <b>{saved?.repo}</b>. Changes save there a moment after you make them, and the newest copy is loaded when you open the app.
          </p>
          {sync.state === 'error' && <p className="small error" role="alert">{sync.message}</p>}
          <div className="row wrap">
            <button className="btn primary" onClick={() => setQr(qr ? null : 'loading')}>{qr ? 'Hide QR code' : 'Connect another device'}</button>
            <button className="btn" onClick={syncNow} disabled={sync.state === 'syncing'}>Sync now</button>
            <button className="btn" onClick={disconnectSync}>Disconnect this browser</button>
          </div>
          {qr && saved && <ConnectQr config={saved} />}
        </>
      )}
    </Section>
  );
}

/** On <you>.github.io the private data repo is guessed as <you>/budget-data (you can change it). */
function guessRepo(): string {
  const m = location.hostname.match(/^([\w-]+)\.github\.io$/i);
  return m ? `${m[1]}/budget-data` : '';
}

/** A QR code that connects another device (e.g. your phone) to the same repo. Valid for 10 minutes. */
function ConnectQr({ config }: { config: SyncConfig }) {
  const [svg, setSvg] = useState('');
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // The Google key for reading documents goes too, unless you untick it.
  const aiKey = readReaderConfig()?.key;
  const [withKey, setWithKey] = useState(true);
  // And the bank connection's passphrase.
  const bankKey = readBankConfig()?.key;
  const [withBank, setWithBank] = useState(true);
  useEffect(() => {
    let live = true;
    const make = () => {
      const at = Date.now();
      QRCode.toString(pairingLink(config, at, withKey ? aiKey : undefined, withBank ? bankKey : undefined), { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
        .then((s) => { if (live) { setSvg(s); setUntil(at + 10 * 60_000); } })
        .catch(() => { if (live) setSvg(''); });
    };
    make();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { live = false; clearInterval(t); };
  }, [config, withKey, aiKey, withBank, bankKey]);
  const left = Math.max(0, Math.ceil((until - now) / 60_000));
  const expired = until > 0 && now > until;
  return (
    <div className="tip stack gap-8" style={{ alignItems: 'center', textAlign: 'center' }}>
      {expired ? (
        <p className="small" style={{ margin: 0 }}>This code has expired. Choose <b>Hide QR code</b>, then <b>Connect another device</b> for a new one.</p>
      ) : svg ? (
        <>
          <div aria-label="QR code to connect another device" role="img"
            style={{ background: '#fff', padding: 8, borderRadius: 'var(--r-md)', width: 220, maxWidth: '100%', lineHeight: 0 }}
            dangerouslySetInnerHTML={{ __html: svg }} />
          <p className="small" style={{ margin: 0 }}>
            <b>Scan with your phone's camera</b> and open the link. It connects and loads your budget, with nothing to type.
          </p>
          <p className="small muted" style={{ margin: 0 }}>
            Works for {left} more minute{left === 1 ? '' : 's'}. Anyone who scans it can open your budget{withKey && aiKey ? ' and use your Google credit' : ''}${withBank && bankKey ? ' and see your bank transactions' : ''}, so only show it to your own devices.
          </p>
          {aiKey && (
            <label className="check-row small" style={{ minHeight: 0 }}>
              <input type="checkbox" checked={withKey} onChange={(e) => setWithKey(e.target.checked)} />
              Include the Google key, for reading documents
            </label>
          )}
          {bankKey && (
            <label className="check-row small" style={{ minHeight: 0 }}>
              <input type="checkbox" checked={withBank} onChange={(e) => setWithBank(e.target.checked)} />
              Include the bank connection
            </label>
          )}
        </>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>Making the code\u2026</p>
      )}
    </div>
  );
}
