import { addDays, fmtShort, type ISODate } from '../../../core/dates';
import type { Budget, Cents } from '../../../core/types';
import { numberKey } from '../../../engine/transfers';
import type { RawBalances } from '../types';
import { NOT_MINE, type Draft, type DraftBalances, type DraftBalanceRow, type Issue, type Review } from './draft';
import { toCents, validDate } from './figures';

// ---------- A list of bank accounts and their balances ----------

/** Your bank accounts a balance can be for (not cards' or people's payday accounts, or KiwiSaver-style funds). */
export function balanceTargets(b: Budget): Budget['accounts'] {
  const debtAccounts = new Set((b.debts ?? []).map((d) => d.accountId));
  return b.accounts.filter((a) => !a.archived && a.kind === 'bank' && !debtAccounts.has(a.id));
}

/** A name as words, so "Food / Gas" and "Food and gas", or "Misc Saving" and "Misc savings", are the same. */
const nameWords = (s: string) => s.toLowerCase().replace(/&|\+|\//g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
  .filter((w) => w && w !== 'and' && w !== 'account' && w !== 'the').map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));

/** Your account with this number, or else the only one whose name matches, never one already taken. */
export function matchAccount(accounts: Budget['accounts'], row: { name?: string; number?: string }, taken: Set<string>): { id: string; by: 'number' | 'name' } | undefined {
  const key = row.number ? numberKey(row.number) : undefined;
  const byNumber = key ? accounts.find((a) => a.number && numberKey(a.number) === key && !taken.has(a.id)) : undefined;
  if (byNumber) return { id: byNumber.id, by: 'number' };
  // A number of yours on another account means it's that one (archived, say): don't guess by name.
  if (key && accounts.some((a) => a.number && numberKey(a.number) === key)) return undefined;
  const words = nameWords(row.name ?? '');
  if (!words.length) return undefined;
  const same = (a: Budget['accounts'][number]) => { const w = nameWords(a.name); return w.length === words.length && w.every((x) => words.includes(x)); };
  const hits = accounts.filter((a) => !taken.has(a.id) && same(a));
  return hits.length === 1 ? { id: hits[0].id, by: 'name' } : undefined;
}

export function balancesDraft(raw: RawBalances | undefined, b: Budget, makeId: () => string, today: ISODate): DraftBalances {
  const accounts = balanceTargets(b);
  const taken = new Set<string>();
  const rows = (raw?.accounts ?? []).map((r): DraftBalanceRow => {
    const m = matchAccount(accounts, r, taken);
    if (m) taken.add(m.id);
    return {
      name: r.name ?? '', number: r.number ?? '', balance: r.balance?.amount ?? '', available: r.available?.amount ?? '',
      accountId: m?.id ?? '', ...(m ? { matchedBy: m.by } : {}),
    };
  });
  // A screen of balances shows them now, so with no date on it, they're today's.
  return { bank: raw?.bank ?? '', date: raw?.asOf ?? today, rows, eventId: makeId() };
}

export function reviewBalances(d: Draft, b: Budget, today: ISODate): Review {
  const issues: Issue[] = [];
  const block = (text: string) => issues.push({ level: 'block', text });
  const note = (text: string) => issues.push({ level: 'note', text });
  const t = d.balances;
  const ignored: string[] = [];
  if (!t.rows.length) return { proposal: null, ignored, issues: [{ level: 'block', text: 'No accounts were found on it.' }] };
  const date = validDate(t.date);
  if (!date) block(t.date.trim() ? `Check the date (${t.date}).` : 'Enter the date the balances are as at.');
  else if (date > addDays(today, 1)) block(`The date, ${fmtShort(date)}, is in the future. Check it.`);
  const accounts = balanceTargets(b);
  const set: { accountId: string; amount: Cents; number?: string }[] = [];
  const used = new Map<string, string>();
  for (const r of t.rows) {
    const label = r.name.trim() || r.number.trim() || 'An account';
    if (r.accountId === NOT_MINE) { ignored.push(`${label}: left out.`); continue; }
    const acc = accounts.find((a) => a.id === r.accountId);
    if (!acc) { block(`Choose which of your accounts ${label} is, or Not one of mine.`); continue; }
    if (used.has(acc.id)) { block(`${label} and ${used.get(acc.id)} are both set to ${acc.name}. Choose a different account for one of them.`); continue; }
    used.set(acc.id, label);
    // The balance is what's in it; "available" can include an overdraft, so it's only used without one.
    const c = toCents(r.balance.trim() ? r.balance : r.available);
    if (c === null) { block(`Check ${label}’s balance: it should look like 1,240.50.`); continue; }
    if (!c) { block(`Enter ${label}’s balance.`); continue; }
    const number = r.number.trim() && numberKey(r.number) && !acc.number ? r.number.trim() : undefined;
    set.push({ accountId: acc.id, amount: c.credit ? -c.cents : c.cents, ...(number ? { number } : {}) });
  }
  // Your accounts at the same bank that aren't on it (another page, maybe): said, so it's no surprise they didn't change.
  const banks = new Set(t.rows.map((r) => numberKey(r.number)?.split('-')[0]).filter(Boolean));
  const missing = accounts.filter((a) => !used.has(a.id) && a.number && banks.has(numberKey(a.number)?.split('-')[0]));
  if (missing.length) note(`Not on it, so not changed: ${missing.map((a) => a.name).join(', ')}.`);
  if (issues.some((i) => i.level === 'block') || !date || !set.length) {
    if (!set.length && !issues.some((i) => i.level === 'block')) block('Every account is left out, so there’s nothing to change.');
    return { proposal: null, issues, ignored };
  }
  return { proposal: { kind: 'balances', asOf: date <= today ? date : today, set, eventId: t.eventId }, issues, ignored };
}
