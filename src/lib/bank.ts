import { endingOf } from './csv';
import { addDays, todayISO, type ISODate } from './dates';
import { setBalance } from './history';
import { isKiwiSaver, recordReading } from './kiwisaver';
import { applyProposal } from './reader/apply';
import { newTransactions } from './reader/check';
import type { BankConfig } from './bankConfig';
import { nextColor } from './colors';
import { recordCardPayments, type SeenPayment } from './cardPayments';
import type { Budget, Txn } from './types';

// ---------------------------------------------------------------------------------------------
// Bank connection through Akahu (NZ open banking), read-only. The Akahu tokens live in a small server
// function you own (Supabase), never in this app or the browser; the app proves it's you with a
// passphrase kept in this browser only. New transactions are added to the account or card you've
// linked each bank account to, the same way an uploaded export's are.
// ---------------------------------------------------------------------------------------------

export { BANK_URL, readBankConfig, writeBankConfig, type BankConfig } from './bankConfig';

/** Synced automatically while the app is open, at most this often. */
export const AUTO_EVERY_MS = 60 * 60 * 1000;

export interface BankAccount {
  id: string; name: string; number: string | null; type: string; institution: string | null; balance: number | null; transactions: boolean;
  /** What can be spent now: the balance less pending payments (today's card purchases). From newer server functions only. */
  available?: number | null;
  /** When the bank last sent this account's balance. */
  updated?: string | null;
}
export interface BankTxn { account: string; id: string; date: ISODate; description: string; amount: number; balance: number | null; merchant: string | null; category?: string | null }
export interface BankPending { account: string; date: ISODate; description: string; amount: number; merchant: string | null }
export interface BankData { accounts: BankAccount[]; transactions: BankTxn[]; /** Not settled yet. */ pending?: BankPending[]; /** The bank sent newer balances after being asked to refresh. */ refreshed?: boolean }

export class BankError extends Error {
  kind: 'not_allowed' | 'not_set_up' | 'unreachable' | 'failed';
  constructor(kind: BankError['kind'], detail?: string) { super(detail ?? kind); this.kind = kind; }
}

export const bankMessage = (e: unknown): string => {
  const k = e instanceof BankError ? e.kind : 'failed';
  return k === 'not_allowed' ? 'The passphrase doesn’t match the PAYDAYS_KEY secret in Supabase.'
    : k === 'not_set_up' ? 'The Akahu tokens aren’t saved in Supabase yet (AKAHU_APP_TOKEN and AKAHU_USER_TOKEN).'
      : k === 'unreachable' ? 'Couldn’t reach your bank connection. Check you’re online and try again.'
        : `Akahu didn’t answer properly${e instanceof Error && e.message !== 'failed' ? ` (${e.message})` : ''}. Try again later.`;
};

/** Your accounts and their settled transactions since a day (all Akahu has, up to 2 years, the first time). */
export async function fetchBank(conf: BankConfig, since?: ISODate, fetchImpl: typeof fetch = (...a) => fetch(...a), refresh = false): Promise<BankData> {
  let res: Response;
  const q = [since && `since=${since}`, refresh && 'refresh=1'].filter(Boolean).join('&');
  try {
    res = await fetchImpl(`${conf.url}${q ? `?${q}` : ''}`, { headers: { 'x-paydays-key': conf.key } });
  } catch { throw new BankError('unreachable'); }
  let body: { error?: string } & Partial<BankData> = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401) throw new BankError('not_allowed');
  if (res.status === 503) throw new BankError('not_set_up');
  if (!res.ok || !Array.isArray(body.accounts) || !Array.isArray(body.transactions)) throw new BankError('failed', body.error);
  return { accounts: body.accounts, transactions: body.transactions, ...(Array.isArray((body as { pending?: unknown }).pending) ? { pending: (body as { pending: BankPending[] }).pending } : {}), ...(typeof (body as { refreshed?: unknown }).refreshed === 'boolean' ? { refreshed: (body as { refreshed: boolean }).refreshed } : {}) };
}

/** Where a bank account's transactions go: the account or card with its number's ending saved (from an earlier upload), if one has. */
export function suggestLink(b: Budget, acc: BankAccount): string {
  const ending = acc.number ? endingOf(acc.number) : undefined;
  if (!ending) return '';
  const hits = [
    ...b.accounts.filter((a) => a.ending === ending && !a.archived).map((a) => `account:${a.id}`),
    ...(b.debts ?? []).filter((d) => d.ending === ending && !d.payroll).map((d) => `debt:${d.id}`),
  ];
  return hits.length === 1 ? hits[0] : '';
}

