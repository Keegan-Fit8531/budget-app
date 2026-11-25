import { addDays, todayISO, type ISODate } from '../../core/dates';
import { hasSetAsides, envelopeOn, setAsideOn } from '../setAside';
import { averageNeed } from '../plan';
import { firstBudgetPay, periodContaining, shiftPeriod, type Period } from '../periods';
import type { Budget, Cents } from '../../core/types';
import { type Outflow, fundedOut } from './outflows';
import { depositSansBalance, depositPending } from './deposits';
import { priorLeftover } from './topUps';
import { balanceOn } from './estimate';
import { envelopeHeld } from '../envelope';

/**
 * A pay sent less than its usual amount (e.g. paused while pay is short): whatever it's short of what the
 * pay puts aside is simply put aside less, not money the account is owed, so later pays don't catch it up.
 */
export const pausedAside = (b: Budget, accountId: string, date: ISODate, usual: Cents, sent: Cents): Cents =>
  sent >= usual ? 0 : Math.min(setAsideOn(b, accountId, date) + envelopeOn(b, accountId, date), usual - sent);

const HORIZON = 24;
const RUN_PAYS = 40;

interface PaySlot { date: ISODate; fixed?: Cents }

/**
 * Paydays from `pay` on (`count` of them, plus one more to close the last), each with any one-pay
 * adjustment, and every payment out of the account over that time. Worked out once per run.
 */
export function window(b: Budget, accountId: string, pay: Period, count: number): { slots: PaySlot[]; out: Outflow[] } {
  const slots: PaySlot[] = [];
  let p = pay;
  for (let i = 0; i <= count; i++) {
    slots.push({ date: p.start, fixed: b.overrides?.[p.start]?.[accountId] });
    p = shiftPeriod(p, 1, b.settings);
  }
  return { slots, out: fundedOut(b, accountId, pay.start, addDays(slots[count].date, -1)) };
}

/** The account's rounding (`Account.round`, e.g. 100 = whole dollars), or 0 for exact cents. */
export const steadyStep = (b: Budget, accountId: string): Cents => b.accounts.find((a) => a.id === accountId)?.round || 0;

/** Rounds a steady amount: up to the account's rounding when it has one (so the buffer never comes up short), else to the cent. */
const roundSteady = (c: Cents, step: Cents): Cents => (step ? Math.ceil(Math.round(c) / step) * step : Math.round(c));

/** The usual steady amount: the long-run average, to the cent, or rounded up to the account's rounding. */
export const usualSteady = (b: Budget, accountId: string) => roundSteady(averageNeed(b, accountId), steadyStep(b, accountId));

/**
 * Core of the steady amount, worked out at one payday (slots[0]) from `balance` the day before:
 *  - normally just enough for this pay's own payments (later pays look after themselves);
 *  - with `level` (Balance this pay): also enough that every later pay can stay at the usual amount;
 *  - otherwise the usual amount, so the buffer for 5-week pays builds up, and less than that only when
 *    there's genuinely extra: anything above the lowest point plus one payment (a cushion) is spread
 *    over the next 24 pays.
 * `slots` are this pay and the next 24 (later one-pay adjustments count for their pay); `out` is
 * every payment from this payday up to the 25th.
 */
