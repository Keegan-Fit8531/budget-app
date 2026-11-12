import { useMemo, useState } from 'react';
import { Donut } from '../components/Donut';
import { Icon } from '../components/Icon';
import { GoalCosts } from '../components/GoalCosts';
import { GoalGifts, PeopleChips, savedSlices, tracksPeople } from '../components/GoalGifts';
import { summariseCosts } from '../lib/goalcosts';
import { paidDirect } from '../lib/contributions';
import { PaydayControl } from '../components/PaydayControl';
import { SavingsChart } from '../components/SavingsChart';
import { nextColor } from '../lib/colors';
import { fmtShort, monthName, todayISO } from '../lib/dates';
import { averageSplit, planFor } from '../lib/engine';
import { PayNav, useViewPeriod } from '../lib/period';
import { centsToInput, money, parseMoney } from '../lib/money';
import { forecast } from '../lib/savings';
import { newId, useBudget } from '../lib/store';
import type { SavingsGoal } from '../lib/types';

export function Savings() {
  const { budget } = useBudget();
  const goals = budget.savings ?? [];
  const today = todayISO();
  const [modal, setModal] = useState<{ goal?: SavingsGoal } | null>(null);
  const { period } = useViewPeriod();
  const plan = useMemo(() => planFor(budget, period), [budget, period]);

  const forecasts = goals.map((g) => forecast(budget, g, today));
  const saved = goals.reduce((t, g) => t + g.balance, 0);
  const latestSlip = Object.entries(budget.payslips ?? {}).sort((a, b) => b[0].localeCompare(a[0]))[0]?.[1];
  const kiwi = latestSlip ? (latestSlip.kiwisaver ?? 0) + (latestSlip.employerKiwisaver ?? 0) : 0;

  return (
    <>
      <header className="between">
        <div>
          <h1 className="h1">Savings</h1>
          <p className="small muted">Goals, how they're tracking, and what each payday puts towards them.</p>
        </div>
        <button className="btn primary" onClick={() => setModal({})}><Icon name="plus" /> Add goal</button>
      </header>
      <div className="card" style={{ padding: '10px 14px' }}><PayNav compact /></div>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <div className="stat" style={{ background: 'var(--card)' }}><span className="small muted">Saved so far</span><b>{money(saved)}</b></div>
        <div className="stat" style={{ background: 'var(--card)' }}>
          <span className="small muted">{monthName(period.start)} pay</span>
          <b>{money(goals.reduce((t, g) => t + (plan.accounts.find((a) => a.account.id === g.accountId)?.funded ?? 0), 0))}</b>
          <span className="small muted">normally {money(goals.reduce((t, g) => t + averageSplit(budget, g.accountId), 0))}</span>
        </div>
        {kiwi > 0 && (
          <div className="stat" style={{ background: 'var(--card)' }}><span className="small muted">KiwiSaver each pay</span><b>{money(kiwi)}</b><span className="small muted">you + employer, from your payslip</span></div>
        )}
      </section>

      {goals.length === 0 && <p className="muted">Add a goal to start tracking your savings.</p>}

      <SavingsChart budget={budget} />

      {forecasts.map((f) => <GoalCard key={f.goal.id} f={f} plan={plan} period={period} onEdit={() => setModal({ goal: f.goal })} />)}

      {modal && <GoalModal goal={modal.goal} onClose={() => setModal(null)} />}
    </>
  );
}

type Tab = 'costs' | 'money' | 'payday';

