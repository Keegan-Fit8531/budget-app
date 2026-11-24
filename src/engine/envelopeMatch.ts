import { addDays, diffDays, type ISODate } from '../core/dates';
import { isEnvelope } from './setAside';
import { ownTransfer } from './transfers';
import { categorizeTxn, FUEL_SHOPS, shopMap } from '../features/insights/logic/spending';
import type { Budget, Item, Txn } from '../core/types';

// Which synced transactions count against an envelope: purchases that match it (fuel for Gas), and
// transfers out of its account that paid for one (bought food on another card, then moved $50 over).

type Shops = ReturnType<typeof shopMap>;
type TxnLike = Pick<Txn, 'description' | 'merchant' | 'category' | 'amount'>;

/** Fuel in a description: the fuel brands Insights knows (`FUEL_SHOPS`), or words that say so. */
const isFuel = (s: string) => FUEL_SHOPS.test(s) || /petrol|gas station/i.test(s);

/** How far either side of a transfer to look for the purchase it paid for. */
const NEAR_DAYS = 3;
/** A purchase this close to a transfer's amount is the one it paid for ($80 for an $80.49 fill). */
const CLOSE = 500;

/** Whether a synced purchase counts against this envelope (Gas → fuel shops, Food → supermarkets, else by name). */
export function matchesEnvelope(item: Pick<Item, 'name'>, t: TxnLike, mine?: Shops): boolean {
  if (t.amount >= 0) return false;
  const { category, shop } = categorizeTxn(t, mine);
  if (category === 'transfers') return false;
  const name = item.name.toLowerCase();
  if (/gas|fuel|petrol/.test(name)) {
    return shop === 'Fuel' || isFuel(t.description) || isFuel(t.merchant ?? '');
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
  /** Each envelope's purchase nearest the amount, in `itemIds` order (what a not-sure guess weighed up). */
  nearest: { txn: Txn; accountId: string }[];
}

interface Purchase { txn: Txn; accountId: string; item: Item }
const purchaseKey = (p: Purchase) => `${p.accountId}|${p.txn.date}|${p.txn.amount}|${p.txn.description}`;

/**
 * Envelope purchases on the account a transfer went to (or any other bank account, when the bank doesn't
 * say where) within 3 days either side, each given to one envelope by `purchaseEnvelope`.
 */
function purchasesNear(b: Budget, accountId: string, t: Txn, envelopes: Item[], mine: Shops): Purchase[] {
  const target = ownTransfer(b, t)?.account;
  const from = addDays(t.date, -NEAR_DAYS), to = addDays(t.date, NEAR_DAYS);
  const where = target ? [target.id] : b.accounts.filter((a) => a.id !== accountId && a.kind === 'bank').map((a) => a.id);
  return where.flatMap((id) => txnsIn(b, id, from, to).map((txn) => ({ txn, accountId: id })))
    .filter((p) => p.txn.amount < 0 && !isTransferOut(p.txn, mine))
    .flatMap((p) => { const item = purchaseEnvelope(envelopes, p.txn, mine); return item ? [{ ...p, item }] : []; });
}

/**
 * The purchases other transfers out of this account (to the same place, within 3 days) paid for, so one
 * shop isn't claimed twice. Each transfer takes the purchase nearest its amount, closest pairs first: $80,
 * $50 and $150 moved over after an $80.49 fill, a $53.94 shop and a $111.67 shop get one each. A transfer
 * you said was for an envelope only takes that envelope's purchases; one you said was "just moving money", none.
 */
function claimedByOthers(b: Budget, accountId: string, t: Txn, envelopes: Item[], mine: Shops): Set<string> {
  const target = ownTransfer(b, t)?.account?.id;
  const key = transferKey(accountId, t);
  const movers = txnsIn(b, accountId, addDays(t.date, -NEAR_DAYS), addDays(t.date, NEAR_DAYS))
    .filter((m) => isTransferOut(m, mine) && ownTransfer(b, m)?.account?.id === target);
  if (movers.length < 2) return new Set();
  const pairs = movers.flatMap((m) => {
    const chosen = b.envelopeTransfers?.[transferKey(accountId, m)];
    if (chosen === '') return [];
    return purchasesNear(b, accountId, m, envelopes, mine).filter((p) => chosen === undefined || p.item.id === chosen)
      .map((p) => ({ mover: transferKey(accountId, m), p: purchaseKey(p), gap: Math.abs(p.txn.amount - m.amount) }));
  }).sort((x, y) => x.gap - y.gap);
  const done = new Set<string>(), taken = new Set<string>(), claimed = new Set<string>();
  for (const { mover, p } of pairs) {
    if (done.has(mover) || taken.has(p)) continue;
    done.add(mover); taken.add(p);
    if (mover !== key) claimed.add(p);
  }
  return claimed;
}

/**
 * Which envelope a transfer out of its account paid for, from the purchases near it (`purchasesNear`)
 * that another transfer didn't pay for (`claimedByOthers`). Sure when only one envelope has a purchase,
 * or when the nearest is within $5 of the amount and every other envelope's within $5 is further off in
 * both amount and day. With several, the one whose
 * purchase is nearest the amount comes first. Undefined when nothing nearby matches.
 */
export function guessTransfer(b: Budget, accountId: string, t: Txn, mine: Shops = shopMap(b)): TransferGuess | undefined {
  const envelopes = envelopesAt(b, accountId, t.date);
  if (!envelopes.length) return undefined;
  const claimed = claimedByOthers(b, accountId, t, envelopes, mine);
  const purchases = purchasesNear(b, accountId, t, envelopes, mine).filter((p) => !claimed.has(purchaseKey(p)));
  const fits = envelopes
    .map((item) => {
      const seen = purchases.filter((p) => p.item.id === item.id)
        .sort((x, y) => Math.abs(x.txn.amount - t.amount) - Math.abs(y.txn.amount - t.amount))
        .map(({ txn, accountId: id }) => ({ txn, accountId: id }));
      const gap = seen.length ? Math.abs(seen[0].txn.amount - t.amount) : Infinity;
      return { item, seen, gap };
    })
    .filter((f) => f.seen.length > 0)
    .sort((x, y) => x.gap - y.gap);
  if (!fits.length) return undefined;
  // Two envelopes each have a purchase nearby (a $30 and an $80 fill) and neither is near the amount, or a
  // fill could be either (two gas envelopes, no limit to tell them apart): that's for you to say.
  const clear = fits[0].seen.every((p) => pickEnvelope(envelopes, p.txn, mine).clear);
  // Another envelope's purchase within $5 too (a $21.19 shop beside a $20.35 fill) still loses if it's
  // further off in both amount and day.
  const best = fits[0].seen[0]?.txn;
  const days = (d: ISODate) => Math.abs(diffDays(t.date, d));
  const beaten = (p: { txn: Txn }) => Math.abs(p.txn.amount - t.amount) > fits[0].gap && days(p.txn.date) > days(best.date);
  const close = fits[0].gap <= CLOSE
    && fits.slice(1).every((f) => f.seen.every((p) => Math.abs(p.txn.amount - t.amount) > CLOSE || beaten(p)));
  const sure = clear && (fits.length === 1 || close);
  return { itemIds: fits.map((f) => f.item.id), sure, seen: fits[0].seen, nearest: fits.map((f) => f.seen[0]) };
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
