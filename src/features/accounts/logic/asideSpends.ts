import { addDays, diffDays, todayISO, type ISODate } from '../../../core/dates';
import type { Account, Budget, Cents, Item, Txn } from '../../../core/types';
import { depositFor } from '../../../engine/balances/deposits';
import { sameAmount } from '../../../engine/billMatch';
import { isTransferOut, transferKey, txnsIn } from '../../../engine/envelopeMatch';
import { periodContaining } from '../../../engine/periods';
import { isHeldInAccount, isSetAside } from '../../../engine/setAside';
import { ownTransfer } from '../../../engine/transfers';
import { shopMap } from '../../insights/logic/spending';

// What money put aside (Car maintenance: WOF / rego, maintenance) was spent on. Money leaves the account
// straight to a shop, or (usually) moves to the card account first and is spent there: $200 to Weekly
// allowance, then NZ Transport on its card. You say which put-aside cost each paid for
// (`budget.asideSpends`), so the card keeps a record of what came out of it.

/** How far either side of a transfer to look for the purchase it paid for. */
const NEAR_DAYS = 3;
/** Money that comes back this soon (out to Misc bills, back the next day) was only moving through. */
const BACK_DAYS = 7;

/** Shops for a put-aside cost, by its name: rego / WOF → NZ Transport, VTNZ …; maintenance → tyres, mechanics. */
const SHOPS: [RegExp, RegExp][] = [
  [/wof|rego|registration|licen[cs]e/i, /nz ?transport|nzta|waka ?kotahi|vtnz|vinz|\bwof\b|\brego\b|registration|testing station/i],
  [/maint|service|repair|tyre|tire|mechanic|part/i, /tyre|tire|mechanic|automotive|\bauto\b|service|repair|repco|supercheap|midas|beaurepaires|bridgestone|\bparts\b|\bmotors\b/i],
];

/** Whether a purchase looks like it was for this put-aside cost (by its shop, or a word of the cost's name). */
export function asideShopMatch(item: Pick<Item, 'name'>, t: Pick<Txn, 'description' | 'merchant'>): boolean {
  const hay = `${t.description} ${t.merchant ?? ''}`;
  if (SHOPS.some(([name, shops]) => name.test(item.name) && shops.test(hay))) return true;
  const words = item.name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !/^(aside|set|money|fund)$/.test(w));
  return words.some((w) => hay.toLowerCase().includes(w));
}

export interface AsideSpend {
  txn: Txn;
  /** What `budget.asideSpends` is keyed by. */
  key: string;
  /** Your answer: the put-aside cost's id, '' = not from the put-aside money, undefined = not answered yet. */
  itemId?: string;
  /** Where a transfer went (Weekly allowance). Undefined for a purchase straight from this account. */
  to?: Account;
  /** What it paid for: the purchase itself, or the one on the account the money went to (NZ Transport $189). */
  paidFor?: { txn: Txn; accountId: string };
  /** The put-aside costs it could be for, the likeliest first. */
  likely: Item[];
}

/** The put-aside costs on an account running on a date. */
const asidesAt = (b: Budget, accountId: string, date: ISODate) =>
  b.items.filter((i) => i.accountId === accountId && isSetAside(i) && i.start <= date && (!i.end || date <= i.end))
    .sort((x, y) => x.name.localeCompare(y.name));

/** One money-out on the account, with what it most likely paid for. */
function describe(b: Budget, accountId: string, t: Txn, mine = shopMap(b)): AsideSpend {
  const key = transferKey(accountId, t);
  const items = asidesAt(b, accountId, t.date);
  const to = isTransferOut(t, mine) ? ownTransfer(b, t)?.account : undefined;
  let paidFor: AsideSpend['paidFor'];
  if (!isTransferOut(t, mine)) paidFor = { txn: t, accountId };
  else if (to) {
    // Purchases there near the transfer, from a quarter of it to twice it: one for a put-aside cost first, else the nearest amount.
    const near = txnsIn(b, to.id, addDays(t.date, -NEAR_DAYS), addDays(t.date, NEAR_DAYS))
      .filter((p) => p.amount < 0 && !isTransferOut(p, mine) && -p.amount >= -t.amount / 4 && -p.amount <= -t.amount * 2)
      .sort((x, y) => Number(items.some((i) => asideShopMatch(i, y))) - Number(items.some((i) => asideShopMatch(i, x)))
        || Math.abs(x.amount - t.amount) - Math.abs(y.amount - t.amount));
    if (near[0]) paidFor = { txn: near[0], accountId: to.id };
  }
  const fits = (i: Item) => (paidFor && asideShopMatch(i, paidFor.txn) ? 0 : 1);
  return { txn: t, key, itemId: b.asideSpends?.[key], to, paidFor, likely: [...items].sort((x, y) => fits(x) - fits(y)) };
}

/**
 * Money out that came back within a week (moved to Misc bills, back the next day; a bill made up from
 * another account first), so it wasn't spending. Payday's deposit doesn't count as money coming back.
 */
function passedThrough(b: Budget, accountId: string, txns: Txn[], today: ISODate): Set<Txn> {
  const isDeposit = (t: Txn) => {
    const p = periodContaining(addDays(t.date, 1), b.settings);
    return diffDays(p.start, t.date) <= 3 && sameAmount(t.amount, depositFor(b, accountId, p, today));
  };
  const ins = txns.filter((t) => t.amount > 0 && !isDeposit(t));
  const used = new Set<Txn>(), out = new Set<Txn>();
  for (const t of txns.filter((x) => x.amount < 0)) {
    const back = ins.find((i) => !used.has(i) && i.amount === -t.amount && Math.abs(diffDays(t.date, i.date)) <= BACK_DAYS);
    if (back) { used.add(back); out.add(t); }
  }
  return out;
}

/** Money out of a put-aside account this pay that you haven't said about yet: the Accounts card asks what it was for. */
export function unsortedAsideSpends(b: Budget, accountId: string, today: ISODate = todayISO()): AsideSpend[] {
  // Only an account that just holds money (a car fund): one that pays bills has money out all the time.
  if (!asidesAt(b, accountId, today).length || b.items.some((i) => i.accountId === accountId && !isHeldInAccount(i))) return [];
  const from = periodContaining(today, b.settings).start;
  const txns = txnsIn(b, accountId, addDays(from, -BACK_DAYS), today);
  const through = passedThrough(b, accountId, txns, today);
  const mine = shopMap(b);
  return txns.filter((t) => t.amount < 0 && t.date >= from && !through.has(t) && b.asideSpends?.[transferKey(accountId, t)] === undefined)
    .map((t) => describe(b, accountId, t, mine));
}

/** Everything you said was paid from the put-aside money, newest first. */
export function asideSpends(b: Budget, accountId: string): AsideSpend[] {
  const said = b.asideSpends ?? {};
  const mine = shopMap(b);
  return txnsIn(b, accountId, '0000-01-01', '9999-12-31')
    .filter((t) => t.amount < 0 && said[transferKey(accountId, t)])
    .map((t) => describe(b, accountId, t, mine));
}

/** What each put-aside cost has had spent on it since a date (WOF / rego → $200). */
export function asideSpentSince(spends: AsideSpend[], since: ISODate): Map<string, Cents> {
  const by = new Map<string, Cents>();
  for (const s of spends) if (s.itemId && s.txn.date >= since) by.set(s.itemId, (by.get(s.itemId) ?? 0) - s.txn.amount);
  return by;
}
