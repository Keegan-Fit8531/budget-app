import { addDays, todayISO, type ISODate } from '../../core/dates';
import { firstBudgetPay, periodContaining, shiftPeriod, type Period } from '../periods';
import type { Budget, Cents } from '../../core/types';
import { depositFor, depositPending } from './deposits';
import { outflows, type Outflow } from './outflows';
import { txnsIn } from '../envelopeMatch';
import { bankFed, checkKey, matchBills, outflowId } from '../billMatch';
import { leftoverBeforeBudget } from './topUps';
import { envelopeHeld } from '../envelope';
import { envelopeOn, isEnvelope } from '../setAside';

/** Estimated balance at the end of `date`, from the last balance you entered. Undefined if unknown. */
export function estimateBalance(b: Budget, accountId: string, date: ISODate, today: ISODate = todayISO()): Cents | undefined {
  const entry = b.balances?.[accountId];
  if (!entry || date < entry.asOf) return undefined;
  let bal = entry.amount;
  let p = periodContaining(entry.asOf, b.settings);
  // Balance as-of payday: count this payday's deposit when the bank still shows the pre-deposit amount.
  if (entry.asOf === p.start && p.start <= date && depositPending(b, accountId, entry)) {
    bal += depositFor(b, accountId, p, today);
  }
  // Paydays after the balance date, up to and including `date`.
  while (p.nextPayday <= date) {
    p = shiftPeriod(p, 1, b.settings);
    bal += depositFor(b, accountId, p, today);
  }
  // Bills up to the balance's day the bank hasn't shown yet are still to come in that pay (the tracker
  // lists them): by the end of that pay they're out too.
  const late = date >= periodContaining(entry.asOf, b.settings).end ? unpaidByBalanceDay(b, accountId, entry.asOf, today) : 0;
  return bal - late - outflows(b, accountId, addDays(entry.asOf, 1), date).reduce((t, o) => t + o.amount, 0);
}

/**
 * Bills dated up to the balance's day that the bank hasn't shown leaving yet (bank-connected accounts):
 * their money is still in the balance, as the bill tracker says, so they still come off it. A bill due on
 * the day of a synced balance (a subscription not taken yet) was counted as already out, and the next pay
 * sent that much too little.
 */
export function unpaidByBalanceDay(b: Budget, accountId: string, asOf: ISODate, today: ISODate): Cents {
  if (!bankFed(b, accountId)) return 0;
  const start = periodContaining(asOf, b.settings).start;
  const matches = matchBills(b, accountId, start, asOf, today);
  const out = outByBalance(b, accountId, today);
  return outflows(b, accountId, start, asOf)
    .filter((o, i) => !matches[i]?.how && !b.billChecks?.[checkKey('paid', outflowId(o), o.date)] && !out.has(billKey(o)))
    .reduce((t, o) => t + o.amount, 0);
}

export const billKey = (o: Outflow): string => `${outflowId(o)}|${o.date}`;

/**
 * Bills (bank-connected accounts) the synced balance already has out though no transaction shows them yet:
 * the bank's balance arrives before its lines (rent out on the 27th, balance $415 lower, newest line the 20th).
 * Since the last balance before this one, the balance fell by more than the lines seen since explain; unseen
 * bills dated in between count as out, oldest first, while that drop covers them (within $1). Keys: `billKey`.
 * Without it the bill is still "to come", the card says short by it, and the next pay sends it again.
 */
export function outByBalance(b: Budget, accountId: string, today: ISODate): Set<string> {
  const out = new Set<string>();
  const entry = b.balances?.[accountId];
  if (!entry || !bankFed(b, accountId)) return out;
  const prev = (b.accountHistory?.[accountId] ?? []).filter((e) => e.kind === 'balance' && e.date < entry.asOf).pop();
  if (!prev || entry.asOf > addDays(prev.date, 14)) return out;
  const from = addDays(prev.date, 1);
  let drop = prev.amount + txnsIn(b, accountId, from, entry.asOf).reduce((t, x) => t + x.amount, 0) - entry.amount;
  const matches = matchBills(b, accountId, from, entry.asOf, today);
  outflows(b, accountId, from, entry.asOf).forEach((o, i) => {
    if (matches[i]?.how || b.billChecks?.[checkKey('paid', outflowId(o), o.date)] || drop + 100 < o.amount) return;
    out.add(billKey(o));
    drop -= o.amount;
  });
  return out;
}

