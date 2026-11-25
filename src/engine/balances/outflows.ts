import { dateInMonth, todayISO, type ISODate } from '../../core/dates';
import { debtAdvice } from '../../features/debts/logic/advice';
import { debtPay, projectedOwed } from '../../features/debts/logic/amounts';
import { debtPaymentsIn, heldDebtPaymentsIn, isHoldDisplayAccount } from '../../features/debts/logic/funding';
import type { Debt } from '../../core/types';
import { asideSpareNow, hasEnvelopes, hasSetAsides, isHeldInAccount, envelopesOn, setAsidesOn } from '../setAside';
import { periodContaining, shiftPeriod, type Period } from '../periods';
import { itemDates } from '../occurrences';
import { savingsNeedIn } from '../../features/savings/logic/savings';
import type { Budget, Cents, PaydayMode, SplitLine } from '../../core/types';
import { paySplitLocked } from './freeze';

export function modeOf(line?: SplitLine): PaydayMode {
  return line?.mode ?? (line?.auto ? 'exact' : 'fixed');
}

export function accountMode(b: Budget, accountId: string): PaydayMode {
  return modeOf(b.split.find((l) => l.accountId === accountId));
}

/** Steady and Build up keep money between pays for the bigger (5-week) ones: their "Buffer" (`buffer.ts`). */
export const keepsBuffer = (b: Budget, accountId: string): boolean => ['smooth', 'build'].includes(accountMode(b, accountId));

export interface Outflow {
  date: ISODate; amount: Cents; name: string;
  /** The cost (`Item`) or debt it's for, so a bank transaction can be matched to it (`engine/billMatch.ts`). */
  itemId?: string; debtId?: string;
}

/**
 * Money leaving an account between two dates (inclusive): its costs and debt plan payments. Money put
 * aside (a WOF, tyres) or held in a month envelope (Gas) stays in the account, so it isn't here; see
 * `fundedOut`.
 */
export function outflows(b: Budget, accountId: string, from: ISODate, to: ISODate): Outflow[] {
  if (from > to) return [];
  const out: Outflow[] = [];
  for (const item of b.items) {
    if (item.accountId !== accountId || isHeldInAccount(item)) continue;
    for (const date of itemDates(item, from, to, b.settings)) out.push({ date, amount: item.amount, name: item.name, itemId: item.id });
  }
  for (const p of debtPaymentsIn(b, accountId, from, to)) {
    // Hold account (Misc bills): show the debt name so Accounts can note Gem Visa on the 21st.
    const name = p.debt.holdAccountId === accountId ? p.debt.name : p.plan.name;
    out.push({ date: p.date, amount: p.amount, name, debtId: p.debt.id });
  }
  // Gem held here: reserve at least Latitude's recommended amount (and a frozen payday send).
  topUpGemHoldOutflows(b, accountId, from, to, out);
  // Held-elsewhere debts (Gem → Misc bills): still count on the debt card for need/display.
  if (isHoldDisplayAccount(b, accountId)) {
    for (const p of heldDebtPaymentsIn(b, accountId, from, to)) out.push({ date: p.date, amount: p.amount, name: p.plan.name, debtId: p.debt.id });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date) || y.amount - x.amount);
}

/**
 * A held debt's statement amount you set yourself (`heldPay`) replaces its payments that day.
 * Misc bills must keep enough for Gem's statement-day send: Gem's own recommended allocation, or
 * what this pay already froze for Gem — whichever is higher — so leftover isn't shown as spare.
 */
