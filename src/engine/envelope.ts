import { dateInMonth, daysInMonth, monthName, todayISO, type ISODate } from '../core/dates';
import { isMonthEnvelope, monthBudget } from './setAside';
import { categorizeTxn, shopMap } from '../features/insights/logic/spending';
import type { Budget, Cents, Item, Txn } from '../core/types';

export {
  monthBudget, monthEnvelopeOn, monthEnvelopePerPay, monthEnvelopesOn, hasMonthEnvelopes, paydaysInMonth,
} from './setAside';

/** Fuel shop / description patterns (same idea as Insights transport → Fuel). */
const FUEL_RE = /z energy|\bmobil\b|\bbp\b|gull|caltex|waitomo|\bnpd\b|\bfuel\b|petrol|gas station/i;

/** Calendar month key "YYYY-MM". */
export const monthKey = (d: ISODate): string => d.slice(0, 7);

/** First and last day of a calendar month. */
export function monthRange(ym: string): { from: ISODate; to: ISODate } {
  const [y, m] = ym.split('-').map(Number);
  return { from: `${ym}-01`, to: dateInMonth(y, m - 1, daysInMonth(y, m - 1)) };
}

/** Whether a synced purchase counts against this envelope (e.g. Gas → fuel shops). */
export function matchesEnvelope(item: Pick<Item, 'name'>, t: Pick<Txn, 'description' | 'merchant' | 'category' | 'amount'>, mine?: ReturnType<typeof shopMap>): boolean {
  if (t.amount >= 0) return false;
  const { category, shop } = categorizeTxn(t, mine);
  if (category === 'transfers') return false;
  const name = item.name.toLowerCase();
  if (/gas|fuel|petrol/.test(name)) {
    return shop === 'Fuel' || FUEL_RE.test(t.description) || FUEL_RE.test(t.merchant ?? '');
  }
  const hay = `${t.description} ${t.merchant ?? ''} ${shop}`.toLowerCase();
  return hay.includes(name);
}

/** Purchases on the account this calendar month that count against the envelope. */
export function envelopeTxns(b: Budget, item: Item, ym: string = monthKey(todayISO())): Txn[] {
  const { from, to } = monthRange(ym);
  const mine = shopMap(b);
  const seen = new Set<string>();
  const out: Txn[] = [];
  for (const t of [...(b.accountTransactions?.[item.accountId] ?? []), ...(b.pendingTransactions?.[item.accountId] ?? [])]) {
    if (t.date < from || t.date > to || !matchesEnvelope(item, t, mine)) continue;
    const key = `${t.date}|${t.amount}|${t.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.description.localeCompare(b.description));
}

export interface EnvelopeStatus {
  item: Item;
  month: string;
  label: string;
  budget: Cents;
  spent: Cents;
  left: Cents;
  over: boolean;
  txns: Txn[];
}

/** Budget / spent / left for one month-envelope item in a calendar month. */
export function envelopeStatus(b: Budget, item: Item, today: ISODate = todayISO()): EnvelopeStatus {
  const month = monthKey(today);
  const budget = monthBudget(item);
  const txns = envelopeTxns(b, item, month);
  const spent = txns.reduce((s, t) => s - t.amount, 0);
  const left = budget - spent;
  return {
    item,
    month,
    label: monthName(`${month}-01`),
    budget,
    spent,
    left,
    over: left < 0,
    txns,
  };
}

/** Every month-envelope on an account, for the Accounts card. */
export function accountEnvelopes(b: Budget, accountId: string, today: ISODate = todayISO()): EnvelopeStatus[] {
  return b.items
    .filter((i) => i.accountId === accountId && isMonthEnvelope(i) && i.start <= today && (!i.end || today <= i.end))
    .map((i) => envelopeStatus(b, i, today))
    .sort((a, b) => a.item.name.localeCompare(b.item.name));
}

/** Remaining (unspent) envelope money on an account this month — spoken for until month end. */
export function envelopeHeld(b: Budget, accountId: string, today: ISODate = todayISO()): Cents {
  return accountEnvelopes(b, accountId, today).reduce((t, e) => t + Math.max(0, e.left), 0);
}
