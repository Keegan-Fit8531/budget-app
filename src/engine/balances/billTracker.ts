import { todayISO, type ISODate } from '../../core/dates';
import { periodContaining, shiftPeriod, type Period } from '../periods';
import type { Budget, Cents } from '../../core/types';
import { type Outflow, outflows } from './outflows';
import { depositFor, depositSansBalance } from './deposits';
import { balanceToday, billKey, outByBalance } from './estimate';
import { bankFed, checkKey, matchBills, otherMoves, outflowId, sameAmount, type BillMatch } from '../billMatch';
import type { Account, Txn } from '../../core/types';

// ---------------------------------------------------------------------------------------------
// Live bill tracking for an account across the current pay period.
// ---------------------------------------------------------------------------------------------

export interface BillRow extends Outflow {
  status: 'paid' | 'today' | 'due';
  /** Days from today (0 = today, negative = days ago). */
  days: number;
  /** For bills still to come: whether the money in the account covers it (in date order). */
  covered?: boolean;
  /** What the bank shows for it (bank-connected accounts): how and when it was paid. */
  match?: BillMatch;
  /** Its date has passed but the bank doesn't show it yet (so its money is still in the account). */
  late?: boolean;
  /**
   * A held debt (Gem) that this account paid only part of: this row is the rest, still to come.
   * `of` is what was kept for it, `sent` what the bank shows paid from here (`txn`).
   */
  rest?: { of: Cents; sent: Cents; txn: Txn };
}

/**
 * A held debt's payment (Gem, two plans) that this account paid less of than it kept: what the bank
 * shows paid is paid, and the rest is a row still to come (`rest`), so $150 doesn't pay a $258 plan.
 * Rows paid from another account are left as they are.
 */
function splitPartPaid(rows: BillRow[]): BillRow[] {
  const out: BillRow[] = [];
  const done = new Set<string>();
  for (const r of rows) {
    if (!r.debtId || r.match?.how === 'card') { out.push(r); continue; }
    const key = `${r.debtId}|${r.date}`;
    if (done.has(key)) continue;
    const group = rows.filter((x) => x.debtId === r.debtId && x.date === r.date && x.match?.how !== 'card');
    const txns = [...new Set(group.filter((x) => x.match?.how === 'direct' && x.match.txn).map((x) => x.match!.txn!))];
    const sent = txns.reduce((t, x) => t - x.amount, 0);
    const of = group.reduce((t, x) => t + x.amount, 0);
    if (!txns.length || sent >= of || sameAmount(sent, of)) { out.push(r); continue; }
    done.add(key);
    const paid = group.find((x) => x.match?.how === 'direct')!;
    out.push({ ...paid, amount: sent, name: r.name });
    out.push({ ...r, amount: of - sent, match: undefined, status: r.days === 0 ? 'today' : 'due', late: r.days < 0, rest: { of, sent, txn: txns[txns.length - 1] } });
  }
  return out;
}

/** A bill paid on another account's card, with no transfer from this account to make up for it yet. */
export interface ToMove { row: BillRow; to: string; amount: Cents }

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
  /** Bills paid on another account's card this pay, whose money is still here to move across. */
  toMove: ToMove[];
  /** Money you moved in or out yourself this pay (not payday, not a bill): why it has more or less than planned. */
  moves: { txn: Txn; other?: Account }[];
  /** Balance less what's still to come out and what's to move across. */
  spare: Cents;
  /** The next payday's deposit and the bills it's for (the following period). */
  next: { period: Period; deposit: Cents; rows: Outflow[] };
}

/**
 * How much has already left the account today (bank sync / stored transactions). Used so a Thursday
 * transfer that already hit the balance isn't still counted as "to come".
 */
function debitedToday(b: Budget, accountId: string, today: ISODate): Cents {
  const seen = [...(b.accountTransactions?.[accountId] ?? []), ...(b.pendingTransactions?.[accountId] ?? [])];
  return seen.filter((t) => t.date === today && t.amount < 0).reduce((s, t) => s - t.amount, 0);
}

/**
 * True when today's entered/synced balance already has today's bills out (e.g. $1,000 in, $200
 * transferred, balance now $800). Without this, those bills stay "to come" and the account looks short.
 */
