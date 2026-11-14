import { useMemo, useState } from 'react';
import { Dot } from './ui';
import { allocationTargets, allowancePerWeek, applyAllocation, existingExtras, undoAllocation, type AllocationUndo, type AllocMode } from '../lib/allocate';
import { fmtShort, monthName, todayISO } from '../lib/dates';
import { planFor, type Period } from '../lib/engine';
import { cash, centsToInput, parseMoney } from '../lib/money';
import { useBudget } from '../lib/store';
import { Icon } from './Icon';

const UNDO_KEY = 'paydays.optimise.undo';

export interface OptimiseUndo extends AllocationUndo {
  at: string; label: string;
  /** What you chose, so Edit can open with it (saves from before Edit existed don't have it). */
  mode?: AllocMode; allocs?: { targetId: string; amount: number }[];
}

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

/**
 * Put the money left over this pay where you choose: goals, weekly allowance, debts, or keep it to spend.
 * With `previous` (Edit), it opens with what you chose last time and the leftover from before it, and
 * saving swaps that allocation for the new one.
 */
export function OptimiseModal({ period, leftover: leftNow, previous: record, onClose, onApplied }: {
  period: Period; leftover: number; previous?: OptimiseUndo | null; onClose: () => void; onApplied: (u: OptimiseUndo | null) => void;
}) {
  const { budget, update } = useBudget();
  // What's already been added for this pay: the last Optimise here (if this device has it), plus any other
  // extra for this pay only (e.g. $300 to Misc savings set on another device), worked out once on opening.
  const [previous] = useState<OptimiseUndo | null>(() => {
    const b = structuredClone(budget);
    if (record) undoAllocation(b, record);
    const extra = existingExtras(b, period);
    if (!extra) return record ?? null;
    if (!record) return { ...extra, at: todayISO(), label: `${monthName(period.start)} pay`, mode: 'once' };
    const allocs = record.allocs ? [...record.allocs] : undefined;
    for (const a of extra.allocs) {
      const same = allocs?.find((x) => x.targetId === a.targetId);
      if (same) same.amount += a.amount; else allocs?.push(a);
    }
    return { ...record, overrides: { ...record.overrides, ...extra.overrides }, allocs };
  });
  // Editing: the budget as it was before the last Optimise, so the whole leftover is there to hand out again.
  const before = useMemo(() => {
    if (!previous) return null;
    const b = structuredClone(budget);
    undoAllocation(b, previous);
    return b;
  }, [budget, previous]);
  const leftover = before ? planFor(before, period).leftover : leftNow;
  const targets = useMemo(() => allocationTargets(before ?? budget), [before, budget]);
  // What you chose last time: as saved, or (older saves) worked out from what each account gained.
  const chosen = useMemo(() => {
    if (!previous || !before) return null;
    if (previous.allocs) return previous.allocs;
    const now = planFor(budget, period), was = planFor(before, period);
    const funded = (p: typeof now, id?: string) => p.accounts.find((a) => a.account.id === id)?.funded ?? 0;
    return targets.filter((t) => t.kind !== 'spend').map((t) => ({ targetId: t.id, amount: funded(now, t.accountId) - funded(was, t.accountId) })).filter((a) => a.amount > 0);
  }, [previous, before, budget, period, targets]);
  const [mode, setMode] = useState<AllocMode>(() => previous?.mode ?? (previous?.label === 'every pay' ? 'every' : 'once'));
  const [ticked, setTicked] = useState<string[]>(() => chosen ? chosen.map((a) => a.targetId) : targets.filter((t) => t.kind === 'goal').slice(0, 1).map((t) => t.id));
  const [amounts, setAmounts] = useState<Record<string, string>>(() => {
    if (chosen) return Object.fromEntries(chosen.map((a) => [a.targetId, centsToInput(a.amount)]));
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
    if (!allocs.length && !previous) return onClose();
    let undo: OptimiseUndo | null = null;
    update((b) => {
      // Editing: put back what last time changed first, then hand out the leftover again.
      if (previous) undoAllocation(b, previous);
      if (allocs.length) {
        const u = applyAllocation(b, period, allocs, mode);
        undo = { at: todayISO(), label: mode === 'once' ? `${monthName(period.start)} pay` : 'every pay', mode, allocs, ...u };
      }
      return b;
    });
    try {
      if (undo) localStorage.setItem(UNDO_KEY, JSON.stringify(undo)); else clearOptimiseUndo();
    } catch { /* ignore */ }
    onApplied(undo);
    onClose();
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="opt-title" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2 id="opt-title" className="h2">{previous ? `Change where ${cash(leftover)} goes` : `Put ${cash(leftover)} to work`}</h2>
          <button className="icon-btn plain" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <p className="small muted">Left over from the {fmtShort(period.start)} pay after everything's budgeted. Choose where it goes.</p>

        <div className="seg" role="group" aria-label="How often" style={{ alignSelf: 'flex-start' }}>
          <button aria-pressed={mode === 'once'} onClick={() => setMode('once')}>This pay only</button>
          <button aria-pressed={mode === 'every'} onClick={() => setMode('every')}>Every pay from now</button>
        </div>

        <div className="stack gap-8">
          {targets.map((t) => {
            const on = ticked.includes(t.id);
            const amt = cents(t.id);
            const weekly = t.kind === 'allowance' && amt > 0 ? allowancePerWeek(budget, period, t, amt, mode) : null;
            return (
              <div key={t.id} className={`pick${on ? ' on' : ''}`}>
                <label className="check-row" style={{ flex: '1 1 180px' }}>
                  <input type="checkbox" checked={on} onChange={(e) => toggle(t.id, e.target.checked)} style={{ width: 20, height: 20, accentColor: 'var(--brand)' }} />
                  <Dot color={t.color} />
                  <span className="min0">
                    <b>{t.name}</b>
                    <span className="small muted block">
                      {weekly ? (mode === 'once' ? `+${cash(weekly.perWeek)} a week this pay (${weekly.weeks} transfers)` : `+${cash(weekly.perWeek)} on each weekly transfer from now`) : t.detail}
                    </span>
                  </span>
                </label>
                {on && (
                  <span className="row gap-6">
                    <input aria-label={`Amount for ${t.name}`} inputMode="decimal" value={amounts[t.id] ?? ''} placeholder="0.00"
                      onChange={(e) => setAmounts((a) => ({ ...a, [t.id]: e.target.value }))}
                      className="input" style={{ width: 110, fontWeight: 600 }} />
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
            <b>{left < 0 ? `${cash(-left)} too much` : left === 0 ? 'All allocated' : `${cash(left)} still left`}</b>
          </span>
        </div>
        {mode === 'every' && <p className="small muted">Every pay raises the normal amounts from now on (allowance: each weekly transfer goes up). Check the next pays still balance on the Planner.</p>}
        {left > 0 && <p className="small muted">Anything not allocated stays as spending money.</p>}

        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={apply} disabled={left < 0} title={left < 0 ? 'Allocate no more than is left over' : undefined}>{previous ? 'Save changes' : 'Apply'}</button>
        </div>
      </div>
    </div>
  );
}
