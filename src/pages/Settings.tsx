import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Icon } from '../components/Icon';
import { ColorPicker, Disclosure, PageHead, Section } from '../components/ui';
import { fmtDay, monthName, todayISO } from '../lib/dates';
import { budgetPeriod, clearPaydayMove, periodContaining, shiftPeriod } from '../lib/engine';
import { downloadMonth, exportablePeriods, periodLabel } from '../lib/export';
import { cash, centsToInput, parseMoney } from '../lib/money';
import { nextColor } from '../lib/colors';
import { CostCategoriesEditor } from '../components/CostCategories';
import { newId, readVersions, useBudget } from '../lib/store';
import { pairingLink, readSyncConfig, SyncError, type SyncConfig } from '../lib/sync';
import { readTheme, saveTheme, type Theme } from '../lib/theme';
import type { Budget, RuleBucket } from '../lib/types';

const RULES = [
  { name: '50/30/20', needs: 50, wants: 30, savings: 20 },
  { name: '60/20/20', needs: 60, wants: 20, savings: 20 },
  { name: '70/20/10', needs: 70, wants: 20, savings: 10 },
];

/** 1st, 2nd, 3rd, 4th… 11th, 12th, 13th… 21st. */
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

export function Settings() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const { budget, update, replace, reset, sync } = useBudget();
  const s = budget.settings;
  const [payText, setPayText] = useState(centsToInput(s.expectedPay));
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const p0 = periodContaining(todayISO(), s);
  const upcoming = [0, 1, 2, 3, 4, 5].map((n) => shiftPeriod(p0, n, s));

  // The payday day moves every pay, so it's only changed on purpose: what's typed is held here and
  // nothing changes until it's confirmed (a stray key press or scroll can't shift the budget).
  const [dayDraft, setDayDraft] = useState<string | null>(null);
  const dayText = dayDraft ?? String(s.paydayDay);
  const typedDay = /^\d{1,2}$/.test(dayText.trim()) ? Number(dayText.trim()) : NaN;
  const dayBad = dayDraft !== null && dayDraft.trim() !== '' && !(typedDay >= 1 && typedDay <= 31);
  const newDay = dayDraft !== null && !dayBad && typedDay !== s.paydayDay && !Number.isNaN(typedDay) ? typedDay : undefined;
  const withNewDay = newDay !== undefined ? periodContaining(todayISO(), { ...s, paydayDay: newDay }) : undefined;
  const dayMove = !withNewDay ? ''
    : withNewDay.start === todayISO() && p0.start !== withNewDay.start ? `Today becomes payday, and the next one is ${fmtDay(withNewDay.nextPayday)} (it's ${fmtDay(p0.nextPayday)} now).`
    : withNewDay.nextPayday === p0.nextPayday ? `Your next payday is still ${fmtDay(p0.nextPayday)}; later paydays move.`
    : `Your next payday moves from ${fmtDay(p0.nextPayday)} to ${fmtDay(withNewDay.nextPayday)}.`;
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

  const costCount = (budget.costCategories ?? []).length;

  return (
    <>
      <PageHead title="Settings" />

      {/* Pay and the rule are what the budget runs on, so they're open. The rest opens when you need it. */}
      <section className="card stack gap-16">
        <h2 className="h2">Pay</h2>
        <div className="form-grid">
          <label className="field">Payday (day of month)
            <input inputMode="numeric" value={dayText} aria-invalid={dayBad || undefined}
              onChange={(e) => setDayDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setDayDraft(null); }}
              onBlur={() => { if (newDay === undefined) setDayDraft(null); }} />
            {dayBad && <span className="error" role="alert">Enter a day of the month, from 1 to 31.</span>}
          </label>
          {newDay !== undefined && (
            <div className="tip stack gap-8 under" role="group" aria-label="Change payday">
              <span>
                <b>Change payday from the {ordinal(s.paydayDay)} to the {ordinal(newDay)}?</b>{' '}
                {dayMove} Every pay is then re-planned around the new dates, so costs dated near payday can land in a different pay.
              </span>
              <div className="row wrap gap-8">
                <button className="btn small primary" onClick={() => { setS('paydayDay', newDay); setDayDraft(null); }}>Change payday</button>
                <button className="btn small" onClick={() => setDayDraft(null)}>Keep the {ordinal(s.paydayDay)}</button>
              </div>
            </div>
          )}
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
        <Disclosure title="Your next paydays" meta={`next ${fmtDay(upcoming[1]?.start ?? upcoming[0].start)}`}>
          <div className="conv">{upcoming.map((p) => <span key={p.start}>{fmtDay(p.start)} · {p.days} days</span>)}</div>
        </Disclosure>
      </section>

      <section className="card stack gap-16">
        <h2 className="h2">Budgeting rule</h2>
        <div className="seg" role="group" aria-label="Rule" style={{ alignSelf: 'flex-start' }}>
          {RULES.map((r) => (
            <button key={r.name} aria-pressed={s.rule.name === r.name} onClick={() => setS('rule', r)}>{r.name}</button>
          ))}
          <button aria-pressed={!RULES.some((r) => r.name === s.rule.name)} onClick={() => setS('rule', { ...s.rule, name: 'Custom' })}>Custom</button>
        </div>
        <div className="form-grid tight">
          {(['needs', 'wants', 'savings'] as RuleBucket[]).map((k) => (
            <label key={k} className="field">{k === 'savings' ? 'Savings, debt %' : `${k[0].toUpperCase()}${k.slice(1)} %`}
              <input type="number" min={0} max={100} value={s.rule[k]}
                onChange={(e) => setS('rule', { ...s.rule, name: 'Custom', [k]: Number(e.target.value) })} />
            </label>
          ))}
        </div>
      </section>

      <section className="card stack gap-12">
        <h2 className="h2">Appearance</h2>
        <div className="seg" role="group" aria-label="Appearance" style={{ alignSelf: 'flex-start' }}>
          {(['auto', 'light', 'dark'] as const).map((t) => (
            <button key={t} aria-pressed={theme === t} onClick={() => { setTheme(t); saveTheme(t); }}>
              {t === 'auto' ? 'Match device' : t === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
        <p className="small muted">Just for this device.</p>
      </section>

      <Section title="Pay history" summary={history.length ? `${history.length} pay${history.length === 1 ? '' : 's'} recorded · latest ${cash(history[0][1])}` : 'No pays recorded yet'}>
        {history.length === 0 && <p className="small muted">Upload a payslip on the Planner to start your pay history.</p>}
        <div>
          {history.map(([start, net]) => {
            const slip = budget.payslips?.[start];
            return (
              <div key={start} className="list-row top">
                <span className="grow">
                  {monthName(start)} {start.slice(0, 4)}
                  <span className="small muted block">
                    {slip
                      ? `Paid ${fmtDay(slip.payDay)}` +
                        (slip.paye !== undefined ? ` · PAYE ${cash(slip.paye)}` : '') +
                        (slip.studentLoan !== undefined ? ` · student loan ${cash(slip.studentLoan)}` : '') +
                        (slip.kiwisaver !== undefined ? ` · KiwiSaver ${cash(slip.kiwisaver)}` : '') +
                        (slip.employerKiwisaver !== undefined ? ` + ${cash(slip.employerKiwisaver)} employer` : '')
                      : 'Typed in'}
                  </span>
                </span>
                <b className="num">{cash(net)}</b>
                <button className="icon-btn mini plain" aria-label={`Remove ${monthName(start)} pay`}
                  onClick={() => update((b) => { delete b.payActuals[start]; if (b.payslips) delete b.payslips[start]; clearPaydayMove(b, start); return b; })}>
                  <Icon name="x" size={16} />
                </button>
              </div>
            );
          })}
        </div>
        {history.length > 1 && (
          <div className="between">
            <span className="small muted">Average {cash(avgPay)} · range {cash(minPay)} – {cash(maxPay)}</span>
            <button className="btn small" onClick={() => { setS('expectedPay', avgPay); setPayText(centsToInput(avgPay)); }}>Use average as expected pay</button>
          </div>
        )}
      </Section>

      <Section title="Groups" summary={budget.groups.map((g) => g.name).join(', ')}>
        <div className="between">
          <p className="small muted grow">Groups drive the charts. Each one counts toward needs, wants or savings for the rule.</p>
          <button className="btn small" onClick={() => update((b) => { b.groups.push({ id: newId(), name: 'New group', color: nextColor(b.groups.map((x) => x.color)), bucket: 'wants' }); return b; })}>
            <Icon name="plus" size={16} /> Add group
          </button>
        </div>
        {budget.groups.map((g, i) => (
          <div key={g.id} className={`form-grid group-row${i ? ' rest' : ''}`}>
            <label className="field"><span>Name</span>
              <input value={g.name} aria-label={`Group name: ${g.name}`} onChange={(e) => update((b) => { b.groups.find((x) => x.id === g.id)!.name = e.target.value; return b; })} />
            </label>
            <label className="field"><span>Counts as</span>
              <select value={g.bucket} aria-label={`${g.name} counts as`} onChange={(e) => update((b) => { b.groups.find((x) => x.id === g.id)!.bucket = e.target.value as RuleBucket; return b; })}>
                <option value="needs">Needs</option><option value="wants">Wants</option><option value="savings">Savings and debt</option>
              </select>
            </label>
            <ColorPicker value={g.color} onChange={(c) => update((b) => { b.groups.find((x) => x.id === g.id)!.color = c; return b; })} />
          </div>
        ))}
      </Section>

      <Section title="Savings cost categories" summary={costCount ? `${costCount} categor${costCount === 1 ? 'y' : 'ies'}` : 'For costs on savings goals'}>
        <CostCategoriesEditor />
      </Section>

      <SyncCard />

      <ExportMonth />

      <EarlierVersions />

      <Section title="Your data" summary="Download or restore a backup, or start over">
        <p className="small muted">{sync.state === 'off' ? 'Right now your budget is saved in this browser only. Download a backup to move it to another device, or sync it above.' : 'Saved in this browser and synced to your private GitHub repo. A backup file is a copy you keep yourself.'}</p>
        <div className="row wrap gap-8">
          <button className="btn" onClick={exportData}>Download backup</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>Restore backup</button>
          <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importData(e.target.files[0])} />
          <button className="btn danger" onClick={() => { if (confirm(`Start over with a blank budget?${sync.state === 'off' ? '' : ' It syncs to every browser, but your current budget stays in Earlier versions and in the repo\u2019s history.'}`)) { reset(); setMsg('Started over with a blank budget.'); } }}>
            Start over
          </button>
        </div>
        {msg && <p className="small" role="status">{msg}</p>}
      </Section>
    </>
  );
}

/** Download one pay (its summary, accounts and payments) as an Excel spreadsheet. */
function ExportMonth() {
  const { budget } = useBudget();
  const today = todayISO();
  const periods = exportablePeriods(budget, today);
  const [start, setStart] = useState(() => budgetPeriod(budget, today).start);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // If the paydays change, the chosen pay may no longer exist: fall back to the pay you're in.
  const period = periods.find((p) => p.start === start) ?? periods.find((p) => p.end >= today) ?? periods[0];

  async function download() {
    setBusy(true); setMsg(null);
    try {
      await downloadMonth(budget, period);
      setMsg({ ok: true, text: `Downloaded ${periodLabel(period)}.` });
    } catch {
      setMsg({ ok: false, text: 'Couldn\u2019t make the spreadsheet. Check your connection and try again.' });
    } finally { setBusy(false); }
  }

  return (
    <Section title="Export a month" summary="Download one pay as a spreadsheet">
      <p className="small muted">Download one pay as a spreadsheet (.xlsx) that opens in Excel, Numbers or Google Sheets: a summary, what payday sends to each account, and every payment due.</p>
      <div className="form-grid bottom">
        <label className="field">Month
          <select value={period.start} onChange={(e) => { setStart(e.target.value); setMsg(null); }}>
            {periods.map((p) => (
              <option key={p.start} value={p.start}>{periodLabel(p)} ({fmtDay(p.start)} – {fmtDay(p.end)})</option>
            ))}
          </select>
        </label>
        <div className="row"><button className="btn primary" onClick={download} disabled={busy}>{busy ? 'Making spreadsheet\u2026' : 'Export to spreadsheet'}</button></div>
      </div>
      {period.end < today && <p className="small muted">A past month is worked out from your budget as it is now, so costs you've changed since show their current amounts.</p>}
      {msg && <p className={`small${msg.ok ? '' : ' error'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    </Section>
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
    return `${costs} savings costs${w ? ` · wedding ${cash(w.balance, { whole: true })} saved` : ''} · ${debts} debt plans`;
  };
  return (
    <Section title="Restore an earlier version" summary={versions.length ? `${versions.length} earlier version${versions.length === 1 ? '' : 's'} kept` : 'None yet: they build up as you make changes'}>
      <p className="small muted">A copy of everything is kept automatically before changes (the last {30}, at most one every 2 minutes). Restoring keeps a copy of what you have now first, so you can switch back.</p>
      {versions.length === 0 && <p className="small muted">No earlier versions yet. They build up as you make changes.</p>}
      {versions.slice(0, 12).map((v) => (
        <div key={v.at} className="list-row">
          <span className="grow">
            <b>{new Date(v.at).toLocaleString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</b>
            <span className="small muted block">{summary(v.budget)}</span>
          </span>
          <button className="btn small" onClick={() => {
            if (!confirm('Go back to this version? What you have now is kept as a version too.')) return;
            restoreVersion(v); setMsg('Restored.'); setTimeout(() => setVersions(readVersions()), 50);
          }}>Restore</button>
        </div>
      ))}
      {msg && <p className="small" role="status">{msg}</p>}
    </Section>
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
  useEffect(() => {
    let live = true;
    const make = () => {
      const at = Date.now();
      QRCode.toString(pairingLink(config, at), { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
        .then((s) => { if (live) { setSvg(s); setUntil(at + 10 * 60_000); } })
        .catch(() => { if (live) setSvg(''); });
    };
    make();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { live = false; clearInterval(t); };
  }, [config]);
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
            Works for {left} more minute{left === 1 ? '' : 's'}. Anyone who scans it can open your budget, so only show it to your own devices.
          </p>
        </>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>Making the code\u2026</p>
      )}
    </div>
  );
}
