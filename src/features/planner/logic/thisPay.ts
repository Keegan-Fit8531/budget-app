import type { ISODate } from '../../../core/dates';
import type { Budget, Cents, PaydayMode } from '../../../core/types';
import { keepSplitChange } from '../../../engine/balances/freeze';

// ---------------------------------------------------------------------------------------------
// Amounts set for one pay only, from the Planner: "What's different this pay" (Change / Reset) and
// "Reset to defaults".
// ---------------------------------------------------------------------------------------------

/**
 * Set an account's amount for one pay only, or with null put it back to its usual amount. A pay that's
 * already been split froze what it sent (`splitSent`, one-pay amounts there at the time included), so the
 * frozen figure is kept in step, or it would go on sending the old amount (and the morning's copy of the
 * split isn't put back over it: `keepSplitChange`).
 */
export function setThisPay(b: Budget, start: ISODate, accountId: string, amount: Cents | null): void {
  const o = { ...(b.overrides?.[start] ?? {}) };
  if (amount === null) delete o[accountId]; else o[accountId] = amount;
  b.overrides = b.overrides ?? {};
  if (Object.keys(o).length) b.overrides[start] = o; else delete b.overrides[start];
  const sent = b.splitSent?.[start];
  if (sent) {
    if (amount === null) delete sent[accountId];
    else sent[accountId] = amount;
    keepSplitChange(b, start);
  }
}

/**
 * Reset a pay to defaults: every account's amount for that pay only goes (as `setThisPay(…, null)` does
 * for one, frozen split included), and the payday amounts balancing changed go back (`modes`, from
 * `modeMemory.ts` → `takeModes`).
 */
export function resetPay(b: Budget, start: ISODate, modes: Record<string, string>): void {
  for (const id of Object.keys(b.overrides?.[start] ?? {})) setThisPay(b, start, id, null);
  for (const [id, m] of Object.entries(modes)) {
    const l = b.split.find((x) => x.accountId === id);
    if (l) l.mode = m as PaydayMode;
  }
}
