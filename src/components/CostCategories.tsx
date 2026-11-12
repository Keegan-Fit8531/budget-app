import { useState } from 'react';
import { costCategories, removeCostCategory, renameCostCategory } from '../lib/goalcosts';
import { useBudget } from '../lib/store';
import { Icon } from './Icon';

/** Rename, add and remove the categories used for savings-goal costs (e.g. wedding). */
export function CostCategoriesEditor({ bare }: { bare?: boolean } = {}) {
  const { budget, update } = useBudget();
  const cats = costCategories(budget);
  const used = (c: string) => (budget.savings ?? []).reduce((t, g) => t + (g.costs ?? []).filter((x) => x.category === c).length, 0);
  const [adding, setAdding] = useState('');
  const [err, setErr] = useState('');

  function rename(from: string, to: string) {
    const name = to.trim();
    if (!name || name === from) return;
    if (cats.includes(name)) { setErr(`"${name}" already exists.`); return; }
    setErr('');
    update((b) => { renameCostCategory(b, from, name); return b; });
  }
  function add() {
    const name = adding.trim();
    if (!name) return;
    if (cats.includes(name)) { setErr(`"${name}" already exists.`); return; }
    setErr('');
    update((b) => { b.costCategories = [...costCategories(b), name]; return b; });
    setAdding('');
  }
  function remove(name: string) {
    const n = used(name);
    const moveTo = cats.find((c) => c !== name && c === 'Other') ?? cats.find((c) => c !== name) ?? 'Other';
    if (n && !confirm(`${n} cost${n === 1 ? '' : 's'} use "${name}". Move ${n === 1 ? 'it' : 'them'} to "${moveTo}"?`)) return;
    update((b) => { removeCostCategory(b, name, moveTo); return b; });
  }

  const Wrap = bare ? 'div' : 'section';
  return (
    <Wrap className={bare ? undefined : 'card'} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {!bare && <h2 className="h2">Savings cost categories</h2>}
      <p className="small muted">Used for costs on savings goals, like the wedding, and their pie chart. Renaming updates every cost in that category.</p>
      {cats.map((c) => (
        <div key={c} className="row" style={{ gap: 8 }}>
          <input aria-label={`Category name: ${c}`} defaultValue={c} key={`${c}-name`}
            onBlur={(e) => rename(c, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            style={{ flex: 1, minHeight: 44, padding: '0 12px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--card)', fontSize: 16 }} />
          <span className="small muted" style={{ width: 64, textAlign: 'right' }}>{used(c)} cost{used(c) === 1 ? '' : 's'}</span>
          <button className="icon-btn" aria-label={`Remove ${c}`} onClick={() => remove(c)}><Icon name="x" size={16} /></button>
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <input aria-label="New category" value={adding} placeholder="New category, e.g. Cake" onChange={(e) => { setAdding(e.target.value); setErr(''); }}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          style={{ flex: 1, minHeight: 44, padding: '0 12px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--card)', fontSize: 16 }} />
        <button className="btn" onClick={add}><Icon name="plus" size={16} /> Add</button>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
    </Wrap>
  );
}


/** The same editor in a pop-up, for use from the wedding costs. */
export function CostCategoriesModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="cats-title" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2 id="cats-title" className="h2">Cost categories</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <CostCategoriesEditor bare />
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
