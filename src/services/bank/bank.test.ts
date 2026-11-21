import { describe, expect, it } from 'vitest';
import { owed } from '../../features/debts/logic/amounts';
import { applyProposal } from '../reader/apply';
import { review } from '../reader/check/review';
import { toDraft } from '../reader/check/toDraft';
import { addGoalFor, applyBank, fetchBank, suggestLink } from './bank';
import { categorizeTxn } from '../../features/insights/logic/spending';
import { debtBudget, seq, debt } from '../../testing/fixtures';

describe('bank connection (Akahu)', () => {
  const data = {
    accounts: [{ id: 'acc_1', name: 'Go', number: '06-0999-0123456-00', type: 'CHECKING', institution: 'ANZ', balance: 100, transactions: true },
      { id: 'acc_2', name: 'Kernel', number: null, type: 'INVESTMENT', institution: 'Kernel', balance: 5000, transactions: false }],
    transactions: [{ account: 'acc_1', id: 't1', date: '2026-11-14', description: 'COUNTDOWN HENDERSON', amount: -45.2, balance: 100, merchant: null },
      { account: 'acc_1', id: 't2', date: '2026-11-15', description: 'SALARY', amount: 900, balance: 1000, merchant: null }],
  };
  it('adds a linked account’s new transactions once, and remembers its number', () => {
    const b = debtBudget();
    const links = { acc_1: 'account:everyday', acc_2: 'ignore' };
    expect(applyBank(b, data, links, '2026-11-16')).toEqual([{ name: 'Everyday', added: 2, balance: 10000 }]);
    expect(b.accountTransactions?.everyday?.map((t) => t.amount)).toEqual([-4520, 90000]);
    expect(b.accounts.find((a) => a.id === 'everyday')!.ending).toBe('3456');
    expect(applyBank(b, data, links, '2026-11-17')).toEqual([{ name: 'Everyday', added: 0 }]);
    // Next time it's suggested by the number.
    expect(suggestLink(b, data.accounts[0])).toBe('account:everyday');
  });
  it('the passphrase and setup problems are told apart', async () => {
    const res = (status: number) => (async () => new Response(JSON.stringify({ error: 'x' }), { status })) as unknown as typeof fetch;
    await expect(fetchBank({ url: 'u', key: 'k' }, undefined, res(401))).rejects.toMatchObject({ kind: 'not_allowed' });
    await expect(fetchBank({ url: 'u', key: 'k' }, undefined, res(503))).rejects.toMatchObject({ kind: 'not_set_up' });
  });
});

it('KiwiSaver: a new savings goal for an account, whose balance then follows it', () => {
  const b = debtBudget();
  const kiwi = { id: 'acc_k', name: 'Kernel KiwiSaver', number: null, type: 'KIWISAVER', institution: 'Kernel', balance: 12345.67, transactions: false };
  const link = addGoalFor(b, kiwi, 'g-ks', 'a-ks', '2026-11-16');
  expect(link).toBe('saving:g-ks');
  expect(b.savings!.find((g) => g.id === 'g-ks')).toMatchObject({ name: 'KiwiSaver', balance: 1234567, accountId: 'a-ks' });
  expect(b.split.some((l) => l.accountId === 'a-ks')).toBe(false); // nothing sent from pay: it comes from your salary
  const r = applyBank(b, { accounts: [{ ...kiwi, balance: 12400 }], transactions: [] }, { acc_k: link }, '2026-11-17');
  expect(r).toEqual([{ name: 'KiwiSaver', added: 0, balance: 1240000 }]);
  expect(b.savings!.find((g) => g.id === 'g-ks')).toMatchObject({ balance: 1240000, asOf: '2026-11-17' });
  // Each balance is kept, for its history of gains and losses.
  expect(b.savings!.find((g) => g.id === 'g-ks')!.readings).toEqual([{ date: '2026-11-16', balance: 1234567 }, { date: '2026-11-17', balance: 1240000 }]);
});

