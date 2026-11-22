import type { ISODate } from './dates';
import type { Payslip } from '../services/reader/payslip';

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
  /**
   * Round what payday sends here to a multiple of this (100 = whole dollars, 5000 = $50) when balancing
   * changes it (trims round down, top-ups round up) and for a Steady amount (rounds up). 0 or unset = off.
   */
  round?: Cents;
  /** The end of its account number, as in its CSV exports, so an export is matched to it. */
  ending?: string;
  /** Its full account number (from the bank connection), so a transfer to or from it can be named. */
  number?: string;
}

/** A transaction from a bank or card export (CSV). + is money in (or paid off a card), − is money out (spent). */
export interface Txn {
  date: ISODate;
  description: string;
  amount: Cents;
  /** From the bank connection: the shop's name and the bank's category for it, when it gives them. */
  merchant?: string;
  category?: string;
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
  /**
   * Put aside, not paid out (a WOF, tyres, a service): each payday sends its share (a yearly $90 WOF is
   * $7.50 a pay) and the money stays in the account until it's needed, so nothing comes out on a date.
   * It starts on the first payday on or after `start`.
   */
  setAside?: boolean;
  /**
   * Cap for money put aside (e.g. Haircut $60): once the account already has this much spare after
   * covering bills, payday stops adding more for this cost until some is spent.
   */
  maxSaved?: Cents;
  /**
   * An envelope (e.g. Gas $200/month, Food $200/week), and how long each one lasts: a calendar month, or
   * a week / fortnight counted from `start`. The amount converted to that span is its budget; synced
   * purchases that match (fuel for Gas) count against it, and what's left when it ends is yours — it
   * doesn't roll over. Absent = an ordinary cost. Mutually exclusive with `setAside`.
   */
  envelope?: EnvelopeSpan;
  /**
   * Only purchases under this amount count against this envelope (Scooter gas: fills under $50). When two
   * envelopes on an account match the same shops (Car gas and Scooter gas), smaller purchases go to this
   * one and the rest to the other, so nothing is counted twice.
   */
  envelopeUnder?: Cents;
  /** Older saves: true meant a month envelope. `tidy()` turns it into `envelope`; don't use it. */
  monthEnvelope?: boolean;
  /** Older saves: the span that went with `monthEnvelope`. `tidy()` turns it into `envelope`; don't use it. */
  envelopeSpan?: EnvelopeSpan;
}

export type EnvelopeSpan = 'week' | 'fortnight' | 'month';

/** How much of each pay is sent to each account on payday. */
export interface SplitLine {
  accountId: string;
  /** Fixed amount sent each payday (ignored when `auto` is on). */
  amount: Cents;
  /** Older saves: true meant 'exact'. Use `mode` instead. */
  auto?: boolean;
  /**
   * fixed: Set amount — you choose the figure
   * smooth: Level amount — same every payday; 4-week pays buffer the 5th week
   * exact: This pay's costs — sends exactly what this period needs
   */
  mode?: PaydayMode;
}

export type PaydayMode = 'fixed' | 'exact' | 'smooth';

export interface BalanceEntry {
  amount: Cents;
  /** The day you checked the balance. */
  asOf: ISODate;
}

/** Something that happened to an account's money, kept as its history. */
export interface AccountEvent {
  id: string;
  date: ISODate;
  /**
   * cost: money spent from the account outside the plan (a tyre puncture), taken off its balance when recorded.
   * balance: the balance you entered from your banking app.
   */
  kind: 'cost' | 'balance';
  amount: Cents;
  /** What a cost was. */
  note?: string;
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
  /** Plans already taken from the card's own transactions (purchase date|amount), so one paid off isn't added again. */
  cardPlans?: string[];
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
  /**
   * KiwiSaver: taken from pay automatically and locked in, so payday sends it nothing and nothing is
   * added or taken out by hand. Unset: worked out from the name.
   */
  kiwisaver?: boolean;
  /** The funds it's invested in, in the order they're shown (each keeps its colour). */
  funds?: { name: string; color: string }[];
  /** Its balance over time (and each fund's), oldest first, one per day. */
  readings?: KiwiReading[];
  /**
   * Money moved in or out seen in a linked bank account (ANZ → Kernel, or a Kernel withdrawal back),
   * oldest first. One after the balance was last updated is added to it.
   */
  bankMoves?: GoalBankMove[];
  /** The balance the bank connection last sent for it, and the day the bank had it as at. */
  bankBalance?: BalanceEntry;
}