function todaysBillsAlreadyOut(b: Budget, accountId: string, today: ISODate, todayOut: Cents, fed = false): boolean {
  if (todayOut <= 0) return false;
  // With the bank connected, today's lines are already matched to their bills: only the balance can tell.
  if (!fed && debitedToday(b, accountId, today) >= todayOut) return true;
  const entry = b.balances?.[accountId];
  if (!entry || entry.asOf !== today) return false;
  const period = periodContaining(today, b.settings);
  // Payday: balance + today's bills ≈ what payday sent (you deposited, then the Thursday transfer left).
  if (today === period.start) {
    const sent = b.splitSent?.[period.start]?.[accountId]
      ?? b.overrides?.[period.start]?.[accountId]
      ?? depositSansBalance(b, accountId, period);
    return Math.abs(entry.amount + todayOut - sent) <= 100;
  }
  // Other days, a bank-connected account's balance is compared with the one before it (`outByBalance`).
  return false;
}

export function billTracker(b: Budget, accountId: string, today: ISODate = todayISO()): BillTracker {
  const s = b.settings;
  const period = periodContaining(today, s);
  let rows: BillRow[] = outflows(b, accountId, period.start, period.end).map((o) => {
    const days = Math.round((Date.parse(o.date) - Date.parse(today)) / 86400000);
    return { ...o, days, status: (days < 0 ? 'paid' : days === 0 ? 'today' : 'due') as BillRow['status'] };
  });
  const entry = b.balances?.[accountId];
  const fed = bankFed(b, accountId) && !!entry;
  if (fed) {
    // The bank says what's been paid, up to when it was last seen: a bill it shows is paid (even early, or
    // on another account's card); one it doesn't is still to come, as its money is still in the account.
    const matches = matchBills(b, accountId, period.start, period.end, today);
    const out = outByBalance(b, accountId, today);
    rows.forEach((r, i) => {
      const m = matches[i];
      if (m?.how) { r.match = m; r.status = 'paid'; return; }
      if (r.date > entry.asOf) return;
      if (b.billChecks?.[checkKey('paid', outflowId(r), r.date)] || out.has(billKey(r))) { r.status = 'paid'; return; }
      r.status = r.days === 0 ? 'today' : 'due';
      r.late = r.days < 0;
    });
    rows = splitPartPaid(rows);
  }
  // Bank already shows today's bill(s) out: treat them as paid so $800 after a $200 transfer isn't
  // "short $200" against five weeks still listed as to come. (With the bank connected, only for bills
  // dated today that no transaction line shows yet: the balance can arrive before the line does.)
  const todayOut = rows.filter((r) => r.status === 'today').reduce((t, r) => t + r.amount, 0);
  let cover = todaysBillsAlreadyOut(b, accountId, today, todayOut, fed) ? todayOut : fed ? 0 : debitedToday(b, accountId, today);
  for (const r of rows) {
    if (r.status !== 'today' || cover < r.amount) continue;
    r.status = 'paid';
    r.late = false;
    cover -= r.amount;
  }
  const paid = rows.filter((r) => r.status === 'paid').reduce((t, r) => t + r.amount, 0);
  const toCome = rows.filter((r) => r.status !== 'paid').reduce((t, r) => t + r.amount, 0);
  const deposit = depositFor(b, accountId, period, today);
  // Balance before today's bills, from the balance you entered (the same figure as the card's headline).
  const entered = balanceToday(b, accountId, today);
  // Without an entered balance: assume this pay's deposit minus what's been paid so far.
  const balance = entered ?? deposit - paid;
  // Paid on another account's card (Netflix on the Weekly allowance card): its money is still here until you move it.
  // A debt payment only once you've said that payment from another account was it (the bill check's 'held').
  const toMove: ToMove[] = rows
    .filter((r) => r.match?.how === 'card' && !r.match.cover && r.match.from
      && (r.match.outflow.itemId || (r.debtId && b.billChecks?.[checkKey('held', r.debtId, r.date)]))
      && !b.billChecks?.[checkKey('move', outflowId(r), r.date)])
    .map((r) => ({ row: r, to: r.match!.from!, amount: Math.min(r.amount, -r.match!.txn!.amount) }));
  const owed = toMove.reduce((t, m) => t + m.amount, 0);
  let left = balance - owed;
  for (const r of rows) if (r.status !== 'paid') { r.covered = left >= r.amount; left -= r.amount; }
  const nextPeriod = shiftPeriod(period, 1, s);
  return {
    period, day: Math.round((Date.parse(today) - Date.parse(period.start)) / 86400000) + 1,
    rows, paid, toCome, deposit, balance, balanceSource: entered === undefined ? 'estimated' : 'entered',
    balanceKnown: entered !== undefined || !s.budgetStart || period.start >= s.budgetStart,
    toMove,
    moves: fed ? otherMoves(b, accountId, period.start, period.end, period.start, deposit, today) : [],
    spare: balance - toCome - owed,
    next: { period: nextPeriod, deposit: depositFor(b, accountId, nextPeriod, today), rows: outflows(b, accountId, nextPeriod.start, nextPeriod.end) },
  };
}
