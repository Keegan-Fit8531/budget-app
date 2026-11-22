import { useState } from 'react';
import { Dot } from '../../ui/components';
import { addPerson, contributions, ME, peopleOf, removePerson, renamePerson, setPersonTotal, UNASSIGNED, type Contribution } from './logic/contributions';
import { fmtShort, todayISO } from '../../core/dates';
import { cash, centsToInput, parseMoney } from '../../core/money';
import { newId, useBudget } from '../../state/store';
import type { GoalGift, SavingsGoal } from '../../core/types';
import { Icon } from '../../ui/Icon';
import { NEW, signed, saveGift, personLabel, tracksPeople, colorFor } from './logic/gifts';
import { PersonPicker } from './GoalGifts';

export function GiftModal({ goal, gift, out = false, onClose }: { goal: SavingsGoal; gift?: GoalGift; out?: boolean; onClose: () => void }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  // Solo goals: skip "who it's from" and treat it as your own deposit. Shared goals (wedding etc.) keep the person picker.
  const showPeople = tracksPeople(budget, goal) || !!gift?.person || out;
  const [amount, setAmount] = useState(gift ? centsToInput(gift.amount) : '');
  const [date, setDate] = useState(gift?.date ?? today);
  const [person, setPerson] = useState(gift?.person ?? peopleOf(goal)[0]);
  const [note, setNote] = useState(gift?.note ?? '');
  const [received, setReceived] = useState(gift?.received ?? true);
  const [err, setErr] = useState('');
  const future = !out && date > today;

  function save() {
    const c = parseMoney(amount);
    if (c === null || c <= 0) return setErr('Enter an amount above $0.');
    if (!date) return setErr('Pick a date.');
    const who = showPeople
      ? (person.startsWith(NEW) ? person.slice(NEW.length).trim() : person)
      : ME;
    if (!who) return setErr('Enter their name.');
    update((b) => {
      saveGift(b, goal.id, { ...gift, id: gift?.id ?? newId(), amount: c, date, person: who, note: note.trim() || undefined, out: out || undefined, received: out ? true : future ? false : received }, gift);
      return b;
    });
    onClose();
  }
  function remove() {
    if (!gift) return;
    update((b) => {
      const g = (b.savings ?? []).find((x) => x.id === goal.id);
      if (!g) return b;
      const s = signed(gift);
      if (s) { g.balance = Math.max(0, g.balance - s); g.asOf = today; }
      g.gifts = (g.gifts ?? []).filter((x) => x.id !== gift.id);
      return b;
    });
    onClose();
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="gift-title" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2 id="gift-title" className="h2">{gift ? (out ? 'Edit money taken out' : 'Edit deposit') : out ? `${goal.name}: take money out` : `${goal.name}: add deposit`}</h2>
          <button className="icon-btn plain" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="form-grid">
          <label className="field">Amount
            <input autoFocus inputMode="decimal" value={amount} placeholder="500.00" onChange={(e) => { setAmount(e.target.value); setErr(''); }} onKeyDown={(e) => e.key === 'Enter' && save()} />
          </label>
          <label className="field">Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        {showPeople && (
          <PersonPicker goal={goal} value={person} onChange={(v) => { setPerson(v); setErr(''); }} label={out ? 'Who it’s for' : 'Who it’s from'} />
        )}
        <label className="field">Note (optional)
          <input value={note} placeholder={out ? 'Paid back' : showPeople ? 'Christmas gift' : 'Bonus, transfer…'} onChange={(e) => setNote(e.target.value)} />
        </label>
        {out ? (
          <p className="small muted">Takes it off the saved balance and off their total. To pay for a wedding cost, use <b>Spend money</b> under the costs instead.</p>
        ) : future ? (
          <p className="small muted">A future date makes it <b>expected</b>: it counts in the plan from {fmtShort(date)}, and you tap <b>Received</b> when it arrives.</p>
        ) : (
          <label className="check-row">
            <input type="checkbox" checked={received} onChange={(e) => setReceived(e.target.checked)} style={{ width: 20, height: 20, accentColor: 'var(--brand)' }} />
            Already in the account (adds it to the saved balance)
          </label>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="between">
          {gift ? <button className="btn ghost danger" onClick={remove}>Delete</button> : <span />}
          <div className="row">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save}>{gift ? 'Save' : out ? 'Take out' : 'Add deposit'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Set someone's total (what they've put in so far), rename or remove them — or add a new person. */
export function PersonModal({ goal, person, onClose }: { goal: SavingsGoal; person?: Contribution; onClose: () => void }) {
  const { update } = useBudget();
  const [name, setName] = useState(person?.person ?? '');
  const [total, setTotal] = useState(person ? centsToInput(person.total) : '');
  const [auto, setAuto] = useState(!!person && goal.remainderPerson === person.person);
  const [err, setErr] = useState('');
  const others = person ? person.pay + person.added - person.takenOut : 0;
  const isYou = person?.person === peopleOf(goal)[0];
  const otherRemainder = goal.remainderPerson && goal.remainderPerson !== person?.person && peopleOf(goal).includes(goal.remainderPerson) ? goal.remainderPerson : undefined;

  function save() {
    const n = name.trim();
    const c = auto ? 0 : total.trim() === '' ? 0 : parseMoney(total);
    if (!n) return setErr('Enter a name.');
    if (c === null) return setErr('Enter an amount, e.g. 1500.');
    if (n !== person?.person && peopleOf(goal).includes(n)) return setErr(`${n} is already on the list.`);
    update((b) => {
      const g = (b.savings ?? []).find((x) => x.id === goal.id);
      if (!g) return b;
      if (person && n !== person.person) renamePerson(g, person.person, n);
      if (!person) addPerson(g, n);
      if (auto) { g.remainderPerson = n; return b; }
      if (g.remainderPerson === n) delete g.remainderPerson;
      setPersonTotal(b, g, n, c);
      return b;
    });
    onClose();
  }
  function remove() {
    if (!person) return;
    if ((goal.gifts ?? []).some((x) => x.person === person.person)) return setErr(`${person.person} has entries in Money in and out. Delete or change those first.`);
    update((b) => {
      const g = (b.savings ?? []).find((x) => x.id === goal.id);
      if (g) removePerson(g, person.person);
      return b;
    });
    onClose();
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="person-title" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2 id="person-title" className="h2">{person ? personLabel(person.person) : 'Add a person'}</h2>
          <button className="icon-btn plain" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="form-grid">
          <label className="field">Name
            <input autoFocus={!person} value={name} placeholder="Sam" onChange={(e) => { setName(e.target.value); setErr(''); }} />
          </label>
          <label className="field">Total put in so far
            <input autoFocus={!!person && !auto} inputMode="decimal" value={auto ? (person?.remainder ? centsToInput(person.total) : 'Worked out') : total} disabled={auto} placeholder="0.00"
              onChange={(e) => { setTotal(e.target.value); setErr(''); }} onKeyDown={(e) => e.key === 'Enter' && save()} />
          </label>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} style={{ width: 20, height: 20, accentColor: 'var(--brand)' }} />
          <span>Gets whatever's left of the balance
            <span className="small muted block">
              {otherRemainder ? `Takes this over from ${personLabel(otherRemainder)}. ` : ''}Their total is the balance minus everyone else's, so it always adds up.
            </span>
          </span>
        </label>
        {!auto && <p className="small muted">
          {isYou ? 'Your payday transfers to this fund are added for you automatically from the budget start. ' : ''}
          {others ? `Their entries${person?.pay ? ' and pay' : ''} so far come to ${cash(others)}; the rest is counted as put in earlier. ` : ''}
          Money added or taken out later keeps adding to this total. This doesn't change the fund's balance.
        </p>}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="between">
          {person && !isYou ? <button className="btn ghost danger" onClick={remove}>Remove</button> : <span />}
          <div className="row">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save}>{person ? 'Save' : 'Add'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Share the saved balance out between people (sets each person's total). */
export function SplitModal({ goal, onClose }: { goal: SavingsGoal; onClose: () => void }) {
  const { budget, update } = useBudget();
  const people = contributions(budget, goal).filter((p) => p.person !== UNASSIGNED);
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(people.map((p) => [p.person, p.total ? centsToInput(p.total) : ''])));
  const [err, setErr] = useState('');
  const rest = people.find((p) => p.remainder)?.person;
  const typed = (p: string) => (vals[p]?.trim() ? parseMoney(vals[p]) : 0);
  const othersTyped = people.filter((p) => p.person !== rest).reduce((t, p) => t + (typed(p.person) ?? 0), 0);
  const cents = (p: string) => (p === rest ? goal.balance - othersTyped : typed(p));
  const assigned = people.reduce((t, p) => t + (cents(p.person) ?? 0), 0);
  const left = goal.balance - assigned;

  function evenly() {
    const each = Math.floor(goal.balance / people.length / 100) * 100;
    setVals(Object.fromEntries(people.map((p, i) => [p.person, centsToInput(i === 0 ? goal.balance - each * (people.length - 1) : each)])));
  }
  function save() {
    if (people.some((p) => cents(p.person) === null)) return setErr('Enter amounts like 7450 or 7450.00.');
    if (rest && (cents(rest) ?? 0) < 0) return setErr(`That's more than the balance, so ${personLabel(rest)} would be below $0.`);
    update((b) => {
      const g = (b.savings ?? []).find((x) => x.id === goal.id);
      if (!g) return b;
      for (const p of people) setPersonTotal(b, g, p.person, cents(p.person) ?? 0);
      return b;
    });
    onClose();
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="split-title" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2 id="split-title" className="h2">Who put in the {cash(goal.balance, { whole: true })}?</h2>
          <button className="icon-btn plain" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="stack gap-8">
          {people.map((p) => (
            <label key={p.person} className="row gap-8">
              <Dot color={colorFor(goal, p.person)} />
              <span className="grow">{personLabel(p.person)}{p.person === rest && <span className="small muted block">Gets what's left</span>}</span>
              <input inputMode="decimal" aria-label={`${personLabel(p.person)} put in`} value={p.person === rest ? centsToInput(cents(p.person) ?? 0) : vals[p.person] ?? ''} disabled={p.person === rest} placeholder="0.00"
                onChange={(e) => { setVals((v) => ({ ...v, [p.person]: e.target.value })); setErr(''); }} onKeyDown={(e) => e.key === 'Enter' && save()}
                className="input" style={{ width: 130, fontWeight: 600 }} />
            </label>
          ))}
        </div>
        <div className="between">
          <button className="btn small" onClick={evenly}>Split evenly</button>
          <b className={left < 0 ? 'neg' : left === 0 ? 'pos' : ''}>{left === 0 ? 'All assigned' : left > 0 ? `${cash(left)} left to assign` : `${cash(-left)} more than the balance`}</b>
        </div>
        <p className="small muted">Anything left over stays as "Not assigned" (e.g. fund returns). Someone missing? Add them with <b>+ Person</b> first. Your payday transfers keep adding to your total.</p>
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
