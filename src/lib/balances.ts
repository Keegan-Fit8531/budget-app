import { addDays, todayISO, type ISODate } from './dates';
import { accountHasPlans, debtPaymentsIn, debtPerPay, projectedOwed } from './debts';
import {
  averageNeed, firstBudgetPay, hasSetAsides, isSetAside, itemDates, periodContaining, setAsideOn, setAsidesOn, shiftPeriod, type Period,
} from './engine';
import { accountHasGoals, savingsNeedIn } from './savings';
import type { Budget, Cents, PaydayMode, SplitLine } from './types';

export function modeOf(line?: SplitLine): PaydayMode {
  return line?.mode ?? (line?.auto ? 'exact' : 'fixed');
}

export function accountMode(b: Budget, accountId: string): PaydayMode {
  return modeOf(b.split.find((l) => l.accountId === accountId));
}

export interface Outflow { date: ISODate; amount: Cents; name: string }

/**
 * Money leaving an account between two dates (inclusive): its costs and debt plan payments. Money put
 * aside (a WOF, tyres) stays in the account, so it isn't here; see `fundedOut`.
 */
export function outflows(b: Budget, accountId: string, from: ISODate, to: ISODate): Outflow[] {
  if (from > to) return [];
  const out: Outflow[] = [];
  for (const item of b.items) {
    if (item.accountId !== accountId || isSetAside(item)) continue;
    for (const date of itemDates(item, from, to, b.settings)) out.push({ date, amount: item.amount, name: item.name });
  }
  for (const p of debtPaymentsIn(b, accountId, from, to)) out.push({ date: p.date, amount: p.amount, name: p.plan.name });
  return out.sort((x, y) => x.date.localeCompare(y.date) || y.amount - x.amount);
}

/**
 * What payday has to fund between two dates: the payments (`outflows`), plus what each payday in that
 * time puts aside, as if it were paid out on payday. Working out the payday amounts this way means money
 * put aside is never counted as free to pay the bills (or as spare), however much has built up.
 */
export function fundedOut(b: Budget, accountId: string, from: ISODate, to: ISODate): Outflow[] {
  const out = outflows(b, accountId, from, to);
  if (from > to || !hasSetAsides(b, accountId)) return out;
  const s = b.settings;
  let p = periodContaining(from, s);
  if (p.start < from) p = shiftPeriod(p, 1, s);
  for (; p.start <= to; p = shiftPeriod(p, 1, s)) {
    for (const x of setAsidesOn(b, accountId, p.start)) out.push({ date: p.start, amount: x.amount, name: x.item.name });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date) || y.amount - x.amount);
}

/** What 'exact' mode sends in a period: the period's costs, debt payments, money put aside and savings-goal amounts. */
export function exactNeed(b: Budget, accountId: string, p: Period): Cents {
  return fundedOut(b, accountId, p.start, p.end).reduce((t, o) => t + o.amount, 0) + savingsNeedIn(b, accountId, p.start);
}

/**
 * A pay sent less than its usual amount (e.g. paused while pay is short): whatever it's short of what the
 * pay puts aside is simply put aside less, not money the account is owed, so later pays don't catch it up.
 */
const pausedAside = (b: Budget, accountId: string, date: ISODate, usual: Cents, sent: Cents): Cents =>
  sent >= usual ? 0 : Math.min(setAsideOn(b, accountId, date), usual - sent);

const HORIZON = 24;
const RUN_PAYS = 40;

interface PaySlot { date: ISODate; fixed?: Cents }

/**
 * Paydays from `pay` on (`count` of them, plus one more to close the last), each with any one-pay
 * adjustment, and every payment out of the account over that time. Worked out once per run.
 */
function window(b: Budget, accountId: string, pay: Period, count: number): { slots: PaySlot[]; out: Outflow[] } {
  const slots: PaySlot[] = [];
  let p = pay;
  for (let i = 0; i <= count; i++) {
    slots.push({ date: p.start, fixed: b.overrides?.[p.start]?.[accountId] });
    p = shiftPeriod(p, 1, b.settings);
  }
  return { slots, out: fundedOut(b, accountId, pay.start, addDays(slots[count].date, -1)) };
}

/** The usual steady amount: the long-run average, to the dollar. */
const usualSteady = (b: Budget, accountId: string) => Math.ceil(averageNeed(b, accountId) / 100) * 100;

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
function steadyAt(slots: PaySlot[], out: Outflow[], usual: Cents, balance: Cents, level = false): Cents {
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
  return Math.ceil(steady / 100) * 100;
}

