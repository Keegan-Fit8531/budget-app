import { applyPayrollDeduction, debtPerPay, owed, settleDue } from './debts';
import { todayISO, type ISODate } from './dates';
import { recordPayday } from './engine';
import { parsePayslipText, readPdfText, type Payslip } from './payslip';
import type { Budget, Cents, Debt } from './types';

// ---------------------------------------------------------------------------------------------
// Reading a document you add (a payslip, or a card / loan statement) as a PDF or a photo.
// Everything happens in the browser: the file never leaves your device.
// ---------------------------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const AMOUNT = '(-?)\\s*\\$?\\s*((?:\\d{1,3}(?:,\\d{3})+|\\d+)\\.\\d{2})(?:\\s*(CR|DR)\\b)?';

/** What a statement says, as far as it could be read. Amounts in cents. */
export interface Statement {
  /** What's owed (a balance in credit reads as 0). */
  balance?: Cents;
  /** The date the balance is as at (the statement's closing date). */
  date?: ISODate;
  limit?: Cents;
  available?: Cents;
  minimum?: Cents;
}

/** The first amount that follows one of `labels` (tried in order), within a short distance of it. */
function amountAfter(text: string, labels: string[]): Cents | undefined {
  for (const label of labels) {
    const m = text.match(new RegExp(`${label}[^\\d$-]{0,40}${AMOUNT}`, 'i'));
    if (!m) continue;
    const cents = Math.round(parseFloat(m[2].replace(/,/g, '')) * 100);
    // "CR" or a minus sign: the account is in credit, so nothing is owed.
    return m[1] === '-' || m[3]?.toUpperCase() === 'CR' ? 0 : cents;
  }
  return undefined;
}

function isoDate(y: number, m: number, d: number): ISODate | undefined {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A date written as 21 Oct 2026, 21 October 2026, October 21, 2026, 21/10/2026 or 21-10-26 (day first, as in NZ). */
export function parseDate(s: string): ISODate | undefined {
  let m = s.match(/(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4}|\d{2})\b/);
  if (m && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) return isoDate(Number(m[3]), MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, Number(m[1]));
  m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (m && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) return isoDate(Number(m[3]), MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, Number(m[2]));
  m = s.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/);
  if (m) return isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
  return undefined;
}

/** Pull the balance owed (and what else is useful) out of a card or loan statement's text. */
export function parseStatementText(raw: string): Statement {
  const text = raw.replace(/\s+/g, ' ');
  const out: Statement = {
    balance: amountAfter(text, [
      'closing balance', 'new balance', 'statement balance', 'total amount owing', 'total owing', 'amount owing',
      'balance owing', 'outstanding balance', 'total amount due', 'total owed', 'amount owed', 'current balance', 'account balance', 'total balance',
    ]),
    limit: amountAfter(text, ['credit limit']),
    available: amountAfter(text, ['available credit', 'available to spend', 'available balance', 'available funds']),
    minimum: amountAfter(text, ['minimum payment due', 'minimum amount due', 'minimum payment', 'minimum due']),
  };
  // No balance line, but a limit and what's available: owed is the difference.
  if (out.balance === undefined && out.limit !== undefined && out.available !== undefined) out.balance = Math.max(0, out.limit - out.available);
  for (const label of ['statement date', 'closing date', 'statement end(?:s|ing)?(?: date)?', 'statement period[^.]{0,40}?(?:to|-|–)', 'period ending', 'as at', 'as of']) {
    const m = text.match(new RegExp(`${label}[\\s:]{0,4}(.{0,24})`, 'i'));
    const d = m && parseDate(m[1]);
    if (d) { out.date = d; break; }
  }
  return out;
}