function steadyAt(slots: PaySlot[], out: Outflow[], usual: Cents, balance: Cents, step: Cents, level = false): Cents {
  const pays = slots.slice(0, HORIZON).map((x, i) => (i === 0 ? { date: x.date } : x));
  let need = 0, cum = 0, n = 0, fixedSum = 0, free = 0;
  for (const o of out) {
    while (n < pays.length && pays[n].date <= o.date) { if (pays[n].fixed !== undefined) fixedSum += pays[n].fixed!; else free++; n++; }
    if (!level && n > 1) break;
    cum += o.amount;
    if (free > 0) need = Math.max(need, cum - balance - fixedSum - usual * (free - 1));
  }
  let bal = balance, low = Infinity, k = 0, cushion = 0;
  for (const o of out) {
    while (k < pays.length && pays[k].date <= o.date) { bal += pays[k].fixed ?? usual; k++; }
    bal -= o.amount;
    low = Math.min(low, bal);
    cushion = Math.max(cushion, o.amount);
  }
  const extra = low === Infinity ? 0 : Math.max(0, low - cushion);
  const steady = Math.max(need, usual - extra / Math.max(1, pays.filter((x) => x.fixed === undefined).length));
  // Nearest cent unless the account rounds (Rent to whole dollars): then up, and the few cents over
  // each pay build up as extra, which later pays give back.
  return roundSteady(steady, step);
}

/** Payments in `out` from `from` up to (not including) `to`, using a moving index into the sorted list. */
export function between(out: Outflow[], from: ISODate, to: ISODate, idx: { i: number }): Outflow[] {
  while (idx.i < out.length && out[idx.i].date < from) idx.i++;
  let j = idx.i;
  while (j < out.length && out[j].date < to) j++;
  return out.slice(idx.i, j);
}

/**
 * Where an account's pay-by-pay run starts: from the balance you entered (the next payday after it),
 * or with no balance (or `useBalance` false) from the budget's first pay with what the pay before it
 * left. Fixed as days pass, so a pay's amount doesn't change once its payday arrives.
 */
export function runStart(b: Budget, accountId: string, today: ISODate, useBalance: boolean): { pay: Period; bal: Cents; cursor: ISODate } {
  const entry = b.balances?.[accountId];
  // An account that keeps money put aside (a car fund): its balance is mostly that money, which isn't
  // there to pay the bills, so its amounts are worked out from the budget's start instead.
  const known = useBalance && entry && entry.asOf <= today && !hasSetAsides(b, accountId) ? entry : undefined;
  if (known) {
    // Payday morning before the split lands: count the deposit so later pays aren't topped up for a false short.
    const p = periodContaining(known.asOf, b.settings);
    const pending = depositPending(b, accountId, known) ? depositSansBalance(b, accountId, p) : 0;
    // Envelope money still unspent (Food shop's later weeks, this month's gas) will be spent before the
    // next payday: it's spoken for, not a cushion. Counted as spare, Food and gas's next pay sent $100, not $1,100.
    const held = envelopeHeld(b, accountId, known.asOf);
    return { pay: shiftPeriod(p, 1, b.settings), bal: known.amount + pending - held, cursor: known.asOf };
  }
  const pay = firstBudgetPay(b, today);
  return { pay, bal: priorLeftover(b, accountId, today), cursor: addDays(pay.start, -1) };
}

/** How many pays a run covers: 40, and always at least up to the pay after today. */
export function runLength(pay: Period, today: ISODate, s: Budget['settings']): number {
  let n = RUN_PAYS;
  for (let p = shiftPeriod(pay, RUN_PAYS - 1, s); p.start <= today; p = shiftPeriod(p, 1, s)) n++;
  return n;
}

export interface Run { first: string; amounts: Map<string, Cents> }
const runCache = new WeakMap<Budget, Map<string, Run>>();

export function cached(b: Budget, key: string, make: () => Run): Run {
  let byKey = runCache.get(b);
  if (!byKey) { byKey = new Map(); runCache.set(b, byKey); }
  let run = byKey.get(key);
  if (!run) { run = make(); byKey.set(key, run); }
  return run;
}

export const runKey = (b: Budget, kind: string, accountId: string, today: ISODate, useBalance: boolean) => JSON.stringify([
  kind, accountId, today, useBalance ? b.balances?.[accountId] ?? null : null, b.overrides,
  b.split.find((l) => l.accountId === accountId), b.items.filter((i) => i.accountId === accountId), b.settings,
  b.accounts.find((a) => a.id === accountId), b.savings?.filter((g) => g.accountId === accountId), b.debts?.filter((d) => d.accountId === accountId),
]);