describe('bank connection: balances and categories', () => {
  const acc = (o: object) => ({ id: 'a1', name: 'Go', number: '06-0999-0123456-00', type: 'CHECKING', institution: 'ANZ', balance: 432.1, transactions: true, ...o });
  it('a linked account’s balance follows the bank, unless updates are turned off', () => {
    const b = debtBudget();
    applyBank(b, { accounts: [acc({})], transactions: [] }, { a1: 'account:everyday' }, '2026-11-16');
    expect(b.balances?.everyday).toEqual({ amount: 43210, asOf: '2026-11-16' });
    b.bankAuto = false;
    applyBank(b, { accounts: [acc({ balance: 10 })], transactions: [] }, { a1: 'account:everyday' }, '2026-11-17');
    expect(b.balances?.everyday).toEqual({ amount: 43210, asOf: '2026-11-16' });
  });
  it('a bank account shows what can be spent now (pending card purchases off), and when the bank sent it', () => {
    const b = debtBudget();
    applyBank(b, { accounts: [acc({ balance: 49.37, available: 21.05, updated: '2026-11-17T00:30:00.000Z' })], transactions: [] }, { a1: 'account:everyday' }, '2026-11-17', '2026-11-17T00:31:00.000Z');
    expect(b.balances?.everyday).toEqual({ amount: 2105, asOf: '2026-11-17' });
    expect(b.bankSeen?.['account:everyday']).toBe('2026-11-17T00:30:00.000Z');
    // Pending card purchases are kept apart, and replaced on the next sync.
    applyBank(b, { accounts: [acc({ balance: 49.37, available: 21.05 })], transactions: [], pending: [{ account: 'a1', date: '2026-11-17', description: 'Tea Talk', amount: -12.81, merchant: null }] }, { a1: 'account:everyday' }, '2026-11-17');
    expect(b.pendingTransactions?.everyday).toEqual([{ date: '2026-11-17', description: 'Tea Talk', amount: -1281 }]);
    applyBank(b, { accounts: [acc({ balance: 49.37, available: 21.05 })], transactions: [], pending: [] }, { a1: 'account:everyday' }, '2026-11-17');
    expect(b.pendingTransactions?.everyday).toBeUndefined();
    // The same balance a day later is still today's balance.
    applyBank(b, { accounts: [acc({ balance: 49.37, available: 21.05 })], transactions: [] }, { a1: 'account:everyday' }, '2026-11-18');
    expect(b.balances?.everyday).toEqual({ amount: 2105, asOf: '2026-11-18' });
  });
  it('a linked card’s owed follows the bank (shown negative there)', () => {
    const b = debtBudget();
    applyBank(b, { accounts: [acc({ id: 'c1', type: 'CREDITCARD', balance: -612.48, number: null })], transactions: [] }, { c1: 'debt:qcard' }, '2026-11-16');
    expect(owed(debt(b, 'qcard'))).toBe(61248);
  });
  it('the bank’s shop name and category are used when the description alone doesn’t say', () => {
    expect(categorizeTxn({ description: 'POS W/D 4829 PAK N SAV', merchant: 'PAK’nSAVE' })).toMatchObject({ category: 'groceries', shop: 'PAK’nSAVE' });
    expect(categorizeTxn({ description: 'XYZ*12345', category: 'Takeaway & fast food' }).category).toBe('takeaways');
  });
});

