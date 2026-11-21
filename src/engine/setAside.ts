import { addDays, dateInMonth, daysInMonth, diffDays, todayISO, type ISODate } from '../core/dates';
import { debtPaymentsIn } from '../features/debts/logic/funding';
import type { Budget, Cents, EnvelopeSpan, Item } from '../core/types';
import { convert } from './frequency';
import { type PayRules, periodContaining, shiftPeriod } from './periods';
import { itemDates } from './occurrences';

// ---------- Money put aside ----------

/** A cost that's put aside each pay and kept in its account until needed (a WOF, tyres), not paid out on a date. */
export const isSetAside = (item: Pick<Item, 'setAside'>): boolean => item.setAside === true;

/** Envelope (Gas $200/month, Food $200/week): funded on payday, spent from synced purchases, resets each span. */
export const isEnvelope = (item: Pick<Item, 'monthEnvelope'>): boolean => item.monthEnvelope === true;

/** Held in the account (put-aside or envelope): not paid out on a scheduled date. */
export const isHeldInAccount = (item: Pick<Item, 'setAside' | 'monthEnvelope'>): boolean =>
  isSetAside(item) || isEnvelope(item);

/** What a set-aside puts aside each pay: its average per month (pay is monthly), or the whole amount once. */
export function setAsidePerPay(item: Pick<Item, 'amount' | 'frequency'>): Cents {
  return item.frequency === 'once' ? item.amount : convert(item.amount, item.frequency, 'month');
}

/** The first payday on or after `date`. */
function paydayFrom(date: ISODate, s: PayRules): ISODate {
  const p = periodContaining(date, s);
  return p.start === date ? date : p.nextPayday;
}

/**
 * Spare in an account for put-aside money, without calling depositFor (avoids recursion).
 * Entered balance, less bills still to come this pay. Undefined when no balance is entered.
 */
export function asideSpareNow(b: Budget, accountId: string, today: ISODate = todayISO()): Cents | undefined {
  const entry = b.balances?.[accountId];
  if (!entry || entry.asOf > today) return undefined;
  let bal = entry.amount;
  if (entry.asOf < today) {
    // Roll forward by bills only (deposits would recurse through set-asides).
    bal -= b.items
      .filter((i) => i.accountId === accountId && !isHeldInAccount(i))
      .reduce((t, i) => t + i.amount * itemDates(i, addDays(entry.asOf, 1), addDays(today, -1), b.settings).length, 0);
    bal -= debtPaymentsIn(b, accountId, addDays(entry.asOf, 1), addDays(today, -1)).reduce((t, x) => t + x.amount, 0);
  }
  const period = periodContaining(today, b.settings);
  const toCome = b.items
    .filter((i) => i.accountId === accountId && !isHeldInAccount(i))
    .reduce((t, i) => t + i.amount * itemDates(i, today, period.end, b.settings).filter((d) => d >= today).length, 0)
    + debtPaymentsIn(b, accountId, today, period.end).reduce((t, x) => t + x.amount, 0);
  return Math.max(0, bal - toCome);
}

/** What a payday puts aside in an account: each set-aside from the first payday on or after its start, up to its end. */
export function setAsidesOn(
  b: Budget,
  accountId: string,
  payday: ISODate,
  opts?: { spare?: Cents; today?: ISODate },
): { item: Item; amount: Cents }[] {
  const list = b.items
    .filter((i) => i.accountId === accountId && isSetAside(i) && i.start <= payday && (!i.end || payday <= i.end)
      && (i.frequency !== 'once' || paydayFrom(i.start, b.settings) === payday))
    .map((item) => ({ item, amount: setAsidePerPay(item) }));
  if (!list.some((x) => x.item.maxSaved && x.item.maxSaved > 0)) return list;

  // Cap each maxSaved item so payday stops topping up once spare is at the cap.
  let spare = opts?.spare;
  if (spare === undefined) spare = asideSpareNow(b, accountId, opts?.today ?? todayISO());
  if (spare === undefined) return list; // no balance entered: keep putting aside

  const capped = list.filter((x) => x.item.maxSaved && x.item.maxSaved > 0);
  const uncapped = list.filter((x) => !(x.item.maxSaved && x.item.maxSaved > 0));
  // Attribute current spare to capped items in name order, each up to its max.
  let left = spare;
  const built = new Map<string, Cents>();
  for (const x of [...capped].sort((a, b) => a.item.name.localeCompare(b.item.name))) {
    const take = Math.min(left, x.item.maxSaved!);
    built.set(x.item.id, take);
    left -= take;
  }
  return [
    ...capped.map((x) => {
      const have = built.get(x.item.id) ?? 0;
      const room = Math.max(0, x.item.maxSaved! - have);
      return { item: x.item, amount: Math.min(x.amount, room) };
    }),
    ...uncapped,
  ];
}

/** The total a payday puts aside in an account. */
export function setAsideOn(b: Budget, accountId: string, payday: ISODate, opts?: { spare?: Cents; today?: ISODate }): Cents {
  return setAsidesOn(b, accountId, payday, opts).reduce((t, x) => t + x.amount, 0);
}

