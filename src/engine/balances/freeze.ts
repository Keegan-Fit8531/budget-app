import { todayISO, type ISODate } from '../../core/dates';
import { periodContaining, type Period } from '../periods';
import type { Budget, Cents } from '../../core/types';
import { liveDepositFor } from './deposits';

/**
 * True once this pay’s split should stop moving: payday has passed, or the payslip / pay amount is in.
 * Future pays still recalculate; this cycle’s deposits stay put unless you change them by hand.
 */
export function paySplitLocked(b: Budget, p: Period, today: ISODate = todayISO()): boolean {
  return p.start < today || b.payActuals[p.start] !== undefined;
}

/**
 * What to lock in for one account when freezing a pay. Prefers what actually landed in the bank,
 * then an earlier auto-balance amount before the live figure collapsed (e.g. Gem/Afterpay → $0),
 * then a one-pay override, then the live calculation.
 */
function snapshotDeposit(b: Budget, accountId: string, p: Period, today: ISODate): Cents {
  const live = liveDepositFor(b, accountId, p, today);
  // Bank credits on payday = what you already deposited for this cycle.
  const credited = (b.accountTransactions?.[accountId] ?? [])
    .filter((t) => t.date === p.start && t.amount > 0)
    .reduce((s, t) => s + t.amount, 0);
  if (credited > 0) return credited;

  const auto = b.autoBalanced?.[p.start]?.[accountId];
  // Balancing later zeroed a deposit: keep what it was before (often this morning’s figure).
  if (auto && auto.prev !== null && auto.prev > live) return auto.prev;
  if (auto && auto.to > live) return auto.to;

  const override = b.overrides?.[p.start]?.[accountId];
  if (override !== undefined && override > live) return override;
  if (override !== undefined) return override;
  return live;
}

/** Drop auto-balance overrides for a pay so they don’t fight the frozen split. Manual edits stay. */
function clearAutoOverridesForPay(b: Budget, start: ISODate): void {
  const mine = b.autoBalanced?.[start];
  if (!mine) return;
  const o = { ...(b.overrides?.[start] ?? {}) };
  for (const [id, x] of Object.entries(mine)) {
    // Remove the auto-set figure only (leave a hand edit). Don’t put `prev` back — the freeze holds it.
    if (o[id] === x.to) delete o[id];
  }
  b.overrides = b.overrides ?? {};
  if (Object.keys(o).length) b.overrides[start] = o; else delete b.overrides[start];
  delete b.autoBalanced![start];
  if (b.autoBalanced && !Object.keys(b.autoBalanced).length) delete b.autoBalanced;
}

/**
 * Snapshot what payday sends to each account for a locked pay. First lock wins unless `replace`.
 * Call when a payslip is saved, when viewing a locked pay, or when restoring from a morning copy.
 */
export function freezePaySplit(b: Budget, p: Period, today: ISODate = todayISO(), opts: { replace?: boolean } = {}): void {
  if (!paySplitLocked(b, p, today)) return;
  if (b.splitSent?.[p.start] && !opts.replace) return;
  const sent: Record<string, Cents> = {};
  for (const a of b.accounts) {
    if (a.archived || a.id === b.settings.payAccountId) continue;
    sent[a.id] = snapshotDeposit(b, a.id, p, today);
  }
  b.splitSent = { ...(b.splitSent ?? {}), [p.start]: sent };
  // Auto one-pay amounts for this cycle are replaced by the freeze (manual overrides kept above).
  clearAutoOverridesForPay(b, p.start);
}

/**
 * Copy another budget’s deposit figures into this one’s frozen split for a locked pay (e.g. today’s
 * morning copy, before the Planner drifted). Replaces any freeze already on that pay.
 */
export function freezePaySplitFrom(b: Budget, p: Period, source: Budget, today: ISODate = todayISO()): void {
  if (!paySplitLocked(b, p, today)) return;
  const src = structuredClone(source);
  if (src.splitSent?.[p.start]) delete src.splitSent[p.start];
  const sent: Record<string, Cents> = {};
  for (const a of b.accounts) {
    if (a.archived || a.id === b.settings.payAccountId) continue;
    // Read the source as it planned that pay (overrides + live), not this budget’s drifted figures.
    sent[a.id] = snapshotDeposit(src, a.id, p, today);
  }
  b.splitSent = { ...(b.splitSent ?? {}), [p.start]: sent };
  clearAutoOverridesForPay(b, p.start);
}

/** Freeze every pay that is already locked and missing a snapshot (past payslips / payday passed). */
export function freezeLockedPays(b: Budget, today: ISODate = todayISO()): void {
  const starts = new Set<ISODate>([
    ...Object.keys(b.payActuals ?? {}),
    ...Object.keys(b.splitSent ?? {}),
  ]);
  // The pay that contains today, when payday has passed or the payslip is in.
  starts.add(periodContaining(today, b.settings).start);
  for (const start of starts) {
    const p = periodContaining(start, b.settings);
    if (p.start !== start) continue;
    freezePaySplit(b, p, today);
  }
}

/** Drop a frozen split (e.g. you cleared the payslip on payday so the pay can be planned again). */
export function unfreezePaySplit(b: Budget, start: ISODate): void {
  if (!b.splitSent?.[start]) return;
  delete b.splitSent[start];
  if (!Object.keys(b.splitSent).length) delete b.splitSent;
}
