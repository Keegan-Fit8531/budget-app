import { fmtShort, monthName, todayISO, type ISODate } from '../core/dates';
import { envelopeBudget, envelopeSpan, envelopeWindow, isEnvelope } from './setAside';
import { categorizeTxn, shopMap } from '../features/insights/logic/spending';
import type { Budget, Cents, EnvelopeSpan, Item, Txn } from '../core/types';

export {
  envelopeBudget, envelopeOn, envelopePerPay, envelopeSpan, envelopesOn, envelopeWindow, hasEnvelopes, paydaysInMonth,
} from './setAside';

/** Fuel shop / description patterns (same idea as Insights transport → Fuel). */
const FUEL_RE = /z energy|\bmobil\b|\bbp\b|gull|caltex|waitomo|\bnpd\b|\bfuel\b|petrol|gas station/i;

/** Whether a synced purchase counts against this envelope (e.g. Gas → fuel shops). */
export function matchesEnvelope(item: Pick<Item, 'name'>, t: Pick<Txn, 'description' | 'merchant' | 'category' | 'amount'>, mine?: ReturnType<typeof shopMap>): boolean {
  if (t.amount >= 0) return false;
  const { category, shop } = categorizeTxn(t, mine);
  if (category === 'transfers') return false;
  const name = item.name.toLowerCase();
  if (/gas|fuel|petrol/.test(name)) {
    return shop === 'Fuel' || FUEL_RE.test(t.description) || FUEL_RE.test(t.merchant ?? '');
  }
  if (/food|grocer|supermarket/.test(name)) return category === 'groceries';
  const hay = `${t.description} ${t.merchant ?? ''} ${shop}`.toLowerCase();
  return hay.includes(name);
}

/** Purchases on the account in one span (from–to) that count against the envelope. */
export function envelopeTxns(b: Budget, item: Item, { from, to }: { from: ISODate; to: ISODate }): Txn[] {
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
  /** The span being tracked (this week, fortnight or calendar month). */
  from: ISODate;
  to: ISODate;
  /** "November", or "21 Nov – 27 Nov" for a week or fortnight. */
  label: string;
  /** How long it lasts before starting fresh. */
  span: EnvelopeSpan;
  budget: Cents;
  spent: Cents;
  left: Cents;
  over: boolean;
  txns: Txn[];
}

/** Budget / spent / left for one envelope in the span (week, fortnight or month) holding `today`. */
export function envelopeStatus(b: Budget, item: Item, today: ISODate = todayISO()): EnvelopeStatus {
  const { from, to } = envelopeWindow(item, today);
  const span = envelopeSpan(item);
  const budget = envelopeBudget(item);
  const txns = envelopeTxns(b, item, { from, to });
  const spent = txns.reduce((s, t) => s - t.amount, 0);
  const left = budget - spent;
  return {
    item,
    from,
    to,
    label: span === 'month' ? monthName(from) : `${fmtShort(from)} – ${fmtShort(to)}`,
    span,
    budget,
    spent,
    left,
    over: left < 0,
    txns,
  };
}

/** Every envelope on an account, for the Accounts card. */
export function accountEnvelopes(b: Budget, accountId: string, today: ISODate = todayISO()): EnvelopeStatus[] {
  return b.items
    .filter((i) => i.accountId === accountId && isEnvelope(i) && i.start <= today && (!i.end || today <= i.end))
    .map((i) => envelopeStatus(b, i, today))
    .sort((a, b) => a.item.name.localeCompare(b.item.name));
}

/** Remaining (unspent) envelope money on an account this span — spoken for until the span ends. */
export function envelopeHeld(b: Budget, accountId: string, today: ISODate = todayISO()): Cents {
  return accountEnvelopes(b, accountId, today).reduce((t, e) => t + Math.max(0, e.left), 0);
}
