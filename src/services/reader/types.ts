import type { CsvRead } from '../bank/csv';
import type { ISODate } from '../../core/dates';

// ---------------------------------------------------------------------------------------------
// What a reader (Google's Gemini, or the one on this device) fills in from a document. This is a
// fixed form: amounts are text exactly as printed and dates are YYYY-MM-DD. Nothing here changes
// the budget; the app checks every field (check/) and applies it itself (apply.ts).
// ---------------------------------------------------------------------------------------------

/** `transactions` is a bank or card export (CSV), read on this device. */
export type DocKind = 'payslip' | 'statement' | 'afterpay' | 'kiwisaver' | 'transactions' | 'balances' | 'unknown';

/** A figure as printed, e.g. { amount: "1240.50", label: "Closing balance" }. */
export interface Fig { amount: string; label?: string }

export interface RawPayslip {
  payDay?: string;
  net?: Fig;
  gross?: Fig;
  taxableGross?: Fig;
  paye?: Fig;
  studentLoan?: Fig;
  kiwisaver?: Fig;
  employerKiwisaver?: Fig;
}

export interface RawStatement {
  debtId?: string | null;
  nameOnDocument?: string;
  /** A screenshot of the card's app (what's owed now, recent purchases), not a statement. */
  appScreen?: boolean;
  balance?: Fig;
  /** Available credit, when shown. */
  available?: Fig;
  inCredit?: boolean;
  statementDate?: string;
  limit?: Fig;
  minimum?: Fig;
  /** What to pay to avoid interest, as printed. */
  avoidInterest?: Fig;
  /** The payment due date, as printed. */
  dueDate?: string;
  /** Plans shown on the statement or My plans screen (Gem interest-free / equal-payment plans), matched by id or expiry. */
  plans?: {
    planId?: string | null;
    description?: string;
    remaining?: Fig;
    ends?: string;
    /** Total plan length in months when shown (6, 12, 24, 36, 60). */
    months?: number | null;
    /** Months still left, as printed (e.g. "8 of 12 months remaining" → 8). */
    monthsLeft?: number | null;
    /** interest-free (any payments) or equal (fixed monthly instalments). */
    type?: 'interest-free' | 'equal' | null;
  }[];
  /**
   * Purchases listed on a card app screen, including pending ones. They're inside its balance, so
   * they're never added to what's owed again; a Gem one of $250 or more becomes a 6-month plan.
   */
  purchases?: { date?: string; description?: string; amount?: Fig; pending?: boolean | null }[];
  /** Payments listed on the statement. They're counted automatically on their due dates, so they're ignored. */
  paymentsShown?: { date?: string; amount?: Fig }[];
}

export interface RawAfterpay {
  /**
   * True for Afterpay’s “Upcoming payments” screen (or any list of everything still due): orders not
   * on it are treated as paid off. False for a single order or a partial list of orders.
   */
  listsAllDue?: boolean | null;
  orders?: {
    planId?: string | null;
    merchant?: string;
    purchaseDate?: string;
    total?: Fig;
    instalments?: { date?: string; amount?: string; label?: string; paid?: boolean }[];
  }[];
}

/** A KiwiSaver statement, breakdown or app screen. */
export interface RawKiwiSaver {
  provider?: string;
  /** The day the balance is as at (the closing date). */
  date?: string;
  /** The start of the period it covers (the opening value's date). */
  since?: string;
  balance?: Fig;
  opening?: Fig;
  employee?: Fig;
  employer?: Fig;
  government?: Fig;
  voluntary?: Fig;
  withdrawals?: Fig;
  earnings?: Fig;
  tax?: Fig;
  returns?: Fig;
  funds?: { name?: string; amount?: Fig }[];
}

/** A bank's list of accounts, each with its balance (internet banking's "Current and savings", say). */
export interface RawBalances {
  bank?: string;
  /** The day the balances are as at, if shown. */
  asOf?: string;
  accounts?: { name?: string; number?: string; balance?: Fig; available?: Fig }[];
}

export interface Extraction {
  kind: DocKind;
  payslip?: RawPayslip;
  statement?: RawStatement;
  afterpay?: RawAfterpay;
  kiwisaver?: RawKiwiSaver;
  balances?: RawBalances;
  transactions?: CsvRead;
  notes?: string;
}

export type ReaderSource = 'gemini' | 'device';

/** What the reader is told about the budget: debt and plan names and ids only. */
export interface ReadContext {
  today: ISODate;
  debts: {
    id: string;
    name: string;
    kind: string;
    rules?: string;
    neverAStatement?: true;
    /** The student loan: IRD's loan balance is its statement. */
    studentLoan?: true;
    /** Afterpay orders also carry their amounts and dates; card plans only their name (see buildContext). */
    plans: { id: string; name: string; type: string; remaining?: string; purchaseDate?: ISODate; total?: string; nextInstalment?: { date: ISODate; amount: string } }[];
  }[];
}

/** A file ready to send: shrunk and turned into base64. */
export interface PreparedFile { name: string; mimeType: string; base64: string; bytes: number }

export interface ProviderOptions { key: string; model: string; signal?: AbortSignal }

/** A document reader that could be swapped for another provider. */
export interface Provider {
  id: string;
  read(file: PreparedFile, ctx: ReadContext, opts: ProviderOptions): Promise<Extraction>;
  /** A long PDF as its pages' text, read a few pages at a time; `onPart` says how many parts are done. */
  readText?(pages: string[], ctx: ReadContext, opts: ProviderOptions, onPart?: (done: number, total: number) => void): Promise<Extraction>;
  /** A tiny request with no document, to check the key, the model and the credit. */
  test(opts: ProviderOptions): Promise<void>;
}
