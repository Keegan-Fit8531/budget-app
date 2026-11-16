import { useMemo, useState, type ReactNode } from 'react';
import { Donut } from '../components/Donut';
import { Icon } from '../components/Icon';
import { MoveButtons, PageHead, ReorderToggle, SyncPill, useFlip } from '../components/ui';
import { moveAmong } from '../lib/order';
import { bankSync } from '../lib/bank';
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
import { cash, centsToInput, parseMoney } from '../lib/money';
import { forecast } from '../lib/savings';
import { isKiwiSaver, kiwiPerPay, recordReading } from '../lib/kiwisaver';
import { KiwiSaverCard } from '../components/KiwiSaver';
import { newId, useBudget } from '../lib/store';
import type { SavingsGoal } from '../lib/types';

export function Savings() {
  const { budget, update } = useBudget();
  const all = budget.savings ?? [];
  // KiwiSaver comes from your salary and is locked in: it has its own card, and isn't in the payday totals or projection.
  const goals = all.filter((g) => !isKiwiSaver(g));
  const kiwis = all.filter(isKiwiSaver);
  const today = todayISO();
  const [modal, setModal] = useState<{ goal?: SavingsGoal } | null>(null);
  const { period } = useViewPeriod();
  const plan = useMemo(() => planFor(budget, period), [budget, period]);

  const forecasts = goals.map((g) => forecast(budget, g, today));
  const [reorder, setReorder] = useState(false);
  const flip = useFlip(all.map((g) => g.id).join());
  // Goals and KiwiSaver cards are each moved among their own kind (they're shown in two runs).
  const mover = (g: SavingsGoal, list: SavingsGoal[]) => {
    if (!reorder || list.length < 2) return null;
    const order = list.map((x) => x.id);
    const i = order.indexOf(g.id);
    return <MoveButtons name={g.name} first={i === 0} last={i === order.length - 1}
      onMove={(dir) => { flip.capture(); update((b) => { moveAmong(b.savings ?? [], order, g.id, dir); return b; }); }} />;
  };
  // Its balance from the bank connection (KiwiSaver, an investment), when it's linked.
  const pill = (g: SavingsGoal) => {
    const s1 = bankSync(budget, `saving:${g.id}`), s2 = bankSync(budget, `account:${g.accountId}`);
    return s1.linked || s2.linked ? <SyncPill source="bank" at={s1.at ?? s2.at ?? g.asOf} /> : null;
  };
  const saved = goals.reduce((t, g) => t + g.balance, 0);
  const kiwi = kiwiPerPay(budget)?.total ?? 0;
  const kiwiSaved = kiwis.reduce((t, g) => t + g.balance, 0);

  return (
    <>
      <PageHead title="Savings" sub="Goals, how they're tracking, and what each payday puts towards them.">
        <PayNav compact />
        <div className="page-actions">
          {(goals.length > 1 || kiwis.length > 1) && <ReorderToggle on={reorder} onChange={setReorder} />}
          <button className="btn primary" onClick={() => setModal({})}><Icon name="plus" /> Add goal</button>
        </div>
      </PageHead>

      <section className="stats">
        <div className="stat"><span className="small muted">Saved so far</span><b>{cash(saved)}</b></div>
        <div className="stat">
          <span className="small muted">{monthName(period.start)} pay</span>
          <b>{cash(goals.reduce((t, g) => t + (plan.accounts.find((a) => a.account.id === g.accountId)?.funded ?? 0), 0))}</b>
          <span className="small muted">normally {cash(goals.reduce((t, g) => t + averageSplit(budget, g.accountId), 0))}</span>
        </div>
        {kiwis.length > 0 ? (
          <div className="stat"><span className="small muted">KiwiSaver</span><b>{cash(kiwiSaved, { whole: true })}</b>{kiwi > 0 && <span className="small muted">+{cash(kiwi)} each pay, from your salary</span>}</div>
        ) : kiwi > 0 && (
          <div className="stat"><span className="small muted">KiwiSaver each pay</span><b>{cash(kiwi)}</b><span className="small muted">you + employer, after tax</span></div>
        )}
      </section>

      {all.length === 0 && <p className="muted">Add a goal to start tracking your savings.</p>}

      <div ref={flip.ref} className={`stack gap-20${reorder ? ' reordering' : ''}`}>
        {forecasts.map((f) => <GoalCard key={f.goal.id} f={f} plan={plan} period={period} extra={<>{pill(f.goal)}{mover(f.goal, goals)}</>} onEdit={() => setModal({ goal: f.goal })} />)}
        {kiwis.map((g) => <KiwiSaverCard key={g.id} goal={g} extra={<>{pill(g)}{mover(g, kiwis)}</>} onEdit={() => setModal({ goal: g })} />)}
      </div>

      {goals.length > 0 && <SavingsChart budget={{ ...budget, savings: goals }} />}

      {modal && <GoalModal goal={modal.goal} onClose={() => setModal(null)} />}
    </>
  );
}

