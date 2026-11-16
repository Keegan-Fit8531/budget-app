import { monthName, type ISODate } from '../dates';
import { debtPerPay, settleDue } from '../debts';
import { clearPaydayMove, paydayFor, recordPayday } from '../engine';
import type { Payslip } from '../payslip';
import type { Account, Budget, Cents, Debt, SplitLine } from '../types';
import type { Proposal } from './check';

// ---------------------------------------------------------------------------------------------
// Undo for the last upload. Before it's applied, a copy of exactly what it touches is kept (in this
// browser only, never in the synced budget). Undo puts each thing back only if it's still as the
// upload left it: anything you've changed since is kept, and named. Payments counted automatically
// since (overnight, or after a sync) don't count as your changes.
// ---------------------------------------------------------------------------------------------

type Part =
  | {
    type: 'pay';
    start: ISODate;
    /** The payday-move entry the upload added or changed, and what it was before (null = none). */
    move?: { key: string; before: ISODate | null; after: ISODate };
    payBefore: Cents | null;
    payAfter: Cents;
    slipBefore: Payslip | null;
    slipAfter: Payslip;
  }
  | { type: 'debt'; id: string; before: Debt | null; after: Debt }
  | { type: 'line'; accountId: string; before: Pick<SplitLine, 'mode' | 'auto'> | null; after: Pick<SplitLine, 'mode' | 'auto'> }
  | { type: 'account'; id: string; after: Account };

export interface UndoRecord { at: string; fileName: string; title: string; parts: Part[] }

const KEY = 'paydays.lastUpload';

export function readUndo(): UndoRecord | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? 'null') as UndoRecord | null; } catch { return null; }
}

