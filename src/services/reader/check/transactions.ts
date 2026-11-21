import { fmtShort, type ISODate } from '../../../core/dates';
import { cash } from '../../../core/money';
import type { BalanceEntry, Budget, Cents, Debt, Txn } from '../../../core/types';
import { toCents, ordersOnly } from './figures';
import type { Draft, Issue, Review } from './draft';

// ---------- Bank and card exports ----------

/** The card or account that has this number's ending saved, if exactly one does. */
export function matchEnding(b: Budget, ending: string): string {
  const hits = [
    ...(b.debts ?? []).filter((d) => d.ending === ending && !d.payroll).map((d) => `debt:${d.id}`),
    ...b.accounts.filter((a) => a.ending === ending && !a.archived).map((a) => `account:${a.id}`),
  ];
  return hits.length === 1 ? hits[0] : '';
}

/**
 * What an export or account statement can be for: cards and loans (not ones paid from your salary, or
 * Afterpay), and your accounts: any of them, bank accounts first (an allowance account at another bank
 * may be set up as somewhere pay is sent), but not a card's own payment account (choose the card).
 */
export function csvTargets(b: Budget): { value: string; label: string; group: 'Cards and loans' | 'Accounts' }[] {
  const debtAccounts = new Set((b.debts ?? []).map((d) => d.accountId));
  return [
    ...(b.debts ?? []).filter((d) => !d.payroll && !ordersOnly(d)).map((d) => ({ value: `debt:${d.id}`, label: d.name, group: 'Cards and loans' as const })),
    ...b.accounts.filter((a) => !a.archived && !debtAccounts.has(a.id)).sort((x, y) => (x.kind === 'bank' ? 0 : 1) - (y.kind === 'bank' ? 0 : 1))
      .map((a) => ({ value: `account:${a.id}`, label: a.name, group: 'Accounts' as const })),
  ];
}

// Date, amount and the start of the description: a statement read again can word the rest differently.
const txKey = (t: Txn) => `${t.date}|${t.amount}|${t.description.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4)}`;

/** The transactions not saved already (an export overlapping one before). Same-day duplicates (4 car washes) count separately. */
export function newTransactions(existing: Txn[], incoming: Txn[]): Txn[] {
  const have = new Map<string, number>();
  for (const t of existing) have.set(txKey(t), (have.get(txKey(t)) ?? 0) + 1);
  return incoming.filter((t) => {
    const n = have.get(txKey(t)) ?? 0;
    if (n > 0) { have.set(txKey(t), n - 1); return false; }
    return true;
  });
}

function targetOf(d: Draft, b: Budget): { debt?: Debt; account?: Budget['accounts'][number]; id: string; type: 'debt' | 'account' | '' } {
  const [type, id = ''] = d.transactions.target.split(':') as ['debt' | 'account' | '', string?];
  if (type === 'debt') return { type, id, debt: (b.debts ?? []).find((x) => x.id === id) };
  if (type === 'account') return { type, id, account: b.accounts.find((x) => x.id === id) };
  return { type: '', id: '' };
}

/** The last balance you checked on a card: kept from a statement, screenshot, export or typing it in (or, before that was kept, the balance if no payments have been counted on it since). */
export function checkedBalance(debt: Debt): BalanceEntry | undefined {
  return debt.checked ?? (debt.paid?.length ? undefined : debt.balance);
}

/**
 * What's owed on the card (or in the account) after these transactions, worked out from the last
 * balance you checked: plus what was spent, less what was paid in since. The account's own balance
 * column is used when the export has one.
 */
export function csvBalance(d: Draft, b: Budget): { amount: Cents; asOf: ISODate; working: string } | undefined {
  const rows = d.transactions.read.rows;
  if (!rows.length) return undefined;
  const last = rows[rows.length - 1];
  const { debt, account } = targetOf(d, b);
  if (account && last.balance !== undefined) {
    // Not if you've entered a newer balance since.
    const entered = b.balances?.[account.id];
    return entered && entered.asOf > last.date ? undefined : { amount: last.balance, asOf: last.date, working: `The export’s balance after its last transaction, on ${fmtShort(last.date)}.` };
  }
  const anchor = debt ? checkedBalance(debt) : account ? b.balances?.[account.id] : undefined;
  if (!anchor || anchor.asOf >= last.date) return undefined;
  const since = rows.filter((t) => t.date > anchor.asOf);
  const out = since.filter((t) => t.amount < 0).reduce((t, x) => t - x.amount, 0);
  const inn = since.filter((t) => t.amount > 0).reduce((t, x) => t + x.amount, 0);
  const amount = debt ? anchor.amount + out - inn : anchor.amount - out + inn;
  return {
    amount, asOf: last.date,
    working: debt
      ? `${cash(anchor.amount)} owed on ${fmtShort(anchor.asOf)}, plus ${cash(out)} spent and less ${cash(inn)} paid since.`
      : `${cash(anchor.amount)} on ${fmtShort(anchor.asOf)}, plus ${cash(inn)} in and less ${cash(out)} out since.`,
  };
}