function topUpGemHoldOutflows(b: Budget, accountId: string, from: ISODate, to: ISODate, out: Outflow[]): void {
  const today = todayISO();
  for (const debt of b.debts ?? []) {
    if (debt.holdAccountId !== accountId || !debt.statementDay) continue;
    // The amount you said you'll send for this statement: it, and nothing else, for that day.
    const set = gemStatementInRange(debt, from, to);
    if (set && debt.heldPay?.[set] !== undefined) {
      for (let i = out.length - 1; i >= 0; i--) if (out[i].debtId === debt.id && out[i].date === set) out.splice(i, 1);
      if (debt.heldPay[set] > 0) out.push({ date: set, amount: debt.heldPay[set], name: debt.name, debtId: debt.id });
      continue;
    }
    if (debt.rules !== 'gem') continue;
    // Each pay in the range on its own (a projection asks for many pays at once).
    for (let period = periodContaining(from, b.settings); period.start <= to; period = shiftPeriod(period, 1, b.settings)) {
      const lo = period.start < from ? from : period.start;
      const hi = period.end > to ? to : period.end;
      // Never more than Gem is projected to still owe: once it's paid off, nothing is kept for it
      // (its recommended amount stays $245, so Misc bills built up by that much every month).
      let need = Math.min(debtAdvice(b, debt, period).recommended, projectedOwed(debt, b.settings, period.start, debtPay(b, debt)));
      const frozen = b.splitSent?.[period.start]?.[debt.accountId];
      if (frozen !== undefined && paySplitLocked(b, period, today)) need = Math.max(need, frozen);
      if (need <= 0) continue;
      const rows = out.filter((o) => o.name === debt.name && o.date >= lo && o.date <= hi);
      const sum = rows.reduce((t, o) => t + o.amount, 0);
      if (need <= sum) continue;
      const stmt = gemStatementInRange(debt, lo, hi) ?? rows[0]?.date;
      if (!stmt) continue;
      const hit = rows.find((o) => o.date === stmt) ?? rows[0];
      if (hit) hit.amount += need - sum;
      else out.push({ date: stmt, amount: need - sum, name: debt.name, debtId: debt.id });
    }
  }
}

function gemStatementInRange(debt: Debt, from: ISODate, to: ISODate): ISODate | undefined {
  if (!debt.statementDay) return undefined;
  const y = Number(from.slice(0, 4));
  const m0 = Number(from.slice(5, 7)) - 1;
  for (let i = 0; i < 3; i++) {
    const d = dateInMonth(y, m0 + i, debt.statementDay);
    if (d >= from && d <= to) return d;
  }
  return undefined;
}

/**
 * What payday has to fund between two dates: the payments (`outflows`), plus what each payday in that
 * time puts aside or funds into a month envelope, as if it were paid out on payday. Working out the
 * payday amounts this way means that money is never counted as free to pay the bills (or as spare).
 */
export function fundedOut(b: Budget, accountId: string, from: ISODate, to: ISODate): Outflow[] {
  const out = outflows(b, accountId, from, to);
  if (from > to || (!hasSetAsides(b, accountId) && !hasEnvelopes(b, accountId))) return out;
  const s = b.settings;
  let p = periodContaining(from, s);
  if (p.start < from) p = shiftPeriod(p, 1, s);
  // Running spare so maxSaved caps apply across several pays without re-reading the same balance.
  let spare = asideSpareAt(b, accountId, p.start);
  for (; p.start <= to; p = shiftPeriod(p, 1, s)) {
    const asides = setAsidesOn(b, accountId, p.start, spare === undefined ? undefined : { spare });
    for (const x of asides) {
      if (x.amount <= 0) continue;
      out.push({ date: p.start, amount: x.amount, name: x.item.name });
      if (spare !== undefined) spare += x.amount;
    }
    for (const x of envelopesOn(b, accountId, p.start)) {
      out.push({ date: p.start, amount: x.amount, name: x.item.name });
    }
  }
  return out.sort((x, y) => x.date.localeCompare(y.date) || y.amount - x.amount);
}

/**
 * Money put aside in an account by `payday`: what was spare on the day you entered its balance, plus what
 * each payday since puts aside (capped at each cost's max). Rolling that figure forward by bills alone
 * (`asideSpareNow`) lost the paydays' money, so a later pay never reached Haircut's $60 max and kept putting $30 aside.
 */
function asideSpareAt(b: Budget, accountId: string, payday: ISODate): Cents | undefined {
  const entry = b.balances?.[accountId];
  if (!entry || payday <= entry.asOf) return asideSpareNow(b, accountId, payday);
  let spare = asideSpareNow(b, accountId, entry.asOf);
  if (spare === undefined) return undefined;
  for (let p = shiftPeriod(periodContaining(entry.asOf, b.settings), 1, b.settings); p.start < payday; p = shiftPeriod(p, 1, b.settings)) {
    for (const x of setAsidesOn(b, accountId, p.start, { spare })) spare += Math.max(0, x.amount);
  }
  return spare;
}

/** What 'exact' mode sends in a period: the period's costs, debt payments, money put aside and savings-goal amounts. */
export function exactNeed(b: Budget, accountId: string, p: Period): Cents {
  return fundedOut(b, accountId, p.start, p.end).reduce((t, o) => t + o.amount, 0) + savingsNeedIn(b, accountId, p.start);
}
