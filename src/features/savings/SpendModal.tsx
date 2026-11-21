import { useState } from 'react';
import { todayISO } from '../../core/dates';
import { costCategories, leftOn, spendFromGoal } from './logic/goalcosts';
import { cash, parseMoney } from '../../core/money';
import { newId, useBudget } from '../../state/store';
import type { SavingsGoal } from '../../core/types';
import { Icon } from '../../ui/Icon';

/** Spend money from the goal: pick a cost (or add a new one); comes off the saved balance and that cost. */
export function SpendModal({ goal, onClose }: { goal: SavingsGoal; onClose: () => void }) {
  const { budget, update } = useBudget();
  const COST_CATEGORIES = costCategories(budget);
  const today = todayISO();
  const costs = goal.costs ?? [];
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [costId, setCostId] = useState(costs.find((c) => leftOn(c) > 0)?.id ?? 'new');
  const [newName, setNewName] = useState('');
  // The first category in the list, as the dropdown shows ('Other' when you have one).
  const [newCat, setNewCat] = useState(() => (COST_CATEGORIES.includes('Other') ? 'Other' : COST_CATEGORIES[0] ?? '__new'));
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
          <button className="icon-btn plain" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
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
            {costs.map((x) => <option key={x.id} value={x.id}>{x.name} ({cash(leftOn(x))} left)</option>)}
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
            Takes {cash(c)} off the saved balance{target ? ` and off ${target.name}: ${cash(leftOn(target))} → ${cash(Math.max(0, leftOn(target) - c))} left` : ', and adds it to the list as spent'}.
            {target && c > leftOn(target) ? ` That's ${cash(c - leftOn(target))} more than was budgeted.` : ''}
          </p>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Spend</button>
        </div>
      </div>
    </div>
  );
}
