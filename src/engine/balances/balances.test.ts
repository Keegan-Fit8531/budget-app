import { describe, expect, it } from 'vitest';
import { balanceToday, estimateBalance } from './estimate';
import { billTracker } from './billTracker';
import { depositFor, depositPending } from './deposits';
import { freezePaySplit, freezePaySplitFrom, unfreezePaySplit } from './freeze';
import { addDays } from '../../core/dates';
import { periodContaining, shiftPeriod } from '../periods';
import { balancePay } from '../rebalance';
import { setBalance } from '../../features/accounts/logic/history';
import { applyBank } from '../../services/bank/bank';
import { budget } from '../../testing/fixtures';

describe('frozen payday split once the cycle has started', () => {
  function withBills() {
    const b = budget();
    b.accounts.push(
      { id: 'bills', name: 'Misc bills', kind: 'bank', color: '#000', groupId: 'needs' },
      { id: 'gem', name: 'Gem Visa', kind: 'external', color: '#000', groupId: 'debt' },
      { id: 'ap', name: 'Afterpay', kind: 'external', color: '#000', groupId: 'debt' },
    );
    b.split.push(
      { accountId: 'bills', amount: 0, mode: 'exact' },
      { accountId: 'gem', amount: 0, mode: 'exact' },
      { accountId: 'ap', amount: 50400, mode: 'fixed' },
    );
    b.items.push({ id: 'power', name: 'Power', amount: 20000, frequency: 'monthly', start: '2026-01-25', accountId: 'bills' });
    b.debts = [{
      id: 'gem', name: 'Gem Visa', kind: 'card', rules: 'gem', accountId: 'gem', holdAccountId: 'bills',
      plans: [{ id: 'p1', name: 'TV', type: 'interest-free', original: 100000, remaining: 50400, asOf: '2026-10-01', purchaseDate: '2026-10-01', months: 6 }],
      balance: { amount: 50400, asOf: '2026-11-18' },
      statementDay: 21,
    }, {
      id: 'ap', name: 'Afterpay', kind: 'bnpl', rules: 'afterpay', accountId: 'ap',
      plans: [{ id: 'photo', name: 'PHOTOGEAR', type: 'afterpay', original: 14900, remaining: 3725, asOf: '2026-11-01', purchaseDate: '2026-11-01' }],
      balance: { amount: 3725, asOf: '2026-11-18' },
    }];
    return b;
  }

  it('keeps the frozen deposits after debts are paid down later in the cycle', () => {
    const b = withBills();
    const p = periodContaining('2026-11-19', b.settings);
    b.payActuals[p.start] = 600000;
    const gemBefore = depositFor(b, 'gem', p, '2026-11-19');
    const apBefore = depositFor(b, 'ap', p, '2026-11-19');
    expect(gemBefore).toBeGreaterThan(0);
    expect(apBefore).toBeGreaterThan(0);
    freezePaySplit(b, p, '2026-11-19');
    expect(b.splitSent?.[p.start]?.gem).toBe(gemBefore);
    expect(b.splitSent?.[p.start]?.ap).toBe(apBefore);

    // Later in the cycle: Afterpay cleared and Gem schedule gone — live would be $0.
    b.debts![1].plans = [];
    b.debts![1].balance = { amount: 0, asOf: '2026-11-19' };
    b.debts![0].plans = [];
    b.debts![0].balance = { amount: 0, asOf: '2026-11-19' };
    expect(depositFor(b, 'gem', p, '2026-11-20')).toBe(gemBefore);
    expect(depositFor(b, 'ap', p, '2026-11-20')).toBe(apBefore);
    // Future pays still recalculate.
    const next = shiftPeriod(p, 1, b.settings);
    expect(depositFor(b, 'ap', next, '2026-11-20')).toBe(0);
  });

  it('recovers a collapsed auto-balance amount when freezing (this morning’s figure)', () => {
    const b = withBills();
    const p = periodContaining('2026-11-19', b.settings);
    b.payActuals[p.start] = 600000;
    // Balancing had Afterpay at $150, then live collapsed to $0.
    b.autoBalanced = { [p.start]: { ap: { prev: 15000, to: 0, reason: 'Trimmed' } } };
    b.overrides = { [p.start]: { ap: 0 } };
    b.debts![1].plans = [];
    b.debts![1].balance = { amount: 0, asOf: '2026-11-19' };
    freezePaySplit(b, p, '2026-11-19');
    expect(b.splitSent?.[p.start]?.ap).toBe(15000);
    expect(depositFor(b, 'ap', p, '2026-11-19')).toBe(15000);
  });

  it('prefers payday bank credits when freezing', () => {
    const b = withBills();
    const p = periodContaining('2026-11-19', b.settings);
    b.payActuals[p.start] = 600000;
    b.accountTransactions = { bills: [{ date: '2026-11-19', amount: 77500, description: 'Payday' }] };
    freezePaySplit(b, p, '2026-11-19');
    expect(b.splitSent?.[p.start]?.bills).toBe(77500);
  });

  it('can restore the freeze from a morning budget copy', () => {
    const morning = withBills();
    const p = periodContaining('2026-11-19', morning.settings);
    morning.payActuals[p.start] = 600000;
    const gemMorning = depositFor(morning, 'gem', p, '2026-11-19');
    expect(gemMorning).toBeGreaterThan(0);

    const now = structuredClone(morning);
    now.debts![0].plans = [];
    now.debts![0].balance = { amount: 0, asOf: '2026-11-19' };
    freezePaySplit(now, p, '2026-11-19'); // would lock $0 without a morning source
    expect(now.splitSent?.[p.start]?.gem).toBe(0);

    freezePaySplitFrom(now, p, morning, '2026-11-19');
    expect(now.splitSent?.[p.start]?.gem).toBe(gemMorning);
    expect(depositFor(now, 'gem', p, '2026-11-20')).toBe(gemMorning);
  });

  it('unfreezes when the payslip is cleared on payday', () => {
    const b = withBills();
    const p = periodContaining('2026-11-19', b.settings);
    b.payActuals[p.start] = 600000;
    freezePaySplit(b, p, '2026-11-19');
    expect(b.splitSent?.[p.start]).toBeDefined();
    delete b.payActuals[p.start];
    unfreezePaySplit(b, p.start);
    expect(b.splitSent?.[p.start]).toBeUndefined();
  });
});

