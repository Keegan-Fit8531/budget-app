import { addDays, type ISODate } from '../../../core/dates';
import type { Budget, Cents } from '../../../core/types';
import { ownTransfer } from '../../../engine/transfers';

/**
 * Money out of and into an account in the 30 days to `today`, for a card that isn't planned around (the
 * account pay lands in, a goal's). Spent leaves out money moved to your own accounts: the payday split, or
 * a top-up for a bill, isn't spending. In is everything that came in.
 */
export function lastMonthFlow(b: Budget, accountId: string, today: ISODate): { spent: Cents; in: Cents } {
  const from = addDays(today, -30);
  let spent = 0, inn = 0;
  for (const t of b.accountTransactions?.[accountId] ?? []) {
    if (t.date <= from || t.date > today) continue;
    if (t.amount > 0) inn += t.amount;
    else if (!ownTransfer(b, t)) spent -= t.amount;
  }
  return { spent, in: inn };
}
