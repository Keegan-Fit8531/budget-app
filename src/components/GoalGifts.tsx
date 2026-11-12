import { useState } from 'react';
import { PALETTE } from '../lib/colors';
import { addPerson, contributions, ME, peopleOf, removePerson, renamePerson, setPersonTotal, UNASSIGNED, type Contribution } from '../lib/contributions';
import { fmtShort, todayISO } from '../lib/dates';
import { centsToInput, money, parseMoney } from '../lib/money';
import { newId, useBudget } from '../lib/store';
import type { Budget, GoalGift, SavingsGoal } from '../lib/types';
import { Icon } from './Icon';

export const NEW_PERSON = '__new';
const NEW = NEW_PERSON;
const signed = (x?: GoalGift) => (!x || !x.received ? 0 : x.out ? -x.amount : x.amount);

/** Add or change money in/out; received money goes straight into (or out of) the saved balance. */
function saveGift(b: Budget, goalId: string, next: GoalGift, previous?: GoalGift) {
  const g = (b.savings ?? []).find((x) => x.id === goalId);
  if (!g) return;
  const diff = signed(next) - signed(previous);
  if (diff) { g.balance = Math.max(0, g.balance + diff); g.asOf = todayISO(); }
  if (next.person && next.person !== UNASSIGNED) addPerson(g, next.person);
  g.gifts = g.gifts ?? [];
  const i = g.gifts.findIndex((x) => x.id === next.id);
  if (i >= 0) g.gifts[i] = next; else g.gifts.push(next);
}

const personLabel = (p: string) => (p === ME ? 'Me' : p);

/** The "Add money" button for a goal's header. */
export function AddMoneyButton({ goal }: { goal: SavingsGoal }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn small primary" onClick={() => setOpen(true)}><Icon name="plus" size={16} /> Add money</button>
      {open && <GiftModal goal={goal} onClose={() => setOpen(false)} />}
    </>
  );
}

/** True when a goal tracks who puts money in (more than just you). */
export function tracksPeople(budget: Budget, goal: SavingsGoal): boolean {
  // Once a goal has a people list (e.g. the wedding), keep showing it, even if it's down to just you.
  return (goal.people?.length ?? 0) > 0 || contributions(budget, goal).some((p) => p.person !== ME && p.total !== 0);
}

