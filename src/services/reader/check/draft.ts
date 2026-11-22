import { type ISODate } from '../../../core/dates';
import type { Payslip } from '../payslip';
import type { CsvRead } from '../../bank/csv';
import type { BalanceEntry, Cents, DebtPlan, KiwiReading, StatementDue, Txn } from '../../../core/types';
import type { DocKind, ReaderSource } from '../types';

// ---------------------------------------------------------------------------------------------
// Checking what was read. The reader's answer becomes a draft you can correct in the rundown; every
// field of the draft is checked in this folder, and only a draft with no blocking problems becomes a
// Proposal: the exact, typed changes ../apply.ts makes. Nothing in this folder changes the budget.
// ---------------------------------------------------------------------------------------------

export const NEW_DEBT = '__new';
/** Chosen in the rundown: a new KiwiSaver goal for this statement. */
export const NEW_GOAL = '__newgoal';
/** Chosen in the rundown: this plan or order isn't one of yours (so it's never matched automatically). */
export const NOT_MINE = '__none';
/** The most any single figure can be: $1,000,000. */
export const MAX_CENTS = 100_000_000;
/** How far a statement's plan expiry can be from one of yours and still be the same plan. */
export const ENDS_SLACK_DAYS = 5;

export interface DraftFig { value: string; label?: string }

export interface DraftPlanRow {
  planId: string; description: string; remaining: DraftFig; ends: string; addAsNew: boolean; newId: string;
  /** Total months when shown (Gem 6/12/24/36/60). */
  months?: number;
  /** Months still left (Gem “X of Y months remaining”). */
  monthsLeft?: number;
  type?: 'interest-free' | 'equal';
}
export interface DraftOrder {
  planId: string;
  merchant: string;
  purchaseDate: string;
  total: DraftFig;
  newId: string;
  instalments: { date: string; amount: string; label?: string; paid: boolean }[];
}

/** A purchase listed on a card app screen. `add` is null until you tick or untick it (then the default applies). */
export interface DraftPurchase { date: string; description: string; amount: string; add: boolean | null; newId: string }

export interface Draft {
  kind: DocKind;
  source: ReaderSource;
  notes?: string;
  payslip: Record<'net' | 'gross' | 'taxableGross' | 'paye' | 'studentLoan' | 'kiwisaver' | 'employerKiwisaver', DraftFig> & { payDay: string };
  statement: {
    debtId: string;
    newName: string;
    newDebtId: string;
    nameOnDocument: string;
    /** A screenshot of the card's app (current balance, recent purchases) rather than a statement. */
    appScreen: boolean;
    balance: DraftFig;
    /** Available credit, used for what's owed (limit less available) when the balance isn't shown. */
    available: DraftFig;
    inCredit: boolean;
    date: string;
    limit: DraftFig;
    minimum: DraftFig;
    avoidInterest: DraftFig;
    dueDate: string;
    plans: DraftPlanRow[];
    purchases: DraftPurchase[];
    payments: { date: string; amount: string }[];
  };
  afterpay: {
    debtId: string;
    /** Upcoming-payments style: everything still due is on this list; other orders are paid off. */
    listsAllDue: boolean;
    orders: DraftOrder[];
  };
  kiwisaver: DraftKiwiSaver;
  transactions: DraftTransactions;
  balances: DraftBalances;
}

/** A bank's list of accounts and their balances: each line, and which of your accounts it's for. */
export interface DraftBalances {
  bank: string;
  date: string;
  rows: DraftBalanceRow[];
  eventId: string;
}
export interface DraftBalanceRow {
  name: string;
  number: string;
  balance: string;
  available: string;
  /** Your account's id, or NOT_MINE to leave it out. */
  accountId: string;
  /** How it was matched: its number, or its name. Undefined when you chose. */
  matchedBy?: 'number' | 'name';
}

export type KiwiFigure = 'balance' | 'opening' | 'employee' | 'employer' | 'government' | 'voluntary' | 'withdrawals' | 'earnings' | 'tax' | 'returns';
/** A KiwiSaver statement or screen, as read: which goal it's for, its figures, and each fund's value. */
export type DraftKiwiSaver = Record<KiwiFigure, DraftFig> & {
  goalId: string;
  newGoalId: string;
  newAccountId: string;
  provider: string;
  date: string;
  since: string;
  funds: { name: string; value: string }[];
};

/** A bank or card export, as read: which card or account it's for, and what's owed or in it now. */
export interface DraftTransactions {
  /** 'debt:<id>' or 'account:<id>'; '' until you choose (a file doesn't say whose it is). */
  target: string;
  /** Chosen for you because this card or account number was used before. */
  matchedBy?: string;
  read: CsvRead;
  /** What's owed (a card) or in the account now. null until you change it: then the worked-out amount is used. */
  amount: string | null;
  eventId: string;
}

export interface PlanUpdate {
  planId: string; remaining: Cents; ends?: ISODate;
  months?: number; type?: 'interest-free' | 'equal';
}
export interface OrderUpdate { planId: string; instalments: { date: ISODate; amount: Cents; label?: string }[] }

export type Proposal =
  | { kind: 'payslip'; slip: Payslip }
  | { kind: 'statement'; debtId: string; newDebt?: { name: string }; balance: Cents; inCredit: boolean; date: ISODate; limit?: Cents; plans: PlanUpdate[]; newPlans: DebtPlan[]; due?: StatementDue }
  | { kind: 'afterpay'; debtId: string; updates: OrderUpdate[]; paidOff: string[]; newPlans: DebtPlan[] }
  | { kind: 'kiwisaver'; goalId: string; newGoal?: { accountId: string; note?: string }; readings: KiwiReading[] }
  | { kind: 'balances'; asOf: ISODate; set: { accountId: string; amount: Cents; number?: string }[]; eventId: string }
  | {
    kind: 'transactions'; target: { type: 'debt' | 'account'; id: string }; ending?: string; add: Txn[];
    /** What's owed or in the account, as at a date, if it changes. */
    balance?: BalanceEntry;
    /** Owed-over-time entries worked out from the transactions (a card). */
    history: BalanceEntry[];
    eventId: string;
  };

export interface Issue { level: 'block' | 'note'; text: string }
export interface Review { proposal: Proposal | null; issues: Issue[]; ignored: string[] }
