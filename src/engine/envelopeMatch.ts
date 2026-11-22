import { addDays, type ISODate } from '../core/dates';
import { isEnvelope } from './setAside';
import { ownTransfer } from './transfers';
import { categorizeTxn, shopMap } from '../features/insights/logic/spending';
import type { Budget, Item, Txn } from '../core/types';

// Which synced transactions count against an envelope: purchases that match it (fuel for Gas), and
// transfers out of its account that paid for one (bought food on another card, then moved $50 over).

type Shops = ReturnType<typeof shopMap>;
type TxnLike = Pick<Txn, 'description' | 'merchant' | 'category' | 'amount'>;

/** Fuel shop / description patterns (same idea as Insights transport → Fuel). */
const FUEL_RE = /z energy|\bmobil\b|\bbp\b|gull|caltex|waitomo|\bnpd\b|\bfuel\b|petrol|gas station/i;

/** How far either side of a transfer to look for the purchase it paid for. */
const NEAR_DAYS = 3;

/** Whether a synced purchase counts against this envelope (Gas → fuel shops, Food → supermarkets, else by name). */
export function matchesEnvelope(item: Pick<Item, 'name'>, t: TxnLike, mine?: Shops): boolean {
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

/** The envelopes on an account that are running on a date. */
export function envelopesAt(b: Budget, accountId: string, date: ISODate): Item[] {
  return b.items.filter((i) => i.accountId === accountId && isEnvelope(i) && i.start <= date && (!i.end || date <= i.end))
    .sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * The one envelope a purchase counts against, of those on its account (`envelopes`), and whether that was
 * clear. When several match (Car gas and Scooter gas both take fuel), one with an `envelopeUnder` limit
 * the purchase is under wins (the smallest limit first), else the only one with no limit. Never two, so a
 * fill isn't counted twice; with no limit to go by it takes the first by name, but isn't `clear`.
 */
export function pickEnvelope(envelopes: Item[], t: TxnLike, mine?: Shops): { item?: Item; clear: boolean } {
  const fits = envelopes.filter((i) => matchesEnvelope(i, t, mine));
  if (fits.length <= 1) return { item: fits[0], clear: true };
  const spent = -t.amount;
  const under = fits.filter((i) => i.envelopeUnder && spent < i.envelopeUnder)
    .sort((x, y) => x.envelopeUnder! - y.envelopeUnder!);
  if (under.length) return { item: under[0], clear: true };
  const open = fits.filter((i) => !i.envelopeUnder);
  // Over every limit and none without one: the one with the biggest limit.
  if (!open.length) return { item: [...fits].sort((x, y) => y.envelopeUnder! - x.envelopeUnder!)[0], clear: true };
  return { item: open[0], clear: open.length === 1 };
}

export const purchaseEnvelope = (envelopes: Item[], t: TxnLike, mine?: Shops): Item | undefined =>
  pickEnvelope(envelopes, t, mine).item;

/** Money moved out to another account (not a purchase). */
export function isTransferOut(t: TxnLike, mine?: Shops): boolean {
  return t.amount < 0 && categorizeTxn(t, mine).category === 'transfers';
}

/**
 * What `budget.envelopeTransfers` is keyed by. No date: a pending transfer can post on a later day, and
 * the bank's reference number in the description already tells transfers apart.
 */
export const transferKey = (accountId: string, t: Pick<Txn, 'amount' | 'description'>): string =>
  `${accountId}|${t.amount}|${t.description}`;

/** Posted and pending transactions on an account between two dates, without repeats, newest first. */
export function txnsIn(b: Budget, accountId: string, from: ISODate, to: ISODate): Txn[] {
  const seen = new Set<string>();
  const out: Txn[] = [];
  for (const t of [...(b.accountTransactions?.[accountId] ?? []), ...(b.pendingTransactions?.[accountId] ?? [])]) {
    if (t.date < from || t.date > to) continue;
    const key = `${t.date}|${t.amount}|${t.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.description.localeCompare(b.description));
}

export interface TransferGuess {
  /** The envelope it most likely paid for, best first. */
  itemIds: string[];
  /** Sure enough to count without asking: one envelope fits. */
  sure: boolean;
  /** The purchases that made the guess (nearest the amount first), and where they were. */
  seen: { txn: Txn; accountId: string }[];
}

/**
 * Which envelope a transfer out of its account paid for, from purchases on the account it went to (or
 * any other account, when the bank doesn't say where) within 3 days either side, each given to one
 * envelope by `purchaseEnvelope` (a $30 fill → Scooter gas, $80 → Car gas). Sure when only one envelope
 * has a purchase; with several, the one whose purchase is nearest the amount comes first. Undefined when nothing nearby matches.
 */
export function guessTransfer(b: Budget, accountId: string, t: Txn, mine: Shops = shopMap(b)): TransferGuess | undefined {
  const envelopes = envelopesAt(b, accountId, t.date);
  if (!envelopes.length) return undefined;
  const target = ownTransfer(b, t)?.account;
  const from = addDays(t.date, -NEAR_DAYS), to = addDays(t.date, NEAR_DAYS);
  const where = target ? [target.id] : b.accounts.filter((a) => a.id !== accountId && a.kind === 'bank').map((a) => a.id);
  const purchases = where.flatMap((id) => txnsIn(b, id, from, to).map((txn) => ({ txn, accountId: id })))
    .filter((p) => p.txn.amount < 0 && !isTransferOut(p.txn, mine));
  const fits = envelopes
    .map((item) => {
      const seen = purchases.filter((p) => purchaseEnvelope(envelopes, p.txn, mine)?.id === item.id)
        .sort((x, y) => Math.abs(x.txn.amount - t.amount) - Math.abs(y.txn.amount - t.amount));
      const gap = seen.length ? Math.abs(seen[0].txn.amount - t.amount) : Infinity;
      return { item, seen, gap };
    })
    .filter((f) => f.seen.length > 0)
    .sort((x, y) => x.gap - y.gap);
  if (!fits.length) return undefined;
  // Two envelopes each have a purchase nearby (a $30 and an $80 fill), or a fill could be either (two gas
  // envelopes, no limit to tell them apart): that's for you to say.
  const sure = fits.length === 1 && fits[0].seen.every((p) => pickEnvelope(envelopes, p.txn, mine).clear);
  return { itemIds: fits.map((f) => f.item.id), sure, seen: fits[0].seen };
}

/**
 * Which envelope a transfer out counts against: your choice if you made one ('' = not envelope
 * spending), else a sure guess. Undefined = not sorted yet (the Accounts card asks).
 */
export function transferEnvelope(b: Budget, accountId: string, t: Txn, mine?: Shops): string | undefined {
  const chosen = b.envelopeTransfers?.[transferKey(accountId, t)];
  if (chosen !== undefined) return chosen;
  const guess = guessTransfer(b, accountId, t, mine);
  return guess?.sure ? guess.itemIds[0] : undefined;
}
