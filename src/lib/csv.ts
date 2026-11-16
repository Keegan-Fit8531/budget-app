import { toISO, type ISODate } from './dates';
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
  const negative = /^-|^\$-|^\(.*\)$|\bDR$/i.test(t) || /^−/.test(t);
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
  const payments = ordered.filter((t) => /payment|thank you/i.test(t.description));
  const card = (number >= 0 && /card/.test(head[number]))
    || (payments.length > 0 && head.every((h) => !/balance/.test(h)) && payments.every((t) => !/transfer|direct debit|automatic payment/i.test(t.description)));
  if (card && payments.length && payments.filter((t) => t.amount < 0).length > payments.length / 2) for (const t of ordered) t.amount = -t.amount;

  // An account number above the column names (bank exports), or the card number column.
  let ending = [...numbers.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  if (!ending) {
    const above = all.slice(0, hi).flat().join(' ');
    // NZ account numbers are bank-branch-account-suffix (12-3456-0654321-00): the account part's end.
    const nz = /\b\d{2}-\d{4}-(\d{7})-\d{2,3}\b/.exec(above);
    const bare = /\b\d{6,}\b/.exec(above);
    if (nz) ending = nz[1].slice(-4); else if (bare) ending = bare[0].slice(-4);
  }
  return { rows: ordered, ...(ending ? { ending } : {}), card, skipped };
}
