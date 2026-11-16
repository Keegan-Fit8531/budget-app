import type { ISODate } from '../dates';

// ---------------------------------------------------------------------------------------------
// What a reader (Google's Gemini, or the one on this device) fills in from a document. This is a
// fixed form: amounts are text exactly as printed and dates are YYYY-MM-DD. Nothing here changes
// the budget; the app checks every field (check.ts) and applies it itself (apply.ts).
// ---------------------------------------------------------------------------------------------

export type DocKind = 'payslip' | 'statement' | 'afterpay' | 'unknown';

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
  balance?: Fig;
  inCredit?: boolean;
  statementDate?: string;
  limit?: Fig;
  minimum?: Fig;
  /** Plans shown on the statement (Gem's interest-free plans), matched to the debt's plans by id. */
  plans?: { planId?: string | null; description?: string; remaining?: Fig; ends?: string }[];
  /** Purchases listed on the statement. They're inside its balance, so they're never added again. */
  purchases?: { date?: string; description?: string; amount?: Fig }[];
  /** Payments listed on the statement. They're counted automatically on their due dates, so they're ignored. */
  paymentsShown?: { date?: string; amount?: Fig }[];
}

export interface RawAfterpay {
  orders?: {
    planId?: string | null;
    merchant?: string;
    purchaseDate?: string;
    total?: Fig;
    instalments?: { date?: string; amount?: string; label?: string; paid?: boolean }[];
  }[];
}

export interface Extraction {
  kind: DocKind;
  payslip?: RawPayslip;
  statement?: RawStatement;
  afterpay?: RawAfterpay;
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
    plans: { id: string; name: string; type: string; remaining: string; ends?: ISODate; purchaseDate?: ISODate; total?: string; nextInstalment?: { date: ISODate; amount: string } }[];
  }[];
}

/** A file ready to send: shrunk and turned into base64. */
export interface PreparedFile { name: string; mimeType: string; base64: string; bytes: number }

export interface ProviderOptions { key: string; model: string; signal?: AbortSignal }

/** A document reader that could be swapped for another provider. */
export interface Provider {
  id: string;
  read(file: PreparedFile, ctx: ReadContext, opts: ProviderOptions): Promise<Extraction>;
  /** A tiny request with no document, to check the key, the model and the credit. */
  test(opts: ProviderOptions): Promise<void>;
}
