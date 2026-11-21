import { useState } from 'react';
import { Disclosure, Dot } from '../../ui/components';
import { colorAt } from '../../core/colors';
import { addPerson, contributions, ME, peopleOf, UNASSIGNED, type Contribution } from './logic/contributions';
import { fmtShort, todayISO } from '../../core/dates';
import { cash } from '../../core/money';
import { useBudget } from '../../state/store';
import type { Budget, GoalGift, SavingsGoal } from '../../core/types';
import { Icon } from '../../ui/Icon';
import { GiftModal, PersonModal, SplitModal } from './GiftModals';

export const NEW_PERSON = '__new';
export const NEW = NEW_PERSON;
export const signed = (x?: GoalGift) => (!x || !x.received ? 0 : x.out ? -x.amount : x.amount);

/** Add or change money in/out; received money goes straight into (or out of) the saved balance. */
export function saveGift(b: Budget, goalId: string, next: GoalGift, previous?: GoalGift) {
  const g = (b.savings ?? []).find((x) => x.id === goalId);
  if (!g) return;
  const diff = signed(next) - signed(previous);
  if (diff) { g.balance = Math.max(0, g.balance + diff); g.asOf = todayISO(); }
  if (next.person && next.person !== UNASSIGNED) addPerson(g, next.person);
  g.gifts = g.gifts ?? [];
  const i = g.gifts.findIndex((x) => x.id === next.id);
  if (i >= 0) g.gifts[i] = next; else g.gifts.push(next);
}

export const personLabel = (p: string) => (p === ME ? 'Me' : p);

/** One-off deposit into a goal (on the card, and again under Money in and out). */
export function AddMoneyButton({ goal }: { goal: SavingsGoal }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn small primary" onClick={() => setOpen(true)}><Icon name="plus" size={16} /> Add deposit</button>
      {open && <GiftModal goal={goal} onClose={() => setOpen(false)} />}
    </>
  );
}

/** True when a goal tracks who puts money in (more than just you). */
export function tracksPeople(budget: Budget, goal: SavingsGoal): boolean {
  // Once a goal has a people list (e.g. the wedding), keep showing it, even if it's down to just you.
  return (goal.people?.length ?? 0) > 0 || contributions(budget, goal).some((p) => p.person !== ME && p.total !== 0);
}

export const colorFor = (goal: SavingsGoal, p: string) => (p === UNASSIGNED ? 'var(--muted)' : colorAt(Math.max(0, peopleOf(goal).indexOf(p))));

/** Slices for the goal's saved pie: each person's share of what's saved, anything not assigned, then what's still to go. */
export function savedSlices(budget: Budget, goal: SavingsGoal, target = goal.target) {
  const people = contributions(budget, goal).filter((p) => p.person !== UNASSIGNED);
  const named = people.reduce((t, p) => t + Math.max(0, p.total), 0);
  const unassigned = Math.max(0, goal.balance - named);
  // Costs people paid themselves count towards the goal too (they're money that didn't have to be saved).
  const direct = people.reduce((t, p) => t + p.direct, 0);
  const covered = Math.max(goal.balance, named) + direct;
  return [
    ...people.filter((p) => Math.max(0, p.total) + p.direct > 0).map((p) => ({ label: personLabel(p.person), value: Math.max(0, p.total) + p.direct, color: colorFor(goal, p.person) })),
    ...(unassigned > 0 ? [{ label: 'Not assigned', value: unassigned, color: colorFor(goal, UNASSIGNED) }] : []),
    ...(target && target > covered ? [{ label: 'To go', value: target - covered, color: 'var(--soft)' }] : []),
  ];
}

/** What the middle of the saved pie says: the balance, or everyone's total when that's bigger (costs already spent). */
export function savedCentre(budget: Budget, goal: SavingsGoal): { amount: number; label: string } {
  const named = contributions(budget, goal).filter((p) => p.person !== UNASSIGNED).reduce((t, p) => t + Math.max(0, p.total), 0);
  return named > goal.balance ? { amount: named, label: 'put in' } : { amount: goal.balance, label: 'saved' };
}