const colorFor = (goal: SavingsGoal, p: string) => (p === UNASSIGNED ? '#94A3B8' : PALETTE[Math.max(0, peopleOf(goal).indexOf(p)) % PALETTE.length]);

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
  const chip = { display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 36, padding: '0 12px', borderRadius: 99, border: '1px solid var(--line)', background: 'var(--card)', color: 'inherit', font: 'inherit', fontSize: 14, cursor: 'pointer' } as const;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <span className="small muted" style={{ marginRight: 2 }}>Put in by</span>
        {people.map((p) => (
          <button key={p.person} style={chip} onClick={() => setPerson(p)} aria-label={`${personLabel(p.person)}: ${money(p.total)}. Edit`}
            title={p.remainder ? 'Gets whatever\u2019s left of the balance' : [p.base ? `${money(p.base)} earlier` : '', p.pay ? `${money(p.pay)} from pay` : '', p.added ? `${money(p.added)} added` : '', p.takenOut ? `${money(p.takenOut)} taken out` : '', p.expected ? `${money(p.expected)} expected` : ''].filter(Boolean).join(' · ') || 'Tap to set their total'}>
            <span className="dot" style={{ background: colorFor(goal, p.person) }} />
            {personLabel(p.person)}
            {p.total === 0 && p.direct > 0 && !p.remainder
              ? <><b>{money(p.direct, { whole: true })}</b><span className="small muted">paid</span></>
              : <>
                <b className={p.total < 0 ? 'neg' : ''}>{money(p.total, { whole: true })}</b>
                {p.remainder && <span className="small muted">· rest</span>}
                {p.direct > 0 && <span className="small muted">+ {money(p.direct, { whole: true })} paid</span>}
              </>}
            {p.expected > 0 && <span className="small muted">+{money(p.expected, { whole: true })} due</span>}
          </button>
        ))}
        <button className="btn small ghost" onClick={() => setPerson('new')}><Icon name="plus" size={16} /> Person</button>
      </div>
      {unassigned > 0 && (
        <div className="tip small" style={{ alignItems: 'center' }}>
          <span style={{ flex: 1 }}><b>{money(unassigned)}</b> of the balance isn't assigned to anyone yet. Split it to show who put in what.</span>
          <button className="btn small primary" onClick={() => setSplitting(true)}>Split {money(unassigned, { whole: true })}</button>
        </div>
      )}
      {unassigned < 0 && <span className="small muted">Everyone's totals come to {money(-unassigned)} more than the balance (costs already spent, or returns down).</span>}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn small primary" onClick={() => setAdding('in')}><Icon name="plus" size={16} /> Add money</button>
        <button className="btn small" onClick={() => setAdding('out')}>Take money out</button>
      </div>
      {entries.length === 0
        ? <p className="small muted">Gifts and one-off deposits show here (your payday transfers are counted automatically). Taking money out records who it was for.</p>
        : <p className="small muted">{money(received)} in{out ? ` · ${money(out)} out` : ''}{expected ? ` · ${money(expected)} expected` : ''}</p>}
      <div>
        {entries.map((x) => (
          <div key={x.id} className="list-row">
            <span className="dot" style={{ background: colorFor(goal, x.person ?? UNASSIGNED) }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              {x.out ? `For ${x.person ? personLabel(x.person) : '…'}` : x.person ? `From ${personLabel(x.person)}` : 'Money added'}
              <span className="small muted" style={{ display: 'block' }}>
                {[`${fmtShort(x.date)} ${x.date.slice(0, 4)}`, x.out ? 'Taken out' : x.received ? '' : 'Expected', x.note].filter(Boolean).join(' · ')}
              </span>
            </span>
            <b className={x.out ? 'neg' : 'pos'} style={{ whiteSpace: 'nowrap' }}>{x.out ? '−' : '+'}{money(x.amount)}</b>
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

function GiftModal({ goal, gift, out = false, onClose }: { goal: SavingsGoal; gift?: GoalGift; out?: boolean; onClose: () => void }) {
  const { update } = useBudget();
  const today = todayISO();
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
    const who = person.startsWith(NEW) ? person.slice(NEW.length).trim() : person;
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
          <h2 id="gift-title" className="h2">{gift ? (out ? 'Edit money taken out' : 'Edit money added') : out ? `${goal.name}: take money out` : `${goal.name}: add money`}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="form-grid">
          <label className="field">Amount
            <input autoFocus inputMode="decimal" value={amount} placeholder="500.00" onChange={(e) => { setAmount(e.target.value); setErr(''); }} onKeyDown={(e) => e.key === 'Enter' && save()} />
          </label>
          <label className="field">Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <PersonPicker goal={goal} value={person} onChange={(v) => { setPerson(v); setErr(''); }} label={out ? 'Who it’s for' : 'Who it’s from'} />
        <label className="field">Note (optional)
          <input value={note} placeholder={out ? 'Paid back' : 'Christmas gift'} onChange={(e) => setNote(e.target.value)} />
        </label>
        {out ? (
          <p className="small muted">Takes it off the saved balance and off their total. To pay for a wedding cost, use <b>Spend money</b> under the costs instead.</p>
        ) : future ? (
          <p className="small muted">A future date makes it <b>expected</b>: it counts in the plan from {fmtShort(date)}, and you tap <b>Received</b> when it arrives.</p>
        ) : (
          <label className="row" style={{ fontSize: 14, cursor: 'pointer', minHeight: 44 }}>
            <input type="checkbox" checked={received} onChange={(e) => setReceived(e.target.checked)} style={{ width: 20, height: 20, accentColor: 'var(--brand)' }} />
            Already in the account (adds it to the saved balance)
          </label>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="between">
          {gift ? <button className="btn ghost danger" onClick={remove}>Delete</button> : <span />}
          <div className="row">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save}>{gift ? 'Save' : out ? 'Take out' : 'Add money'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Set someone's total (what they've put in so far), rename or remove them — or add a new person. */
function PersonModal({ goal, person, onClose }: { goal: SavingsGoal; person?: Contribution; onClose: () => void }) {
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
          <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
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
        <label className="row" style={{ fontSize: 14, cursor: 'pointer', minHeight: 44, gap: 10 }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} style={{ width: 20, height: 20, accentColor: 'var(--brand)' }} />
          <span>Gets whatever's left of the balance
            <span className="small muted" style={{ display: 'block' }}>
              {otherRemainder ? `Takes this over from ${personLabel(otherRemainder)}. ` : ''}Their total is the balance minus everyone else's, so it always adds up.
            </span>
          </span>
        </label>
        {!auto && <p className="small muted">
          {isYou ? 'Your payday transfers to this fund are added for you automatically from the budget start. ' : ''}
          {others ? `Their entries${person?.pay ? ' and pay' : ''} so far come to ${money(others)}; the rest is counted as put in earlier. ` : ''}
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
function SplitModal({ goal, onClose }: { goal: SavingsGoal; onClose: () => void }) {
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
          <h2 id="split-title" className="h2">Who put in the {money(goal.balance, { whole: true })}?</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {people.map((p) => (
            <label key={p.person} className="row" style={{ gap: 10 }}>
              <span className="dot" style={{ background: colorFor(goal, p.person) }} />
              <span style={{ flex: 1 }}>{personLabel(p.person)}{p.person === rest && <span className="small muted" style={{ display: 'block' }}>Gets what's left</span>}</span>
              <input inputMode="decimal" aria-label={`${personLabel(p.person)} put in`} value={p.person === rest ? centsToInput(cents(p.person) ?? 0) : vals[p.person] ?? ''} disabled={p.person === rest} placeholder="0.00"
                onChange={(e) => { setVals((v) => ({ ...v, [p.person]: e.target.value })); setErr(''); }} onKeyDown={(e) => e.key === 'Enter' && save()}
                style={{ width: 130, minHeight: 44, padding: '0 10px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', color: 'inherit', fontSize: 16, fontWeight: 600 }} />
            </label>
          ))}
        </div>
        <div className="between">
          <button className="btn small" onClick={evenly}>Split evenly</button>
          <b className={left < 0 ? 'neg' : left === 0 ? 'pos' : ''}>{left === 0 ? 'All assigned' : left > 0 ? `${money(left)} left to assign` : `${money(-left)} more than the balance`}</b>
        </div>
        <p className="small muted">Anything left over stays as "Not assigned" (e.g. fund returns). Someone missing? Add them with <b>+ Person</b> first. Your payday transfers keep adding to your total.</p>
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