export interface BankResult { name: string; added: number; balance?: number; cardPayments?: SeenPayment[] }

/** A new savings goal (with its own account, sent nothing from pay) for a bank account, e.g. KiwiSaver. Returns its link. */
export function addGoalFor(b: Budget, acc: BankAccount, id: string, accountId: string, today: ISODate = todayISO()): string {
  const groupId = b.groups.find((g) => g.id === 'savings')?.id ?? b.groups.find((g) => g.bucket === 'savings')?.id ?? b.groups[0]?.id ?? '';
  const kiwi = /kiwi ?saver/i.test(`${acc.name} ${acc.type}`) || acc.type === 'KIWISAVER';
  const name = kiwi ? 'KiwiSaver' : acc.name;
  const balance = Math.round((acc.balance ?? 0) * 100);
  b.accounts.push({ id: accountId, name, kind: 'bank', color: nextColor(b.accounts.map((x) => x.color)), groupId });
  // KiwiSaver comes out of your salary, so payday never sends it anything.
  if (!kiwi) b.split.push({ accountId, amount: 0 });
  b.savings = [...(b.savings ?? []), {
    id, name, accountId, balance, asOf: today, note: `Balance from ${acc.institution ?? 'your bank'} through the bank connection.`,
    ...(kiwi ? { kiwisaver: true, readings: [{ date: today, balance }] } : {}),
  }];
  return `saving:${id}`;
}

/** A goal's balance from the bank. A KiwiSaver goal keeps each one, for its history of returns. */
function setGoalBalance(goal: NonNullable<Budget['savings']>[number], cents: number, today: ISODate): void {
  if (isKiwiSaver(goal)) recordReading(goal, { date: today, balance: cents });
  else { goal.balance = cents; goal.asOf = today; }
}

