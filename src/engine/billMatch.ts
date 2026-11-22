import { addDays, diffDays, todayISO, weekday, type ISODate } from '../core/dates';
import { outflows, type Outflow } from './balances/outflows';
import { txnsIn } from './envelopeMatch';
import { ownTransfer } from './transfers';
import type { Account, Budget, Cents, Txn } from '../core/types';

// Which bank transaction paid each bill. A bill can come straight out of its own account ('direct'), be
// paid on another account's card ('card': Skinny on the Weekly allowance card), with a transfer from the
// bill's account to make up for it (`cover`), or be paid by moving the money across before the card
// charge shows up ('moved'). One payment can cover several bills on a day (Tower: car + contents).

export type PaidHow = 'direct' | 'card' | 'moved';

export interface BillMatch {
  outflow: Outflow;
  /** Unset = not seen in the bank. */
  how?: PaidHow;
  /** The payment seen ('direct' / 'card'), or the transfer ('moved'). */
  txn?: Txn;
  /** The account it came out of ('direct': the bill's own), or was moved to ('moved'). */
  from?: string;
  /** 'card': the transfer from the bill's account that made up for it, once seen. */
  cover?: Txn;
  /** One payment paid this and other bills (Tower: car + contents), or a bigger payment covered it (Gem). */
  shared?: boolean;
}

/**
 * How a bill-check answer is kept in `budget.billChecks`. 'held': you've answered whether a debt payment
 * seen from another account paid the one held here; 'unpaid': it didn't, so it's still to send from here;
 * 'rest': you've answered whether the rest of a held payment this account paid part of is still to send.
 */
export const checkKey = (kind: 'move' | 'paid' | 'day' | 'amount' | 'held' | 'unpaid' | 'rest', id: string, v: string | number): string => `${kind}|${id}|${v}`;

/** The cost or debt an outflow is for. */
export const outflowId = (o: Outflow): string => o.itemId ?? o.debtId ?? o.name;

/** Whether the bank connection fills this account (so what the bank shows can be trusted). */
export function bankFed(b: Budget, accountId: string): boolean {
  return b.bankAuto !== false && Object.values(b.bankLinks ?? {}).includes(`account:${accountId}`);
}

/** How far around a bill's date its payment can show up: banks post late, and a few take it early. */
const BEFORE = 4, AFTER = 10;
/** How far either side of a card payment the transfer that made up for it can be. */
const COVER_DAYS = 7;

/** Same amount, near enough (a cent or two of rounding, or 1% on a big one). */
export const sameAmount = (a: Cents, b: Cents): boolean => Math.abs(a - b) <= Math.max(50, Math.round(Math.max(a, b) / 100));

// --- Names -----------------------------------------------------------------------------------------

/** Words in a bill's name that say nothing about who's paid ("Car insurance" → nothing to go on). */
const GENERIC = new Set(['insurance', 'storage', 'bill', 'bills', 'payment', 'monthly', 'weekly', 'fee', 'fees', 'subscription', 'plan',
  'the', 'and', 'for', 'car', 'house', 'home', 'contents', 'scooter', 'life', 'health', 'mobile', 'phone', 'internet', 'card', 'new']);

/** What a bill is called vs who the bank says took it. */
const ALIASES: [RegExp, RegExp][] = [
  [/mobile|phone/i, /spark|one ?nz|vodafone|2degrees|skinny|warehouse mob/i],
  [/internet|broadband|fibre|wifi/i, /skinny|spark|one ?nz|2degrees|orcon|slingshot|voyager|contact|mercury/i],
  [/icloud|apple/i, /apple\.com|itunes/i],
  [/claude/i, /anthropic/i],
  [/chatgpt|openai/i, /openai/i],
  [/power|electric|energy/i, /mercury|genesis|contact energy|meridian|trustpower|electric kiwi|flick|frank energy|nova energy/i],
  [/gym|fitness/i, /gym|les mills|anytime fitness|jetts|snap fitness/i],
  [/kindy|kindergarten|daycare|childcare|preschool/i, /kind[ey]|daycare|childcare|early learning|preschool/i],
];

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 3);

/** Two words a typo or a bank's cut-off apart ("Circut" / "Cricut", "Kindergarten" / "Kindergardten", "YouTube" / "Youtu"). */
function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 && b.length < 5) return false;
  if (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  // At most one letter added, dropped, changed, or two swapped.
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length] <= 1;
}