/** The debt a statement is most likely for: one whose name (or card type) appears in its text. */
export function matchDebt(debts: Debt[], raw: string): Debt | undefined {
  const text = raw.toLowerCase();
  const score = (d: Debt) => {
    let n = 0;
    if (text.includes(d.name.toLowerCase())) n += 10;
    for (const word of d.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !['card', 'visa', 'loan', 'the'].includes(w))) if (text.includes(word)) n += 3;
    if (d.rules === 'gem' && /\bgem\b/.test(text)) n += 3;
    if (d.rules === 'mastercard' && text.includes('mastercard')) n += 2;
    if ((d.rules === 'afterpay' || d.kind === 'bnpl') && text.includes('afterpay')) n += 3;
    return n;
  };
  const best = debts.filter((d) => !d.payroll).map((d) => ({ d, n: score(d) })).sort((x, y) => y.n - x.n)[0];
  return best && best.n > 0 ? best.d : undefined;
}

export type ReadDocument =
  | { kind: 'payslip'; payslip: Payslip; text: string }
  | { kind: 'statement'; statement: Statement; text: string };

/** Work out what a document's text is: a payslip if it reads as one, otherwise a statement. */
export function classifyText(text: string): ReadDocument {
  const payslip = parsePayslipText(text);
  return payslip ? { kind: 'payslip', payslip, text } : { kind: 'statement', statement: parseStatementText(text), text };
}

const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/** Text of a photo or screenshot, recognised on your device (the engine is served by the app itself). */
async function readImageText(file: File, onProgress?: (fraction: number) => void): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  const base = new URL(`${import.meta.env.BASE_URL}ocr/`, location.href).href;
  const worker = await createWorker('eng', 1, {
    workerPath: `${base}worker.min.js`, corePath: base.replace(/\/$/, ''), langPath: base.replace(/\/$/, ''),
    logger: (m: { status: string; progress: number }) => { if (m.status === 'recognizing text') onProgress?.(m.progress); },
  });
  try {
    return (await worker.recognize(file)).data.text;
  } finally {
    await worker.terminate();
  }
}

/** Read a PDF or image you've chosen and work out what it is. Throws if the file can't be read at all. */
export async function readDocument(file: File, onProgress?: (fraction: number) => void): Promise<ReadDocument> {
  let text = isPdf(file) ? await readPdfText(file) : '';
  // A scanned PDF has no text in it, and a photo never does: those are recognised from the picture.
  if (!isPdf(file)) text = await readImageText(file, onProgress);
  return classifyText(text);
}

/**
 * Record a payslip: the pay received, the payslip itself, and any student loan deduction. A pay day a
 * little off the usual payday moves that payday (see recordPayday). Returns the pay it went to.
 */
export function recordPayslip(b: Budget, slip: Payslip): { start: ISODate; loan: boolean } {
  const start = recordPayday(b, slip.payDay);
  b.payActuals[start] = slip.net;
  b.payslips = { ...(b.payslips ?? {}), [start]: slip };
  // The student loan comes out before pay: count the payslip's deduction against the loan.
  const loan = slip.studentLoan ? !!applyPayrollDeduction(b, start, slip.studentLoan) : false;
  return { start, loan };
}

/** Set what a debt owes from a statement (or typed in), as at a date, and note it in the debt's history. */
export function recordStatement(b: Budget, debtId: string, s: { balance: Cents; date?: ISODate; limit?: Cents }, today: ISODate = todayISO()): Debt | undefined {
  const debt = (b.debts ?? []).find((d) => d.id === debtId);
  if (!debt) return undefined;
  const asOf = s.date && s.date <= today ? s.date : today;
  debt.balance = { amount: s.balance, asOf };
  if (s.limit !== undefined && s.limit > 0) debt.limit = s.limit;
  const hist = (debt.history ?? []).filter((h) => h.asOf !== asOf);
  hist.push({ amount: owed(debt), asOf });
  debt.history = hist.sort((x, y) => x.asOf.localeCompare(y.asOf)).slice(-500);
  // An older statement: payments planned since its date count as paid, so today's figure is current.
  if (asOf < today) settleDue(debt, b.settings, today, debtPerPay(b, debt));
  return debt;
}
