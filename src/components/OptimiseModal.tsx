import { useMemo, useState } from 'react';
import { allocationTargets, allowancePerWeek, applyAllocation, type AllocationUndo, type AllocMode } from '../lib/allocate';
import { fmtShort, monthName, todayISO } from '../lib/dates';
import type { Period } from '../lib/engine';
import { centsToInput, money, parseMoney } from '../lib/money';
import { useBudget } from '../lib/store';
import { Icon } from './Icon';

const UNDO_KEY = 'paydays.optimise.undo';

export interface OptimiseUndo extends AllocationUndo { at: string; label: string }

export function readOptimiseUndo(): OptimiseUndo | null {
  try {
    const raw = localStorage.getItem(UNDO_KEY);
    const u = raw ? JSON.parse(raw) : null;
    return u && u.periodStart && !Array.isArray(u.items) ? u : null; // ignore the old format
  } catch { return null; }
}
export function clearOptimiseUndo() {
  try { localStorage.removeItem(UNDO_KEY); } catch { /* ignore */ }
}

/** Put the money left over this pay where you choose: goals, weekly allowance, debts, or keep it to spend. */
export function OptimiseModal({ period, leftover, onClose, onApplied }: {
  period: Period; leftover: number; onClose: () => void; onApplied: (u: OptimiseUndo) => void;
}) {
  const { budget, update } = useBudget();
  const targets = useMemo(() => allocationTargets(budget), [budget]);
  const [mode, setMode] = useState<AllocMode>('once');
  const [ticked, setTicked] = useState<string[]>(() => targets.filter((t) => t.kind === 'goal').slice(0, 1).map((t) => t.id));
  const [amounts, setAmounts] = useState<Record<string, string>>(() => {
    const first = targets.find((t) => t.kind === 'goal');
    return first ? { [first.id]: centsToInput(leftover) } : {};
  });
  const cents = (id: string) => (ticked.includes(id) ? Math.max(0, parseMoney(amounts[id] ?? '') ?? 0) : 0);
  const allocated = targets.reduce((t, x) => t + cents(x.id), 0);
  const left = leftover - allocated;

  function toggle(id: string, on: boolean) {
    setTicked((t) => (on ? [...t, id] : t.filter((x) => x !== id)));
    if (on && !amounts[id]) setAmounts((a) => ({ ...a, [id]: centsToInput(Math.max(0, left)) }));
  }
  function splitEvenly() {
    if (!ticked.length) return;
    const each = Math.floor(leftover / ticked.length);
    const next: Record<string, string> = { ...amounts };
    ticked.forEach((id, i) => { next[id] = centsToInput(i === ticked.length - 1 ? leftover - each * (ticked.length - 1) : each); });
    setAmounts(next);
  }
  function allTo(id: string) {
    setTicked([id]);
    setAmounts({ [id]: centsToInput(leftover) });
  }
  function apply() {
    const allocs = targets.map((t) => ({ targetId: t.id, amount: cents(t.id) })).filter((a) => a.amount > 0);
    if (!allocs.length) return onClose();
    let undo: OptimiseUndo | null = null;
    update((b) => {
      const u = applyAllocation(b, period, allocs, mode);
      undo = { at: todayISO(), label: mode === 'once' ? `${monthName(period.start)} pay` : 'every pay', ...u };
      return b;
    });
    if (undo) {
      try { localStorage.setItem(UNDO_KEY, JSON.stringify(undo)); } catch { /* ignore */ }
      onApplied(undo);
    }
    onClose();
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="opt-title" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2 id="opt-title" className="h2">Put {money(leftover)} to work</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <p className="small muted">Left over from the {fmtShort(period.start)} pay after everything's budgeted. Choose where it goes.</p>

        <div className="seg" role="group" aria-label="How often" style={{ alignSelf: 'flex-start' }}>
          <button aria-pressed={mode === 'once'} onClick={() => setMode('once')}>This pay only</button>
          <button aria-pressed={mode === 'every'} onClick={() => setMode('every')}>Every pay from now</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {targets.map((t) => {
            const on = ticked.includes(t.id);
            const amt = cents(t.id);
            const weekly = t.kind === 'allowance' && amt > 0 ? allowancePerWeek(budget, period, t, amt, mode) : null;
            return (
              <div key={t.id} style={{ border: `1px solid ${on ? 'var(--brand-2)' : 'var(--line)'}`, borderRadius: 14, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <label className="row" style={{ flex: '1 1 180px', gap: 10, cursor: 'pointer', minHeight: 44 }}>
                  <input type="checkbox" checked={on} onChange={(e) => toggle(t.id, e.target.checked)} style={{ width: 20, height: 20, accentColor: 'var(--brand)' }} />
                  <span className="dot" style={{ background: t.color }} />
                  <span style={{ minWidth: 0 }}>
                    <b>{t.name}</b>
                    <span className="small muted" style={{ display: 'block' }}>
                      {weekly ? (mode === 'once' ? `+${money(weekly.perWeek)} a week this pay (${weekly.weeks} transfers)` : `+${money(weekly.perWeek)} on each weekly transfer from now`) : t.detail}
                    </span>
                  </span>
                </label>
                {on && (
                  <span className="row" style={{ gap: 6 }}>
                    <input aria-label={`Amount for ${t.name}`} inputMode="decimal" value={amounts[t.id] ?? ''} placeholder="0.00"
                      onChange={(e) => setAmounts((a) => ({ ...a, [t.id]: e.target.value }))}
                      style={{ width: 110, minHeight: 40, padding: '0 10px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', fontSize: 16, fontWeight: 600 }} />
                    <button className="btn small ghost" onClick={() => allTo(t.id)}>All</button>
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="between">
          <button className="btn small" onClick={splitEvenly}>Split evenly between ticked</button>
          <span className={left < 0 ? 'neg' : left === 0 ? 'pos' : ''}>
            <b>{left < 0 ? `${money(-left)} too much` : left === 0 ? 'All allocated' : `${money(left)} still left`}</b>
          </span>
        </div>
        {mode === 'every' && <p className="small muted">Every pay raises the normal amounts from now on (allowance: each weekly transfer goes up). Check the next pays still balance on the Planner.</p>}
        {left > 0 && <p className="small muted">Anything not allocated stays as spending money.</p>}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={apply} disabled={left < 0} title={left < 0 ? 'Allocate no more than is left over' : undefined}>Apply</button>
        </div>
      </div>
    </div>
  );
}