/** 2 = a word of the bill's name is in the transaction, 1 = a known alias (Mobile → Spark), 0 = neither. */
export function nameMatch(name: string, t: Pick<Txn, 'description' | 'merchant'>): 0 | 1 | 2 {
  const hay = `${t.description} ${t.merchant ?? ''}`;
  const theirs = words(hay);
  if (words(name).some((w) => !GENERIC.has(w) && theirs.some((x) => near(w, x)))) return 2;
  return ALIASES.some(([mine, bank]) => mine.test(name) && bank.test(hay)) ? 1 : 0;
}

// --- Matching --------------------------------------------------------------------------------------

interface Seen { txn: Txn; accountId: string; id: number }

const cache = new WeakMap<Budget, Map<string, BillMatch[]>>();

/**
 * Each bill (and debt payment) leaving `accountId` between two dates, with the bank transaction that
 * paid it, if one's been seen. Bills a little earlier are matched too, so they don't take this pay's
 * payments. Only transactions up to `today` count.
 */
export function matchBills(b: Budget, accountId: string, from: ISODate, to: ISODate, today: ISODate = todayISO()): BillMatch[] {
  const key = `${accountId}|${from}|${to}|${today}`;
  let byBudget = cache.get(b);
  if (!byBudget) cache.set(b, (byBudget = new Map()));
  const hit = byBudget.get(key);
  if (hit) return hit;

  const start = addDays(from, -40);
  // Two calls, so this window's bills are exactly what `outflows(from, to)` gives (same order, same amounts).
  const earlier = outflows(b, accountId, start, addDays(from, -1));
  const bills = [...earlier, ...outflows(b, accountId, from, to)];
  const until = addDays(to, AFTER) < today ? addDays(to, AFTER) : today;
  let n = 0;
  const seen: Seen[] = [];
  for (const a of b.accounts) {
    if (a.kind !== 'bank') continue;
    for (const txn of txnsIn(b, a.id, addDays(start, -BEFORE), until)) seen.push({ txn, accountId: a.id, id: n++ });
  }
  const used = new Set<number>();
  const res: BillMatch[] = bills.map((outflow) => ({ outflow }));
  const own = new Map(seen.map((s) => [s.id, ownTransfer(b, s.txn)?.account]));

  // 1. Single payments, best fit first: the name, then the amount, then the date, then its own account.
  const pairs: { i: number; s: Seen; score: number }[] = [];
  res.forEach((m, i) => {
    const o = m.outflow;
    for (const s of seen) {
      const t = s.txn;
      if (t.amount >= 0 || own.get(s.id)) continue;
      // You said a payment from another account wasn't this one (Gem paid extra from Weekly allowance).
      if (s.accountId !== accountId && o.debtId && b.billChecks?.[checkKey('unpaid', o.debtId, o.date)]) continue;
      const gap = diffDays(o.date, t.date);
      if (gap < -BEFORE || gap > AFTER) continue;
      const nm = nameMatch(o.name, t);
      const paid = -t.amount;
      const r = Math.min(paid, o.amount) / Math.max(paid, o.amount);
      const here = s.accountId === accountId;
      const ok = here ? (nm > 0 && r >= 0.25) || sameAmount(paid, o.amount) : nm > 0 && r >= 0.25;
      if (!ok) continue;
      pairs.push({ i, s, score: nm + 1.5 * r + 0.5 * (1 - Math.abs(gap) / 14) + (here ? 0.25 : 0) });
    }
  });
  pairs.sort((x, y) => y.score - x.score);
  for (const p of pairs) {
    if (res[p.i].how || used.has(p.s.id)) continue;
    used.add(p.s.id);
    res[p.i] = { ...res[p.i], how: p.s.accountId === accountId ? 'direct' : 'card', txn: p.s.txn, from: p.s.accountId };
  }

  // 2. A bigger payment that covered more than one plan of the same bill (Gem Visa: two plans, one payment).
  for (const m of res) {
    if (m.how) continue;
    const twins = res.filter((x) => x.how && x.txn && x.outflow.name === m.outflow.name && x.outflow.date === m.outflow.date);
    const t = twins[0]?.txn;
    if (!t) continue;
    const total = twins.filter((x) => x.txn === t).reduce((s, x) => s + x.outflow.amount, 0) + m.outflow.amount;
    if (-t.amount >= Math.round(total * 0.95)) {
      Object.assign(m, { how: twins[0].how, txn: t, from: twins[0].from, shared: true });
      twins.forEach((x) => { x.shared = true; });
    }
  }

  // 3. One payment out of this account for several bills on a day (Tower: car $116.82 + contents $48.99).
  for (const s of seen) {
    if (s.accountId !== accountId || used.has(s.id) || s.txn.amount >= 0 || own.get(s.id)) continue;
    const days = new Map<ISODate, BillMatch[]>();
    for (const m of res) {
      if (m.how) continue;
      const gap = diffDays(m.outflow.date, s.txn.date);
      if (gap < -2 || gap > 7) continue;
      days.set(m.outflow.date, [...(days.get(m.outflow.date) ?? []), m]);
    }
    for (const group of days.values()) {
      if (group.length < 2 || !sameAmount(group.reduce((t, m) => t + m.outflow.amount, 0), -s.txn.amount)) continue;
      used.add(s.id);
      group.forEach((m) => Object.assign(m, { how: 'direct', txn: s.txn, from: accountId, shared: true }));
      break;
    }
  }

  // 4. Paid on another account's card: the transfer from this account that made up for it.
  const transfersOut = seen.filter((s) => s.accountId === accountId && s.txn.amount < 0 && own.get(s.id));
  for (const m of res) {
    if (m.how !== 'card' || !m.txn || m.cover) continue;
    const t = m.txn;
    const need = res.filter((x) => x.txn === t).reduce((s, x) => s + x.outflow.amount, 0);
    const cover = transfersOut
      .filter((s) => !used.has(s.id) && own.get(s.id)?.id === m.from && Math.abs(diffDays(t.date, s.txn.date)) <= COVER_DAYS
        && (sameAmount(-s.txn.amount, need) || sameAmount(-s.txn.amount, -t.amount)))
      .sort((x, y) => Math.abs(diffDays(t.date, x.txn.date)) - Math.abs(diffDays(t.date, y.txn.date)))[0];
    if (!cover) continue;
    used.add(cover.id);
    res.filter((x) => x.txn === t).forEach((x) => { x.cover = cover.txn; });
  }

  // 5. Money moved to another account for it, before its card charge shows up (Skinny: $83 moved on the 18th).
  for (const m of res) {
    if (m.how) continue;
    const s = transfersOut.find((x) => !used.has(x.id) && sameAmount(-x.txn.amount, m.outflow.amount)
      && diffDays(m.outflow.date, x.txn.date) >= -COVER_DAYS && diffDays(m.outflow.date, x.txn.date) <= 3);
    if (!s) continue;
    used.add(s.id);
    Object.assign(m, { how: 'moved', txn: s.txn, from: own.get(s.id)!.id });
  }

  const out = res.slice(earlier.length);
  byBudget.set(key, out);
  return out;
}