/** One savings goal: a short summary (pie, saved, one status line), then tabs for costs, money in and out, and payday. */
function GoalCard({ f, plan, period, onEdit }: { f: ReturnType<typeof forecast>; plan: ReturnType<typeof planFor>; period: ReturnType<typeof useViewPeriod>['period']; onEdit: () => void }) {
  const { budget } = useBudget();
  const today = todayISO();
  const g = f.goal;
  const acc = budget.accounts.find((a) => a.id === g.accountId);
  const funded = plan.accounts.find((a) => a.account.id === g.accountId);
  const people = tracksPeople(budget, g);
  const costs = g.costs ?? [];
  const c = costs.length ? summariseCosts(budget, g, today) : undefined;
  // What the goal is aiming for: its target, or (for a goal with costs, like the wedding) the total costs.
  const aim = g.target ?? (c ? c.total : undefined);
  // Costs already paid by someone directly (not from the fund) count as covered.
  const direct = paidDirect(g);
  const pct = aim ? Math.min(100, ((g.balance + direct) / aim) * 100) : 0;
  const color = acc?.color ?? '#22C55E';
  const slices = people && savedSlices(budget, g, aim).length
    ? savedSlices(budget, g, aim)
    : aim ? [{ label: 'Saved', value: g.balance, color }, ...(direct ? [{ label: 'Paid already', value: direct, color: '#94A3B8' }] : []), { label: 'To go', value: Math.max(0, aim - g.balance - direct), color: 'var(--soft)' }]
    : [{ label: 'Saved', value: 1, color }];
  const usual = averageSplit(budget, g.accountId);
  const thisPay = funded?.funded ?? 0;
  const tabKey = `paydays.goaltab.${g.id}`;
  const [tab, setTabState] = useState<Tab>(() => {
    try { const t = localStorage.getItem(tabKey) as Tab | null; if (t) return t; } catch { /* ignore */ }
    return costs.length ? 'costs' : 'payday';
  });
  const setTab = (t: Tab) => { setTabState(t); try { localStorage.setItem(tabKey, t); } catch { /* ignore */ } };
  const when = g.targetDate ? `${fmtShort(g.targetDate)} ${g.targetDate.slice(0, 4)}` : '';

  // One status line: the thing to know about this goal right now.
  let status: { text: string; tone: 'pos' | 'neg' | 'muted' };
  if (c && c.leftAtTarget !== undefined) {
    status = c.leftAtTarget < 0
      ? { text: `${money(-c.leftAtTarget, { whole: true })} short of the costs by ${when}${c.neededPerPay ? ` · send ${money(c.neededPerPay, { whole: true })} a pay to cover it` : ''}`, tone: 'neg' }
      : { text: `Costs covered by ${when}, with ${money(c.leftAtTarget, { whole: true })} spare`, tone: 'pos' };
  } else if (g.target && f.remaining === 0) status = { text: 'Goal reached', tone: 'pos' };
  else if (f.onTrack === false && f.requiredPerPay !== undefined) status = { text: `Behind: send ${money(f.requiredPerPay, { whole: true })} a pay to reach it by ${when}`, tone: 'neg' };
  else if (f.onTrack === true) status = { text: `On track for ${when}`, tone: 'pos' };
  else if (g.target && f.reachedBy) status = { text: `Reached by about ${monthName(f.reachedBy)} ${f.reachedBy.slice(0, 4)}`, tone: 'muted' };
  else status = { text: `About ${money(f.projected, { whole: true })} in 12 pays`, tone: 'muted' };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'costs', label: costs.length ? `Costs · ${costs.length}` : 'Costs' },
    { id: 'money', label: g.gifts?.length ? `Money · ${g.gifts.length}` : 'Money' },
    { id: 'payday', label: 'Payday' },
  ];

  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="between" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="h2">{g.name}</h2>
          {(() => {
            const sub = [acc && !acc.name.toLowerCase().includes(g.name.toLowerCase()) ? acc.name : null, g.note].filter(Boolean).join(' · ');
            return sub ? <p className="small muted">{sub}</p> : null;
          })()}
        </div>
        <button className="btn small" onClick={onEdit}><Icon name="edit" size={16} /> Edit</button>
      </div>

      <div className="row" style={{ flexWrap: 'nowrap', gap: 16, alignItems: 'center' }}>
        <Donut size={104} slices={slices}>
          <b style={{ fontSize: 16 }}>{aim ? `${Math.round(pct)}%` : money(g.balance, { whole: true })}</b>
          <span className="small muted">{direct ? 'covered' : 'saved'}</span>
        </Donut>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>{money(g.balance, { whole: true })}</span>
          <span className="small muted">{direct ? `saved + ${money(direct, { whole: true })} paid already · ` : ''}{aim ? `of ${money(aim, { whole: true })}${g.target ? ' target' : ' costs'} · ` : ''}updated {fmtShort(g.asOf)}</span>
          <span className={`small ${status.tone}`} style={{ fontWeight: 600 }}>{status.text}</span>
          <span className="small muted">
            {monthName(period.start)} pay {money(thisPay, { whole: true })}{thisPay !== usual ? ` (usually ${money(usual, { whole: true })})` : ''}
            {f.periodsLeft !== undefined ? ` · ${f.periodsLeft} pays left` : ''}
            {g.otherPerPay ? ` · +${money(g.otherPerPay, { whole: true })} a pay from elsewhere` : ''}
          </span>
        </div>
      </div>

      {people && <PeopleChips goal={g} />}

      <div className="seg" role="tablist" aria-label={`${g.name} details`} style={{ alignSelf: 'stretch', display: 'flex' }}>
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)} style={{ flex: 1, paddingInline: 6 }}>{t.label}</button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'costs' && <GoalCosts goal={g} />}
        {tab === 'money' && <GoalGifts goal={g} />}
        {tab === 'payday' && (
          <PaydayControl accountId={g.accountId} sends={funded?.funded ?? 0} needs={funded?.need ?? 0}
            autoLabel="Send what's needed to hit the target date"
            autoHint={g.target && g.targetDate ? 'Works out the per-pay amount from your target and date.' : 'Needs a target and a target date.'} />
        )}
      </div>
    </section>
  );
}

