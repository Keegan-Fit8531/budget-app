import { endingOf } from './csv';
import { addDays, todayISO, type ISODate } from './dates';
import { applyProposal } from './reader/apply';
import { newTransactions } from './reader/check';
import type { Budget, Txn } from './types';

// ---------------------------------------------------------------------------------------------
// Bank connection through Akahu (NZ open banking), read-only. The Akahu tokens live in a small server
// function you own (Supabase), never in this app or the browser; the app proves it's you with a
// passphrase kept in this browser only. New transactions are added to the account or card you've
// linked each bank account to, the same way an uploaded export's are.
// ---------------------------------------------------------------------------------------------

/** Your server function (it reads from Akahu with your tokens). */
export const BANK_URL = 'https://ardxcgyhyxicnxxzzxdp.supabase.co/functions/v1/akahu-sync';
const CONF_KEY = 'paydays.bank';
/** Synced automatically when the app opens, at most this often. */
export const AUTO_EVERY_MS = 6 * 60 * 60 * 1000;

export interface BankConfig { url: string; key: string; lastSync?: string }
export interface BankAccount { id: string; name: string; number: string | null; type: string; institution: string | null; balance: number | null; transactions: boolean }
export interface BankTxn { account: string; id: string; date: ISODate; description: string; amount: number; balance: number | null; merchant: string | null }
export interface BankData { accounts: BankAccount[]; transactions: BankTxn[] }

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

export function readBankConfig(): BankConfig | null {
  try {
    const c = JSON.parse(localStorage.getItem(CONF_KEY) ?? 'null') as BankConfig | null;
    return c?.key ? { ...c, url: c.url || BANK_URL } : null;
  } catch { return null; }
}

export function writeBankConfig(c: BankConfig | null): void {
  try { if (c) localStorage.setItem(CONF_KEY, JSON.stringify(c)); else localStorage.removeItem(CONF_KEY); } catch { /* storage blocked */ }
}

/** Your accounts and their settled transactions since a day (all Akahu has, up to 2 years, the first time). */
export async function fetchBank(conf: BankConfig, since?: ISODate, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<BankData> {
  let res: Response;
  try {
    res = await fetchImpl(`${conf.url}${since ? `?since=${since}` : ''}`, { headers: { 'x-paydays-key': conf.key } });
  } catch { throw new BankError('unreachable'); }
  let body: { error?: string } & Partial<BankData> = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401) throw new BankError('not_allowed');
  if (res.status === 503) throw new BankError('not_set_up');
  if (!res.ok || !Array.isArray(body.accounts) || !Array.isArray(body.transactions)) throw new BankError('failed', body.error);
  return { accounts: body.accounts, transactions: body.transactions };
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

/** Add the new transactions to each linked account or card. Returns how many were added to each. */
export function applyBank(b: Budget, data: BankData, links: Record<string, string>, today: ISODate = todayISO()): { name: string; added: number }[] {
  const out: { name: string; added: number }[] = [];
  for (const acc of data.accounts) {
    const [type, id] = (links[acc.id] ?? '').split(':') as ['account' | 'debt' | '', string?];
    if ((type !== 'account' && type !== 'debt') || !id) continue;
    const target = type === 'debt' ? (b.debts ?? []).find((d) => d.id === id) : b.accounts.find((a) => a.id === id);
    if (!target) continue;
    const rows: Txn[] = data.transactions
      .filter((t) => t.account === acc.id && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && t.amount)
      .map((t) => ({ date: t.date, description: (t.description ?? '').replace(/\s{2,}/g, ' ').trim() || 'Transaction', amount: Math.round(t.amount * 100) }))
      .sort((x, y) => x.date.localeCompare(y.date));
    const existing = type === 'debt' ? (target as NonNullable<Budget['debts']>[number]).transactions ?? [] : b.accountTransactions?.[id] ?? [];
    const add = newTransactions(existing, rows);
    const ending = acc.number ? endingOf(acc.number) : undefined;
    if (add.length || (ending && !target.ending)) {
      applyProposal(b, { kind: 'transactions', target: { type, id }, ...(ending ? { ending } : {}), add, history: [], eventId: `bank-${acc.id}-${today}` }, today);
    }
    out.push({ name: target.name, added: add.length });
  }
  return out;
}

/** The day to fetch from: a week before the last sync (so late-settling ones are caught), or everything the first time. */
export const sinceFor = (conf: BankConfig): ISODate | undefined => (conf.lastSync ? addDays(conf.lastSync.slice(0, 10), -7) : undefined);