describe('payments to cards and savings funds, from every stored bank transaction', () => {
  const go = { id: 'a1', name: 'Go', number: '06-0999-0123456-00', type: 'CHECKING', institution: 'ANZ', balance: 500, transactions: true };
  const tx = (id: string, date: string, description: string, amount: number) => ({ account: 'a1', id, date, description, amount, balance: null, merchant: null });

  it('a card payment already in the account before payments were looked for is noted once', () => {
    const b = debtBudget();
    // Already stored (an earlier sync, or the history trimmed): not new to the account.
    b.accountTransactions = { everyday: [{ date: '2026-11-10', description: 'Q Mastercard Fitzgerald Id1105532418', amount: -5000 }] };
    debt(b, 'qcard').balance = { amount: 50000, asOf: '2026-11-05' };
    const data = { accounts: [go], transactions: [tx('t1', '2026-11-10', 'Q Mastercard Fitzgerald Id1105532418', -50)] };
    applyBank(b, data, { a1: 'account:everyday' }, '2026-11-16');
    expect(debt(b, 'qcard').bankPayments).toEqual([expect.objectContaining({ date: '2026-11-10', amount: 5000, counted: 5000 })]);
    expect(owed(debt(b, 'qcard'))).toBe(45000);
    applyBank(b, data, { a1: 'account:everyday' }, '2026-11-17');
    expect(debt(b, 'qcard').bankPayments).toHaveLength(1);
    expect(owed(debt(b, 'qcard'))).toBe(45000);
  });

  function fund(linked: boolean) {
    const b = debtBudget();
    b.accounts.push({ id: 'kernel', name: 'Wedding · Kernel', kind: 'external', color: '#000', groupId: 'savings' });
    b.savings = [{ id: 'wedding', name: 'Wedding', accountId: 'kernel', balance: 1000000, asOf: '2026-11-10' }];
    const links: Record<string, string> = { a1: 'account:everyday', ...(linked ? { k1: 'saving:wedding' } : {}) };
    return { b, links };
  }
  const kernel = (updated: string, balance: number) => ({ id: 'k1', name: 'Kernel Cash Plus', number: null, type: 'INVESTMENT', institution: 'Kernel', balance, transactions: false, updated });

  it('Kernel, from the bank connection: money paid in or out after its balance date is added on, once', () => {
    const { b, links } = fund(true);
    const data = {
      accounts: [kernel('2026-11-14T10:00:00+13:00', 10000), go],
      transactions: [
        tx('t1', '2026-11-12', 'Kernel - Adminis Cus Fitzgerald K F W7H7Ghge', -1000), // before: already in Kernel's balance
        tx('t2', '2026-11-15', 'Kernel - Adminis Cus Fitzgerald K F W7H7Ghge', -250), // after: added
        tx('t3', '2026-11-16', 'Kernel Consols Withdrawal For Suit And', 550), // taken out after: off
        tx('t4', '2026-11-16', 'Countdown', -20),
      ],
    };
    const r = applyBank(b, data, links, '2026-11-17');
    const g = b.savings![0];
    expect(g.balance).toBe(1000000 + 25000 - 55000);
    expect(g.asOf).toBe('2026-11-16');
    expect(g.bankMoves?.map((m) => [m.date, m.amount, m.counted])).toEqual([['2026-11-12', 100000, 0], ['2026-11-15', 25000, 25000], ['2026-11-16', -55000, -55000]]);
    expect(r.find((x) => x.name === 'Wedding')).toMatchObject({ balance: 970000 });
    // Synced again: nothing added twice. Then Kernel catches up: its balance has them, so they're not added on.
    applyBank(b, data, links, '2026-11-17');
    expect(g.balance).toBe(970000);
    applyBank(b, { ...data, accounts: [kernel('2026-11-17T08:00:00+13:00', 9700), go] }, links, '2026-11-17');
    expect(g.balance).toBe(970000);
    expect(g.bankMoves?.every((m) => m.counted === 0)).toBe(true);
  });

  it('Kernel typed in or uploaded (not linked): a move after that balance is added once; one before is only noted', () => {
    const { b, links } = fund(false);
    const data = { accounts: [go], transactions: [tx('t1', '2026-11-08', 'Kernel - Adminis Cus', -1000), tx('t2', '2026-11-15', 'Kernel - Adminis Cus', -250)] };
    applyBank(b, data, links, '2026-11-17');
    const g = b.savings![0];
    expect(g.balance).toBe(1025000);
    expect(g.asOf).toBe('2026-11-15');
    expect(g.bankMoves?.map((m) => m.counted)).toEqual([0, 25000]);
    applyBank(b, data, links, '2026-11-18');
    expect(g.balance).toBe(1025000);
  });

  it('a statement older than a payment seen in the bank: the payment comes off it again', () => {
    const b = debtBudget();
    const q = debt(b, 'qcard');
    q.balance = { amount: 50000, asOf: '2026-11-05' };
    b.accountTransactions = { everyday: [] };
    applyBank(b, { accounts: [go], transactions: [tx('t1', '2026-11-12', 'Q Mastercard', -100)] }, { a1: 'account:everyday' }, '2026-11-16');
    expect(owed(q)).toBe(40000);
    // A screenshot dated 10 Nov (before the payment): its $600 is the latest figure, less the $100 paid since.
    const r = review({ ...toDraft({ kind: 'statement', statement: { debtId: 'qcard', balance: { amount: '600.00' }, statementDate: '2026-11-10' } }, b, 'gemini', seq(), '2026-11-16') }, b, '2026-11-16');
    const after = applyProposal(structuredClone(b), r.proposal!, '2026-11-16');
    expect(owed(debt(after, 'qcard'))).toBe(50000);
  });
});