/**
 * What's in an account today, before today's payments come out (a bill dated today may not have left
 * the bank yet, so it counts as still to come). A balance entered today is used as-is; an older one is
 * rolled forward to yesterday, plus today's deposit when today is payday (it lands before the bills).
 * Undefined without an entered balance. The Accounts card's headline and the tracker's "In the account"
 * both show this, so they always agree; `estimateBalance` (end of day) is for projections.
 */
export function balanceToday(b: Budget, accountId: string, today: ISODate = todayISO()): Cents | undefined {
  const entry = b.balances?.[accountId];
  if (!entry || entry.asOf > today) return undefined;
  if (entry.asOf === today) return entry.amount;
  const rolled = estimateBalance(b, accountId, addDays(today, -1), today);
  if (rolled === undefined) return undefined;
  const period = periodContaining(today, b.settings);
  return rolled + (today === period.start ? depositFor(b, accountId, period, today) : 0);
}

export interface PeriodForecast { period: Period; deposit: Cents; out: Cents; end: Cents | undefined }

/** Balance forecast for `count` pay periods starting with the one containing `today`. */
const sub = (a: Cents | undefined, c: Cents) => (a === undefined ? undefined : a - c);

export function forecastBalances(b: Budget, accountId: string, count: number, today: ISODate = todayISO()): PeriodForecast[] {
  const entry = b.balances?.[accountId];
  const pending = !!entry && depositPending(b, accountId, entry);
  const rows: PeriodForecast[] = [];
  let p = periodContaining(today, b.settings);
  for (let i = 0; i < count; i++) {
    // Deposit still counts when the balance is as-of this payday but the money hasn't landed yet.
    const received = !entry || p.start > entry.asOf || (p.start === entry.asOf && pending);
    // Envelope money counts as spent: what's unspent now in this pay, then what each later payday funds.
    const spent = envelopeSpentBy(b, accountId, p.end, today);
    const spentBefore = i === 0 ? 0 : envelopeSpentBy(b, accountId, addDays(p.start, -1), today);
    rows.push({
      period: p,
      deposit: received ? depositFor(b, accountId, p, today) : 0,
      out: outflows(b, accountId, entry && entry.asOf > p.start ? addDays(entry.asOf, 1) : p.start, p.end).reduce((t, o) => t + o.amount, 0) + spent - spentBefore,
      end: sub(estimateBalance(b, accountId, p.end, today), spent),
    });
    p = shiftPeriod(p, 1, b.settings);
  }
  return rows;
}

/**
 * Projected balance at the end of `date`. From your entered balance when there is one; otherwise from
 * the budget's first pay, starting with what the pay before it left, adding each payday
 * and taking each payment. Undefined when it can't be told (before the budget, or before your balance).
 */
export function balanceOn(b: Budget, accountId: string, date: ISODate, today: ISODate = todayISO()): Cents | undefined {
  const entry = b.balances?.[accountId];
  if (entry) return entry.asOf <= date ? estimateBalance(b, accountId, date, today) : undefined;
  const s = b.settings;
  const first = firstBudgetPay(b, today);
  if (date < addDays(first.start, -1)) return undefined;
  let bal = leftoverBeforeBudget(b, accountId, today);
  if (date < first.start) return bal;
  for (let q = first; q.start <= date; q = shiftPeriod(q, 1, s)) bal += depositFor(b, accountId, q, today);
  return bal - outflows(b, accountId, first.start, date).reduce((t, o) => t + o.amount, 0);
}

/**
 * Envelope money spent by `date` (Food shop, Car gas): what's unspent today, and what every payday after
 * today up to `date` puts in its envelopes. Envelope spending leaves by transfers the projection can't
 * see, so without this a future pay's balance grows by each payday's envelope money (a food and gas
 * account shows thousands at its end a few pays out when it really ends about $0). 0 for an account with no envelopes.
 */
export function envelopeSpentBy(b: Budget, accountId: string, date: ISODate, today: ISODate = todayISO()): Cents {
  if (!b.items.some((i) => i.accountId === accountId && isEnvelope(i))) return 0;
  let spent = envelopeHeld(b, accountId, today);
  for (let p = shiftPeriod(periodContaining(today, b.settings), 1, b.settings); p.start <= date; p = shiftPeriod(p, 1, b.settings)) {
    spent += envelopeOn(b, accountId, p.start);
  }
  return spent;
}
