import { useRef, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { ColorPicker, Disclosure, PageHead, Section } from '../../ui/components';
import { fmtDay, monthName, todayISO } from '../../core/dates';
import { clearPaydayMove, periodContaining, shiftPeriod } from '../../engine/periods';
import { cash, centsToInput, parseMoney } from '../../core/money';
import { nextColor } from '../../core/colors';
import { CostCategoriesEditor } from '../savings/CostCategories';
import { newId, useBudget } from '../../state/store';
import { ReaderCard } from '../../services/reader/ui/ReaderCard';
import { BankCard } from '../../services/bank/BankCard';
import { looksLikeBudget } from '../../core/valid';
import { readTheme, saveTheme, type Theme } from '../../ui/theme';
import type { Budget, RuleBucket } from '../../core/types';
import { SyncCard } from '../../services/sync/SyncCard';
import { ExportMonth } from './ExportMonth';
import { SavedCopies } from './SavedCopies';

const RULES = [
  { name: '50/30/20', needs: 50, wants: 30, savings: 20 },
  { name: '60/20/20', needs: 60, wants: 20, savings: 20 },
  { name: '70/20/10', needs: 70, wants: 20, savings: 10 },
];

/** 1st, 2nd, 3rd, 4th… 11th, 12th, 13th… 21st. */
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

export function SettingsPage() {
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
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `budget-backup-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Not straight away: Safari (iPhone) hasn't started the download yet, and it would fail.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function importData(file: File) {
    try {
      const data: unknown = JSON.parse(await file.text());
      if (!looksLikeBudget(data)) throw new Error('bad');
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
        <div className="form-grid roomy">
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
              <option value="friday">Friday before</option>
              <option value="monday">Monday after</option>
            </select>
          </label>
          <label className="field">If it falls on a Sunday
            <select value={s.sunday} onChange={(e) => setS('sunday', e.target.value as 'friday' | 'monday')}>
              <option value="friday">Friday before</option>
              <option value="monday">Monday after</option>
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

      <ReaderCard />

      <BankCard />

      <ExportMonth />

      <SavedCopies />

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