/** Payments in `out` from `from` up to (not including) `to`, using a moving index into the sorted list. */
function between(out: Outflow[], from: ISODate, to: ISODate, idx: { i: number }): Outflow[] {
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
function runStart(b: Budget, accountId: string, today: ISODate, useBalance: boolean): { pay: Period; bal: Cents; cursor: ISODate } {
  const entry = b.balances?.[accountId];
  // An account that keeps money put aside (a car fund): its balance is mostly that money, which isn't
  // there to pay the bills, so its amounts are worked out from the budget's start instead.
  const known = useBalance && entry && entry.asOf <= today && !hasSetAsides(b, accountId) ? entry : undefined;
  if (known) return { pay: shiftPeriod(periodContaining(known.asOf, b.settings), 1, b.settings), bal: known.amount, cursor: known.asOf };
  const pay = firstBudgetPay(b, today);
  return { pay, bal: priorLeftover(b, accountId, today), cursor: addDays(pay.start, -1) };
}

/** How many pays a run covers: 40, and always at least up to the pay after today. */
function runLength(pay: Period, today: ISODate, s: Budget['settings']): number {
  let n = RUN_PAYS;
  for (let p = shiftPeriod(pay, RUN_PAYS - 1, s); p.start <= today; p = shiftPeriod(p, 1, s)) n++;
  return n;
}

interface Run { first: string; amounts: Map<string, Cents> }
const runCache = new WeakMap<Budget, Map<string, Run>>();

function cached(b: Budget, key: string, make: () => Run): Run {
  let byKey = runCache.get(b);
  if (!byKey) { byKey = new Map(); runCache.set(b, byKey); }
  let run = byKey.get(key);
  if (!run) { run = make(); byKey.set(key, run); }
  return run;
}

const runKey = (b: Budget, kind: string, accountId: string, today: ISODate, useBalance: boolean) => JSON.stringify([
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
      const amt = steadyAt(slots.slice(i, i + HORIZON + 1), ahead, usual, bal);
      amounts.set(date, amt);
      const sent = slots[i].fixed ?? amt;
      bal += sent + pausedAside(b, accountId, date, amt, sent);
      bal -= between(out, date, slots[i + 1].date, { i: idx.i }).reduce((t, o) => t + o.amount, 0);
    }
    return { first: slots[0].date, amounts };
  });
}

/**
 * For Balance this pay: what a pay would need to send so every later pay can stay at the usual amount
 * (it leaves enough over for the next 5-week pay). Compare with what it sends now to get the top-up.
 */
