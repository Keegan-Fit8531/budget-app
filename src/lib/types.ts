import type { ISODate } from './dates';
import type { Payslip } from './payslip';

/** Money is always stored as whole cents to avoid rounding drift. */
export type Cents = number;

export type Frequency = 'weekly' | 'fortnightly' | 'monthly' | 'yearly' | 'once';

export type RuleBucket = 'needs' | 'wants' | 'savings';

export interface Group {
  id: string;
  name: string;
  color: string;
  bucket: RuleBucket;
}

export interface Account {
  id: string;
  name: string;
  color: string;
  /** bank = a bank account you hold; external = somewhere money is sent (a person, card, fund) */
  kind: 'bank' | 'external';
  groupId: string;
  note?: string;
  archived?: boolean;
}

/** Something that takes money out of an account on a schedule (a bill, rent, a weekly transfer). */
export interface Item {
  id: string;
  name: string;
  amount: Cents;
  frequency: Frequency;
  /** First date it happens. Sets the weekday (weekly/fortnightly) or day of month (monthly). */
  start: ISODate;
  end?: ISODate;
  accountId: string;
  note?: string;
  /** Show this weekly cost on the planner's "Weeks this pay" calendar. */
  showInWeeks?: boolean;
  /** Skip it when it lands this many days (or fewer) before payday — you go without until pay. */
  skipIfWithin?: number;
}

/** How much of each pay is sent to each account on payday. */
export interface SplitLine {
  accountId: string;
  /** Fixed amount sent each payday (ignored when `auto` is on). */
  amount: Cents;
  /** Older saves: true meant 'exact'. Use `mode` instead. */
  auto?: boolean;
  /**
   * fixed: the same set amount every payday
   * exact: exactly what this period's costs need (4 or 5 weeks of rent)
   * smooth: a steady amount, worked out from the balance, so a buffer covers 5-week periods
   */
  mode?: PaydayMode;
}

export type PaydayMode = 'fixed' | 'exact' | 'smooth';

export interface BalanceEntry {
  amount: Cents;
  /** The day you checked the balance. */
  asOf: ISODate;
}

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
}

export interface Debt {
  id: string;
  name: string;
  /** card / buy-now-pay-later / a person / other loan */
  kind: 'card' | 'bnpl' | 'person' | 'loan';
  /** Card rules used to suggest the plan type for new purchases. */
  rules?: 'gem' | 'mastercard' | 'afterpay';
  /** The payday-split account that payments are sent to. */
  accountId: string;
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
}

export interface SavingsGoal {
  id: string;
  name: string;
  /** The payday-split account savings are sent to. */
  accountId: string;
  /** Saved so far, as of `asOf`. */
  balance: Cents;
  asOf: ISODate;
  target?: Cents;
  targetDate?: ISODate;
  /** Contributions you don't send from pay (e.g. a partner's), per pay. */
  otherPerPay?: Cents;
  note?: string;
  /** Costs to be paid from this goal (e.g. wedding venue, photographer). */
  costs?: GoalCost[];
  /** One-off money added to this goal, e.g. a gift from family (received, or expected on a date). */
  gifts?: GoalGift[];
  /** People who put money in (e.g. Me, Sam). The first is you: your payday transfers count for them. */
  people?: string[];
  /** Amounts each person put in before tracking started (set by editing their total). */
  personBase?: Record<string, Cents>;
  /** This person's total is worked out as whatever's left of the balance after everyone else's. */
  remainderPerson?: string;
}

export interface GoalGift {
  id: string;
  amount: Cents;
  date: ISODate;
  /** Who it's from / what it's for. */
  note?: string;
  /** The person who put it in (or, when `out`, who it was taken out for). */
  person?: string;
  /** true = money taken out of the fund (counts against that person's total). */
  out?: boolean;
  /** false = expected but not arrived yet (counts in projections, not in the saved balance). */
  received: boolean;
}

export interface GoalCost {
  id: string;
  name: string;
  amount: Cents;
  category: string;
  /** When it has to be paid, if known (undated costs are due by the goal's target date). */
  due?: ISODate;
  /** Fully paid (nothing left to pay). */
  paid?: boolean;
  /** Paid without using the fund (e.g. Sam paid the deposit themself): the saved balance isn't touched. */
  paidOutside?: boolean;
  /** Who paid it, when paid outside the fund (older single-person form; see paidSplit). */
  paidBy?: string;
  /** Who paid how much, when paid outside the fund by more than one person (e.g. Alex $1,000 + Me $800). */
  paidSplit?: { person: string; amount: Cents }[];
  /** When it was paid. */
  paidOn?: ISODate;
  /** Money spent on it so far, from the goal's fund. */
  spends?: GoalSpend[];
}

export interface GoalSpend {
  id: string;
  amount: Cents;
  date: ISODate;
  note?: string;
}

export interface Settings {
  paydayDay: number;
  /** Where pay goes when the payday falls on a Saturday / Sunday. */
  saturday: 'friday' | 'monday';
  sunday: 'friday' | 'monday';
  expectedPay: Cents;
  /** Older saves: automatic balancing could be turned off. It's always on now; this is ignored. */
  autoBalance?: boolean;
  /**
   * Paydays that really fell on a different day than the rule gives (e.g. paid a day early before a
   * holiday, taken from a payslip): the month of the usual payday ("YYYY-MM") → the day pay arrived.
   * The pay before it ends the day before, and that pay starts on it.
   */
  paydayMoves?: Record<string, ISODate>;
  /** First payday the budget covers; earlier pay periods are ignored by the Planner. */
  budgetStart?: ISODate;
  /** The account pay lands in; it keeps whatever isn't split out. */
  payAccountId: string;
  rule: { needs: number; wants: number; savings: number; name: string };
}

export interface Budget {
  version: 1;
  /** When you last changed anything (used to keep the newest copy when syncing between browsers). */
  updatedAt?: string;
  settings: Settings;
  groups: Group[];
  accounts: Account[];
  items: Item[];
  split: SplitLine[];
  /** Actual pay received, keyed by the pay period's start date. */
  payActuals: Record<ISODate, Cents>;
  /** Payslip breakdowns, keyed the same way as payActuals. */
  payslips?: Record<ISODate, Payslip>;
  /** Cards, buy-now-pay-later and people you owe, with their payment plans. */
  debts?: Debt[];
  savings?: SavingsGoal[];
  /** Account balances you've entered, by account id. */
  balances?: Record<string, BalanceEntry>;
  /** One-pay adjustments: pay period start → account id → amount sent that pay instead of the usual. */
  overrides?: Record<ISODate, Record<string, Cents>>;
  /**
   * What automatic balancing changed: pay start → account id → the amount before (null = none), the
   * amount it set, and why. Lets it redo a pay from scratch when something changes, without touching
   * changes you made yourself.
   */
  autoBalanced?: Record<ISODate, Record<string, { prev: Cents | null; to: Cents; reason: string }>>;
  /** Your categories for savings-goal costs (e.g. wedding: Venue, Attire…). */
  costCategories?: string[];
  /** One-time changes already applied to this save. */
  flags?: string[];
}