/** Compact, tappable list of who's put in what (sits under the saved pie). */
export function PeopleChips({ goal }: { goal: SavingsGoal }) {
  const { budget } = useBudget();
  const [person, setPerson] = useState<Contribution | 'new' | null>(null);
  const [splitting, setSplitting] = useState(false);
  const people = contributions(budget, goal).filter((p) => p.person !== UNASSIGNED);
  const named = people.reduce((t, p) => t + p.total, 0);
  const unassigned = goal.balance - named;
  return (
    <div className="stack gap-6">
      {/* Who put in what is in the ring above; the amounts (and editing them) are a click away. */}
      <Disclosure title="Who put it in" meta={`${people.length} ${people.length === 1 ? 'person' : 'people'}`} storageKey={`paydays.goalpeople.${goal.id}`}>
        <div className="row wrap gap-6">
          {people.map((p) => (
            <button key={p.person} className="chip" onClick={() => setPerson(p)} aria-label={`${personLabel(p.person)}: ${cash(p.total)}. Edit`}
              title={p.remainder ? 'Gets whatever\u2019s left of the balance' : [p.base ? `${cash(p.base)} earlier` : '', p.pay ? `${cash(p.pay)} from pay` : '', p.added ? `${cash(p.added)} added` : '', p.takenOut ? `${cash(p.takenOut)} taken out` : '', p.expected ? `${cash(p.expected)} expected` : ''].filter(Boolean).join(' · ') || 'Tap to set their total'}>
              <Dot color={colorFor(goal, p.person)} />
              {personLabel(p.person)}
              {p.total === 0 && p.direct > 0 && !p.remainder
                ? <><b>{cash(p.direct, { whole: true })}</b><span className="xs muted">paid</span></>
                : <>
                  <b className={p.total < 0 ? 'neg' : ''}>{cash(p.total, { whole: true })}</b>
                  {p.remainder && <span className="xs muted">· rest</span>}
                  {p.direct > 0 && <span className="xs muted">+ {cash(p.direct, { whole: true })} paid</span>}
                </>}
              {p.expected > 0 && <span className="xs muted">+{cash(p.expected, { whole: true })} due</span>}
            </button>
          ))}
          <button className="btn small ghost" onClick={() => setPerson('new')}><Icon name="plus" size={16} /> Person</button>
        </div>
      </Disclosure>
      {unassigned > 0 && (
        <div className="tip small between">
          <span className="grow"><b>{cash(unassigned)}</b> of the balance isn't assigned to anyone yet. Split it to show who put in what.</span>
          <button className="btn small primary" onClick={() => setSplitting(true)}>Split {cash(unassigned, { whole: true })}</button>
        </div>
      )}
      {unassigned < 0 && <span className="small muted">Everyone's totals come to {cash(-unassigned)} more than the balance (costs already spent, or returns down).</span>}
      {person && <PersonModal goal={goal} person={person === 'new' ? undefined : person} onClose={() => setPerson(null)} />}
      {splitting && <SplitModal goal={goal} onClose={() => setSplitting(false)} />}
    </div>
  );
}

/** Every amount in and out of a goal, with who it was from or for. */
export function GoalGifts({ goal }: { goal: SavingsGoal }) {
  const { update } = useBudget();
  const [edit, setEdit] = useState<GoalGift | null>(null);
  const [adding, setAdding] = useState<'in' | 'out' | null>(null);
  const today = todayISO();
  const entries = [...(goal.gifts ?? [])].sort((a, b) => b.date.localeCompare(a.date));
  const received = entries.filter((x) => x.received && !x.out).reduce((t, x) => t + x.amount, 0);
  const out = entries.filter((x) => x.out).reduce((t, x) => t + x.amount, 0);
  const expected = entries.filter((x) => !x.received && !x.out).reduce((t, x) => t + x.amount, 0);

  return (
    <div className="stack gap-8">
      <div className="row gap-8 wrap">
        <button className="btn small primary" onClick={() => setAdding('in')}><Icon name="plus" size={16} /> Add deposit</button>
        <button className="btn small" onClick={() => setAdding('out')}>Take money out</button>
      </div>
      {entries.length === 0
        ? <p className="small muted">One-off deposits and gifts show here (payday transfers are counted automatically). Taking money out records who it was for.</p>
        : <p className="small muted">{cash(received)} in{out ? ` · ${cash(out)} out` : ''}{expected ? ` · ${cash(expected)} expected` : ''}</p>}
      <div>
        {entries.map((x) => (
          <div key={x.id} className="list-row">
            <Dot color={colorFor(goal, x.person ?? UNASSIGNED)} />
            <span className="grow">
              {x.out ? `For ${x.person ? personLabel(x.person) : '…'}` : x.person ? `From ${personLabel(x.person)}` : 'Money added'}
              <span className="small muted block">
                {[`${fmtShort(x.date)} ${x.date.slice(0, 4)}`, x.out ? 'Taken out' : x.received ? '' : 'Expected', x.note].filter(Boolean).join(' · ')}
              </span>
            </span>
            <b className={x.out ? 'neg' : 'pos'} style={{ whiteSpace: 'nowrap' }}>{x.out ? '−' : '+'}{cash(x.amount)}</b>
            {!x.received && !x.out && (
              <button className="btn small" onClick={() => update((b) => { saveGift(b, goal.id, { ...x, received: true, date: x.date > today ? today : x.date }, x); return b; })}>Received</button>
            )}
            <button className="btn small ghost" style={{ paddingInline: 8 }} aria-label="Edit entry" onClick={() => setEdit(x)}><Icon name="edit" size={16} /></button>
          </div>
        ))}
      </div>
      {edit && <GiftModal goal={goal} gift={edit} out={edit.out} onClose={() => setEdit(null)} />}
      {adding && <GiftModal goal={goal} out={adding === 'out'} onClose={() => setAdding(null)} />}
    </div>
  );
}

/** Choose a person (or add a new one) for an entry. */
export function PersonPicker({ goal, value, onChange, label }: { goal: SavingsGoal; value: string; onChange: (v: string) => void; label: string }) {
  const [custom, setCustom] = useState('');
  const people = peopleOf(goal);
  return (
    <>
      <label className="field">{label}
        <select value={value.startsWith(NEW) ? NEW : value} onChange={(e) => onChange(e.target.value === NEW ? `${NEW}${custom}` : e.target.value)}>
          {people.map((p) => <option key={p} value={p}>{personLabel(p)}</option>)}
          <option value={NEW}>+ New person…</option>
        </select>
      </label>
      {value.startsWith(NEW) && (
        <label className="field">Their name
          <input autoFocus value={custom} placeholder="Mum and Dad" onChange={(e) => { setCustom(e.target.value); onChange(`${NEW}${e.target.value}`); }} />
        </label>
      )}
    </>
  );
}
