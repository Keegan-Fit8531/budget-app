import type { ISODate } from './dates';
import type { AccountEvent, Budget, Cents } from './types';

/**
 * An account's history: the balances you've entered and one-off costs paid from it (a tyre puncture).
 * A one-off cost is taken off the balance you entered when it's recorded, so what's in the account
 * drops by that much straight away, and every projection carries on from there.
 */

function events(b: Budget, accountId: string): AccountEvent[] {
  b.accountHistory = b.accountHistory ?? {};
  return (b.accountHistory[accountId] = b.accountHistory[accountId] ?? []);
}

/** Set an account's balance from your banking app, and note it in the history (checking it again straight after replaces the note). */
export function setBalance(b: Budget, accountId: string, amount: Cents, today: ISODate, id: string): void {
  b.balances = { ...(b.balances ?? {}), [accountId]: { amount, asOf: today } };
  const list = events(b, accountId);
  const last = list[list.length - 1];
  if (last?.kind === 'balance' && last.date === today) last.amount = amount;
  else list.push({ id, date: today, kind: 'balance', amount });
}

/**
 * Money spent from an account outside its plan: taken off the balance you entered, and noted in the
 * history. Needs an entered balance to take it from; returns false (and changes nothing) without one.
 */
export function recordCost(b: Budget, accountId: string, cost: { amount: Cents; date: ISODate; note: string }, id: string): boolean {
  const entry = b.balances?.[accountId];
  if (!entry) return false;
  b.balances = { ...b.balances, [accountId]: { ...entry, amount: entry.amount - cost.amount } };
  events(b, accountId).push({ id, kind: 'cost', date: cost.date, amount: cost.amount, note: cost.note });
  return true;
}

/** Take a one-off cost out of the history. `putBack` adds its money back to the balance. */
export function removeCost(b: Budget, accountId: string, id: string, putBack: boolean): void {
  const list = b.accountHistory?.[accountId];
  const cost = list?.find((e) => e.id === id && e.kind === 'cost');
  if (!list || !cost) return;
  b.accountHistory![accountId] = list.filter((e) => e !== cost);
  const entry = b.balances?.[accountId];
  if (putBack && entry) b.balances = { ...b.balances, [accountId]: { ...entry, amount: entry.amount + cost.amount } };
}

/** An account's history, latest first (by date, then the order recorded). */
export function accountHistory(b: Budget, accountId: string): AccountEvent[] {
  return (b.accountHistory?.[accountId] ?? [])
    .map((e, i) => ({ e, i }))
    .sort((x, y) => y.e.date.localeCompare(x.e.date) || y.i - x.i)
    .map((x) => x.e);
}