export function hasSetAsides(b: Pick<Budget, 'items'>, accountId: string): boolean {
  return b.items.some((i) => i.accountId === accountId && isSetAside(i));
}

export function hasEnvelopes(b: Pick<Budget, 'items'>, accountId: string): boolean {
  return b.items.some((i) => i.accountId === accountId && isEnvelope(i));
}

/**
 * Account-level cap for money put aside: the sum of each set-aside's maxSaved, only when every
 * set-aside on the account has a max (e.g. Haircut $60). Undefined when any set-aside is uncapped —
 * those can keep building without a ceiling.
 */
export function asideMaxSaved(b: Pick<Budget, 'items'>, accountId: string): Cents | undefined {
  const asides = b.items.filter((i) => i.accountId === accountId && isSetAside(i));
  if (!asides.length || !asides.every((i) => i.maxSaved && i.maxSaved > 0)) return undefined;
  return asides.reduce((t, i) => t + (i.maxSaved ?? 0), 0);
}

/** How long an envelope lasts before it starts fresh: a calendar month unless set to a week or fortnight. */
export const envelopeSpan = (item: Pick<Item, 'envelopeSpan'>): EnvelopeSpan => item.envelopeSpan ?? 'month';

const SPAN_DAYS = { week: 7, fortnight: 14 } as const;

/** An envelope's budget for one span (week, fortnight or month): its amount converted to that span. */
export function envelopeBudget(item: Pick<Item, 'amount' | 'frequency' | 'envelopeSpan'>): Cents {
  return item.frequency === 'once' ? item.amount : convert(item.amount, item.frequency, envelopeSpan(item));
}

/** First and last day of a calendar month ("YYYY-MM"). */
function calendarMonthRange(ym: string): { from: ISODate; to: ISODate } {
  const [y, m] = ym.split('-').map(Number);
  return { from: `${ym}-01`, to: dateInMonth(y, m - 1, daysInMonth(y, m - 1)) };
}

/**
 * The span of an envelope that holds `date`: its calendar month, or the week / fortnight counted from
 * the item's start (a weekly envelope starting on a Thursday runs Thursday to Wednesday).
 */
export function envelopeWindow(item: Pick<Item, 'start' | 'envelopeSpan'>, date: ISODate): { from: ISODate; to: ISODate } {
  const span = envelopeSpan(item);
  if (span === 'month') return calendarMonthRange(date.slice(0, 7));
  const len = SPAN_DAYS[span];
  const from = addDays(item.start, Math.floor(diffDays(item.start, date) / len) * len);
  return { from, to: addDays(from, len - 1) };
}

/** Paydays whose actual pay date falls in this calendar month. */
export function paydaysInMonth(ym: string, s: PayRules): ISODate[] {
  const { from, to } = calendarMonthRange(ym);
  const out: ISODate[] = [];
  let p = periodContaining(from, s);
  if (p.start < from) p = shiftPeriod(p, 1, s);
  for (; p.start <= to; p = shiftPeriod(p, 1, s)) out.push(p.start);
  return out;
}

/**
 * What a payday puts into an envelope. A month envelope: an even share of the calendar month's budget
 * across the paydays in that month (last payday gets any remainder). A week or fortnight envelope: the
 * budget of every week / fortnight that starts in this pay (from the item's start, up to its end).
 */
export function envelopePerPay(item: Item, payday: ISODate, s: PayRules): Cents {
  if (!isEnvelope(item)) return 0;
  const span = envelopeSpan(item);
  if (span !== 'month') {
    const p = periodContaining(payday, s);
    if (p.start !== payday) return 0;
    const len = SPAN_DAYS[span];
    let from = envelopeWindow(item, payday).from;
    if (from < payday) from = addDays(from, len);
    let count = 0;
    for (; from <= p.end && (!item.end || from <= item.end); from = addDays(from, len)) if (from >= item.start) count++;
    return count * envelopeBudget(item);
  }
  if (item.start > payday || (item.end && payday > item.end)) return 0;
  const budget = envelopeBudget(item);
  const pays = paydaysInMonth(payday.slice(0, 7), s);
  const i = pays.indexOf(payday);
  if (i < 0) return 0;
  if (pays.length <= 1) return budget;
  const each = Math.floor(budget / pays.length);
  return i === pays.length - 1 ? budget - each * (pays.length - 1) : each;
}

/** Envelope amounts a payday funds in an account. */
export function envelopesOn(b: Budget, accountId: string, payday: ISODate): { item: Item; amount: Cents }[] {
  return b.items
    .filter((i) => i.accountId === accountId && isEnvelope(i))
    .map((item) => ({ item, amount: envelopePerPay(item, payday, b.settings) }))
    .filter((x) => x.amount > 0);
}

export function envelopeOn(b: Budget, accountId: string, payday: ISODate): Cents {
  return envelopesOn(b, accountId, payday).reduce((t, x) => t + x.amount, 0);
}