export interface GoalBankMove {
  date: ISODate;
  /** + paid in, − taken out. */
  amount: Cents;
  /** The bank account it left or went to. */
  from: string;
  /** How much of it was added to the balance (0 when the balance was updated after it, so already had it). */
  counted: Cents;
}

/** A KiwiSaver balance on a day: from the bank connection, a statement, or typed in. */
export interface KiwiReading {
  date: ISODate;
  balance: Cents;
  /** Each fund's value, by fund name. */
  funds?: Record<string, Cents>;
  /** From a statement: what went in and what it earned from `since` to this date. */
  statement?: KiwiStatement;
}

export interface KiwiStatement {
  since: ISODate;
  employee?: Cents;
  employer?: Cents;
  government?: Cents;
  voluntary?: Cents;
  withdrawals?: Cents;
  /** Investment earnings or losses before tax (negative for a loss). */
  earnings?: Cents;
  /** PIE tax taken (as a positive amount). */
  tax?: Cents;
  /** Returns after tax, when that's all it shows (e.g. "Returns (all time)"). */
  returns?: Cents;
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
  /** Bank accounts' transactions, from CSV exports, by account id, oldest first. */
  accountTransactions?: Record<string, Txn[]>;
  /** Bank accounts' transactions not settled yet (today's card purchases), by account id: replaced on every sync, never kept. */
  pendingTransactions?: Record<string, Txn[]>;
  /** Bank connection (Akahu): which of your accounts or cards each bank account's transactions go to ('account:id', 'debt:id', or 'ignore'). */
  bankLinks?: Record<string, string>;
  /** When each linked account, card or goal ('account:id', 'debt:id', 'saving:id') last came through a bank sync (ISO time). */
  bankSeen?: Record<string, string>;
  /** Bank connection updates (transactions and balances) automatically; false = manual mode. On unless turned off. */
  bankAuto?: boolean;
  /** Gemini's guesses for shops the app's own rules put in Other (by shop name in lower case). Your own choices win. */
  shopGuesses?: Record<string, string>;
  /** Spending categories you've chosen for shops (by shop name in lower case), over the app's own guess. */
  shopCategories?: Record<string, string>;
  /**
   * Transfers out of an envelope's account that you said were spending (bought food on another card, then
   * moved $50 over to cover it): `envelope.ts` → `transferKey` → the envelope cost's id, or '' for "not
   * envelope spending". Counted against that envelope like a purchase.
   */
  envelopeTransfers?: Record<string, string>;
  /**
   * Your answers to the bill check (Accounts, after a bank sync), by `engine/billMatch.ts` → `checkKey`,
   * with the day you answered: `move|item|date` (paid on another account's card, but no need to move
   * money back), `paid|item|date` (paid, though the bank doesn't show it), `day|item|19` / `amount|item|cents`
   * (a suggested change you said no to).
   */
  billChecks?: Record<string, ISODate>;
  /** This month's insights: one per pay cycle, by its payday (see review.ts), newest first. */
  reviews?: Record<ISODate, import('../features/insights/logic/review').MonthlyReview>;
  /** Account balances you've entered, by account id. */
  balances?: Record<string, BalanceEntry>;
  /** Each account's history (balances entered, one-off costs), by account id, in the order they were recorded. */
  accountHistory?: Record<string, AccountEvent[]>;
  /** One-pay adjustments: pay period start → account id → amount sent that pay instead of the usual. */
  overrides?: Record<ISODate, Record<string, Cents>>;
  /**
   * What payday actually sent to each account once that pay is locked (payslip in, or payday has
   * passed). The Planner keeps these figures for that cycle so later debt/cost changes don’t rewrite
   * the split you already made. Future pays still recalculate.
   */
  splitSent?: Record<ISODate, Record<string, Cents>>;
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