export function writeUndo(r: UndoRecord | null): void {
  try { if (r) localStorage.setItem(KEY, JSON.stringify(r)); else localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

const findDebt = (b: Budget, id: string) => (b.debts ?? []).find((d) => d.id === id);
const lineOf = (b: Budget, accountId: string) => b.split.find((l) => l.accountId === accountId);
const modeOf = (l: SplitLine | undefined) => (l ? { mode: l.mode, ...(l.auto !== undefined ? { auto: l.auto } : {}) } : null);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Keep what Undo needs: `before` is the budget before the upload, `after` the same budget once it's applied. */
export function buildUndo(before: Budget, after: Budget, p: Proposal, fileName: string, title: string): UndoRecord {
  const parts: Part[] = [];
  const debtPart = (id: string) => {
    const a = findDebt(after, id);
    if (a) parts.push({ type: 'debt', id, before: structuredClone(findDebt(before, id) ?? null), after: structuredClone(a) });
  };
  const linePart = (accountId: string) => {
    const a = lineOf(after, accountId);
    const was = modeOf(lineOf(before, accountId));
    if (a && !same(was, modeOf(a))) parts.push({ type: 'line', accountId, before: was, after: modeOf(a)! });
  };
  if (p.kind === 'payslip') {
    const mb = before.settings.paydayMoves ?? {};
    const ma = after.settings.paydayMoves ?? {};
    const key = Object.keys(ma).find((k) => ma[k] !== mb[k]);
    const probe = { ...before, settings: structuredClone(before.settings), payActuals: { ...before.payActuals }, payslips: { ...(before.payslips ?? {}) }, overrides: {}, autoBalanced: {} } as Budget;
    const start = recordPayday(probe, p.slip.payDay);
    parts.push({
      type: 'pay', start,
      ...(key ? { move: { key, before: mb[key] ?? null, after: ma[key] } } : {}),
      payBefore: probe.payActuals[start] ?? null, payAfter: after.payActuals[start],
      slipBefore: structuredClone(probe.payslips?.[start] ?? null), slipAfter: structuredClone(after.payslips![start]),
    });
    const loan = (before.debts ?? []).find((d) => d.payroll && d.kind === 'loan');
    if (loan && !same(loan, findDebt(after, loan.id))) debtPart(loan.id);
  } else {
    const debt = findDebt(after, p.debtId);
    if (p.kind === 'statement' && p.newDebt) {
      const acc = after.accounts.find((a) => a.id === p.debtId);
      if (acc) parts.push({ type: 'account', id: acc.id, after: structuredClone(acc) });
    }
    debtPart(p.debtId);
    if (debt) linePart(debt.accountId);
  }
  return { at: new Date().toISOString(), fileName, title, parts };
}

/** A debt with its history left out (that's added to whenever anything changes, by you or automatically). */
const core = (d: Debt) => { const x = structuredClone(d); delete x.history; return x; };

/** Still as the upload left it, allowing for payments that have been counted automatically since. */
function untouched(cur: Debt, after: Debt, b: Budget, today: ISODate): boolean {
  if (same(core(cur), core(after))) return true;
  const settled = structuredClone(after);
  settleDue(settled, b.settings, today, debtPerPay(b, settled));
  return same(core(cur), core(settled));
}

/** What Undo would do, without doing it: the things that would be kept because you've changed them since. */
export function undoKeeps(b: Budget, r: UndoRecord, today: ISODate): string[] {
  return undoUpload(structuredClone(b), r, today);
}

/** Undo the upload in `b` (in place). Returns what was kept because you changed it since. */
export function undoUpload(b: Budget, r: UndoRecord, today: ISODate): string[] {
  const kept: string[] = [];
  const removedDebts = new Set<string>();
  for (const part of r.parts) {
    if (part.type === 'pay') {
      if (b.payActuals[part.start] !== part.payAfter || !same(b.payslips?.[part.start], part.slipAfter)) {
        kept.push(`Kept your later change to the ${monthName(part.start)} pay.`);
        continue;
      }
      let key = part.start;
      if (part.move && b.settings.paydayMoves?.[part.move.key] === part.move.after) {
        // Put that payday back on its usual day (or where it was before): its pay moves back with it.
        clearPaydayMove(b, part.start);
        const [y, m] = part.move.key.split('-').map(Number);
        key = part.move.before ? recordPayday(b, part.move.before) : paydayFor(y, m - 1, b.settings);
      }
      if (part.payBefore === null) delete b.payActuals[key]; else b.payActuals[key] = part.payBefore;
      b.payslips = b.payslips ?? {};
      if (part.slipBefore === null) delete b.payslips[key]; else b.payslips[key] = part.slipBefore;
    } else if (part.type === 'debt') {
      const list = b.debts ?? [];
      const i = list.findIndex((d) => d.id === part.id);
      if (i < 0) continue; // deleted since: nothing to put back
      if (!untouched(list[i], part.after, b, today)) { kept.push(`Kept your later change to ${list[i].name}.`); continue; }
      if (part.before === null) { list.splice(i, 1); removedDebts.add(part.id); continue; }
      const restored = structuredClone(part.before);
      // Payments that have fallen due since it was saved count as paid, as they would have anyway.
      settleDue(restored, b.settings, today, debtPerPay(b, restored));
      list[i] = restored;
    } else if (part.type === 'line') {
      const l = lineOf(b, part.accountId);
      if (!l || !same(modeOf(l), part.after) || !part.before) continue;
      l.mode = part.before.mode;
      if (part.before.auto !== undefined) l.auto = part.before.auto; else delete l.auto;
    }
  }
  // A debt the upload added: its payday account goes too, unless you've since put costs on it.
  for (const part of r.parts) {
    if (part.type !== 'account' || !removedDebts.has(part.id)) continue;
    if (b.items.some((i) => i.accountId === part.id)) { kept.push(`Kept the ${part.after.name} account: it has costs on it now.`); continue; }
    b.accounts = b.accounts.filter((a) => a.id !== part.id);
    b.split = b.split.filter((l) => l.accountId !== part.id);
  }
  return kept;
}
