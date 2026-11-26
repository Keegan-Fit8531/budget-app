import type { ISODate } from './dates';
import type { BalanceEntry, Cents, Txn } from './types';

// Debts as saved in the budget (`Budget.debts`). Split out of types.ts to keep it small; types.ts re-exports
// everything here, so import from './types' as before.

/**
 * interest-free: clear by a deadline, any payment (Gem 6 months, Mastercard 3 months)
 * equal: even payments each pay over N months (Gem 12/24/36)
 * afterpay: 4 fortnightly instalments, first 2 weeks after purchase
 * balance: a fixed payment each pay until it's gone, with interest if the debt has a rate
 */
export type PlanType = 'interest-free' | 'equal' | 'afterpay' | 'balance';

export interface DebtPlan {
  id: string;
  name: string;
  type: PlanType;
  /** Original purchase / loan amount. */
  original: Cents;
  /** What's still owed on it as of `asOf`. */
  remaining: Cents;
  asOf: ISODate;
  purchaseDate: ISODate;
  /** Interest-free or equal-payment length in months. */
  months?: number;
  /** For 'balance' plans: how much to pay each pay. */
  payment?: Cents;
  /**
   * The exact instalments still to pay (e.g. copied from the Afterpay app). When set, these are used
   * as-is instead of being worked out from the purchase date, and `remaining` is their total.
   */
  instalments?: { date: ISODate; amount: Cents; label?: string }[];
  /** When the interest-free period ends, if known exactly (otherwise purchase date + months). */
  ends?: ISODate;
  /** 'balance' and 'equal' plans: no payments before this day (paused); the first is on the first payday on or after it. */
  startsOn?: ISODate;
}

export interface Debt {
  id: string;
  name: string;
  /** card / buy-now-pay-later / a person / other loan */
  kind: 'card' | 'bnpl' | 'person' | 'loan';
  /** Card rules used to suggest the plan type for new purchases. */
  rules?: 'gem' | 'mastercard' | 'afterpay';
  /** The payday-split account shown for this debt (e.g. Gem Visa): Planner still shows how much is sent. */
  accountId: string;
  /**
   * Bank account that holds the payment until statement day (e.g. Misc bills). Payday still lists the
   * debt with its amount; the money sits here so you don't send it to the card before the statement
   * (Gem would treat an early transfer as an extra payment). Payments leave this account on/after
   * statement day. When unset, money is planned against `accountId` as usual.
   */
  holdAccountId?: string;
  /**
   * What you'll send from the hold account for a statement (statement date → amount), set in the Accounts bill
   * check. Replaces the planned and recommended amount for that statement only.
   */
  heldPay?: Record<ISODate, Cents>;
  limit?: Cents;
  /** Standard interest rate, % per year. */
  rate?: number;
  plans: DebtPlan[];
  /** The outstanding balance you last checked (e.g. from the card's app or statement). */
  balance?: BalanceEntry;
  /** Every time the amount owed changed (balance updates, purchases added or paid down), one entry per day. */
  history?: BalanceEntry[];
  /** Day of the month the statement comes out; payments are made on/after it (Gem: 21st). */
  statementDay?: number;
  /**
   * Repaid by your employer from your salary before pay reaches you (e.g. a student loan), so it isn't
   * part of the payday split. perPay = the latest deduction; payslips with a deduction update it.
   */
  payroll?: { perPay: Cents; applied?: ISODate[] };
  /** Colour for a debt with no payday account (e.g. a payroll-deducted loan). */
  color?: string;
  /**
   * The last balance you checked (a statement, screenshot, export or typed in), before any payments
   * were counted automatically. A card export's purchases and payments are added on from here.
   */
  checked?: BalanceEntry;
  /** The card number's last digits, as in its CSV exports, so an export is matched to it. */
  ending?: string;
  /** Its transactions, from CSV exports or the bank connection, oldest first. */
  transactions?: Txn[];
  /** Not settled yet on the card (bank connection only); replaced on every sync. */
  pending?: Txn[];
  /** Statement months whose plan was made from the card's own transactions (the day it ends), so one paid off isn't made again. */
  cardPlans?: string[];
  /**
   * Your answers to Plan check (purchase date|amount → what it is): the plan length in months (0: not on a
   * plan, or paid off), and the plan as it was before, so Undo can put it back (null: there wasn't one).
   */
  planAnswers?: Record<string, { months: number; was: DebtPlan | null; on: ISODate }>;
  /**
   * Planned payments already counted as paid (they're automatic), oldest first. Kept so the pay a payment
   * came out of still shows it once it has gone: without this a pay's total would shrink, and its leftover
   * grow, as each of its payments went out.
   */
  paid?: PaidPayment[];
  /** The last day a document (statement, screenshot, export) brought it up to date. */
  checkedOn?: ISODate;
  /** Payments to it seen leaving a linked bank account on a bank sync (e.g. ANZ → Gem Visa), oldest first. */
  bankPayments?: BankPayment[];
  /** What the latest statement asks for (read from it; the bank connection doesn't send these). */
  statementDue?: StatementDue;
}

export interface StatementDue {
  /** The statement's date. */
  date: ISODate;
  minimum?: Cents;
  /** What to pay to avoid interest, as printed (Gem: closing balance less what's still interest-free). */
  avoidInterest?: Cents;
  /** Pay by this day. */
  by?: ISODate;
}

export interface BankPayment {
  date: ISODate;
  amount: Cents;
  /** The bank account it left. */
  from: string;
  /** The part that came off what's owed: what it paid over the planned payments around its date. */
  counted: Cents;
  /** The planned payments it stood for (date|amount|plan), so a later transfer doesn't take them too. */
  planned?: string[];
}

export interface PaidPayment {
  date: ISODate;
  amount: Cents;
  /** The plan it went to. */
  name: string;
  /** It came off the balance outside any plan (worked out from the balance, so redone if an older statement is added). */
  synthetic?: boolean;
  /** The plan's id (saved since document reading was added; older entries only have the name). */
  planId?: string;
}
