import { addDays, addMonths, diffDays, type ISODate } from '../../../core/dates';
import { nameMatch } from '../../../engine/billMatch';
import { txnsIn } from '../../../engine/envelopeMatch';
import { ownTransfer } from '../../../engine/transfers';
import type { Budget, Item, Txn } from '../../../core/types';

// A monthly bill you've just added, set to start after today, that the bank already shows coming out on
// another day of the month (Canva set for the 10th, charged on the 20th). Until it's moved, this pay counts
// a payment that's already gone. Bills with a history are checked by `usualShift` in `billCheck.ts`.

/** How far back to look for the bill's earlier payments. */
const LOOK_BACK = 130;

/** When the bill's next payment really comes (the day of the month the bank showed it), and those payments. */
export function realStart(b: Budget, item: Item, today: ISODate): { start: ISODate; seen: { txn: Txn; accountId: string }[] } | undefined {
  if (item.frequency !== 'monthly' || item.start <= today) return undefined;
  const hits: { txn: Txn; accountId: string }[] = [];
  const dup = new Set<string>();
  for (const a of b.accounts) {
    if (a.kind !== 'bank') continue;
    for (const txn of txnsIn(b, a.id, addDays(today, -LOOK_BACK), today)) {
      if (txn.amount >= 0 || ownTransfer(b, txn) || nameMatch(item.name, txn) !== 2) continue;
      if (Math.min(-txn.amount, item.amount) / Math.max(-txn.amount, item.amount) < 0.75) continue;
      if (dup.has(`${txn.date}|${txn.amount}`)) continue;
      dup.add(`${txn.date}|${txn.amount}`);
      hits.push({ txn, accountId: a.id });
    }
  }
  hits.sort((x, y) => x.txn.date.localeCompare(y.txn.date));
  const last = hits[hits.length - 1]?.txn.date;
  // The last payment must be about a month before the first planned one, on a day well away from it.
  if (!last || diffDays(last, item.start) > 45) return undefined;
  let start = addMonths(last, 1);
  while (start <= today) start = addMonths(start, 1);
  if (Math.abs(diffDays(start, item.start)) <= 3) return undefined;
  return { start, seen: hits.slice(-4) };
}
