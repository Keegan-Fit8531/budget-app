import { useState } from 'react';
import { colorAt } from '../../core/colors';
import { addDays, fmtDay, fmtShort, todayISO } from '../../core/dates';
import { periodContaining } from '../../engine/periods';
import { costCategories, leftOn, removeSpend, savedToday, spentOn, summariseCosts } from './logic/goalcosts';
import { cash } from '../../core/money';
import { useBudget } from '../../state/store';
import type { ReactNode } from 'react';
import type { GoalCost, SavingsGoal } from '../../core/types';
import { CostCategoriesModal } from './CostCategories';
import { Donut } from '../../ui/Donut';
import { paidShares } from './logic/contributions';
import { Icon } from '../../ui/Icon';
import { Chevron, Disclosure, Dot, Modal } from '../../ui/components';
import { CostModal } from './CostModal';
import { SpendModal } from './SpendModal';

/** Costs paid from a savings goal (e.g. the wedding): what's due when, and whether the fund will cover it. */
export function GoalCosts({ goal }: { goal: SavingsGoal }) {
  const { budget } = useBudget();
  const today = todayISO();
  const [modal, setModal] = useState<{ cost?: GoalCost } | null>(null);
  const [spending, setSpending] = useState(false);
  const [editCats, setEditCats] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const groupKey = `paydays.costgroups.${goal.id}`;
  const [openGroups, setOpenGroups] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(groupKey) ?? '[]'); } catch { return []; } });
  const toggleGroup = (cat: string) => setOpenGroups((o) => {
    const next = o.includes(cat) ? o.filter((x) => x !== cat) : [...o, cat];
    try { localStorage.setItem(groupKey, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });
  const s = summariseCosts(budget, goal, today);
  const costs = goal.costs ?? [];
  const cats = costCategories(budget);
  const catColor = (c: string) => colorAt(Math.max(0, cats.indexOf(c)));

  const groups = cats.filter((cat) => costs.some((c) => (c.category ?? cats[0]) === cat)).map((cat) => {
    const inCat = (c: GoalCost) => (c.category ?? cats[0]) === cat;
    const open = s.checks.filter((c) => inCat(c.cost));
    return {
      cat, open,
      done: costs.filter((c) => inCat(c) && leftOn(c) === 0),
      total: costs.filter(inCat).reduce((t, c) => t + c.amount, 0),
      left: costs.filter(inCat).reduce((t, c) => t + leftOn(c), 0),
      short: open.reduce((t, c) => t + (c.by && !c.covered ? c.short : 0), 0),
      undated: open.some((c) => !c.by),
    };
  });

  return (
    <div className="stack gap-12">
      {costs.length === 0 && <p className="small muted">Add the costs this has to cover (venue, photographer…), with due dates if they have one. They're checked against what you'll have saved.</p>}

      {costs.length > 0 && (
        // What's left to pay, with the split by category as a small ring; each category's share is on its row.
        <div className="row gap-16">
          <Donut size={72} slices={groups.map((g) => ({ label: g.cat, value: g.total, color: catColor(g.cat) }))} />
          <div className="grow">
            <span className="fig-sm block">{cash(s.toPay, { whole: true })} <span className="small muted" style={{ fontWeight: 500 }}>still to pay</span></span>
            <span className="small muted">of {cash(s.total, { whole: true })}{s.paid > 0 ? ` · ${cash(s.paid, { whole: true })} paid` : ''}</span>
          </div>
        </div>
      )}

      <div className="row wrap gap-8">
        <button className="btn small primary" onClick={() => setModal({})}><Icon name="plus" size={16} /> Add cost</button>
        {costs.length > 0 && <button className="btn small" onClick={() => setSpending(true)}>Spend money</button>}
        <button className="btn small ghost" onClick={() => setEditCats(true)}>Categories</button>
      </div>

      {costs.length > 0 && (
        <>
          <div className="stack gap-8">
            {groups.map((g) => {
              const expanded = openGroups.includes(g.cat);
              return (
                <div key={g.cat} className="cost-group">
                  <button className="cost-group-head" aria-expanded={expanded} onClick={() => toggleGroup(g.cat)}>
                    <span className="row gap-8 min0">
                      <Dot color={catColor(g.cat)} />
                      <span className="min0">
                        <b className="block">{g.cat}</b>
                        <span className="small muted block">
                          {g.open.length + g.done.length} cost{g.open.length + g.done.length === 1 ? '' : 's'} · {s.total ? Math.round((g.total / s.total) * 100) : 0}%
                          {g.left === 0 ? ' · all paid' : g.left !== g.total ? ` · ${cash(g.left, { whole: true })} to pay` : ''}
                        </span>
                      </span>
                    </span>
                    <span className="row nowrap gap-8">
                      <span className="right">
                        <b className="block num">{cash(g.total, { whole: true })}</b>
                        {g.left > 0 && <span className={`xs ${g.short ? 'neg' : 'muted'}`}>{g.short ? `${cash(g.short, { whole: true })} short` : 'Covered'}</span>}
                      </span>
                      <Chevron />
                    </span>
                  </button>
                  {expanded && (
                    <div>
                      {g.open.map((c) => (
                        <CostRow key={c.cost.id} goal={goal} cost={c.cost} open={openId === c.cost.id} onToggle={() => setOpenId(openId === c.cost.id ? null : c.cost.id)}
                          onEdit={() => setModal({ cost: c.cost })}
                          status={<span className={`xs ${!c.by ? 'muted' : c.covered ? 'muted' : 'neg'}`}>{!c.by ? 'Needs a date' : c.covered ? 'Covered' : `${cash(c.short, { whole: true })} short`}</span>}
                          due={c.cost.due ? `Due ${fmtShort(c.cost.due)}` : undefined} />
                      ))}
                      {g.done.map((c) => (
                        <CostRow key={c.id} goal={goal} cost={c} done open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)}
                          onEdit={() => setModal({ cost: c })}
                          status={<span className="xs pos">{!c.paid ? 'Spent' : c.paidOutside ? `Paid by ${paidShares(c).map((x) => x.person).join(' & ') || '…'}` : 'Paid'}</span>}
                          due={c.paidOn ? `Paid ${fmtShort(c.paidOn)} ${c.paidOn.slice(0, 4)}${paidShares(c).length > 1 ? ` · ${paidShares(c).map((x) => `${x.person} ${cash(x.amount, { whole: true })}`).join(' + ')}` : c.paidOutside ? ' · not from the fund' : ''}` : c.due ? fmtShort(c.due) : undefined} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <Disclosure title="What “Covered” means">
            <p className="small muted">
              The fund should have enough by the time the cost is due.{' '}
              {goal.targetDate
                ? <>Costs without a due date are checked against {fmtDay(goal.targetDate)} (the last pay that counts is {fmtDay(periodContaining(addDays(goal.targetDate, -1), budget.settings).start)}).</>
                : <>Set a target date with Edit to check costs without a due date.</>}
            </p>
          </Disclosure>
        </>
      )}

      {modal && <CostModal goal={goal} cost={modal.cost} onClose={() => setModal(null)} />}
      {spending && <SpendModal goal={goal} onClose={() => setSpending(false)} />}
      {editCats && <CostCategoriesModal onClose={() => setEditCats(false)} />}
    </div>
  );
}

/** One cost line: what's left, its status, and (opened) every spend with dates and the total. */
function CostRow({ goal, cost, status, due, done, open, onToggle, onEdit }: {
  goal: SavingsGoal; cost: GoalCost; status: ReactNode; due?: string; done?: boolean; open: boolean;
  onToggle: () => void; onEdit: () => void;
}) {
  const { budget, update } = useBudget();
  // Undoing a spend asks whether the money goes back into the saved balance.
  const [undo, setUndo] = useState<{ id: string; amount: number; date: string } | null>(null);
  const undoSpend = (putBack: boolean) => {
    if (!undo) return;
    const id = undo.id;
    update((b) => { const g = (b.savings ?? []).find((y) => y.id === goal.id); if (g) removeSpend(b, g, cost.id, id, putBack); return b; });
    setUndo(null);
  };
  // What's in the fund now (the saved balance and the paydays since it was updated).
  const now = undo ? savedToday(budget, goal, todayISO()) : 0;
  const spent = spentOn(cost);
  const left = leftOn(cost);
  const spends = [...(cost.spends ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <div style={{ borderBottom: '1px solid var(--line)' }}>
      <div className={`list-row${done ? ' muted' : ''}`} style={{ borderBottom: 0 }}>
        <button onClick={onEdit} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit', overflowWrap: 'anywhere' }}>
          <span className="block">{done ? <s>{cost.name}</s> : cost.name}</span>
          {(due || (spent > 0 && !done)) && <span className="small muted">{[due, spent > 0 && !done ? `${cash(spent)} spent of ${cash(cost.amount)}` : ''].filter(Boolean).join(' · ')}</span>}
        </button>
        <span style={{ textAlign: 'right', flex: '0 0 auto' }}>
          <b style={{ display: 'block', whiteSpace: 'nowrap' }}>{cash(done ? Math.max(cost.amount, spent) : left, { whole: true })}</b>
          {spent > cost.amount ? <span className="small neg block">{cash(spent - cost.amount)} over</span> : status}
        </span>
        <button className="btn small ghost" onClick={onEdit} style={{ flex: '0 0 auto', paddingInline: 8 }} aria-label={`Edit ${cost.name}`}><Icon name="edit" size={16} /></button>
      </div>
      {spends.length > 0 && (
        <button className="btn small ghost" onClick={onToggle} aria-expanded={open} style={{ marginBottom: 6, minHeight: 30 }}>
          {open ? 'Hide' : 'Show'} {spends.length} spend{spends.length === 1 ? '' : 's'} · {cash(spent)} spent
        </button>
      )}
      {open && spends.length > 0 && (
        <div className="inset" style={{ marginBottom: 10 }}>
          {spends.map((x) => (
            <div key={x.id} className="list-row small">
              <span style={{ width: 56, flex: '0 0 56px' }}>{fmtShort(x.date)}</span>
              <span className="grow">{x.note || 'Spent'}</span>
              <b>{cash(x.amount)}</b>
              <button className="btn small ghost" aria-label={`Remove ${cash(x.amount)} spent on ${fmtShort(x.date)}`}
                onClick={() => setUndo({ id: x.id, amount: x.amount, date: x.date })}>
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
          <div className="list-row small"><span className="grow"><b>Total spent</b></span><b>{cash(spent)}</b></div>
          <div className="list-row small muted"><span className="grow">Budgeted {cash(cost.amount)}</span><span>{spent > cost.amount ? `${cash(spent - cost.amount)} over` : `${cash(cost.amount - spent)} left`}</span></div>
        </div>
      )}
      {undo && (
        <Modal title={<>Remove {cash(undo.amount)} spent on {fmtShort(undo.date)}?</>} onClose={() => setUndo(null)}>
          <p className="small muted">
            It comes off {cost.name} either way. Choose what happens to the saved balance, now {cash(now)}.
          </p>
          <button className="btn primary" onClick={() => undoSpend(true)}>Put {cash(undo.amount)} back: balance becomes {cash(now + undo.amount)}</button>
          <button className="btn" onClick={() => undoSpend(false)}>Leave the balance at {cash(now)}</button>
          <p className="small muted">Leave it if the balance already shows the real amount (e.g. you've updated it since, or the spend was more than was saved).</p>
          <div className="row end">
            <button className="btn" onClick={() => setUndo(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
