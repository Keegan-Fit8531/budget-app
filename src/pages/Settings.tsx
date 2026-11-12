import { useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { fmtDay, monthName, todayISO } from '../lib/dates';
import { periodContaining, shiftPeriod } from '../lib/engine';
import { centsToInput, money, parseMoney } from '../lib/money';
import { nextColor } from '../lib/colors';
import { CostCategoriesEditor } from '../components/CostCategories';
import { newId, readVersions, useBudget } from '../lib/store';
import { readSyncConfig, SyncError } from '../lib/sync';
import type { Budget, RuleBucket } from '../lib/types';

const RULES = [
  { name: '50/30/20', needs: 50, wants: 30, savings: 20 },
  { name: '60/20/20', needs: 60, wants: 20, savings: 20 },
  { name: '70/20/10', needs: 70, wants: 20, savings: 10 },
];

export function Settings() {
  const { budget, update, replace, reset, sync } = useBudget();
  const s = budget.settings;
  const [payText, setPayText] = useState(centsToInput(s.expectedPay));
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const p0 = periodContaining(todayISO(), s);
  const upcoming = [0, 1, 2, 3, 4, 5].map((n) => shiftPeriod(p0, n, s));
  const history = Object.entries(budget.payActuals).sort((a, b) => b[0].localeCompare(a[0]));
  const nets = history.map(([, n]) => n);
  const avgPay = nets.length ? Math.round(nets.reduce((x, y) => x + y, 0) / nets.length) : 0;
  const minPay = nets.length ? Math.min(...nets) : 0;
  const maxPay = nets.length ? Math.max(...nets) : 0;

  function setS<K extends keyof Budget['settings']>(k: K, v: Budget['settings'][K]) {
    update((b) => { b.settings[k] = v; return b; });
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(budget, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `budget-backup-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importData(file: File) {
    try {
      const data = JSON.parse(await file.text()) as Budget;
      if (data.version !== 1 || !Array.isArray(data.accounts)) throw new Error('bad');
      replace(data);
      setMsg('Backup restored.');
    } catch {
      setMsg('That file isn’t a budget backup.');
    }
  }

  return (
    <>
      <header><h1 className="h1">Settings</h1></header>

      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h2 className="h2">Pay</h2>
        <div className="form-grid">
          <label className="field">Payday (day of month)
            <input type="number" min={1} max={31} value={s.paydayDay}
              onChange={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= 31) setS('paydayDay', n); }} />
          </label>
          <label className="field">If it falls on a Saturday
            <select value={s.saturday} onChange={(e) => setS('saturday', e.target.value as 'friday' | 'monday')}>
              <option value="friday">Paid Friday before</option>
              <option value="monday">Paid Monday after</option>
            </select>
          </label>
          <label className="field">If it falls on a Sunday
            <select value={s.sunday} onChange={(e) => setS('sunday', e.target.value as 'friday' | 'monday')}>
              <option value="friday">Paid Friday before</option>
              <option value="monday">Paid Monday after</option>
            </select>
          </label>
          <label className="field">Expected pay (NZD)
            <input inputMode="decimal" value={payText} onChange={(e) => setPayText(e.target.value)}
              onBlur={() => { const c = parseMoney(payText); if (c !== null && c > 0) setS('expectedPay', c); else setPayText(centsToInput(s.expectedPay)); }} />
          </label>
          <label className="field">Pay lands in
            <select value={s.payAccountId} onChange={(e) => setS('payAccountId', e.target.value)}>
              {budget.accounts.filter((a) => a.kind === 'bank' && !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        </div>
        <div>
          <p className="small muted" style={{ marginBottom: 6 }}>Your next paydays</p>
          <div className="conv">{upcoming.map((p) => <span key={p.start}>{fmtDay(p.start)} · {p.days} days</span>)}</div>
        </div>
      </section>

      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h2 className="h2">Pay history</h2>
        {history.length === 0 && <p className="small muted">Upload a payslip on the Planner to start your pay history.</p>}
        {history.map(([start, net]) => {
          const slip = budget.payslips?.[start];
          return (
            <div key={start} className="list-row" style={{ alignItems: 'flex-start' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                {monthName(start)} {start.slice(0, 4)}
                <span className="small muted" style={{ display: 'block' }}>
                  {slip
                    ? `Paid ${fmtDay(slip.payDay)}` +
                      (slip.paye !== undefined ? ` · PAYE ${money(slip.paye)}` : '') +
                      (slip.studentLoan !== undefined ? ` · student loan ${money(slip.studentLoan)}` : '') +
                      (slip.kiwisaver !== undefined ? ` · KiwiSaver ${money(slip.kiwisaver)}` : '') +
                      (slip.employerKiwisaver !== undefined ? ` + ${money(slip.employerKiwisaver)} employer` : '')
                    : 'Typed in'}
                </span>
              </span>
              <b>{money(net)}</b>
              <button className="btn small ghost" aria-label={`Remove ${monthName(start)} pay`}
                onClick={() => update((b) => { delete b.payActuals[start]; if (b.payslips) delete b.payslips[start]; return b; })}>
                <Icon name="x" size={16} />
              </button>
            </div>
          );
        })}
        {history.length > 1 && (
          <div className="between" style={{ marginTop: 6 }}>
            <span className="small muted">Average {money(avgPay)} · range {money(minPay)} – {money(maxPay)}</span>
            <button className="btn small" onClick={() => { setS('expectedPay', avgPay); setPayText(centsToInput(avgPay)); }}>Use average as expected pay</button>
          </div>
        )}
      </section>

      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h2 className="h2">Budgeting rule</h2>
        <div className="seg" role="group" aria-label="Rule" style={{ alignSelf: 'flex-start' }}>
          {RULES.map((r) => (
            <button key={r.name} aria-pressed={s.rule.name === r.name} onClick={() => setS('rule', r)}>{r.name}</button>
          ))}
          <button aria-pressed={!RULES.some((r) => r.name === s.rule.name)} onClick={() => setS('rule', { ...s.rule, name: 'Custom' })}>Custom</button>
        </div>
        <div className="form-grid">
          {(['needs', 'wants', 'savings'] as RuleBucket[]).map((k) => (
            <label key={k} className="field">{k === 'savings' ? 'Savings and debt %' : `${k[0].toUpperCase()}${k.slice(1)} %`}
              <input type="number" min={0} max={100} value={s.rule[k]}
                onChange={(e) => setS('rule', { ...s.rule, name: 'Custom', [k]: Number(e.target.value) })} />
            </label>
          ))}
        </div>
      </section>

      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="between">
          <h2 className="h2">Groups</h2>
          <button className="btn small" onClick={() => update((b) => { b.groups.push({ id: newId(), name: 'New group', color: nextColor(b.groups.map((x) => x.color)), bucket: 'wants' }); return b; })}>
            <Icon name="plus" size={16} /> Add group
          </button>
        </div>
        <p className="small muted">Groups drive the pie charts. Each one counts toward needs, wants or savings for the rule.</p>
        {budget.groups.map((g) => (
          <div key={g.id} className="form-grid" style={{ alignItems: 'end' }}>
            <label className="field">Name
              <input value={g.name} onChange={(e) => update((b) => { b.groups.find((x) => x.id === g.id)!.name = e.target.value; return b; })} />
            </label>
            <label className="field">Counts as
              <select value={g.bucket} onChange={(e) => update((b) => { b.groups.find((x) => x.id === g.id)!.bucket = e.target.value as RuleBucket; return b; })}>
                <option value="needs">Needs</option><option value="wants">Wants</option><option value="savings">Savings and debt</option>
              </select>
            </label>
            <label className="field">Colour
              <input type="color" value={g.color} style={{ padding: 4 }}
                onChange={(e) => update((b) => { b.groups.find((x) => x.id === g.id)!.color = e.target.value; return b; })} />
            </label>
          </div>
        ))}
      </section>

      <CostCategoriesEditor />

      <EarlierVersions />

      <SyncCard />

      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 className="h2">Your data</h2>
        <p className="small muted">{sync.state === 'off' ? 'Right now your budget is saved in this browser only. Download a backup to move it to another device, or sync it below.' : 'Saved in this browser and synced to your private GitHub repo. A backup file is a copy you keep yourself.'}</p>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn" onClick={exportData}>Download backup</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>Restore backup</button>
          <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importData(e.target.files[0])} />
          <button className="btn danger" onClick={() => { if (confirm(`Start over with a blank budget?${sync.state === 'off' ? '' : ' It syncs to every browser, but your current budget stays in Earlier versions and in the repo\u2019s history.'}`)) { reset(); setMsg('Started over with a blank budget.'); } }}>
            Start over
          </button>
        </div>
        {msg && <p className="small" role="status">{msg}</p>}
      </section>
    </>
  );
}

/** Restore an earlier version of everything (kept automatically before changes). */
function EarlierVersions() {
  const { restoreVersion } = useBudget();
  const [versions, setVersions] = useState(readVersions);
  const [msg, setMsg] = useState('');
  const summary = (b: Budget) => {
    const w = (b.savings ?? []).find((g) => g.id === 'wedding');
    const costs = (b.savings ?? []).reduce((t, g) => t + (g.costs?.length ?? 0), 0);
    const debts = (b.debts ?? []).reduce((t, d) => t + d.plans.length, 0);
    return `${costs} savings costs${w ? ` · wedding ${money(w.balance, { whole: true })} saved` : ''} · ${debts} debt plans`;
  };
  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 className="h2">Restore an earlier version</h2>
      <p className="small muted">A copy of everything is kept automatically before changes (the last {30}, at most one every 2 minutes). Restoring keeps a copy of what you have now first, so you can switch back.</p>
      {versions.length === 0 && <p className="small muted">No earlier versions yet. They build up as you make changes.</p>}
      {versions.slice(0, 12).map((v) => (
        <div key={v.at} className="list-row">
          <span style={{ flex: 1, minWidth: 0 }}>
            <b>{new Date(v.at).toLocaleString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</b>
            <span className="small muted" style={{ display: 'block' }}>{summary(v.budget)}</span>
          </span>
          <button className="btn small" onClick={() => {
            if (!confirm('Go back to this version? What you have now is kept as a version too.')) return;
            restoreVersion(v); setMsg('Restored.'); setTimeout(() => setVersions(readVersions()), 50);
          }}>Restore</button>
        </div>
      ))}
      {msg && <p className="small" role="status">{msg}</p>}
    </section>
  );
}

/** Connect this browser to a private GitHub repo, so every browser has the same budget. */
function SyncCard() {
  const { sync, connectSync, disconnectSync, syncNow } = useBudget();
  const saved = readSyncConfig();
  // On <you>.github.io, the data repo is most likely <you>/budget-data, so start with that.
  const [repo, setRepo] = useState(saved?.repo ?? guessRepo());
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

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
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="between">
        <h2 className="h2">Sync across browsers</h2>
        {sync.state !== 'off' && (
          <span className={`pill ${sync.state === 'error' ? 'bad' : 'good'}`} style={{ background: sync.state === 'error' ? 'var(--bad-bg)' : 'var(--good-bg)' }} role="status">
            {sync.state === 'syncing' ? 'Syncing\u2026' : sync.state === 'synced' ? `Synced ${new Date(sync.at).toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' })}` : 'Not synced'}
          </span>
        )}
      </div>
      {sync.state === 'off' ? (
        <>
          <p className="small muted">
            Keep your budget in a <b>private</b> GitHub repo, so it's the same in every browser and on your phone. Do this once in each browser.
          </p>
          <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
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
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn" onClick={syncNow} disabled={sync.state === 'syncing'}>Sync now</button>
            <button className="btn" onClick={disconnectSync}>Disconnect this browser</button>
          </div>
        </>
      )}
    </section>
  );
}

/** On <you>.github.io the private data repo is guessed as <you>/budget-data (you can change it). */
function guessRepo(): string {
  const m = location.hostname.match(/^([\w-]+)\.github\.io$/i);
  return m ? `${m[1]}/budget-data` : '';
}
