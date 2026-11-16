import { addDays as addDaysISO, toISO, type ISODate } from './dates';
import type { Cents, Txn } from './types';

// ---------------------------------------------------------------------------------------------
// Reading a bank or card export (CSV) on this device: nothing is sent anywhere. Banks lay these out
// differently (some put account details above the column names, some split money in and out into
// two columns), so the columns are found by their names: a date, a description and an amount, and
// a balance and a card or account number if there are any.
// ---------------------------------------------------------------------------------------------

export interface CsvRead {
  /** Oldest first; + is money in (or paid off a card), − is money out. */
  rows: (Txn & { balance?: Cents })[];
  /** The end of the card or account number in the file, to match it next time. */
  ending?: string;
  /** It looks like a credit card export (a card number column, or payments received). */
  card: boolean;
  /** Rows with no amount or no readable date. */
  skipped: number;
  /** Statement transactions whose printed balance doesn't add up with the one before (misread, or one missed before it). */
  unsure?: number;
}

/** Split CSV text into rows of cells (quotes, commas and line breaks inside quotes handled). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const t = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A date as NZ exports write it (day first): 15/11/26, 15/11/2026, 2026-11-15, 15 Nov 2026, 15-Nov-26. */
export function csvDate(s: string): ISODate | undefined {
  const t = s.trim();
  let y: number, m: number, d: number;
  let x = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(t);
  if (x) { y = +x[1]; m = +x[2]; d = +x[3]; } else if ((x = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/.exec(t))) {
    d = +x[1]; m = +x[2]; y = +x[3];
  } else if ((x = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{2}|\d{4})\b/.exec(t))) {
    d = +x[1]; m = MONTHS.indexOf(x[2].toLowerCase()) + 1; y = +x[3];
  } else return undefined;
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return undefined;
  const iso = toISO(new Date(Date.UTC(y, m - 1, d)));
  return iso.endsWith(`-${String(d).padStart(2, '0')}`) ? iso : undefined;
}

/** An amount as exports write it: -$44.60, $1,240.50, (12.40), 12.40 DR. Undefined if it isn't one. */
export function csvAmount(s: string): Cents | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const negative = /^-|^\$-|^\(.*\)$|\bDR$|-$/i.test(t) || /^−|−$/.test(t);
  const clean = t.replace(/NZD|DR|CR|[$,\s()−+-]/gi, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return undefined;
  const cents = Math.round(parseFloat(clean) * 100);
  return negative ? -cents : cents;
}

const find = (head: string[], ...tests: RegExp[]) => {
  for (const re of tests) { const i = head.findIndex((h) => re.test(h)); if (i >= 0) return i; }
  return -1;
};

