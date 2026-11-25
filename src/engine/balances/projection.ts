import { addDays, todayISO, type ISODate } from '../../core/dates';
import { shiftPeriod, type Period } from '../periods';
import type { Budget, Cents } from '../../core/types';
import { estimateBalance, balanceOn } from './estimate';
import { accountMode, type Outflow, outflows } from './outflows';
import { depositFor } from './deposits';

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
