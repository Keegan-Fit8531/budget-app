import { useRef, useState } from 'react';
import { PALETTE } from '../lib/colors';
import { addDays, fmtDay, fmtShort, todayISO } from '../lib/dates';
import { periodContaining } from '../lib/engine';
import { costCategories, leftOn, removeSpend, spendFromGoal, spentOn, summariseCosts } from '../lib/goalcosts';
import { centsToInput, money, parseMoney } from '../lib/money';
import { newId, useBudget } from '../lib/store';
import type { ReactNode } from 'react';
import type { GoalCost, SavingsGoal } from '../lib/types';
import { CostCategoriesModal } from './CostCategories';
import { Donut, Legend } from './Donut';
import { NEW_PERSON, PersonPicker } from './GoalGifts';
import { addPerson, paidShares, peopleOf } from '../lib/contributions';
import { Icon } from './Icon';

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
  const catColor = (c: string) => PALETTE[Math.max(0, cats.indexOf(c)) % PALETTE.length];

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn small primary" onClick={() => setModal({})}><Icon name="plus" size={16} /> Add cost</button>
        {costs.length > 0 && <button className="btn small" onClick={() => setSpending(true)}>Spend money</button>}
        <button className="btn small ghost" onClick={() => setEditCats(true)}>Categories</button>
      </div>

      {costs.length === 0 && <p className="small muted">Add the costs this has to cover (venue, photographer…), with due dates if they have one. They're checked against what you'll have saved.</p>}

      {costs.length > 0 && (
        <>
          <div>
            <div className="between small">
              <span><b>{money(s.toPay, { whole: true })}</b> <span className="muted">still to pay of {money(s.total, { whole: true })}</span></span>
              {s.paid > 0 && <span className="muted">{money(s.paid, { whole: true })} paid</span>}
            </div>
          </div>
          {/* Share of costs by category. */}
          <div className="row" style={{ flexWrap: 'wrap', gap: 20, alignItems: 'center' }}>
            <Donut size={130} slices={groups.map((g) => ({ label: g.cat, value: g.total, color: catColor(g.cat) }))}>
              <span className="small muted">Costs</span>
              <b style={{ fontSize: 16 }}>{money(s.total, { whole: true })}</b>
            </Donut>
            <Legend slices={groups.map((g) => ({ label: g.cat, value: g.total, color: catColor(g.cat) }))} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {groups.map((g) => {
              const expanded = openGroups.includes(g.cat);
              return (
                <div key={g.cat} className="cost-group" style={{ ['--group' as string]: catColor(g.cat) }}>
                  <button className="between cost-group-head" aria-expanded={expanded} onClick={() => toggleGroup(g.cat)}
                    style={{ width: '100%', background: 'none', border: 0, color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left', flexWrap: 'nowrap', borderBottom: expanded ? undefined : 0 }}>
                    <span className="row" style={{ gap: 8, minWidth: 0 }}>
                      <span className="dot" style={{ background: catColor(g.cat) }} />
                      <span style={{ minWidth: 0 }}>
                        <b style={{ fontSize: 15 }}>{g.cat}</b>
                        <span className="small muted" style={{ display: 'block' }}>
                          {g.open.length + g.done.length} cost{g.open.length + g.done.length === 1 ? '' : 's'}
                          {g.left === 0 ? ' · all paid' : g.left !== g.total ? ` · ${money(g.left, { whole: true })} to pay` : ''}
                        </span>
                      </span>
                    </span>
                    <span className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
                      <span style={{ textAlign: 'right' }}>
                        <b style={{ display: 'block' }}>{money(g.total, { whole: true })}</b>
                        {g.left > 0 && <span className={`small ${g.short ? 'neg' : 'pos'}`}>{g.short ? `${money(g.short, { whole: true })} short` : 'Covered'}</span>}
                      </span>
                      <span aria-hidden="true" style={{ display: 'inline-flex', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}><Icon name="down" size={18} /></span>
                    </span>
                  </button>
                  {expanded && (
                    <div>
                      {g.open.map((c) => (
                        <CostRow key={c.cost.id} goal={goal} cost={c.cost} open={openId === c.cost.id} onToggle={() => setOpenId(openId === c.cost.id ? null : c.cost.id)}
                          onEdit={() => setModal({ cost: c.cost })}
                          status={<span className={`small ${!c.by ? 'muted' : c.covered ? 'pos' : 'neg'}`}>{!c.by ? 'Needs a date' : c.covered ? 'Covered' : `${money(c.short, { whole: true })} short`}</span>}
                          due={c.cost.due ? `Due ${fmtShort(c.cost.due)}` : undefined} />
                      ))}
                      {g.done.map((c) => (
                        <CostRow key={c.id} goal={goal} cost={c} done open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)}
                          onEdit={() => setModal({ cost: c })}
                          status={<span className="small pos">{!c.paid ? 'Spent' : c.paidOutside ? `Paid by ${paidShares(c).map((x) => x.person).join(' & ') || '…'}` : 'Paid'}</span>}
                          due={c.paidOn ? `Paid ${fmtShort(c.paidOn)} ${c.paidOn.slice(0, 4)}${paidShares(c).length > 1 ? ` · ${paidShares(c).map((x) => `${x.person} ${money(x.amount, { whole: true })}`).join(' + ')}` : c.paidOutside ? ' · not from the fund' : ''}` : c.due ? fmtShort(c.due) : undefined} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="small muted">
            {goal.targetDate
              ? <>Costs without a due date are checked against {fmtDay(goal.targetDate)} (the last pay that counts is {fmtDay(periodContaining(addDays(goal.targetDate, -1), budget.settings).start)}). </>
              : <>Set a target date with Edit to check costs without a due date. </>}
            "Covered" means the fund should have enough by then. Tap a group to see its costs.
          </p>
        </>
      )}

      {modal && <CostModal goal={goal} cost={modal.cost} onClose={() => setModal(null)} />}
      {spending && <SpendModal goal={goal} onClose={() => setSpending(false)} />}
      {editCats && <CostCategoriesModal onClose={() => setEditCats(false)} />}
    </div>
  );
}

function CostModal({ goal, cost, onClose }: { goal: SavingsGoal; cost?: GoalCost; onClose: () => void }) {
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
      if (sum !== c) return fail(`The amounts add up to ${money(sum)}, but the cost is ${money(c)}.`, 'split');
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
          <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Paid?</span>
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {split.map((r, i) => (
                  <div key={r.key} className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'nowrap' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
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
                    <b className={sum === total ? 'pos' : 'neg'}>{sum === total ? 'Adds up' : sum < total ? `${money(total - sum)} still to split` : `${money(sum - total)} too much`}</b>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
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

/** One cost line: what's left, its status, and (opened) every spend with dates and the total. */
function CostRow({ goal, cost, status, due, done, open, onToggle, onEdit }: {
  goal: SavingsGoal; cost: GoalCost; status: ReactNode; due?: string; done?: boolean; open: boolean;
  onToggle: () => void; onEdit: () => void;
}) {
  const { update } = useBudget();
  // Undoing a spend asks whether the money goes back into the saved balance.
  const [undo, setUndo] = useState<{ id: string; amount: number; date: string } | null>(null);
  const undoSpend = (putBack: boolean) => {
    if (!undo) return;
    const id = undo.id;
    update((b) => { const g = (b.savings ?? []).find((y) => y.id === goal.id); if (g) { removeSpend(g, cost.id, id, putBack); if (putBack) g.asOf = todayISO(); } return b; });
    setUndo(null);
  };
  const spent = spentOn(cost);
  const left = leftOn(cost);
  const spends = [...(cost.spends ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <div style={{ borderBottom: '1px solid var(--line)' }}>
      <div className={`list-row${done ? ' muted' : ''}`} style={{ borderBottom: 0 }}>
        <button onClick={onEdit} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit', overflowWrap: 'anywhere' }}>
          <span style={{ display: 'block' }}>{done ? <s>{cost.name}</s> : cost.name}</span>
          {(due || (spent > 0 && !done)) && <span className="small muted">{[due, spent > 0 && !done ? `${money(spent)} spent of ${money(cost.amount)}` : ''].filter(Boolean).join(' · ')}</span>}
        </button>
        <span style={{ textAlign: 'right', flex: '0 0 auto' }}>
          <b style={{ display: 'block', whiteSpace: 'nowrap' }}>{money(done ? Math.max(cost.amount, spent) : left, { whole: true })}</b>
          {spent > cost.amount ? <span className="small neg" style={{ display: 'block' }}>{money(spent - cost.amount)} over</span> : status}
        </span>
        <button className="btn small ghost" onClick={onEdit} style={{ flex: '0 0 auto', paddingInline: 8 }} aria-label={`Edit ${cost.name}`}><Icon name="edit" size={16} /></button>
      </div>
      {spends.length > 0 && (
        <button className="btn small ghost" onClick={onToggle} aria-expanded={open} style={{ marginBottom: 6, minHeight: 30 }}>
          {open ? 'Hide' : 'Show'} {spends.length} spend{spends.length === 1 ? '' : 's'} · {money(spent)} spent
        </button>
      )}
      {open && spends.length > 0 && (
        <div style={{ marginBottom: 10, background: 'var(--bg)', borderRadius: 12, padding: '4px 12px' }}>
          {spends.map((x) => (
            <div key={x.id} className="list-row small">
              <span style={{ width: 56, flex: '0 0 56px' }}>{fmtShort(x.date)}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{x.note || 'Spent'}</span>
              <b>{money(x.amount)}</b>
              <button className="btn small ghost" aria-label={`Remove ${money(x.amount)} spent on ${fmtShort(x.date)}`}
                onClick={() => setUndo({ id: x.id, amount: x.amount, date: x.date })}>
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
          <div className="list-row small"><span style={{ flex: 1 }}><b>Total spent</b></span><b>{money(spent)}</b></div>
          <div className="list-row small muted"><span style={{ flex: 1 }}>Budgeted {money(cost.amount)}</span><span>{spent > cost.amount ? `${money(spent - cost.amount)} over` : `${money(cost.amount - spent)} left`}</span></div>
        </div>
      )}
      {undo && (
        <div className="modal-back" onClick={() => setUndo(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="undo-spend-title" onClick={(e) => e.stopPropagation()}>
            <div className="between">
              <h2 id="undo-spend-title" className="h2">Remove {money(undo.amount)} spent on {fmtShort(undo.date)}?</h2>
              <button className="icon-btn" aria-label="Close" onClick={() => setUndo(null)}><Icon name="x" /></button>
            </div>
            <p className="small muted">
              It comes off {cost.name} either way. Choose what happens to the saved balance, now {money(goal.balance)}.
            </p>
            <button className="btn primary" onClick={() => undoSpend(true)}>Put {money(undo.amount)} back: balance becomes {money(goal.balance + undo.amount)}</button>
            <button className="btn" onClick={() => undoSpend(false)}>Leave the balance at {money(goal.balance)}</button>
            <p className="small muted">Leave it if the balance already shows the real amount (e.g. you've updated it since, or the spend was more than was saved).</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setUndo(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Spend money from the goal: pick a cost (or add a new one); comes off the saved balance and that cost. */
function SpendModal({ goal, onClose }: { goal: SavingsGoal; onClose: () => void }) {
  const { budget, update } = useBudget();
  const COST_CATEGORIES = costCategories(budget);
  const today = todayISO();
  const costs = goal.costs ?? [];
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [costId, setCostId] = useState(costs.find((c) => leftOn(c) > 0)?.id ?? 'new');
  const [newName, setNewName] = useState('');
  const [newCat, setNewCat] = useState('Other');
  const [newCatName, setNewCatName] = useState('');
  const [err, setErr] = useState('');
  const c = parseMoney(amount);
  const target = costs.find((x) => x.id === costId);

  function save() {
    if (c === null || c <= 0) return setErr('Enter how much you spent.');
    if (costId === 'new' && !newName.trim()) return setErr('Enter what the new cost is.');
    const cat = newCat === '__new' ? newCatName.trim() : newCat;
    if (costId === 'new' && !cat) return setErr('Enter a name for the new category.');
    update((b) => {
      const g = (b.savings ?? []).find((x) => x.id === goal.id);
      if (!g) return b;
      if (costId === 'new' && !costCategories(b).includes(cat)) b.costCategories = [...costCategories(b), cat];
      spendFromGoal(g, { id: newId(), amount: c, date, note: note.trim() || undefined },
        costId === 'new' ? { newCost: { id: newId(), name: newName.trim(), category: cat } } : { costId });
      return b;
    });
    onClose();
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="spend-title" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2 id="spend-title" className="h2">{goal.name}: spend money</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="form-grid">
          <label className="field">Amount spent
            <input autoFocus inputMode="decimal" value={amount} placeholder="200.00" onChange={(e) => { setAmount(e.target.value); setErr(''); }} />
          </label>
          <label className="field">Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <label className="field">What it was for
          <select value={costId} onChange={(e) => setCostId(e.target.value)}>
            {costs.map((x) => <option key={x.id} value={x.id}>{x.name} ({money(leftOn(x))} left)</option>)}
            <option value="new">New cost…</option>
          </select>
        </label>
        {costId === 'new' && (
          <div className="form-grid">
            <label className="field">New cost
              <input value={newName} placeholder="Invitations" onChange={(e) => { setNewName(e.target.value); setErr(''); }} />
            </label>
            <label className="field">Category
              <select value={newCat} onChange={(e) => setNewCat(e.target.value)}>
                {COST_CATEGORIES.map((x) => <option key={x} value={x}>{x}</option>)}
                <option value="__new">+ New category…</option>
              </select>
            </label>
            {newCat === '__new' && (
              <label className="field">New category name
                <input value={newCatName} onChange={(e) => { setNewCatName(e.target.value); setErr(''); }} placeholder="Cake" />
              </label>
            )}
          </div>
        )}
        <label className="field">Note (optional)
          <input value={note} placeholder="Flowers from the market" onChange={(e) => setNote(e.target.value)} />
        </label>
        {c !== null && c > 0 && (
          <p className="small muted">
            Takes {money(c)} off the saved balance{target ? ` and off ${target.name}: ${money(leftOn(target))} → ${money(Math.max(0, leftOn(target) - c))} left` : ', and adds it to the list as spent'}.
            {target && c > leftOn(target) ? ` That's ${money(c - leftOn(target))} more than was budgeted.` : ''}
          </p>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Spend</button>
        </div>
      </div>
    </div>
  );
}