describe('payday morning before the deposit lands', () => {
  function withRent() {
    const b = budget();
    b.accounts.push({ id: 'rent', name: 'Rent', kind: 'bank', color: '#000', groupId: 'needs' });
    b.split.push({ accountId: 'rent', amount: 0, mode: 'smooth' });
    b.items.push({ id: 'r', name: 'Rent', amount: 41500, frequency: 'weekly', start: '2026-01-05', accountId: 'rent' });
    return b;
  }

  it('a balance refreshed on payday before the split still counts what payday sends', () => {
    // $500 left on Wed 18 Nov; bank sync on Thu 19 Nov (payday) before the split lands.
    const b = withRent();
    setBalance(b, 'rent', 50000, '2026-11-18', 'h1');
    setBalance(b, 'rent', 50000, '2026-11-19', 'h2');
    const p = periodContaining('2026-11-19', b.settings);
    expect(depositPending(b, 'rent', b.balances!.rent)).toBe(true);
    // What's in the bank right now is still $500…
    expect(balanceToday(b, 'rent', '2026-11-19')).toBe(50000);
    // …but the period's end still counts today's deposit (to the cent), so it isn't falsely short.
    // Steady ≈ $1,804.51; 4 × $415 out → ends $644.51.
    expect(depositFor(b, 'rent', p, '2026-11-19')).toBe(180451);
    expect(estimateBalance(b, 'rent', p.end, '2026-11-19')).toBe(64451);
    expect(balancePay(b, p, '2026-11-19').shortAccounts).toEqual([]);
  });

  it('bank sync on payday does not bump asOf when the balance is unchanged', () => {
    const b = withRent();
    setBalance(b, 'rent', 50000, '2026-11-18', 'h1');
    applyBank(b, {
      accounts: [{ id: 'a1', name: 'Rent', number: '06-0115-0000001-00', type: 'CHECKING', institution: 'ANZ', balance: 500, transactions: true }],
      transactions: [],
    }, { a1: 'account:rent' }, '2026-11-19');
    expect(b.balances?.rent).toEqual({ amount: 50000, asOf: '2026-11-18' });
    expect(balancePay(b, periodContaining('2026-11-19', b.settings), '2026-11-19').shortAccounts).toEqual([]);
  });

  it('once the deposit is in the balance, it is not counted twice', () => {
    const b = withRent();
    setBalance(b, 'rent', 50000, '2026-11-18', 'h1');
    setBalance(b, 'rent', 230451, '2026-11-19', 'h2'); // $500 + steady $1,804.51
    const p = periodContaining('2026-11-19', b.settings);
    expect(depositPending(b, 'rent', b.balances!.rent)).toBe(false);
    expect(estimateBalance(b, 'rent', p.end, '2026-11-19')).toBe(64451);
    expect(balancePay(b, p, '2026-11-19').shortAccounts).toEqual([]);
  });
});