/** Add the new transactions to each linked account or card, and savings goals' balances. Returns how many were added to each. */
export function applyBank(b: Budget, data: BankData, links: Record<string, string>, today: ISODate = todayISO(), now: string = new Date().toISOString()): BankResult[] {
  const out: BankResult[] = [];
  for (const acc of data.accounts) {
    // Noted for each account that came through, so its card shows when it last synced.
    const link = links[acc.id];
    // That's when the bank last sent its balance, when it says, so a pill never looks fresher than the bank is.
    if (link && link !== 'ignore' && link.includes(':')) b.bankSeen = { ...(b.bankSeen ?? {}), [link]: acc.updated && Date.parse(acc.updated) ? acc.updated : now };
    const [type, id] = (links[acc.id] ?? '').split(':') as ['account' | 'debt' | 'saving' | '', string?];
    // A savings goal (KiwiSaver, an investment): its balance follows the account's.
    if (type === 'saving' && id) {
      const goal = (b.savings ?? []).find((g) => g.id === id);
      if (goal && acc.balance !== null) {
        const cents = Math.round(acc.balance * 100);
        if (goal.balance !== cents) { setGoalBalance(goal, cents, today); out.push({ name: goal.name, added: 0, balance: cents }); }
      }
      continue;
    }
    if ((type !== 'account' && type !== 'debt') || !id) continue;
    const target = type === 'debt' ? (b.debts ?? []).find((d) => d.id === id) : b.accounts.find((a) => a.id === id);
    if (!target) continue;
    const rows: Txn[] = data.transactions
      .filter((t) => t.account === acc.id && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && t.amount)
      .map((t) => ({ date: t.date, description: (t.description ?? '').replace(/\s{2,}/g, ' ').trim() || 'Transaction', amount: Math.round(t.amount * 100), ...(t.merchant ? { merchant: t.merchant } : {}), ...(t.category ? { category: t.category } : {}) }))
      .sort((x, y) => x.date.localeCompare(y.date));
    const existing = type === 'debt' ? (target as NonNullable<Budget['debts']>[number]).transactions ?? [] : b.accountTransactions?.[id] ?? [];
    const add = newTransactions(existing, rows);
    const ending = acc.number ? endingOf(acc.number) : undefined;
    if (type === 'account' && acc.number && (target as Budget['accounts'][number]).number !== acc.number) (target as Budget['accounts'][number]).number = acc.number;
    // Its balance follows the bank's too (what's owed, for a card), unless you've turned updates off.
    const live = b.bankAuto !== false && acc.balance !== null;
    // A bank account's balance is what you can spend now (pending card purchases taken off, as your
    // banking app shows it); a card's is what's owed.
    const shown = type === 'account' && typeof acc.available === 'number' ? acc.available : acc.balance;
    const cents = live ? Math.round(shown! * 100) : 0;
    // Banks show what's owed on a card as a negative balance.
    const balance = live && type === 'debt' ? { amount: Math.abs(cents), asOf: today } : undefined;
    if (add.length || (ending && !target.ending) || balance) {
      applyProposal(b, { kind: 'transactions', target: { type, id }, ...(ending ? { ending } : {}), add, ...(balance ? { balance } : {}), history: [], eventId: `bank-${acc.id}-${today}` }, today);
    }
    const changed = live && type === 'account' && b.balances?.[id]?.amount !== cents;
    if (changed) setBalance(b, id, cents, today, `bank-${acc.id}-${today}`);
    // The same as before, but checked again today: it's today's balance, not an estimate from an older one.
    else if (live && type === 'account' && b.balances?.[id] && b.balances[id].asOf < today) b.balances[id] = { ...b.balances[id], asOf: today };
    // What hasn't settled yet replaces what was pending last time (once settled, it's in the transactions).
    if (type === 'account' && data.pending) {
      const pend: Txn[] = data.pending.filter((t) => t.account === acc.id && t.amount)
        .map((t) => ({ date: t.date, description: (t.description ?? '').replace(/\s{2,}/g, ' ').trim() || 'Pending', amount: Math.round(t.amount * 100), ...(t.merchant ? { merchant: t.merchant } : {}) }));
      const all = { ...(b.pendingTransactions ?? {}) };
      if (pend.length) all[id] = pend; else delete all[id];
      b.pendingTransactions = all;
    }
    // Payments from this account to cards that can't be linked themselves (Gem Visa, Q Mastercard).
    const cardPayments = type === 'account' ? recordCardPayments(b, id, add, today) : [];
    // The account behind a savings goal: the goal's balance is the bank's.
    if (live && type === 'account') for (const g of b.savings ?? []) if (g.accountId === id && g.balance !== cents) setGoalBalance(g, cents, today);
    out.push({ name: target.name, added: add.length, ...(changed ? { balance: cents } : {}), ...(cardPayments.length ? { cardPayments } : {}) });
  }
  return out;
}

/** Linked to the bank connection (and updating by itself): when it last came through, if it has. */
export function bankSync(b: Budget, link: string): { linked: boolean; at?: string } {
  const linked = b.bankAuto !== false && Object.values(b.bankLinks ?? {}).includes(link);
  return { linked, at: linked ? b.bankSeen?.[link] : undefined };
}

/** The day to fetch from: a week before the last sync (so late-settling ones are caught), or everything the first time. */
export const sinceFor = (conf: BankConfig): ISODate | undefined => (conf.lastSync ? addDays(conf.lastSync.slice(0, 10), -7) : undefined);

/** An account number as numbers (bank, branch, account, suffix), so 06-0115-0324910-055 and -55 are the same. */
const numberKey = (n: string): string | undefined => {
  const m = n.match(/(\d{2})\D?(\d{4})\D?(\d{7})\D?(\d{2,3})/);
  return m ? m.slice(1).map((x) => String(Number(x))).join('-') : undefined;
};

/**
 * A transfer between your own accounts, named: "To: 06-0115-0324910-55 Debit Transfer 083615" is
 * "To Rent". Undefined when it isn't one, or the number isn't one of your accounts.
 */
export function transferTo(b: Pick<Budget, 'accounts'>, description: string): { dir: 'to' | 'from'; name: string } | undefined {
  const m = description.match(/\b(to|from)\b:?\s*(\d{2}-?\d{4}-?\d{7}-?\d{2,3})/i);
  if (!m) return undefined;
  const key = numberKey(m[2]);
  const acc = key ? b.accounts.find((a) => a.number && numberKey(a.number) === key) : undefined;
  return acc ? { dir: m[1].toLowerCase() as 'to' | 'from', name: acc.name } : undefined;
}