export function reviewTransactions(d: Draft, b: Budget, today: ISODate): Review {
  const issues: Issue[] = [];
  const ignored: string[] = [];
  const block = (text: string) => issues.push({ level: 'block', text });
  const note = (text: string) => issues.push({ level: 'note', text });
  const t = d.transactions;
  const rows = t.read.rows.map(({ date, description, amount }) => ({ date, description, amount }));
  if (!rows.length) return { proposal: null, ignored, issues: [{ level: 'block', text: 'No transactions were found in the file.' }] };
  const { type, id, debt, account } = targetOf(d, b);
  if (!type) return { proposal: null, ignored, issues: [{ level: 'block', text: `Choose which ${t.read.card ? 'card' : 'card or account'} this is for: the file doesn’t say.` }] };
  if (!debt && !account) return { proposal: null, ignored, issues: [{ level: 'block', text: 'Choose which card or account this is for.' }] };
  const name = (debt ?? account)!.name;
  if (debt && !t.read.card) note(`This looks like a bank account’s export, not a card’s. Check it’s ${name}.`);
  if (account && t.read.card) note(`This looks like a credit card’s export. Check it’s ${name}.`);

  const existing = debt ? debt.transactions ?? [] : b.accountTransactions?.[id] ?? [];
  const add = newTransactions(existing, rows);
  const dup = rows.length - add.length;
  if (dup) ignored.push(`${dup} transaction${dup === 1 ? '' : 's'} already saved: not added again.`);
  if (t.read.skipped) ignored.push(`${t.read.skipped} row${t.read.skipped === 1 ? '' : 's'} with no amount: left out.`);
  if (t.read.unsure) note(`${t.read.unsure === 1 ? 'One transaction doesn’t' : `${t.read.unsure} transactions don’t`} add up with the balance printed after ${t.read.unsure === 1 ? 'it' : 'them'}: ${t.read.unsure === 1 ? 'it' : 'they'} may have been misread, or one before ${t.read.unsure === 1 ? 'it' : 'them'} missed. Check against the statement.`);

  // What's owed or in the account now: the worked-out amount, or what you typed.
  const suggested = csvBalance(d, b);
  let balance: BalanceEntry | undefined;
  if (t.amount === null) {
    if (suggested) balance = { amount: debt ? Math.max(0, suggested.amount) : suggested.amount, asOf: suggested.asOf };
    else if (debt) note(`What’s owed on ${name} isn’t changed: there’s no checked balance from before these transactions to add them to. Type what your app says you owe now, or upload a statement or screenshot.`);
  } else if (t.amount.trim()) {
    const c = toCents(t.amount);
    if (!c) block(`Check the amount ${debt ? 'owed' : 'in the account'}: it should look like 1,240.50.`);
    else balance = { amount: debt ? (c.credit ? 0 : c.cents) : c.credit ? -c.cents : c.cents, asOf: today };
  }
  if (debt && suggested && suggested.amount < 0 && t.amount === null) note(`That works out as ${cash(-suggested.amount)} in credit, so nothing is owed. Check it against your app.`);
  if (!add.length && !balance) block('Nothing new: every transaction in the file is already saved.');

  // A card's owed-over-time history, worked out from the transactions.
  const history: BalanceEntry[] = [];
  if (debt) {
    const net = (from: ISODate, to: ISODate) => rows.filter((r) => r.date > from && r.date <= to).reduce((x, r) => x - r.amount, 0);
    const days = [...new Set(rows.map((r) => r.date))];
    const known = [...(debt.history ?? []), ...(debt.balance ? [debt.balance] : [])].sort((x, y) => x.asOf.localeCompare(y.asOf));
    const first = known[0];
    // Before the first amount the app knew: worked back from it.
    if (first) for (const day of days) if (day < first.asOf) history.push({ asOf: day, amount: Math.max(0, first.amount - net(day, first.asOf)) });
    // Between the checked balance and the export's last day: worked forward from it (replacing estimates).
    const anchor = checkedBalance(debt);
    if (anchor && balance && t.amount === null) {
      for (const day of days) if (day > anchor.asOf && day < balance.asOf) history.push({ asOf: day, amount: Math.max(0, anchor.amount + net(anchor.asOf, day)) });
    }
  }

  if (issues.some((i) => i.level === 'block')) return { proposal: null, issues, ignored };
  return {
    proposal: { kind: 'transactions', target: { type: type as 'debt' | 'account', id }, ...(t.read.ending ? { ending: t.read.ending } : {}), add, ...(balance ? { balance } : {}), history, eventId: t.eventId },
    issues, ignored,
  };
}
