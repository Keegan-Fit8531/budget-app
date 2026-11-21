import { useRef, useState } from 'react';
import { fmtShort, todayISO } from '../../core/dates';
import { costCategories, spentOn } from './logic/goalcosts';
import { cash, centsToInput, parseMoney } from '../../core/money';
import { newId, useBudget } from '../../state/store';
import type { GoalCost, SavingsGoal } from '../../core/types';
import { NEW_PERSON } from './logic/gifts';
import { PersonPicker } from './GoalGifts';
import { addPerson, paidShares, peopleOf } from './logic/contributions';
import { Icon } from '../../ui/Icon';

export function CostModal({ goal, cost, onClose }: { goal: SavingsGoal; cost?: GoalCost; onClose: () => void }) {
  const { budget, update } = useBudget();
  const COST_CATEGORIES = costCategories(budget);
  const [name, setName] = useState(cost?.name ?? '');
  const [amount, setAmount] = useState(cost ? centsToInput(cost.amount) : '');
  const [category, setCategory] = useState(cost?.category ?? COST_CATEGORIES[0]);
  const [newCategory, setNewCategory] = useState('');
  const [due, setDue] = useState(cost?.due ?? '');
  const [pay, setPay] = useState<'no' | 'fund' | 'outside'>(cost?.paid ? (cost.paidOutside ? 'outside' : 'fund') : 'no');
  // Who paid how much (paid outside the fund). One row to start; amounts blank = the whole cost.
  const [split, setSplit] = useState<{ key: string; person: string; amount: string }[]>(() => {
    const shares = cost ? paidShares(cost) : [];
    return shares.length
      ? shares.map((x, i) => ({ key: `r${i}`, person: x.person, amount: shares.length > 1 ? centsToInput(x.amount) : '' }))
      : [{ key: 'r0', person: peopleOf(goal)[0], amount: '' }];
  });
  const nameOf = (v: string) => (v.startsWith(NEW_PERSON) ? v.slice(NEW_PERSON.length).trim() : v);
  const splitCents = (total: number) => split.map((r) => ({ person: nameOf(r.person), amount: split.length === 1 && !r.amount.trim() ? total : parseMoney(r.amount) }));
  const [paidOn, setPaidOn] = useState(cost?.paidOn ?? todayISO());
  const [errAt, setErrAt] = useState<'name' | 'amount' | 'category' | 'split' | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  /** Show the problem under the field it's about, and jump there (it may be scrolled out of view). */
  const fail = (msg: string, at: 'name' | 'amount' | 'category' | 'split') => {
    setErr(msg); setErrAt(at);
    const el = at === 'name' ? nameRef.current : at === 'amount' ? amountRef.current : null;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); el?.focus();
  };
  const fieldErr = (at: typeof errAt) => (err && errAt === at ? <span className="error small" role="alert" style={{ fontWeight: 500 }}>{err}</span> : null);
  const [err, setErr] = useState('');

  function save() {
    const c = parseMoney(amount);
    if (!name.trim()) return fail('Give the cost a name, e.g. Wedding bands.', 'name');
    if (c === null || c <= 0) return fail('Enter an amount above $0.', 'amount');
    const cat = category === '__new' ? newCategory.trim() : category;
    if (!cat) return fail('Enter a name for the new category.', 'category');
    if (pay === 'outside') {
      const rows = splitCents(c);
      if (rows.some((r) => !r.person)) return fail('Enter who paid it.', 'split');
      if (rows.some((r) => r.amount === null || r.amount <= 0)) return fail('Enter how much each person paid.', 'split');
      const sum = rows.reduce((t, r) => t + (r.amount ?? 0), 0);
      if (sum !== c) return fail(`The amounts add up to ${cash(sum)}, but the cost is ${cash(c)}.`, 'split');
      if (new Set(rows.map((r) => r.person)).size !== rows.length) return fail('Each person can only be listed once.', 'split');
    }
    update((b) => {
      const g = (b.savings ?? []).find((x) => x.id === goal.id);
      if (!g) return b;
      if (!costCategories(b).includes(cat)) b.costCategories = [...costCategories(b), cat];
      g.costs = g.costs ?? [];
      // Keep what the form doesn't edit (e.g. its spend history).
      const existing = cost ? g.costs.find((x) => x.id === cost.id) : undefined;
      const shares = pay === 'outside' ? splitCents(c).map((r) => ({ person: r.person, amount: r.amount ?? 0 })) : [];
      const spent = existing ? spentOn(existing) : 0;
      // Only paying from the fund changes the saved balance; paid outside the fund just records it.
      const fromFundBefore = existing?.paid && !existing.paidOutside ? Math.max(0, existing.amount - spent) : 0;
      const fromFundNow = pay === 'fund' ? Math.max(0, c - spent) : 0;
      if (fromFundBefore !== fromFundNow) { g.balance = Math.max(0, g.balance + fromFundBefore - fromFundNow); g.asOf = todayISO(); }
      for (const x of shares) addPerson(g, x.person);
      const next: GoalCost = {
        ...existing, id: cost?.id ?? newId(), name: name.trim(), amount: c, category: cat, due: pay === 'no' ? due || undefined : undefined,
        paid: pay !== 'no' || undefined,
        paidOutside: pay === 'outside' || undefined,
        paidBy: shares.length === 1 ? shares[0].person : undefined,
        paidSplit: shares.length > 1 ? shares : undefined,
        paidOn: pay !== 'no' ? paidOn || todayISO() : undefined,
      };
      const i = g.costs.findIndex((x) => x.id === next.id);
      if (i >= 0) g.costs[i] = next; else g.costs.push(next);
      return b;
    });
    onClose();
  }
  function remove() {
    update((b) => {
      const g = (b.savings ?? []).find((x) => x.id === goal.id);
      if (g?.costs) g.costs = g.costs.filter((x) => x.id !== cost?.id);
      return b;
    });
    onClose();
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="cost-title" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2 id="cost-title" className="h2">{cost ? `Edit ${cost.name}` : `${goal.name}: add a cost`}</h2>
          <button className="icon-btn plain" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <label className="field">What it is
          <input ref={nameRef} autoFocus={!cost} value={name} onChange={(e) => { setName(e.target.value); setErr(''); }} placeholder="Wedding bands" />
          {fieldErr('name')}
        </label>
        <div className="form-grid">
          <label className="field">Amount
            <input ref={amountRef} inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setErr(''); }} placeholder="3,000.00" />
            {fieldErr('amount')}
          </label>
          <label className="field">Category
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {COST_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              <option value="__new">+ New category…</option>
            </select>
          </label>
          {category === '__new' && (
            <label className="field">New category name
              <input autoFocus value={newCategory} onChange={(e) => { setNewCategory(e.target.value); setErr(''); }} placeholder="Cake" />
              {fieldErr('category')}
            </label>
          )}
        </div>
        <div className="stack gap-8">
          <span className="h3">Paid?</span>
          <div className="seg" role="group" aria-label="Paid?" style={{ display: 'flex' }}>
            <button aria-pressed={pay === 'no'} onClick={() => setPay('no')} style={{ flex: 1, paddingInline: 6 }}>Not yet</button>
            <button aria-pressed={pay === 'fund'} onClick={() => setPay('fund')} style={{ flex: 1, paddingInline: 6 }}>From the fund</button>
            <button aria-pressed={pay === 'outside'} onClick={() => setPay('outside')} style={{ flex: 1, paddingInline: 6 }}>Paid already</button>
          </div>
          {pay === 'fund' && <p className="small muted">Takes {cost && spentOn(cost) ? 'what\u2019s left of it' : 'it'} off the saved balance.</p>}
          {pay === 'outside' && <p className="small muted">Paid with other money (not the fund), so your savings don't change. It's recorded against who paid.</p>}
          {pay === 'outside' && (() => {
            const total = parseMoney(amount) ?? 0;
            const sum = split.reduce((t, r) => t + (split.length === 1 && !r.amount.trim() ? total : parseMoney(r.amount) ?? 0), 0);
            return (
              <div className="stack gap-8">
                {split.map((r, i) => (
                  <div key={r.key} className="row gap-8 bottom nowrap">
                    <div className="grow">
                      <PersonPicker goal={goal} value={r.person} label={i === 0 ? 'Paid by' : 'And'}
                        onChange={(v) => { setSplit((sp) => sp.map((x) => (x.key === r.key ? { ...x, person: v } : x))); setErr(''); }} />
                    </div>
                    <label className="field" style={{ width: 120, flex: '0 0 120px' }}>{i === 0 ? 'Amount' : ' '}
                      <input inputMode="decimal" value={r.amount} placeholder={split.length === 1 ? 'All of it' : '0.00'}
                        onChange={(e) => { setSplit((sp) => sp.map((x) => (x.key === r.key ? { ...x, amount: e.target.value } : x))); setErr(''); }} />
                    </label>
                    {split.length > 1 && (
                      <button className="icon-btn" aria-label="Remove this person" style={{ marginBottom: 4 }} onClick={() => setSplit((sp) => sp.filter((x) => x.key !== r.key))}><Icon name="x" /></button>
                    )}
                  </div>
                ))}
                <div className="between small">
                  <button className="btn small ghost" onClick={() => setSplit((sp) => {
                    const used = sp.map((x) => nameOf(x.person));
                    const next = peopleOf(goal).find((p) => !used.includes(p)) ?? `${NEW_PERSON}`;
                    const first = sp.length === 1 && !sp[0].amount.trim() ? [{ ...sp[0], amount: '' }] : sp;
                    return [...first, { key: `r${Date.now()}`, person: next, amount: '' }];
                  })}><Icon name="plus" size={16} /> Add another person</button>
                  {fieldErr('split')}
                  {split.length > 1 && total > 0 && (
                    <b className={sum === total ? 'pos' : 'neg'}>{sum === total ? 'Adds up' : sum < total ? `${cash(total - sum)} still to split` : `${cash(sum - total)} too much`}</b>
                  )}
                </div>
              </div>
            );
          })()}
          {pay !== 'no' && (
            <div className="form-grid">
              <label className="field">Paid on
                <input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
              </label>
            </div>
          )}
        </div>
        {pay === 'no' && (
          <div className="stack gap-6">
            <div className="row gap-8 bottom">
              <label className="field" style={{ flex: 1 }}>Due date (optional)
                <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
              </label>
              {due && <button className="btn small ghost" onClick={() => setDue('')}>Clear</button>}
            </div>
            <p className="small muted">No due date? It's checked against the wedding date{goal.targetDate ? ` (${fmtShort(goal.targetDate)})` : ''}.</p>
          </div>
        )}
        {err && <p className="error small" role="status">{errAt === 'name' ? '\u2191 ' : ''}{err}</p>}
        <div className="between">
          {cost ? <button className="btn ghost danger" onClick={remove}>Delete</button> : <span />}
          <div className="row">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save}>{cost ? 'Save' : 'Add'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
