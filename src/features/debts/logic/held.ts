import { todayISO, type ISODate } from '../../../core/dates';
import { billTracker } from '../../../engine/balances/billTracker';
import { checkKey } from '../../../engine/billMatch';
import type { Budget, Cents, Debt } from '../../../core/types';

// A held debt's payment this pay (Gem in Misc bills): what's been paid from the hold account and what's
// still to send, and "No more this month", which makes what's been paid the whole payment.

/** A held debt's amount for one statement (`Debt.heldPay`), set or (amount undefined) taken off. */
export function setHeld(d: Budget, debtId: string, date: ISODate, amount?: Cents): void {
  const x = d.debts?.find((y) => y.id === debtId);
  if (!x) return;
  if (amount !== undefined) { x.heldPay = { ...(x.heldPay ?? {}), [date]: amount }; return; }
  if (x.heldPay) { delete x.heldPay[date]; if (!Object.keys(x.heldPay).length) delete x.heldPay; }
}

export interface HeldNow {
  /** The statement-day payment's date. */
  date: ISODate;
  accountId: string;
  paid: Cents;
  toCome: Cents;
  /** You said no more this month: `heldPay` is what was paid (undone with `resumeHeld`). */
  ended: boolean;
}

/** This pay's held payment for a debt, from the hold account's bill tracker (undefined: none this pay). */
export function heldNow(b: Budget, debt: Debt, today: ISODate = todayISO()): HeldNow | undefined {
  if (!debt.holdAccountId) return undefined;
  const rows = billTracker(b, debt.holdAccountId, today).rows.filter((r) => r.debtId === debt.id);
  if (!rows.length && !Object.keys(debt.heldPay ?? {}).length) return undefined;
  const date = rows[0]?.date ?? Object.keys(debt.heldPay!).sort().pop()!;
  const ended = !!b.billChecks?.[checkKey('rest', debt.id, date)] && debt.heldPay?.[date] !== undefined;
  if (!rows.length && !ended) return undefined;
  const sum = (paid: boolean) => rows.filter((r) => (r.status === 'paid') === paid).reduce((t, r) => t + r.amount, 0);
  return { date, accountId: debt.holdAccountId, paid: sum(true), toCome: sum(false), ended };
}

/** "No more this month": what's been paid from the hold account is this statement's whole payment. */
export function endHeld(b: Budget, debtId: string, h: HeldNow, today: ISODate = todayISO()): void {
  setHeld(b, debtId, h.date, h.paid);
  b.billChecks = { ...(b.billChecks ?? {}), [checkKey('rest', debtId, h.date)]: today };
}

/** Undo "No more this month". */
export function resumeHeld(b: Budget, debtId: string, date: ISODate): void {
  setHeld(b, debtId, date);
  const key = checkKey('rest', debtId, date);
  b.billChecks = Object.fromEntries(Object.entries(b.billChecks ?? {}).filter(([k]) => k !== key));
}