export function levelAmount(b: Budget, accountId: string, p: Period, today: ISODate = todayISO()): Cents | undefined {
  const bal = balanceOn(b, accountId, addDays(p.start, -1), today);
  if (bal === undefined) return undefined;
  const { slots, out } = window(b, accountId, p, HORIZON);
  return steadyAt(slots, out, usualSteady(b, accountId), bal, true);
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
function fromRun(b: Budget, accountId: string, p: Period, today: ISODate,
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

/**
 * What payday sends to an account in a period, by its mode. The Planner and every balance projection
 * use this, so they always agree. `usual`: ignore a one-pay adjustment (what it would normally send).
 */
export function depositFor(b: Budget, accountId: string, p: Period, today: ISODate = todayISO(), opts: { usual?: boolean } = {}): Cents {
  // A one-pay adjustment (e.g. from Balance this pay) replaces the usual amount for that pay.
  const override = opts.usual ? undefined : b.overrides?.[p.start]?.[accountId];
  if (override !== undefined) return override;
  // A pay before the budget started (already split): what it actually sent.
  const sentEarlier = sentBeforeBudget(b, accountId, p);
  if (sentEarlier !== undefined) return sentEarlier;
  // A savings account whose goals have all passed their target date (e.g. after the wedding) gets nothing more.
  const goals = (b.savings ?? []).filter((g) => g.accountId === accountId);
  if (goals.length && goals.every((g) => g.targetDate && g.targetDate <= p.start)) return 0;
  const line = b.split.find((l) => l.accountId === accountId);
  const mode = modeOf(line);
  if (mode === 'exact') return topsUp(b, accountId) ? exactTopUp(b, accountId, p, today) : exactNeed(b, accountId, p);
  if (mode === 'smooth') return steadyFor(b, accountId, p, today);
  const amount = line?.amount ?? 0;
  // A debt never gets more than it still owes (e.g. once a card is paid off, stop sending money).
  const debt = (b.debts ?? []).find((d) => d.accountId === accountId);
  if (debt && (debt.balance || debt.plans.length)) {
    return Math.min(amount, Math.max(0, projectedOwed(debt, b.settings, addDays(p.start, -1), debtPerPay(b, debt))));
  }
  return amount;
}

/** Estimated balance at the end of `date`, from the last balance you entered. Undefined if unknown. */
export function estimateBalance(b: Budget, accountId: string, date: ISODate, today: ISODate = todayISO()): Cents | undefined {
  const entry = b.balances?.[accountId];
  if (!entry || date < entry.asOf) return undefined;
  let bal = entry.amount;
  let p = periodContaining(entry.asOf, b.settings);
  // Paydays after the balance date, up to and including `date`.
  while (p.nextPayday <= date) {
    p = shiftPeriod(p, 1, b.settings);
    bal += depositFor(b, accountId, p, today);
  }
  return bal - outflows(b, accountId, addDays(entry.asOf, 1), date).reduce((t, o) => t + o.amount, 0);
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
export function forecastBalances(b: Budget, accountId: string, count: number, today: ISODate = todayISO()): PeriodForecast[] {
  const entry = b.balances?.[accountId];
  const rows: PeriodForecast[] = [];
  let p = periodContaining(today, b.settings);
  for (let i = 0; i < count; i++) {
    const received = !entry || p.start > entry.asOf;
    rows.push({
      period: p,
      deposit: received ? depositFor(b, accountId, p, today) : 0,
      out: outflows(b, accountId, entry && entry.asOf > p.start ? addDays(entry.asOf, 1) : p.start, p.end).reduce((t, o) => t + o.amount, 0),
      end: estimateBalance(b, accountId, p.end, today),
    });
    p = shiftPeriod(p, 1, b.settings);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Live bill tracking for an account across the current pay period.
// ---------------------------------------------------------------------------------------------

export interface BillRow extends Outflow {
  status: 'paid' | 'today' | 'due';
  /** Days from today (0 = today, negative = days ago). */
  days: number;
  /** For bills still to come: whether the money in the account covers it (in date order). */
  covered?: boolean;
}

export interface BillTracker {
  period: Period;
  /** Day number within the pay period (1 = payday). */
  day: number;
  rows: BillRow[];
  paid: Cents;
  toCome: Cents;
  /** What payday put in this period. */
  deposit: Cents;
  /** Money in the account now: from your entered balance, or estimated. */
  balance: Cents;
  balanceSource: 'entered' | 'estimated';
  /** False when the balance isn't entered and this pay was split before the budget started — so it can't be estimated. */
  balanceKnown: boolean;
  spare: Cents;
  /** The next payday's deposit and the bills it's for (the following period). */
  next: { period: Period; deposit: Cents; rows: Outflow[] };
}

export function billTracker(b: Budget, accountId: string, today: ISODate = todayISO()): BillTracker {
  const s = b.settings;
  const period = periodContaining(today, s);
  const rows: BillRow[] = outflows(b, accountId, period.start, period.end).map((o) => {
    const days = Math.round((Date.parse(o.date) - Date.parse(today)) / 86400000);
    return { ...o, days, status: days < 0 ? 'paid' : days === 0 ? 'today' : 'due' };
  });
  const paid = rows.filter((r) => r.status === 'paid').reduce((t, r) => t + r.amount, 0);
  const toCome = rows.filter((r) => r.status !== 'paid').reduce((t, r) => t + r.amount, 0);
  const deposit = depositFor(b, accountId, period, today);
  // Balance before today's bills, from the balance you entered (the same figure as the card's headline).
  const entered = balanceToday(b, accountId, today);
  // Without an entered balance: assume this pay's deposit minus what's been paid so far.
  const balance = entered ?? deposit - paid;
  let left = balance;
  for (const r of rows) if (r.status !== 'paid') { r.covered = left >= r.amount; left -= r.amount; }
  const nextPeriod = shiftPeriod(period, 1, s);
  return {
    period, day: Math.round((Date.parse(today) - Date.parse(period.start)) / 86400000) + 1,
    rows, paid, toCome, deposit, balance, balanceSource: entered === undefined ? 'estimated' : 'entered',
    balanceKnown: entered !== undefined || !s.budgetStart || period.start >= s.budgetStart,
    spare: balance - toCome,
    next: { period: nextPeriod, deposit: depositFor(b, accountId, nextPeriod, today), rows: outflows(b, accountId, nextPeriod.start, nextPeriod.end) },
  };
}

/**
 * Money an account can spare this pay: its lowest projected balance over the next `pays` pays,
 * minus its largest single payment in that time (kept in reserve). Needs an entered balance.
 */
export function spareBalance(b: Budget, accountId: string, period: Period, pays = 12, today: ISODate = todayISO()): Cents {
  return spareInfo(b, accountId, period, pays, today)?.spare ?? 0;
}

export interface SpareInfo {
  /** Lowest projected balance over the next pays, and when. */
  low: Cents;
  lowAt: ISODate;
  /** The largest single payment, kept in reserve. */
  reserve: Cents;
  spare: Cents;
}

/** The details behind spareBalance (undefined when no balance is entered). */
export function spareInfo(b: Budget, accountId: string, period: Period, pays = 12, today: ISODate = todayISO()): SpareInfo | undefined {
  if (!b.balances?.[accountId]) return undefined;
  let low = Infinity;
  let lowAt = period.end;
  let p = period;
  for (let i = 0; i < pays; i++) {
    const end = estimateBalance(b, accountId, p.end, today);
    if (end === undefined) return undefined;
    if (end < low) { low = end; lowAt = p.end; }
    if (i < pays - 1) p = shiftPeriod(p, 1, b.settings);
  }
  const reserve = outflows(b, accountId, period.start, p.end).reduce((m, o) => Math.max(m, o.amount), 0);
  return { low, lowAt, reserve, spare: Math.max(0, Math.floor((low - reserve) / 100) * 100) };
}

/**
 * For a steady account: the next pay (after `from`) whose costs are bigger than its steady deposit,
 * e.g. a pay with 5 rent Mondays. That's what the money sitting in the account is kept for.
 */
export function nextBufferUse(b: Budget, accountId: string, from: Period, pays = 13, today: ISODate = todayISO()): { period: Period; need: Cents; deposit: Cents } | undefined {
  let p = from;
  for (let i = 0; i < pays; i++) {
    p = shiftPeriod(p, 1, b.settings);
    const need = fundedOut(b, accountId, p.start, p.end).reduce((t, o) => t + o.amount, 0);
    const deposit = depositFor(b, accountId, p, today);
    if (need > deposit) return { period: p, need, deposit };
  }
  return undefined;
}

export interface ProjectedRow extends Outflow { after?: Cents }
export interface PayProjection {
  period: Period;
  /** Money in the account the day before payday: from your balance, or (no balance) built up from empty. */
  start?: Cents;
  startFrom: 'balance' | 'empty' | 'unknown';
  deposit: Cents;
  /** set = a fixed amount; adjusted = a one-pay adjustment; estimated = worked out (steady or exact). */
  depositKind: 'set' | 'adjusted' | 'estimated';
  rows: ProjectedRow[];
  end?: Cents;
  lowest?: { amount: Cents; date: ISODate };
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
 * A future pay for one account, day by day: what's there before payday, what payday puts in,
 * every payment on its date with the balance after it, and what's left at the end.
 */
export function payProjection(b: Budget, accountId: string, p: Period, today: ISODate = todayISO()): PayProjection {
  const entry = b.balances?.[accountId];
  const before = addDays(p.start, -1);
  const start = balanceOn(b, accountId, before, today);
  const startFrom: PayProjection['startFrom'] = start === undefined ? 'unknown' : entry ? 'balance' : 'empty';
  const override = b.overrides?.[p.start]?.[accountId];
  const mode = accountMode(b, accountId);
  const deposit = depositFor(b, accountId, p, today);
  const depositKind: PayProjection['depositKind'] = override !== undefined ? 'adjusted' : mode === 'fixed' ? 'set' : 'estimated';
  const rows: ProjectedRow[] = outflows(b, accountId, p.start, p.end);
  // Balance after each payment: from the start of the pay, or (balance entered part-way through) from that day.
  let lowest: PayProjection['lowest'];
  let bal = start !== undefined ? start + deposit : undefined;
  for (const r of rows) {
    if (bal === undefined && entry && entry.asOf < r.date) bal = balanceOn(b, accountId, addDays(r.date, -1), today);
    if (bal === undefined) continue;
    bal -= r.amount; r.after = bal;
    if (!lowest || bal < lowest.amount) lowest = { amount: bal, date: r.date };
  }
  const end = balanceOn(b, accountId, p.end, today);
  return { period: p, start, startFrom, deposit, depositKind, rows, end, lowest };
}

// ---------------------------------------------------------------------------------------------
// Exact accounts top up: what's left from earlier pays counts towards the next pay's bills.
// ---------------------------------------------------------------------------------------------

/** Exact accounts that pay bills from a bank account (not debts or savings): leftovers count towards the next pay. */
export function topsUp(b: Budget, accountId: string): boolean {
  const a = b.accounts.find((x) => x.id === accountId);
  return !!a && a.kind === 'bank' && accountMode(b, accountId) === 'exact' && !accountHasGoals(b, accountId) && !accountHasPlans(b, accountId);
}

/** Pay-by-pay run for an exact account that tops up: each pay's bills less what's already there. */
function topUpRun(b: Budget, accountId: string, today: ISODate, useBalance = true): Run {
  return cached(b, runKey(b, 'topup', accountId, today, useBalance), () => {
    const s = b.settings;
    const start = runStart(b, accountId, today, useBalance);
    const count = runLength(start.pay, today, s);
    const { slots, out } = window(b, accountId, start.pay, count);
    let bal = start.bal - fundedOut(b, accountId, addDays(start.cursor, 1), addDays(start.pay.start, -1)).reduce((t, o) => t + o.amount, 0);
    const amounts = new Map<string, Cents>();
    const idx = { i: 0 };
    for (let i = 0; i < count; i++) {
      const date = slots[i].date;
      // The bills, money put aside (and any savings-goal amount), less what's already there, or plus what an earlier pay left short.
      const spent = between(out, date, slots[i + 1].date, idx).reduce((t, o) => t + o.amount, 0) + savingsNeedIn(b, accountId, date);
      const amt = Math.max(0, spent - bal);
      amounts.set(date, amt);
      const sent = slots[i].fixed ?? amt;
      bal += sent - spent + pausedAside(b, accountId, date, amt, sent);
    }
    return { first: slots[0].date, amounts };
  });
}

/**
 * What an exact account gets each pay: that pay's bills, less whatever is already left in the account
 * just before payday (from your balance, or what earlier pays left over). Never less than $0.
 * Worked out pay by pay, so a pay that's sent less or more than needed carries into the next one.
 */
export function exactTopUp(b: Budget, accountId: string, p: Period, today: ISODate = todayISO()): Cents {
  return fromRun(b, accountId, p, today, topUpRun, () => sentBeforeBudget(b, accountId, p) ?? exactNeed(b, accountId, p));
}

/**
 * With no balance entered: what's left in an account the day before the first budgeted pay, from what the
 * pay before it sent (e.g. the last pay's fixed amount for a bills account, less that pay's bills). 0 if unknown.
 */
export function leftoverBeforeBudget(b: Budget, accountId: string, today: ISODate = todayISO()): Cents {
  return b.balances?.[accountId] ? 0 : priorLeftover(b, accountId, today);
}

/** What the pay before the budget left in an account (whether or not you've entered a balance since). */
function priorLeftover(b: Budget, accountId: string, today: ISODate): Cents {
  const acc = b.accounts.find((a) => a.id === accountId);
  if (!acc || acc.kind !== 'bank' || accountHasGoals(b, accountId) || accountHasPlans(b, accountId)) return 0;
  const first = firstBudgetPay(b, today);
  const prev = shiftPeriod(first, -1, b.settings);
  // What it sent: a one-pay adjustment made to it (e.g. topped up by transfer), or its fixed amount.
  const sent = b.overrides?.[prev.start]?.[accountId] ?? sentBeforeBudget(b, accountId, prev);
  return sent === undefined ? 0 : sent - fundedOut(b, accountId, prev.start, addDays(first.start, -1)).reduce((t, o) => t + o.amount, 0);
}

/** What a pay before the budget started sent to an account: its last fixed amount. */
function sentBeforeBudget(b: Budget, accountId: string, p: Period): Cents | undefined {
  const start = b.settings.budgetStart;
  if (!start || p.start >= start) return undefined;
  const line = b.split.find((l) => l.accountId === accountId);
  const acc = b.accounts.find((a) => a.id === accountId);
  return acc?.kind === 'bank' && line && line.amount > 0 ? line.amount : undefined;
}