export function GoalModal({ goal, onClose }: { goal?: SavingsGoal; onClose: () => void }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const usedByGoals = new Set((budget.savings ?? []).filter((g) => g.id !== goal?.id).map((g) => g.accountId));
  const debtAccounts = new Set((budget.debts ?? []).map((d) => d.accountId));
  const options = budget.accounts.filter((a) => !a.archived && a.id !== budget.settings.payAccountId && !debtAccounts.has(a.id) && !usedByGoals.has(a.id));
  const [name, setName] = useState(goal?.name ?? '');
  const [accountId, setAccountId] = useState(goal?.accountId ?? 'new');
  const [balance, setBalance] = useState(goal ? centsToInput(goal.balance) : '');
  const [target, setTarget] = useState(goal?.target !== undefined ? centsToInput(goal.target) : '');
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '');
  const [other, setOther] = useState(goal?.otherPerPay ? centsToInput(goal.otherPerPay) : '');
  const [note, setNote] = useState(goal?.note ?? '');
  const [err, setErr] = useState('');

  function save() {
    if (!name.trim()) return setErr('Enter a name.');
    const bal = balance.trim() === '' ? 0 : parseMoney(balance);
    const tgt = target.trim() === '' ? undefined : parseMoney(target);
    const oth = other.trim() === '' ? undefined : parseMoney(other);
    if (bal === null || bal < 0) return setErr('Check the amount saved.');
    if (tgt === null || (tgt !== undefined && tgt <= 0)) return setErr('Check the target amount.');
    if (oth === null) return setErr('Check the other contributions.');
    update((b) => {
      b.savings = b.savings ?? [];
      let accId = accountId;
      if (accId === 'new') {
        accId = newId();
        const groupId = b.groups.find((g) => g.id === 'savings')?.id ?? b.groups.find((g) => g.bucket === 'savings')?.id ?? b.groups[0]?.id ?? '';
        b.accounts.push({ id: accId, name: name.trim(), kind: 'bank', color: nextColor(b.accounts.map((x) => x.color)), groupId });
        b.split.push({ accountId: accId, amount: 0 });
      }
      const balanceChanged = !goal || goal.balance !== bal;
      // Keep everything the form doesn't edit (costs, money added…) from the saved goal.
      const existing = goal ? b.savings.find((x) => x.id === goal.id) : undefined;
      const next: SavingsGoal = {
        ...existing,
        id: goal?.id ?? newId(), name: name.trim(), accountId: accId, balance: bal,
        asOf: balanceChanged ? today : goal!.asOf, target: tgt, targetDate: targetDate || undefined,
        otherPerPay: oth || undefined, note: note.trim() || undefined,
      };
      const i = b.savings.findIndex((x) => x.id === next.id);
      if (i >= 0) b.savings[i] = next; else b.savings.push(next);
      return b;
    });
    onClose();
  }
  function remove() {
    if (!goal || !confirm(`Remove the ${goal.name} goal? The account stays in your payday split.`)) return;
    update((b) => ({ ...b, savings: (b.savings ?? []).filter((x) => x.id !== goal.id) }));
    onClose();
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="goal-title" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2 id="goal-title" className="h2">{goal ? `Edit ${goal.name}` : 'Add a savings goal'}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <label className="field">Name
          <input autoFocus={!goal} value={name} onChange={(e) => { setName(e.target.value); setErr(''); }} placeholder="Emergency fund" />
        </label>
        <label className="field">Saved in
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="new">A new account</option>
            {options.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <div className="form-grid">
          <label className="field">Saved so far
            <input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0.00" />
          </label>
          <label className="field">Target (optional)
            <input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="20,000.00" />
          </label>
          <label className="field">Target date (optional)
            <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          </label>
          <label className="field">Others add each pay (optional)
            <input inputMode="decimal" value={other} onChange={(e) => setOther(e.target.value)} placeholder="e.g. a partner's share" />
          </label>
        </div>
        <label className="field">Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {targetDate && targetDate <= today && <p className="small muted">That target date has passed, so nothing more is planned for this goal. Pick a later date to keep saving towards it.</p>}
        <p className="small muted">Update "saved so far" whenever you check your balance. Investment fund returns aren't predicted.</p>
        {err && <p className="error" role="alert">{err}</p>}
        <div className="between">
          {goal ? <button className="btn ghost danger" onClick={remove}>Remove goal</button> : <span />}
          <div className="row">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save}>{goal ? 'Save' : 'Add'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