type Tab = 'costs' | 'money' | 'payday';

/** One savings goal: a short summary (pie, saved, one status line), then tabs for costs, money in and out, and payday. */
function GoalCard({ f, plan, period, onEdit, extra }: { f: ReturnType<typeof forecast>; plan: ReturnType<typeof planFor>; period: ReturnType<typeof useViewPeriod>['period']; onEdit: () => void; extra?: ReactNode }) {
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
  const color = acc?.color ?? 'var(--brand-2)';
  const slices = people && savedSlices(budget, g, aim).length
    ? savedSlices(budget, g, aim)
    : aim ? [{ label: 'Saved', value: g.balance, color }, ...(direct ? [{ label: 'Paid already', value: direct, color: 'var(--muted)' }] : []), { label: 'To go', value: Math.max(0, aim - g.balance - direct), color: 'var(--soft)' }]
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
      ? { text: `${cash(-c.leftAtTarget, { whole: true })} short of the costs by ${when}${c.neededPerPay ? ` · send ${cash(c.neededPerPay, { whole: true })} a pay to cover it` : ''}`, tone: 'neg' }
      : { text: `Costs covered by ${when}, with ${cash(c.leftAtTarget, { whole: true })} spare`, tone: 'pos' };
  } else if (g.target && f.remaining === 0) status = { text: 'Goal reached', tone: 'pos' };
  else if (f.onTrack === false && f.requiredPerPay !== undefined) status = { text: `Behind: send ${cash(f.requiredPerPay, { whole: true })} a pay to reach it by ${when}`, tone: 'neg' };
  else if (f.onTrack === true) status = { text: `On track for ${when}`, tone: 'pos' };
  else if (g.target && f.reachedBy) status = { text: `Reached by about ${monthName(f.reachedBy)} ${f.reachedBy.slice(0, 4)}`, tone: 'muted' };
  else status = { text: `About ${cash(f.projected, { whole: true })} in 12 pays`, tone: 'muted' };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'costs', label: costs.length ? `Costs · ${costs.length}` : 'Costs' },
    { id: 'money', label: g.gifts?.length ? `Money · ${g.gifts.length}` : 'Money' },
    { id: 'payday', label: 'Payday' },
  ];

  return (
    <section className="card stack gap-12" data-flip={g.id}>
      <div className="between nowrap top">
        <div className="min0">
          <h2 className="h2">{g.name}</h2>
          {(() => {
            const sub = [acc && !acc.name.toLowerCase().includes(g.name.toLowerCase()) ? acc.name : null, g.note].filter(Boolean).join(' · ');
            return sub ? <p className="small muted">{sub}</p> : null;
          })()}
        </div>
        <span className="row nowrap gap-8">{extra}<button className="icon-btn sm has-tip tip-left" data-tip="Edit goal" aria-label={`Edit ${g.name}`} onClick={onEdit}><Icon name="edit" size={16} /></button></span>
      </div>

      <div className="row nowrap gap-16">
        <Donut size={96} slices={slices}>
          <b className="h3">{aim ? `${Math.round(pct)}%` : cash(g.balance, { whole: true })}</b>
          <span className="xs muted">{direct ? 'covered' : 'saved'}</span>
        </Donut>
        <div className="grow stack gap-2">
          <span className="fig">{cash(g.balance, { whole: true })}</span>
          <span className="small muted">{direct ? `saved + ${cash(direct, { whole: true })} paid already · ` : ''}{aim ? `of ${cash(aim, { whole: true })}${g.target ? ' target' : ' costs'} · ` : ''}updated {fmtShort(g.asOf)}</span>
          <span className={`small strong ${status.tone}`}>{status.text}</span>
          <span className="small muted">
            {monthName(period.start)} pay {cash(thisPay, { whole: true })}{thisPay !== usual ? ` (usually ${cash(usual, { whole: true })})` : ''}
            {f.periodsLeft !== undefined ? ` · ${f.periodsLeft} pays left` : ''}
            {g.otherPerPay ? ` · +${cash(g.otherPerPay, { whole: true })} a pay from elsewhere` : ''}
          </span>
        </div>
      </div>

      {people && <PeopleChips goal={g} />}

      <div className="seg fill" role="tablist" aria-label={`${g.name} details`}>
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
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
  const [kiwi, setKiwi] = useState(goal ? isKiwiSaver(goal) : false);
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
        if (!kiwi) b.split.push({ accountId: accId, amount: 0 });
      }
      // KiwiSaver is paid from your salary: payday sends it nothing, so an empty payday line goes.
      if (kiwi) b.split = b.split.filter((l) => l.accountId !== accId || l.amount !== 0 || (l.mode ?? 'fixed') !== 'fixed' || l.auto);
      const balanceChanged = !goal || goal.balance !== bal;
      // Keep everything the form doesn't edit (costs, money added…) from the saved goal.
      const existing = goal ? b.savings.find((x) => x.id === goal.id) : undefined;
      const next: SavingsGoal = {
        ...existing,
        id: goal?.id ?? newId(), name: name.trim(), accountId: accId, balance: bal,
        asOf: balanceChanged ? today : goal!.asOf, target: tgt, targetDate: targetDate || undefined,
        otherPerPay: kiwi ? undefined : oth || undefined, note: note.trim() || undefined,
        kiwisaver: kiwi === /kiwi\s?saver/i.test(name.trim()) ? undefined : kiwi,
      };
      if (kiwi) {
        next.targetDate = undefined;
        // Its balance over time is its history of gains and losses.
        if (balanceChanged || !next.readings?.length) recordReading(next, { date: next.asOf, balance: bal });
      }
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
          <button className="icon-btn plain" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
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
        <label className="check-row">
          <input type="checkbox" checked={kiwi} onChange={(e) => setKiwi(e.target.checked)} />
          <span>KiwiSaver: taken from my pay, and I can’t add to it or take it out</span>
        </label>
        <div className="form-grid">
          <label className="field">{kiwi ? 'Balance' : 'Saved so far'}
            <input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0.00" />
          </label>
          <label className="field">Target (optional)
            <input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="20,000.00" />
          </label>
          {!kiwi && (
            <>
              <label className="field">Target date (optional)
                <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
              </label>
              <label className="field">Others add each pay (optional)
                <input inputMode="decimal" value={other} onChange={(e) => setOther(e.target.value)} placeholder="e.g. a partner's share" />
              </label>
            </>
          )}
        </div>
        <label className="field">Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {targetDate && targetDate <= today && <p className="small muted">That target date has passed, so nothing more is planned for this goal. Pick a later date to keep saving towards it.</p>}
        <p className="small muted">{kiwi
          ? 'Payday sends it nothing. Each balance you enter (or the bank connection brings in) is kept, to chart its gains and losses.'
          : 'Update "saved so far" whenever you check your balance. Investment fund returns aren\'t predicted.'}</p>
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