/**
 * Rolling steady amounts for an account, pay by pay: each payday works out its amount from what's
 * projected to be left in the account just before it (so money left over, or a pay that sent more or
 * less than usual, carries into the next pay's amount). Cached per budget and the inputs that matter.
 */
function steadyRun(b: Budget, accountId: string, today: ISODate, useBalance = true): Run {
  return cached(b, runKey(b, 'steady', accountId, today, useBalance), () => {
    const s = b.settings;
    const start = runStart(b, accountId, today, useBalance);
    const count = runLength(start.pay, today, s);
    const usual = usualSteady(b, accountId);
    const { slots, out } = window(b, accountId, start.pay, count + HORIZON);
    // Payments between the balance date and the first payday come off first.
    let bal = start.bal - fundedOut(b, accountId, addDays(start.cursor, 1), addDays(start.pay.start, -1)).reduce((t, o) => t + o.amount, 0);
    const amounts = new Map<string, Cents>();
    const idx = { i: 0 };
    for (let i = 0; i < count; i++) {
      const date = slots[i].date;
      const ahead = between(out, date, slots[i + HORIZON].date, idx); // this pay and the next 23
      const amt = steadyAt(slots.slice(i, i + HORIZON + 1), ahead, usual, bal, steadyStep(b, accountId));
      amounts.set(date, amt);
      const sent = slots[i].fixed ?? amt;
      bal += sent + pausedAside(b, accountId, date, amt, sent);
      bal -= between(out, date, slots[i + 1].date, { i: idx.i }).reduce((t, o) => t + o.amount, 0);
    }
    return { first: slots[0].date, amounts };
  });
}

/** How far ahead Balance this pay looks: a year, so every 5-week pay in it is covered. */
const LEVEL_PAYS = 12;

/**
 * For Balance this pay: what a pay would need to send so every pay in the next year can stay at the usual
 * amount (it leaves enough over for the 5-week pays). Compare with what it sends now to get the top-up.
 * Only a year: a dip further out (two years on) is too far to put money aside for now.
 */
export function levelAmount(b: Budget, accountId: string, p: Period, today: ISODate = todayISO()): Cents | undefined {
  const bal = balanceOn(b, accountId, addDays(p.start, -1), today);
  if (bal === undefined) return undefined;
  const { slots, out } = window(b, accountId, p, LEVEL_PAYS);
  return steadyAt(slots, out, usualSteady(b, accountId), bal, steadyStep(b, accountId), true);
}

/** The steady amount a pay sends (before any one-pay adjustment), worked out from what's left by then. */
export function steadyFor(b: Budget, accountId: string, p: Period, today: ISODate = todayISO()): Cents {
  return fromRun(b, accountId, p, today, steadyRun, () => usualSteady(b, accountId));
}

/**
 * A pay's amount from a run: from the balance you entered; for a pay before that balance (e.g. the
 * pay you're in, already split) the amount the budget worked out for it without the balance; before
 * the budget, `before()`. Far beyond the run: its last amount.
 */
export function fromRun(b: Budget, accountId: string, p: Period, today: ISODate,
  run: (b: Budget, id: string, today: ISODate, useBalance?: boolean) => Run, before: () => Cents): Cents {
  const r = run(b, accountId, today);
  const hit = r.amounts.get(p.start);
  if (hit !== undefined) return hit;
  if (p.start < r.first) {
    if (b.balances?.[accountId]) {
      const plain = run(b, accountId, today, false).amounts.get(p.start);
      if (plain !== undefined) return plain;
    }
    return before();
  }
  return [...r.amounts.values()].pop()!;
}

/** The steady amount for the next payday (what Deposits shows as the payday amount). */
export function smoothAmount(b: Budget, accountId: string, today: ISODate = todayISO()): Cents {
  return steadyFor(b, accountId, shiftPeriod(periodContaining(today, b.settings), 1, b.settings), today);
}
