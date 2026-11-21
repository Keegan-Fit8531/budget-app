import { SyncPill } from '../../shared/SyncPill';
import { useMemo, useState, type ReactNode } from 'react';
import { Donut } from '../../ui/Donut';
import { Icon } from '../../ui/Icon';
import { AccIcon, Disclosure, Modal, MoveButtons, ReorderToggle, useFlip } from '../../ui/components';
import { moveAmong } from '../../core/order';
import { bankSync } from '../../services/bank/bank';
import { GoalCosts } from './GoalCosts';
import { AddMoneyButton, GoalGifts, PeopleChips, savedSlices, tracksPeople } from './GoalGifts';
import { summariseCosts } from './logic/goalcosts';
import { paidDirect } from './logic/contributions';
import { PaydayControl } from '../../shared/PaydayControl';
import { SavingsChart } from './SavingsChart';
import { fmtShort, monthName, todayISO } from '../../core/dates';
import { averageSplit, planFor } from '../../engine/plan';
import { PayNav, useViewPeriod } from '../../state/period';
import { cash } from '../../core/money';
import { forecast } from './logic/savings';
import { isKiwiSaver, kiwiPerPay } from './logic/kiwisaver';
import { KiwiSaverCard } from './KiwiSaver';
import { useBudget } from '../../state/store';
import type { SavingsGoal } from '../../core/types';
import { GoalModal } from './GoalModal';

export function SavingsPage() {
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
    return s1.linked || s2.linked ? <SyncPill source="bank" at={s1.at ?? s2.at ?? g.asOf} /> : <SyncPill source="entered" at={g.asOf} />;
  };
  const saved = goals.reduce((t, g) => t + g.balance, 0);
  const kiwi = kiwiPerPay(budget)?.total ?? 0;
  const kiwiSaved = kiwis.reduce((t, g) => t + g.balance, 0);

  return (
    <>
      <header className="page-head">
        <PayNav title="Savings" />
        <div className="page-actions">
          {(goals.length > 1 || kiwis.length > 1) && <ReorderToggle on={reorder} onChange={setReorder} />}
          <button className="btn primary" onClick={() => setModal({})}><Icon name="plus" /> Add goal</button>
        </div>
      </header>

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


/** One savings goal: a short summary (pie, saved, one status line), then tabs for costs, money in and out, and payday. */
/** Money paid into or taken out of a goal's fund, seen in your bank accounts (ANZ → Kernel). */
function BankMoves({ goal: g }: { goal: SavingsGoal }) {
  const { budget } = useBudget();
  const list = (g.bankMoves ?? []).slice().reverse();
  const name = (id: string) => budget.accounts.find((a) => a.id === id)?.name ?? 'your bank';
  return (
    <Disclosure title="Moved from your bank" meta={`${list.length} · latest ${fmtShort(list[0].date)}`}>
      <div>
        {list.slice(0, 12).map((m, i) => (
          <div key={`${m.date}-${i}`} className="list-row small">
            <span style={{ flex: '0 0 56px' }} className="muted">{fmtShort(m.date)}</span>
            <span className="grow min0">{m.amount > 0 ? `From ${name(m.from)}` : `To ${name(m.from)}`}
              <span className="xs muted block">{m.counted ? `${m.amount > 0 ? 'Added to' : 'Taken off'} the balance (after it was last updated)` : 'Already in the balance'}</span>
            </span>
            <b className={`num${m.amount < 0 ? ' neg' : ''}`}>{m.amount > 0 ? '+' : '−'}{cash(Math.abs(m.amount))}</b>
          </div>
        ))}
      </div>
    </Disclosure>
  );
}

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
  const [settings, setSettings] = useState(false);
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

  return (
    <section className="card acct" data-flip={g.id}>
      <div className="acct-head">
        <AccIcon color={acc?.color} name="piggy" />
        <div className="grow min0">
          <h2 className="h2 clip">{g.name}</h2>
          {(() => {
            const sub = [acc && !acc.name.toLowerCase().includes(g.name.toLowerCase()) ? acc.name : null, g.note].filter(Boolean).join(' · ');
            return sub ? <p className="small muted clip">{sub}</p> : null;
          })()}
        </div>
        <div className="acct-side">
          {extra}
          <button className="icon-btn mini has-tip tip-left" data-tip="Money and payday" aria-label={`${g.name}: money in and out, and payday`} onClick={() => setSettings(true)}><Icon name="settings" size={14} /></button>
          <button className="icon-btn mini has-tip tip-left" data-tip="Edit goal" aria-label={`Edit ${g.name}`} onClick={onEdit}><Icon name="edit" size={14} /></button>
        </div>
      </div>

      <div className="row nowrap gap-20" style={{ alignItems: 'center' }}>
        <Donut size={104} slices={slices}>
          <b className="h3">{aim ? `${Math.round(pct)}%` : cash(g.balance, { whole: true })}</b>
          <span className="xs muted">{direct ? 'covered' : 'saved'}</span>
        </Donut>
        <div className="grow min0 stack gap-4">
          <b className="fig" style={{ fontSize: 30 }}>{cash(g.balance, { whole: true })}</b>
          <span className="small muted">{aim ? `of ${cash(aim, { whole: true })}${g.target ? ' target' : ' costs'}` : 'saved'}{direct ? ` · ${cash(direct, { whole: true })} paid already` : ''}</span>
          <span className={`small strong ${status.tone}`}>{status.text}</span>
        </div>
      </div>

      <div className="trio">
        <div className="stat">
          <span className="small muted">{monthName(period.start)} pay</span>
          <b>{cash(thisPay, { whole: true })}</b>
          <span className="xs muted">{thisPay !== usual ? `usually ${cash(usual, { whole: true })}` : 'as usual'}</span>
        </div>
        <div className="stat">
          <span className="small muted">Pays left</span>
          <b>{f.periodsLeft ?? '—'}</b>
          <span className="xs muted">{when ? `to ${when}` : 'no date set'}</span>
        </div>
        <div className="stat">
          <span className="small muted">{c ? 'Still to pay' : 'In 12 pays'}</span>
          <b>{cash(c ? Math.max(0, c.total - c.paid) : f.projected, { whole: true })}</b>
          <span className="xs muted">{c ? `${costs.length} cost${costs.length === 1 ? '' : 's'}` : 'projected'}</span>
        </div>
      </div>

      {/* One-off deposits (payday sends are separate, under Money and payday). */}
      <div className="row wrap gap-8">
        <AddMoneyButton goal={g} />
      </div>

      {people && <PeopleChips goal={g} />}

      {costs.length > 0 && <div style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--s-4)' }}><GoalCosts goal={g} /></div>}

      {(g.bankMoves?.length ?? 0) > 0 && <BankMoves goal={g} />}

      {settings && (
        <Modal title={g.name} sub="Money in and out, and what payday sends" width={640} onClose={() => setSettings(false)}>
          <section className="stack gap-12">
            <h3 className="h3">Payday</h3>
            <PaydayControl accountId={g.accountId} sends={funded?.funded ?? 0} needs={funded?.need ?? 0}
              autoLabel="Send what's needed to hit the target date"
              autoHint={g.target && g.targetDate ? 'Works out the per-pay amount from your target and date.' : 'Needs a target and a target date.'} />
          </section>
          <section className="stack gap-12" style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--s-4)' }}>
            <h3 className="h3">Money in and out</h3>
            <GoalGifts goal={g} />
          </section>
        </Modal>
      )}
    </section>
  );
}