describe('bill tracker', () => {
  it('on payday, counts the deposit that lands that day', () => {
    const b = budget();
    b.accounts.push({ id: 'bills', name: 'Bills', kind: 'bank', color: '#000', groupId: 'needs' });
    b.split.push({ accountId: 'bills', amount: 30000, mode: 'fixed' });
    b.items.push({ id: 'i', name: 'Power', amount: 25000, frequency: 'monthly', start: '2026-01-25', accountId: 'bills' });
    b.balances = { bills: { amount: 1000, asOf: '2026-11-12' } };
    const payday = billTracker(b, 'bills', '2026-11-19');
    expect(payday.balance).toBe(31000);
    expect(payday.spare).toBe(6000);
    expect(payday.rows[0].covered).toBe(true);
    expect(billTracker(b, 'bills', '2026-11-20').balance).toBe(31000);
  });

  it("payday deposit then today's weekly transfer: balance $800 is enough for the 4 weeks left", () => {
    // $1,000 put in on payday, $200 transferred to weekly allowance today → $800 left for 4 Thursdays.
    const b = budget();
    b.accounts.push({ id: 'storage', name: 'Allowance storage', kind: 'bank', color: '#000', groupId: 'lifestyle' });
    b.split.push({ accountId: 'storage', amount: 100000, mode: 'fixed' });
    b.items.push({ id: 'wa', name: 'Weekly allowance transfer', amount: 20000, frequency: 'weekly', start: '2026-01-01', accountId: 'storage' });
    b.balances = { storage: { amount: 80000, asOf: '2026-11-19' } };
    b.accountTransactions = { storage: [{ date: '2026-11-19', amount: -20000, description: 'Weekly allowance' }] };

    const t = billTracker(b, 'storage', '2026-11-19');
    expect(t.paid).toBe(20000);
    expect(t.toCome).toBe(80000);
    expect(t.spare).toBe(0);
    expect(t.rows.find((r) => r.date === '2026-11-19')?.status).toBe('paid');
    expect(t.rows.filter((r) => r.status !== 'paid').every((r) => r.covered)).toBe(true);
  });

  it("same after a bank balance sync with no matching transaction line", () => {
    const b = budget();
    b.accounts.push({ id: 'storage', name: 'Allowance storage', kind: 'bank', color: '#000', groupId: 'lifestyle' });
    b.split.push({ accountId: 'storage', amount: 100000, mode: 'fixed' });
    b.items.push({ id: 'wa', name: 'Weekly allowance transfer', amount: 20000, frequency: 'weekly', start: '2026-01-01', accountId: 'storage' });
    // Synced balance today is post-transfer; payday sent $1,000.
    b.balances = { storage: { amount: 80000, asOf: '2026-11-19' } };
    b.overrides = { '2026-11-19': { storage: 100000 } };
    const t = billTracker(b, 'storage', '2026-11-19');
    expect(t.spare).toBe(0);
    expect(t.toCome).toBe(80000);
  });

  it('on a day a payment is due, the card headline and "In the account" are the same amount', () => {
    // Rent of $415 every Monday; $705 was in the account on Sat 14 Nov, and Mon 16 Nov is rent day.
    const b = budget();
    b.accounts.push({ id: 'rent', name: 'Rent', kind: 'bank', color: '#000', groupId: 'needs' });
    b.split.push({ accountId: 'rent', amount: 180000, mode: 'fixed' });
    b.items.push({ id: 'r', name: 'Rent', amount: 41500, frequency: 'weekly', start: '2026-01-05', accountId: 'rent' });
    b.balances = { rent: { amount: 70500, asOf: '2026-11-14' } };

    // Today's rent is still to come in both figures: $705 in the account, $415 to come, $290 left.
    const t = billTracker(b, 'rent', '2026-11-16');
    expect(balanceToday(b, 'rent', '2026-11-16')).toBe(70500);
    expect(t.balance).toBe(70500);
    expect(t.rows.find((r) => r.date === '2026-11-16')).toMatchObject({ status: 'today', covered: true });
    expect(t.toCome).toBe(41500);
    expect(t.spare).toBe(29000);
    // Projections still count it as gone by the end of the day.
    expect(estimateBalance(b, 'rent', '2026-11-16', '2026-11-16')).toBe(29000);

    // The day after, it has come out of both.
    const next = billTracker(b, 'rent', '2026-11-17');
    expect(balanceToday(b, 'rent', '2026-11-17')).toBe(29000);
    expect(next.balance).toBe(29000);
    expect(next.toCome).toBe(0);

    // They agree every day, payday (Thu 19 Nov, $1,800 in) and later rent days included,
    // and what's in the account less what's still to come is what's left.
    for (let d = '2026-11-14'; d <= '2026-12-31'; d = addDays(d, 1)) {
      const on = billTracker(b, 'rent', d);
      expect(on.balanceSource, d).toBe('entered');
      expect(on.balance, d).toBe(balanceToday(b, 'rent', d));
      expect(on.balance - on.toCome, d).toBe(on.spare);
    }
    expect(balanceToday(b, 'rent', '2026-11-19')).toBe(29000 + 180000);
    // Rent day Mon 23 Nov: last week's rent is gone, today's isn't yet.
    expect(balanceToday(b, 'rent', '2026-11-23')).toBe(209000);
    expect(billTracker(b, 'rent', '2026-11-24').balance).toBe(209000 - 41500);

    // No balance entered: no headline, and the tracker falls back to its own estimate.
    b.balances = {};
    expect(balanceToday(b, 'rent', '2026-11-16')).toBeUndefined();
    expect(billTracker(b, 'rent', '2026-11-16').balanceSource).toBe('estimated');
  });
});