/** Read a bank or card export. Undefined if no date and amount columns can be found. */
export function readTransactionsCsv(text: string): CsvRead | undefined {
  const all = parseCsv(text);
  // The column names: the first row (of the first 20) with a date column and an amount column.
  const hi = all.slice(0, 20).findIndex((r) => r.some((c) => /date/i.test(c)) && r.some((c) => /amount|debit|credit|withdrawal|deposit/i.test(c)));
  if (hi < 0) return undefined;
  const head = all[hi].map((h) => h.toLowerCase());
  const date = find(head, /^(transaction )?date$/, /^date/, /date/);
  const amount = find(head, /^amount$/, /^amount(?!.*(foreign|credit|debit))/);
  const debit = find(head, /debit|withdrawal|paid out|money out/);
  const credit = find(head, /credit|deposit|paid in|money in/);
  const balance = find(head, /^balance$/, /balance/);
  const number = find(head, /card( number| no)?$/, /^account( number| no)?$/, /card|account/);
  const texts = [/^description$/, /details/, /payee|other party|merchant/, /memo|narrative/, /^type$|tran type/, /particulars/, /reference/]
    .map((re) => head.findIndex((h, i) => re.test(h) && i !== date && i !== amount && i !== number))
    .filter((i, k, list) => i >= 0 && list.indexOf(i) === k);
  if (date < 0 || (amount < 0 && debit < 0 && credit < 0)) return undefined;

  const read: { t: CsvRead['rows'][number]; order: number }[] = [];
  let skipped = 0;
  const numbers = new Map<string, number>();
  all.slice(hi + 1).forEach((r, order) => {
    const d = csvDate(r[date] ?? '');
    let a = amount >= 0 ? csvAmount(r[amount] ?? '') : undefined;
    if (a === undefined && (debit >= 0 || credit >= 0)) {
      const out = debit >= 0 ? csvAmount(r[debit] ?? '') : undefined;
      const inn = credit >= 0 ? csvAmount(r[credit] ?? '') : undefined;
      if (out !== undefined || inn !== undefined) a = (inn ? Math.abs(inn) : 0) - (out ? Math.abs(out) : 0);
    }
    if (!d || !a) { skipped++; return; }
    // The first text columns that have something in them, e.g. "Payee · Particulars".
    const words = texts.map((i) => r[i] ?? '').filter(Boolean);
    const description = [...new Set(words)].slice(0, 2).join(' · ').replace(/\s{2,}/g, ' ').trim() || 'Transaction';
    const bal = balance >= 0 ? csvAmount(r[balance] ?? '') : undefined;
    read.push({ t: { date: d, description, amount: a, ...(bal !== undefined ? { balance: bal } : {}) }, order });
    const n = number >= 0 ? (r[number] ?? '').replace(/\D/g, '') : '';
    if (n.length >= 4) numbers.set(n.slice(-4), (numbers.get(n.slice(-4)) ?? 0) + 1);
  });
  if (!read.length) return undefined;

  // Exports list newest first or oldest first; within a day keep the file's own order (oldest first).
  const newestFirst = read.length > 1 && read[0].t.date > read[read.length - 1].t.date;
  const ordered = read
    .sort((x, y) => x.t.date.localeCompare(y.t.date) || (newestFirst ? y.order - x.order : x.order - y.order))
    .map((x) => x.t);

  // A card export: payments in are "Payment received"/"Thank you". If those are the negative ones,
  // this export writes spending as + and payments as −, so turn it round.
  // Only a card's own "Payment received - thank you": a bank export's "Bill payment" is money going out.
  const payments = ordered.filter((t) => /payment received|thank you/i.test(t.description));
  const card = (number >= 0 && /card/.test(head[number]))
    || (payments.length > 0 && head.every((h) => !/balance/.test(h)) && payments.every((t) => !/transfer|direct debit|automatic payment/i.test(t.description)));
  if (card && payments.length && payments.filter((t) => t.amount < 0).length > payments.length / 2) for (const t of ordered) t.amount = -t.amount;

  // An account number above the column names (bank exports), or the card number column.
  const ending = [...numbers.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? endingOf(all.slice(0, hi).flat().join(' '));
  return { rows: ordered, ...(ending ? { ending } : {}), card, skipped };
}

/**
 * The end of an account or card number in some text (a file name, the lines above an export's columns).
 * NZ account numbers are bank-branch-account-suffix (12-3456-0654321-00): the account part's end.
 */
export function endingOf(text: string): string | undefined {
  const nz = /\b\d{2}-\d{4}-(\d{7})-\d{2,3}\b/.exec(text);
  if (nz) return nz[1].slice(-4);
  const bare = /\b\d{6,}\b/.exec(text);
  return bare ? bare[0].slice(-4) : undefined;
}

/**
 * Transactions Gemini read from a bank statement, in the same form as an export's: dates checked
 * (a date that would be after today, from a statement printed without years, is last year's), amounts
 * as cents, oldest first. The closing balance goes on the last transaction if it has none.
 */
export function fromStatementRows(
  rows: { date?: string; description?: string; amount?: string; balance?: string }[],
  opts: { today: ISODate; number?: string; closing?: { amount?: string; date?: string } },
): CsvRead {
  let skipped = 0;
  let unsure = 0;
  const out: CsvRead['rows'] = [];
  // The balance before each transaction, in the order printed: if a transaction's own balance only adds
  // up with its amount the other way round, the sign was misread (money in taken for money out).
  let before: Cents | undefined;
  let lastDate: ISODate | undefined;
  for (const r of rows) {
    let date = csvDate(r.date ?? '');
    let amount = csvAmount(r.amount ?? '');
    const balance = csvAmount(r.balance ?? '');
    // Balances and totals printed between the transactions aren't transactions (Gemini sometimes lists them).
    if (/opening balance|closing balance|brought forward|carried forward|totals? (at|for)|^balance$/i.test(r.description ?? '')) {
      skipped++;
      before = balance ?? (amount !== undefined ? Math.abs(amount) : before);
      continue;
    }
    if (!date || !amount) { skipped++; continue; }
    if (date > opts.today) date = `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
    // A statement is printed in date order: a date before the one above it was misread (a day or month).
    if (lastDate && date < lastDate && date < addDaysISO(lastDate, -3)) { date = lastDate; unsure++; }
    lastDate = date;
    if (before !== undefined && balance !== undefined && Math.abs(before + amount - balance) > 1) {
      if (Math.abs(before - amount - balance) <= 1) amount = -amount;
      else unsure++;
    }
    if (balance !== undefined) before = balance;
    out.push({ date, description: (r.description ?? '').replace(/\s{2,}/g, ' ').trim() || 'Transaction', amount, ...(balance !== undefined ? { balance } : {}) });
  }
  const ordered = out.map((t, i) => ({ t, i })).sort((a, b) => a.t.date.localeCompare(b.t.date) || a.i - b.i).map((x) => x.t);
  const last = ordered[ordered.length - 1];
  const closing = csvAmount(opts.closing?.amount ?? '');
  const closingDate = csvDate(opts.closing?.date ?? '');
  if (last && last.balance === undefined && closing !== undefined && closingDate && closingDate >= last.date) last.balance = closing;
  const ending = opts.number ? endingOf(opts.number) ?? (opts.number.replace(/\D/g, '').slice(-4) || undefined) : undefined;
  return { rows: ordered, ...(ending ? { ending } : {}), card: false, skipped, ...(unsure ? { unsure } : {}) };
}

/** Several reads of one long document (a few pages each), as one. */
export function joinReads(reads: CsvRead[]): CsvRead {
  return {
    rows: reads.flatMap((r) => r.rows).map((t, i) => ({ t, i })).sort((a, b) => a.t.date.localeCompare(b.t.date) || a.i - b.i).map((x) => x.t),
    ...(reads.find((r) => r.ending) ? { ending: reads.find((r) => r.ending)!.ending } : {}),
    card: reads.some((r) => r.card),
    skipped: reads.reduce((t, r) => t + r.skipped, 0),
    ...(reads.some((r) => r.unsure) ? { unsure: reads.reduce((t, r) => t + (r.unsure ?? 0), 0) } : {}),
  };
}