/** The next weekday on or after a date (a bill due on a Saturday leaves on Monday). */
export function businessDay(d: ISODate): ISODate {
  const w = weekday(d);
  return w === 6 ? addDays(d, 2) : w === 0 ? addDays(d, 1) : d;
}

/**
 * Transactions on an account between two dates that aren't a bill's payment or its make-up transfer,
 * and aren't payday's deposit (`deposit`, on or just after `payday`): money you moved in or out yourself.
 * These are what make an account end up with more (or less) than the plan says.
 */
export function otherMoves(b: Budget, accountId: string, from: ISODate, to: ISODate, payday: ISODate, deposit: Cents, today: ISODate = todayISO()): { txn: Txn; other?: Account }[] {
  const matched = matchBills(b, accountId, addDays(from, -10), addDays(to, 10), today);
  const taken = new Set<Txn>(matched.flatMap((m) => [m.txn, m.cover].filter(Boolean) as Txn[]));
  let payday1 = false;
  return txnsIn(b, accountId, from, to < today ? to : today)
    .filter((t) => {
      if (taken.has(t)) return false;
      if (!payday1 && t.amount > 0 && sameAmount(t.amount, deposit) && diffDays(payday, t.date) >= -1 && diffDays(payday, t.date) <= 3) { payday1 = true; return false; }
      return true;
    })
    .map((txn) => ({ txn, other: ownTransfer(b, txn)?.account }))
    .reverse();
}
