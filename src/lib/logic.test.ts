import { describe, expect, it } from 'vitest';
import { balanceToday, billTracker, depositFor, depositPending, estimateBalance, outflows } from './balances';
import { applyAllocation, existingExtras, undoAllocation } from './allocate';
import { addDays } from './dates';
import { applyPayment, debtPay, debtPaymentsIn, debtPerPay, debtSchedules, owed, projectedOwed, paidIn, planSchedule, recordHistory, settleDue } from './debts';
import { classifyText, matchDebt, parseDate, parseStatementText, recordStatement } from './documents';
import { averageNeed, clearPaydayMove, periodContaining, planFor, recordPayday, setAsidePerPay, shiftPeriod, upcomingPayPeriod } from './engine';
import { projectedAt, removeSpend, spendFromGoal } from './goalcosts';
import { autoBalance, autoPays, balancedMode, balancePay } from './rebalance';
import { accountHistory, recordCost, removeCost, setBalance } from './history';
import { parseMoney } from './money';
import { forecast } from './savings';
import { seedBudget } from './seed';
import type { Budget, Debt, SavingsGoal } from './types';
import { looksLikeBudget } from './valid';
import { applyProposal, preview, windBack } from './reader/apply';
import { csvTargets, NEW_DEBT, NOT_MINE, review, toCents, toDraft, validDate, type Draft } from './reader/check';
import { classifyHttpError, nextPacificMidnight, nzTime, ReaderError } from './reader/errors';
import { geminiProvider, parseReply } from './reader/gemini';
import { prepareFile } from './reader/prepare';
import { buildContext, RESPONSE_SCHEMA } from './reader/prompt';
import type { Extraction } from './reader/types';
import { KEEP_DAYS, localDay, needsCopy, toForget } from './versions';
import { addGoalFor, applyBank, fetchBank, suggestLink } from './bank';
import { cardPaid } from './cardPayments';
import { guessDebt } from './reader/check';
import { transferTo } from './bank';
import { moveAmong } from './order';
import { csvAmount, csvDate, endingOf, fromStatementRows, readTransactionsCsv } from './csv';
import { layoutPage } from './reader/pdftext';
import { mergeReads, splitRow } from './reader/gemini';
import { categorize, categorizeTxn, summarize } from './spending';

/** A blank budget paid on the 19th, with automatic balancing off so amounts are exactly as set. */
function budget(): Budget {
  const b = structuredClone(seedBudget);
  b.settings.paydayDay = 19;
  b.settings.expectedPay = 500000;
  b.settings.autoBalance = false;
  return b;
}

describe('pay periods', () => {
  it('every date falls inside its own pay period, whatever the payday and weekend rules', () => {
    for (const paydayDay of [1, 2, 15, 19, 28, 29, 30, 31]) {
      for (const saturday of ['friday', 'monday'] as const) {
        for (const sunday of ['friday', 'monday'] as const) {
          const s = { paydayDay, saturday, sunday };
          for (let d = '2024-01-01'; d < '2028-01-01'; d = addDays(d, 1)) {
            const p = periodContaining(d, s);
            expect(p.start <= d && d <= p.end, `${d} with payday ${paydayDay} (${saturday}/${sunday}) got ${p.start} – ${p.end}`).toBe(true);
          }
        }
      }
    }
  });

  it('a payday moved into the next month still starts the right period', () => {
    // Sat 31 May 2025 → paid Mon 2 June, so 1 June is still in the pay that started 30 April.
    const s = { paydayDay: 31, saturday: 'monday' as const, sunday: 'monday' as const };
    expect(periodContaining('2025-06-01', s)).toMatchObject({ start: '2025-04-30', end: '2025-06-01', nextPayday: '2025-06-02' });
    expect(periodContaining('2025-06-02', s).start).toBe('2025-06-02');
  });

  it('on payday the current pay is still upcoming (pay can land late); the day after it is not', () => {
    const b = budget();
    expect(upcomingPayPeriod(b, '2026-11-18').start).toBe('2026-11-19');
    expect(upcomingPayPeriod(b, '2026-11-19').start).toBe('2026-11-19');
    expect(upcomingPayPeriod(b, '2026-11-20').start).toBe('2026-12-18');
    expect(autoPays(b, '2026-11-19')[0].start).toBe('2026-11-19');
    expect(autoPays(b, '2026-11-20')[0].start).toBe('2026-12-18');
  });
});

describe('savings goals', () => {
  function withGoal(target: number) {
    const b = budget();
    b.accounts.push({ id: 'sv', name: 'Savings', kind: 'bank', color: '#000', groupId: 'savings' });
    b.split.push({ accountId: 'sv', amount: 10000, mode: 'fixed' });
    b.savings = [{ id: 'g', name: 'Goal', accountId: 'sv', balance: 0, asOf: '2026-11-12', target, targetDate: '2027-01-20' }];
    return b;
  }

  it('is on track when the pays left before the date are just enough', () => {
    // 12 Nov → 20 Jan: paydays 19 Nov, 18 Dec, 19 Jan. $100 a pay reaches $300 on the third.
    const b = withGoal(30000);
    const f = forecast(b, b.savings![0], '2026-11-12');
    expect(f.reachedBy).toBe('2027-01-19');
    expect(f.onTrack).toBe(true);
  });

  it('is behind when it needs one more pay than there is', () => {
    const b = withGoal(40000);
    const f = forecast(b, b.savings![0], '2026-11-12');
    expect(f.reachedBy).toBe('2027-02-19');
    expect(f.onTrack).toBe(false);
  });

  it('projects from the pays still to come, not the one already in the balance', () => {
    const b = withGoal(30000);
    b.savings![0].balance = 50000;
    expect(projectedAt(b, b.savings![0], '2026-11-18', '2026-11-12')).toEqual({ amount: 50000, pays: 0 });
    expect(projectedAt(b, b.savings![0], '2026-11-19', '2026-11-12')).toEqual({ amount: 60000, pays: 1 });
  });

  it('a payday that has passed since the balance was updated still counts', () => {
    // $0 saved on 12 Nov, $100 a pay: 19 Nov, 18 Dec and 19 Jan make $300 by 20 Jan.
    const b = withGoal(30000);
    const g = b.savings![0];
    expect(projectedAt(b, g, '2027-01-20', '2026-11-12').amount).toBe(30000);
    // After the 19 Nov payday, with the balance not updated yet: the same, not a pay short.
    expect(projectedAt(b, g, '2027-01-20', '2026-11-25')).toEqual({ amount: 30000, pays: 3 });
    expect(forecast(b, g, '2026-11-25')).toMatchObject({ onTrack: true, reachedBy: '2027-01-19', projected: 30000, periodsLeft: 2 });
    // Once it's updated (that payday's $100 is in it), the pay isn't added a second time.
    g.balance = 10000; g.asOf = '2026-11-25';
    expect(projectedAt(b, g, '2027-01-20', '2026-11-25')).toEqual({ amount: 30000, pays: 2 });
    expect(forecast(b, g, '2026-11-25')).toMatchObject({ onTrack: true, reachedBy: '2027-01-19', projected: 30000 });
  });

  it('counts extra sent for one pay only (Optimise) in the forecast', () => {
    // $100 a pay, plus $100 extra in the 18 Dec pay: $400 by 19 Jan instead of $300.
    const b = withGoal(40000);
    b.overrides = { '2026-12-18': { sv: 20000 } };
    const f = forecast(b, b.savings![0], '2026-11-12');
    expect(f).toMatchObject({ reachedBy: '2027-01-19', onTrack: true, projected: 40000 });
  });
});

describe('debts', () => {
  it('a 3-months-interest-free card balance is only paid down once per payday', () => {
    const s = budget().settings;
    const debt: Debt = { id: 'm', name: 'Card', kind: 'card', rules: 'mastercard', accountId: 'm', plans: [], balance: { amount: 90000, asOf: '2026-08-01' } };
    recordHistory(debt, '2026-08-01');
    // The day after the 19 Aug payday its $300 counts as paid…
    expect(settleDue(debt, s, '2026-08-20')).toBe(true);
    expect(debt.balance?.amount).toBe(60000);
    // …and opening the app on later days doesn't take that payday off again.
    for (const day of ['2026-08-21', '2026-08-25', '2026-09-17']) expect(settleDue(debt, s, day)).toBe(false);
    expect(debt.balance?.amount).toBe(60000);
    expect(debtSchedules(debt, s).flatMap((x) => x.payments).map((p) => [p.date, p.amount])).toEqual([['2026-09-18', 30000], ['2026-10-19', 30000]]);
  });

  it('an interest-free plan uses the exact end date when one is entered', () => {
    const s = budget().settings;
    const debt: Debt = { id: 'd', name: 'Card', kind: 'card', accountId: 'd', plans: [] };
    const sch = planSchedule(debt, {
      id: 'p', name: 'Couch', type: 'interest-free', months: 6, original: 60000, remaining: 60000,
      asOf: '2026-11-01', purchaseDate: '2026-11-01', ends: '2027-02-10',
    }, s);
    expect(sch.deadline).toBe('2027-02-10');
    expect(sch.payments.map((p) => p.date)).toEqual(['2026-11-19', '2026-12-18', '2027-01-19']);
  });
});

describe('debt payments that have gone out', () => {
  function withAfterpay() {
    const b = budget();
    b.accounts.push({ id: 'ap', name: 'Afterpay', kind: 'external', color: '#000', groupId: 'debt' });
    b.split.push({ accountId: 'ap', amount: 0, mode: 'exact' });
    b.debts = [{
      id: 'ap', name: 'Afterpay', kind: 'bnpl', rules: 'afterpay', accountId: 'ap',
      plans: [{
        id: 'p', name: 'Shoes', type: 'afterpay', original: 40000, remaining: 30000, asOf: '2026-11-11', purchaseDate: '2026-10-22',
        instalments: [{ date: '2026-11-19', amount: 10000 }, { date: '2026-12-03', amount: 10000 }, { date: '2026-12-17', amount: 10000 }],
      }],
    }];
    return b;
  }
  const sent = (b: Budget, pay: ReturnType<typeof periodContaining>, today: string) => planFor(b, pay, today).accounts.find((a) => a.account.id === 'ap')?.funded;

  it("stay in the pay they came out of, so its total and what's left over don't change as they go", () => {
    const b = withAfterpay();
    const pay = periodContaining('2026-11-19', b.settings);
    const next = shiftPeriod(pay, 1, b.settings);
    const before = planFor(b, pay, '2026-11-18');
    expect(sent(b, pay, '2026-11-18')).toBe(30000);
    // Each day of the pay, as the app does on opening: what fell due before today counts as paid.
    for (let day = pay.start; day <= pay.end; day = addDays(day, 1)) {
      for (const d of b.debts!) settleDue(d, b.settings, day);
      const now = planFor(b, pay, day);
      expect(sent(b, pay, day), day).toBe(30000);
      expect(now.leftover, day).toBe(before.leftover);
      expect(now.dues.map((d) => [d.date, d.item.amount]), day).toEqual([['2026-11-19', 10000], ['2026-12-03', 10000], ['2026-12-17', 10000]]);
      expect(sent(b, next, day), day).toBe(0);
    }
    expect(b.debts![0].plans[0].remaining).toBe(10000); // the 17 Dec one is still to come on the last day
  });

  it("a fixed payment's last pay still shows it after it's paid, and the pay after sends nothing", () => {
    const b = budget();
    b.accounts.push({ id: 'k', name: 'Kim', kind: 'external', color: '#000', groupId: 'debt' });
    b.split.push({ accountId: 'k', amount: 20000, mode: 'fixed' });
    b.debts = [{ id: 'k', name: 'Kim', kind: 'person', accountId: 'k', plans: [], balance: { amount: 20000, asOf: '2026-11-12' } }];
    const pay = periodContaining('2026-11-19', b.settings);
    expect(depositFor(b, 'k', pay, '2026-11-18')).toBe(20000);
    settleDue(b.debts[0], b.settings, '2026-11-20', 20000);
    expect(b.debts[0].balance?.amount).toBe(0);
    expect(depositFor(b, 'k', pay, '2026-11-20')).toBe(20000);
    expect(depositFor(b, 'k', shiftPeriod(pay, 1, b.settings), '2026-11-20')).toBe(0);
  });

  it("an older statement added after a payday doesn't put that payday's payment in its pay twice", () => {
    const b = budget();
    b.accounts.push({ id: 'm', name: 'Card', kind: 'external', color: '#000', groupId: 'debt' });
    b.split.push({ accountId: 'm', amount: 0, mode: 'exact' });
    b.debts = [{ id: 'm', name: 'Card', kind: 'card', rules: 'mastercard', accountId: 'm', plans: [], balance: { amount: 90000, asOf: '2026-11-01' } }];
    recordHistory(b.debts[0], '2026-11-01');
    const pay = periodContaining('2026-11-19', b.settings);
    settleDue(b.debts[0], b.settings, '2026-11-20');
    expect(debtPaymentsIn(b, 'm', pay.start, pay.end).map((x) => [x.date, x.amount])).toEqual([['2026-11-19', 30000]]);
    // A statement as at 10 Nov arrives on the 25th: the 19 Nov payment is worked out again from it.
    recordStatement(b, 'm', { balance: 60000, date: '2026-11-10' }, '2026-11-25');
    expect(paidIn(b.debts[0], pay.start, pay.end).map((x) => x.date)).toEqual(['2026-11-19']);
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

describe('a payday that moved', () => {
  it('pay arriving a day early moves that payday: the pay before ends sooner and this one starts sooner', () => {
    const b = budget();
    b.overrides = { '2026-11-19': { everyday: 100 } };
    // Usual payday Thu 19 Nov 2026; the payslip says Wed 18 Nov.
    expect(recordPayday(b, '2026-11-18')).toBe('2026-11-18');
    const s = b.settings;
    expect(periodContaining('2026-11-17', s)).toMatchObject({ start: '2026-10-19', end: '2026-11-17', days: 30 });
    expect(periodContaining('2026-11-18', s)).toMatchObject({ start: '2026-11-18', end: '2026-12-17', days: 30 });
    // Later paydays are untouched, and what was kept for that pay follows it to its new date.
    expect(shiftPeriod(periodContaining('2026-11-18', s), 1, s).start).toBe('2026-12-18');
    expect(b.overrides).toEqual({ '2026-11-18': { everyday: 100 } });
    // Recording it again changes nothing; removing it puts the payday back.
    expect(recordPayday(b, '2026-11-18')).toBe('2026-11-18');
    clearPaydayMove(b, '2026-11-18');
    expect(periodContaining('2026-11-18', b.settings).start).toBe('2026-10-19');
    expect(b.overrides).toEqual({ '2026-11-19': { everyday: 100 } });
  });

  it('a payslip on the usual day, or nowhere near a payday, moves nothing', () => {
    const b = budget();
    expect(recordPayday(b, '2026-11-19')).toBe('2026-11-19');
    expect(recordPayday(b, '2026-11-02')).toBe('2026-10-19');
    expect(b.settings.paydayMoves).toBeUndefined();
  });
});

describe('recording a debt payment', () => {
  it('a payment made on payday is that payday\'s payment, not an extra one', () => {
    const s = budget().settings;
    const debt: Debt = {
      id: 'd', name: 'Loan', kind: 'loan', accountId: 'd',
      plans: [{ id: 'p', name: 'Car', type: 'balance', original: 100000, remaining: 100000, asOf: '2026-11-01', purchaseDate: '2026-11-01', payment: 20000 }],
    };
    applyPayment(debt, 20000, s, '2026-11-19');
    expect(debt.plans[0].remaining).toBe(80000);
    expect(settleDue(debt, s, '2026-11-20')).toBe(false);
    expect(debt.plans[0].remaining).toBe(80000);
    expect(planSchedule(debt, debt.plans[0], s).payments[0].date).toBe('2026-12-18');
  });

  it('a payment between paydays leaves the next payday\'s payment in place', () => {
    const s = budget().settings;
    const debt: Debt = {
      id: 'd', name: 'Loan', kind: 'loan', accountId: 'd',
      plans: [{ id: 'p', name: 'Car', type: 'balance', original: 100000, remaining: 100000, asOf: '2026-11-01', purchaseDate: '2026-11-01', payment: 20000 }],
    };
    applyPayment(debt, 5000, s, '2026-11-10');
    expect(planSchedule(debt, debt.plans[0], s).payments[0]).toMatchObject({ date: '2026-11-19', amount: 20000 });
  });

  it("a payment recorded late, dated before a payday that has since gone out, doesn't bring that payday back", () => {
    const s = budget().settings;
    const debt: Debt = {
      id: 'd', name: 'Loan', kind: 'loan', accountId: 'd',
      plans: [{ id: 'p', name: 'Car', type: 'balance', original: 100000, remaining: 100000, asOf: '2026-11-01', purchaseDate: '2026-11-01', payment: 20000 }],
    };
    recordHistory(debt, '2026-11-01');
    // The 19 Nov payday's $200 counts as paid the day after…
    settleDue(debt, s, '2026-11-20');
    expect(debt.plans[0]).toMatchObject({ remaining: 80000, asOf: '2026-11-20' });
    // …and on the 22nd, an extra $50 paid back on the 15th is recorded.
    applyPayment(debt, 5000, s, '2026-11-15');
    expect(debt.plans[0]).toMatchObject({ remaining: 75000, asOf: '2026-11-20' });
    // The 19 Nov payday isn't planned (and counted as paid) a second time.
    expect(settleDue(debt, s, '2026-11-22')).toBe(false);
    expect(debt.plans[0].remaining).toBe(75000);
    expect(planSchedule(debt, debt.plans[0], s).payments[0].date).toBe('2026-12-18');
    // What was owed comes down from the day it was paid, not just from today.
    expect(debt.history).toEqual([{ amount: 100000, asOf: '2026-11-01' }, { amount: 95000, asOf: '2026-11-15' }, { amount: 75000, asOf: '2026-11-20' }]);
  });

  it("Gem with no statement day: a payment made on payday is that payday's payment, not an extra one", () => {
    const s = budget().settings;
    const debt: Debt = {
      id: 'g', name: 'Gem', kind: 'card', rules: 'gem', accountId: 'g',
      plans: [{ id: 'p', name: 'Couch', type: 'interest-free', months: 6, original: 60000, remaining: 60000, asOf: '2026-11-01', purchaseDate: '2026-11-01' }],
    };
    expect(debtSchedules(debt, s).flatMap((x) => x.payments)[0].date).toBe('2026-11-19');
    applyPayment(debt, 10000, s, '2026-11-19');
    expect(debt.plans[0].remaining).toBe(50000);
    expect(debtSchedules(debt, s).flatMap((x) => x.payments)[0].date).toBe('2026-12-18');
  });
});

describe('undoing a spend from a goal', () => {
  const goal = (): SavingsGoal => ({ id: 'g', name: 'G', accountId: 'sv', balance: 10000, asOf: '2026-11-01', costs: [{ id: 'c', name: 'C', amount: 50000, category: 'x' }] });

  it('can put the money back', () => {
    const g = goal();
    spendFromGoal(g, { id: 's', amount: 4000, date: '2026-11-12' }, { costId: 'c' });
    removeSpend(g, 'c', 's');
    expect(g.balance).toBe(10000);
  });

  it('can leave the balance alone (e.g. the spend was more than was saved)', () => {
    const g = goal();
    spendFromGoal(g, { id: 's', amount: 30000, date: '2026-11-12' }, { costId: 'c' });
    expect(g.balance).toBe(0);
    removeSpend(g, 'c', 's', false);
    expect(g.balance).toBe(0);
    expect(g.costs?.[0].spends).toEqual([]);
  });

  it("a spend dated ahead doesn't date the balance ahead (the paydays before it would stop counting)", () => {
    const g = goal();
    spendFromGoal(g, { id: 's', amount: 1000, date: '2026-12-25' }, { costId: 'c' }, '2026-11-12');
    expect(g).toMatchObject({ balance: 9000, asOf: '2026-11-12' });
  });
});

describe('checking what comes in', () => {
  it('a lone "." or "-" is not an amount', () => {
    for (const bad of ['', '.', '-', '-.', 'abc', '1.234', '1..2']) expect(parseMoney(bad), bad).toBeNull();
    expect(parseMoney('.5')).toBe(50);
    expect(parseMoney('$1,234.56')).toBe(123456);
    expect(parseMoney('-20')).toBe(-2000);
  });

  it('a backup or the synced file has to have the shape of a budget', () => {
    expect(looksLikeBudget(budget())).toBe(true);
    expect(looksLikeBudget(JSON.parse(JSON.stringify(budget())))).toBe(true);
    const cut = budget() as Partial<Budget>;
    delete cut.split;
    for (const bad of [null, 'budget', [], { version: 1, accounts: [] }, { ...budget(), version: 2 }, cut, { ...budget(), items: [null] }]) expect(looksLikeBudget(bad)).toBe(false);
  });
});

describe('automatic balancing', () => {
  it('always runs, and says which payday amount it gives an account', () => {
    const b = budget();
    b.accounts.push({ id: 'bills', name: 'Bills', kind: 'bank', color: '#000', groupId: 'needs' }, { id: 'food', name: 'Food', kind: 'bank', color: '#000', groupId: 'needs' }, { id: 'spare', name: 'Spare', kind: 'bank', color: '#000', groupId: 'needs' });
    b.split.push({ accountId: 'bills', amount: 30000, mode: 'fixed' }, { accountId: 'food', amount: 90000, mode: 'fixed' }, { accountId: 'spare', amount: 5000, mode: 'fixed' });
    b.items.push({ id: 'i1', name: 'Power', amount: 20000, frequency: 'monthly', start: '2026-01-25', accountId: 'bills' });
    b.items.push({ id: 'i2', name: 'Food', amount: 20000, frequency: 'weekly', start: '2026-01-05', accountId: 'food' });
    expect([balancedMode(b, 'bills'), balancedMode(b, 'food'), balancedMode(b, 'spare')]).toEqual(['not-fixed', 'smooth', undefined]);
    autoBalance(b, '2026-11-12'); // settings.autoBalance is false in this budget: it's ignored now
    expect(b.split.map((l) => l.mode)).toEqual(['exact', 'smooth', 'fixed']);
  });

  it('when the payday changes, what it set for pays that no longer exist is undone', () => {
    // $5,100 a pay goes to savings out of a $5,000 pay, so balancing saves $100 less each pay.
    const b = budget();
    b.accounts.push({ id: 'sv', name: 'Savings', kind: 'bank', color: '#000', groupId: 'savings' });
    b.split.push({ accountId: 'sv', amount: 510000, mode: 'fixed' });
    const today = '2026-11-14';
    autoBalance(b, today);
    expect(b.overrides?.['2026-11-19']?.sv).toBe(500000);

    // Paid on the 20th: the trim moves to the pay starting Fri 20 Nov, and 19 Nov's (no longer a pay) goes.
    b.settings.paydayDay = 20;
    autoBalance(b, today);
    expect(b.overrides?.['2026-11-19']).toBeUndefined();
    expect(b.autoBalanced?.['2026-11-20']?.sv).toMatchObject({ prev: null, to: 500000 });
    // An amount set by hand for that pay, and a past pay's record, to check they're left alone.
    b.overrides!['2026-11-20'].food = 12300;
    b.autoBalanced!['2026-10-20'] = { sv: { prev: null, to: 25000, reason: 'An earlier pay' } };
    b.overrides!['2026-10-20'] = { sv: 25000 };

    // Back to the 19th: no pay starts on 20 Nov any more, so its trim goes rather than lingering…
    b.settings.paydayDay = 19;
    autoBalance(b, today);
    expect(b.autoBalanced?.['2026-11-20']).toBeUndefined();
    expect(b.overrides?.['2026-11-20']).toEqual({ food: 12300 }); // …but what you set yourself stays
    expect(b.overrides?.['2026-11-19']?.sv).toBe(500000);
    // A pay that had already started keeps its record (it's history, and comes back if the payday does).
    expect(b.autoBalanced?.['2026-10-20']).toBeDefined();
    expect(b.overrides?.['2026-10-20']).toEqual({ sv: 25000 });
  });
  it('an account set to round to $50 is trimmed to a round $50, the few dollars over left over', () => {
    // $5,000 pay: $1,030 to Fun and $4,263.40 to the wedding fund is $293.40 short.
    const b = budget();
    b.accounts.push({ id: 'wed', name: 'Wedding', kind: 'bank', color: '#000', groupId: 'savings', round: 5000 }, { id: 'fun', name: 'Fun', kind: 'bank', color: '#000', groupId: 'lifestyle' });
    b.split.push({ accountId: 'wed', amount: 426340, mode: 'fixed' }, { accountId: 'fun', amount: 103000, mode: 'fixed' });
    const p = periodContaining('2026-11-20', b.settings);
    const r = balancePay(b, p, '2026-11-14');
    const wed = r.changes.find((c) => c.accountId === 'wed')!;
    expect(wed.to).toBe(395000); // not $3,970.00
    expect(r.after).toBe(2000);
    expect(wed.to % 5000).toBe(0);
    expect(r.after).toBeGreaterThanOrEqual(0);
    expect(r.after).toBeLessThan(5000);
    // Rounding off: trimmed by exactly what's short.
    b.accounts.find((a) => a.id === 'wed')!.round = 0;
    expect(balancePay(b, p, '2026-11-14').changes.find((c) => c.accountId === 'wed')!.to).toBe(396940);
  });

  it("never 'trims' the account pay lands in: nothing is sent to it", () => {
    const b = budget();
    b.settings.expectedPay = 30000;
    b.accounts[0].groupId = 'savings'; // the pay account, counted as savings
    b.accounts.push({ id: 'x', name: 'Bills', kind: 'bank', color: '#000', groupId: 'needs' });
    b.split.push({ accountId: 'x', amount: 0, mode: 'exact' });
    b.items.push({ id: 'i', name: 'Power', amount: 60000, frequency: 'monthly', start: '2026-11-25', accountId: 'x' });
    const p = periodContaining('2026-11-19', b.settings);
    b.overrides = { [p.start]: { x: 10000 } }; // sent $100 by hand, so it's $500 short
    const r = balancePay(b, p, '2026-11-12');
    expect(r.shortAccounts.map((a) => a.accountId)).toEqual(['x']);
    expect(r.changes.map((c) => c.accountId)).toEqual(['x']);
  });

  it('a short account set to round tops up to the next round amount', () => {
    const b = budget();
    b.accounts.push({ id: 'bills', name: 'Bills', kind: 'bank', color: '#000', groupId: 'needs', round: 5000 });
    b.split.push({ accountId: 'bills', amount: 10000, mode: 'fixed' });
    b.items.push({ id: 'p', name: 'Power', amount: 13210, frequency: 'monthly', start: '2026-01-25', accountId: 'bills' });
    const p = periodContaining('2026-11-20', b.settings);
    b.overrides = { [p.start]: { bills: 10000 } }; // $100 set for this pay: $32.10 short
    const c = balancePay(b, p, '2026-11-14').changes.find((x) => x.accountId === 'bills')!;
    expect(c.to).toBe(15000); // needs $132.10: $150, not $132.10
  });
});

describe('money put aside (a car fund)', () => {
  const today = '2026-11-14';
  /** A car account: $130 a month for maintenance and tyres, and $70 a month for the WOF, both put aside. */
  function car(): Budget {
    const b = budget();
    b.accounts.push({ id: 'car', name: 'Car', kind: 'bank', color: '#000', groupId: 'needs' });
    b.split.push({ accountId: 'car', amount: 0, mode: 'exact' });
    b.items.push(
      { id: 'm', name: 'Motor maintenance', amount: 13000, frequency: 'monthly', start: '2026-11-01', accountId: 'car', setAside: true },
      { id: 'w', name: 'WOF', amount: 7000, frequency: 'monthly', start: '2026-11-01', accountId: 'car', setAside: true },
    );
    return b;
  }
  const pay = (b: Budget, n = 0) => shiftPeriod(periodContaining('2026-11-19', b.settings), n, b.settings);

  it('every payday puts it in, however much has built up, and none of it comes out', () => {
    const b = car();
    // $1,200 already saved up in the account. Before, Exact counted it towards the next "bills" and sent nothing.
    b.balances = { car: { amount: 120000, asOf: today } };
    // $130 + $70 every pay.
    expect(depositFor(b, 'car', pay(b), today)).toBe(20000);
    expect(depositFor(b, 'car', pay(b, 6), today)).toBe(20000);
    expect(outflows(b, 'car', today, '2027-12-31')).toEqual([]);
    // Paydays 19 Nov, Fri 18 Dec and 19 Jan: it keeps building up.
    expect(estimateBalance(b, 'car', '2027-01-31', today)).toBe(120000 + 3 * 20000);
    expect(averageNeed(b, 'car')).toBe(20000);
    // Something put aside yearly is spread over the year: a $90 WOF is $7.50 a pay.
    expect(setAsidePerPay({ amount: 9000, frequency: 'yearly' })).toBe(750);
  });

  it("counts in what the account needs, but isn't one of the pay's payments", () => {
    const b = car();
    const plan = planFor(b, pay(b), today);
    const acc = plan.accounts.find((a) => a.account.id === 'car')!;
    expect(acc.need).toBe(20000);
    expect(acc.funded).toBe(20000);
    expect(acc.dues.map((d) => [d.item.name, d.item.amount, d.date])).toEqual([['Motor maintenance', 13000, '2026-11-19'], ['WOF', 7000, '2026-11-19']]);
    expect(plan.dues).toEqual([]);
    // Not put aside before its start: a set-aside starting 1 Dec is first funded on Fri 18 Dec.
    b.items.push({ id: 't', name: 'Tyres', amount: 2000, frequency: 'monthly', start: '2026-12-01', accountId: 'car', setAside: true });
    expect([depositFor(b, 'car', pay(b), today), depositFor(b, 'car', pay(b, 1), today)]).toEqual([20000, 22000]);
  });

  it('moved to an account with a fixed amount (a savings account sending $0), it is still sent', () => {
    const b = car();
    b.split.find((l) => l.accountId === 'car')!.mode = 'fixed';
    expect(depositFor(b, 'car', pay(b), today)).toBe(20000);
    expect(planFor(b, pay(b), today).accounts.find((a) => a.account.id === 'car')!.funded).toBe(20000);
    // A fixed amount above it is kept as it is.
    b.split.find((l) => l.accountId === 'car')!.amount = 50000;
    expect(depositFor(b, 'car', pay(b), today)).toBe(50000);
  });

  it('with bills in the same account: the bills are paid as usual, and what has built up is never spent on them', () => {
    const b = car();
    b.items.push({ id: 'ins', name: 'Car insurance', amount: 6000, frequency: 'monthly', start: '2026-11-25', accountId: 'car' });
    b.balances = { car: { amount: 80000, asOf: today } };
    expect(depositFor(b, 'car', pay(b), today)).toBe(26000);
    expect(depositFor(b, 'car', pay(b, 3), today)).toBe(26000);
    // Only the insurance comes out: the $800 grows by $200 a pay.
    expect(outflows(b, 'car', today, '2026-12-17').map((o) => o.name)).toEqual(['Car insurance']);
    expect(estimateBalance(b, 'car', '2026-12-17', today)).toBe(80000 + 26000 - 6000);
  });

  it('payday always follows it (never a fixed amount that could send too little), and balancing never calls it spare', () => {
    const b = car();
    expect(balancedMode(b, 'car')).toBe('not-fixed');
    // Left on a fixed $0 with $1,200 built up, nothing would look wrong, but nothing would go in.
    b.split.find((l) => l.accountId === 'car')!.mode = 'fixed';
    b.balances = { car: { amount: 120000, asOf: today } };
    autoBalance(b, today);
    expect(b.split.find((l) => l.accountId === 'car')!.mode).toBe('exact');
    expect(depositFor(b, 'car', pay(b), today)).toBe(20000);
    // A weekly bill alongside it makes it Steady.
    b.items.push({ id: 'fuel', name: 'Petrol', amount: 6000, frequency: 'weekly', start: '2026-11-20', accountId: 'car' });
    expect(balancedMode(b, 'car')).toBe('smooth');

    // A pay that's short looks for spare money: $5,000 in the car fund isn't.
    const c = car();
    c.items.push({ id: 'ins', name: 'Car insurance', amount: 6000, frequency: 'monthly', start: '2026-11-25', accountId: 'car' });
    c.balances = { car: { amount: 500000, asOf: today } };
    c.settings.expectedPay = 5000;
    const r = balancePay(c, pay(c), today);
    expect(r.notSpare.find((x) => x.accountId === 'car')?.reason).toMatch(/put aside for Motor maintenance and WOF/);
    // What's put aside is paused for the pay, but never the insurance.
    expect(r.changes).toEqual([expect.objectContaining({ accountId: 'car', from: 26000, to: 6000 })]);
    expect(r.changes[0].reason).toMatch(/this pay only/);
  });

  it('a pay that puts less aside is just less put aside: the next pay is the usual amount', () => {
    const b = car();
    b.items.push({ id: 'ins', name: 'Car insurance', amount: 6000, frequency: 'monthly', start: '2026-11-25', accountId: 'car' });
    b.overrides = { [pay(b).start]: { car: 6000 } };
    expect(depositFor(b, 'car', pay(b, 1), today)).toBe(26000);
    // Sending less than even the bills need is still made up next pay.
    b.overrides = { [pay(b).start]: { car: 4000 } };
    expect(depositFor(b, 'car', pay(b, 1), today)).toBe(28000);
  });
});

describe("an account's history and one-off costs", () => {
  const today = '2026-11-16';
  function car(): Budget {
    const b = budget();
    b.accounts.push({ id: 'car', name: 'Car', kind: 'bank', color: '#000', groupId: 'needs' });
    b.split.push({ accountId: 'car', amount: 0, mode: 'exact' });
    b.items.push(
      { id: 'm', name: 'Motor maintenance', amount: 13000, frequency: 'monthly', start: '2026-11-01', accountId: 'car', setAside: true },
      { id: 'w', name: 'WOF', amount: 7000, frequency: 'monthly', start: '2026-11-01', accountId: 'car', setAside: true },
    );
    setBalance(b, 'car', 120000, '2026-11-14', 'b1');
    return b;
  }
  const next = (b: Budget) => shiftPeriod(periodContaining(today, b.settings), 1, b.settings);

  it('a one-off cost comes off what is in the account, and is kept in the history', () => {
    const b = car();
    expect(recordCost(b, 'car', { amount: 18000, date: '2026-11-16', note: 'Tyre puncture' }, 'c1')).toBe(true);
    expect(balanceToday(b, 'car', today)).toBe(102000);
    expect(accountHistory(b, 'car').map((e) => [e.kind, e.date, e.amount, e.note])).toEqual([
      ['cost', '2026-11-16', 18000, 'Tyre puncture'], ['balance', '2026-11-14', 120000, undefined],
    ]);
    // Paid from what's put aside: payday still puts aside $200, and the fund builds up again from $1,020.
    expect(depositFor(b, 'car', next(b), today)).toBe(20000);
    expect(estimateBalance(b, 'car', '2026-11-30', today)).toBe(102000 + 20000);
    // Nothing to take it from without a balance.
    const c = budget();
    expect(recordCost(c, 'everyday', { amount: 100, date: today, note: 'x' }, 'c')).toBe(false);
    expect(c.accountHistory).toBeUndefined();
  });

  it('from a bills account, next payday makes it up', () => {
    const b = budget();
    b.accounts.push({ id: 'bills', name: 'Bills', kind: 'bank', color: '#000', groupId: 'needs' });
    b.split.push({ accountId: 'bills', amount: 0, mode: 'exact' });
    b.items.push({ id: 'p', name: 'Power', amount: 20000, frequency: 'monthly', start: '2026-11-17', accountId: 'bills' });
    // $200 there now covers the 17 Nov power bill, so the next pay sends the 17 Dec one's $200.
    setBalance(b, 'bills', 20000, today, 'b1');
    expect(depositFor(b, 'bills', next(b), today)).toBe(20000);
    recordCost(b, 'bills', { amount: 5000, date: today, note: 'Late fee' }, 'c1');
    expect(depositFor(b, 'bills', next(b), today)).toBe(25000);
  });

  it('removing a cost can put its money back, or leave the balance as it is', () => {
    const b = car();
    recordCost(b, 'car', { amount: 18000, date: today, note: 'Tyre puncture' }, 'c1');
    recordCost(b, 'car', { amount: 9000, date: '2026-11-15', note: 'Wipers' }, 'c2');
    expect(balanceToday(b, 'car', today)).toBe(93000);
    // Recorded later but paid earlier: listed by the day it was paid.
    expect(accountHistory(b, 'car').map((e) => e.id)).toEqual(['c1', 'c2', 'b1']);
    removeCost(b, 'car', 'c1', true);
    expect(balanceToday(b, 'car', today)).toBe(111000);
    removeCost(b, 'car', 'c2', false);
    expect(balanceToday(b, 'car', today)).toBe(111000);
    expect(accountHistory(b, 'car').map((e) => e.id)).toEqual(['b1']);
    // A balance can't be removed this way.
    removeCost(b, 'car', 'b1', true);
    expect(accountHistory(b, 'car')).toHaveLength(1);
  });

  it('notes each balance you enter; entering it again straight away replaces the note', () => {
    const b = car();
    setBalance(b, 'car', 110000, '2026-11-14', 'b2');
    expect(accountHistory(b, 'car').map((e) => [e.id, e.amount])).toEqual([['b1', 110000]]);
    recordCost(b, 'car', { amount: 5000, date: '2026-11-14', note: 'Car wash' }, 'c1');
    setBalance(b, 'car', 104000, '2026-11-14', 'b3');
    expect(b.balances?.car).toEqual({ amount: 104000, asOf: '2026-11-14' });
    expect(accountHistory(b, 'car').map((e) => e.id)).toEqual(['b3', 'c1', 'b1']);
  });
});

describe('reading a statement', () => {
  it('finds the balance, date, limit and minimum in a card statement', () => {
    const s = parseStatementText(`Gem Visa  Statement date: 21 Oct 2026
      Opening balance $1,902.11  Purchases $340.00  Payments -$500.00 CR
      Closing balance   $1,742.11   Credit limit $8,000.00  Available credit $6,257.89
      Minimum payment due $52.00 by 15 Nov 2026`);
    expect(s).toEqual({ balance: 174211, date: '2026-10-21', limit: 800000, available: 625789, minimum: 5200 });
  });

  it('reads other wordings, a balance in credit, and limit minus available', () => {
    expect(parseStatementText('Total amount owing: 2,340.50 as at 03/11/2026')).toMatchObject({ balance: 234050, date: '2026-11-03' });
    expect(parseStatementText('Current balance $12.40 CR').balance).toBe(0);
    expect(parseStatementText('Credit limit $5,000.00 Available to spend $4,100.00').balance).toBe(90000);
    expect(parseStatementText('A photo of a cat').balance).toBeUndefined();
  });

  it('reads dates day first', () => {
    expect([parseDate('21 October 2026'), parseDate('October 21, 2026'), parseDate('3/11/26'), parseDate('31-12-2026'), parseDate('soon')])
      .toEqual(['2026-10-21', '2026-10-21', '2026-11-03', '2026-12-31', undefined]);
  });

  it('tells a payslip from a statement, and picks the debt it names', () => {
    expect(classifyText('Pay Day: 19-Nov-2026 Total Payments $4,000.00').kind).toBe('payslip');
    expect(classifyText('Closing balance $10.00').kind).toBe('statement');
    const debts: Debt[] = [
      { id: 'a', name: 'Gem Visa', kind: 'card', rules: 'gem', accountId: 'a', plans: [] },
      { id: 'b', name: 'Q Mastercard', kind: 'card', rules: 'mastercard', accountId: 'b', plans: [] },
    ];
    expect(matchDebt(debts, 'Your Q Mastercard statement')?.id).toBe('b');
    expect(matchDebt(debts, 'GEM VISA closing balance')?.id).toBe('a');
    expect(matchDebt(debts, 'Power bill')).toBeUndefined();
  });

  it('sets what the debt owes as at the statement date', () => {
    const b = budget();
    b.debts = [{ id: 'a', name: 'Card', kind: 'card', accountId: 'a', limit: 500000, plans: [] }];
    recordStatement(b, 'a', { balance: 174211, date: '2026-11-10', limit: 800000 }, '2026-11-12');
    expect(b.debts[0]).toMatchObject({ balance: { amount: 174211, asOf: '2026-11-10' }, limit: 800000, history: [{ amount: 174211, asOf: '2026-11-10' }] });
    // A date in the future (misread) counts as today.
    recordStatement(b, 'a', { balance: 100000, date: '2027-01-01' }, '2026-11-12');
    expect(b.debts[0].balance).toEqual({ amount: 100000, asOf: '2026-11-12' });
  });
});

describe('optimising the leftover, then changing it', () => {
  function twoGoals() {
    const b = budget();
    for (const id of ['a', 'b']) {
      b.accounts.push({ id, name: id, kind: 'bank', color: '#000', groupId: 'savings' });
      b.split.push({ accountId: id, amount: 10000, mode: 'fixed' });
    }
    b.savings = ['a', 'b'].map((id) => ({ id, name: id, accountId: id, balance: 0, asOf: '2026-11-12' }));
    return b;
  }
  const funded = (b: Budget, p: ReturnType<typeof periodContaining>, id: string) => planFor(b, p).accounts.find((a) => a.account.id === id)!.funded;

  it('this pay only: editing swaps the old amounts for the new ones', () => {
    const b = twoGoals();
    const p = periodContaining('2026-11-20', b.settings);
    const start = planFor(b, p).leftover;
    const first = applyAllocation(b, p, [{ targetId: 'goal-a', amount: 30000 }], 'once');
    expect(planFor(b, p).leftover).toBe(start - 30000);
    // Edit: put back what Optimise did, then hand it out again.
    undoAllocation(b, first);
    expect(planFor(b, p).leftover).toBe(start);
    applyAllocation(b, p, [{ targetId: 'goal-a', amount: 5000 }, { targetId: 'goal-b', amount: 20000 }], 'once');
    expect(funded(b, p, 'a')).toBe(15000);
    expect(funded(b, p, 'b')).toBe(30000);
    expect(planFor(b, p).leftover).toBe(start - 25000);
  });

  it('finds extra already added for this pay only, so Optimise can hand it out again', () => {
    const b = twoGoals();
    const p = periodContaining('2026-11-20', b.settings);
    b.overrides = { [p.start]: { a: 40000 } }; // $300 on top of the usual $100, set without Optimise
    const start = planFor(b, p).leftover;
    const x = existingExtras(b, p)!;
    expect(x.allocs).toEqual([{ targetId: 'goal-a', amount: 30000 }]);
    // Hand it all out again: $200 back to goal a, $100 plus what was left to goal b.
    undoAllocation(b, x);
    expect(planFor(b, p).leftover).toBe(start + 30000);
    applyAllocation(b, p, [{ targetId: 'goal-a', amount: 20000 }, { targetId: 'goal-b', amount: 10000 + start }], 'once');
    expect(funded(b, p, 'a')).toBe(30000);
    expect(planFor(b, p).leftover).toBe(0);
    // An amount set lower than usual isn't extra.
    b.overrides = { [p.start]: { a: 5000 } };
    expect(existingExtras(b, p)).toBeNull();
  });

  it('every pay: editing changes the normal amount rather than adding to it', () => {
    const b = twoGoals();
    const p = periodContaining('2026-11-20', b.settings);
    const first = applyAllocation(b, p, [{ targetId: 'goal-a', amount: 30000 }], 'every');
    expect(b.split.find((l) => l.accountId === 'a')!.amount).toBe(40000);
    undoAllocation(b, first);
    applyAllocation(b, p, [{ targetId: 'goal-a', amount: 10000 }], 'every');
    expect(b.split.find((l) => l.accountId === 'a')!.amount).toBe(20000);
  });
});

// ---------------------------------------------------------------------------------------------
// Reading documents with Google's Gemini. The AI is always faked here: these check what the app does
// with an answer (the checks, the changes, no doubling, Undo), and how each error is told apart.
// ---------------------------------------------------------------------------------------------

describe('reading documents: figures, dates and errors', () => {
  it('reads amounts as printed, and refuses anything that isn’t a sensible amount or a real date', () => {
    expect(toCents('1,240.50')).toEqual({ cents: 124050, credit: false });
    expect(toCents('$12.40 CR')).toEqual({ cents: 1240, credit: true });
    expect(toCents('-5.00')).toEqual({ cents: 500, credit: true });
    expect(toCents('')).toBeUndefined();
    expect([toCents('12.4.5'), toCents('about $40'), toCents('2000000.00')]).toEqual([null, null, null]);
    expect([validDate('2026-11-03'), validDate('2026-02-30'), validDate('03/11/2026'), validDate('1999-01-01')]).toEqual(['2026-11-03', undefined, undefined, undefined]);
  });

  it('tells each of Google’s errors apart', () => {
    const kind = (status: number, body: unknown) => classifyHttpError(status, body).kind;
    expect(kind(401, {})).toBe('bad_key');
    expect(kind(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } })).toBe('bad_key');
    expect(kind(402, { error: { code: 'payment_required', message: 'Your Prepay credit balance is depleted.' } })).toBe('no_credit');
    expect(kind(404, { error: { code: 404, status: 'NOT_FOUND', message: 'models/gemini-1.0 is not found' } })).toBe('model_gone');
    expect(kind(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } })).toBe('daily_quota');
    expect(kind(429, { error: { code: 'quota_exceeded', message: 'You have exceeded your daily quota.' } })).toBe('daily_quota');
    expect(kind(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }] }] } })).toBe('too_fast');
    expect(kind(429, { error: { code: 429, message: 'You have exceeded your monthly spending cap.' } })).toBe('spend_cap');
    expect(kind(400, { error: { code: 'failed_precondition', message: 'Billing is not enabled.' } })).toBe('billing_needed');
    expect(kind(403, { error: { code: 403, status: 'PERMISSION_DENIED' } })).toBe('bad_key');
    expect(kind(503, {})).toBe('overloaded');
    expect(kind(504, {})).toBe('timeout');
    // The daily allowance resets at midnight Pacific time: 9 pm in NZ in November.
    expect(nzTime(nextPacificMidnight(new Date('2026-11-16T03:00:00Z')))).toMatch(/^9:00\spm$/i);
  });

  const reply = (text: string, extra: object = {}) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking…', thought: true }, { text }] } }], ...extra });

  it('a reply is used only if it’s the form; a blocked or empty one says why', () => {
    expect(parseReply(reply('{"kind":"payslip","payslip":{"payDay":"2026-11-19"}}')).kind).toBe('payslip');
    expect(() => parseReply(reply('not json'))).toThrow(ReaderError);
    expect(() => parseReply(reply('{"kind":"recipe"}'))).toThrowError(expect.objectContaining({ kind: 'unusable' }));
    expect(() => parseReply({ candidates: [{ finishReason: 'SPII' }] })).toThrowError(expect.objectContaining({ kind: 'refused_personal' }));
    expect(() => parseReply({ promptFeedback: { blockReason: 'SAFETY' } })).toThrowError(expect.objectContaining({ kind: 'refused' }));
    expect(() => parseReply({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] })).toThrowError(expect.objectContaining({ kind: 'unusable' }));
  });

  it('the form makes Gemini answer every field (null when not shown), and the nulls are dropped again', () => {
    // With optional fields the real Gemini sometimes stopped early: a payslip with only its gross pay,
    // a Gem statement with no balance. Every object in the form must list all its fields as required.
    const walk = (s: Record<string, unknown>, at: string) => {
      const props = s.properties as Record<string, Record<string, unknown>> | undefined;
      if (props) {
        expect(new Set(s.required as string[]), at).toEqual(new Set(Object.keys(props)));
        for (const [k, v] of Object.entries(props)) walk(v, `${at}.${k}`);
      }
      if (s.items) walk(s.items as Record<string, unknown>, `${at}[]`);
    };
    walk(RESPONSE_SCHEMA, 'form');
    const ex = parseReply(reply(JSON.stringify({
      kind: 'statement', payslip: null, afterpay: null, notes: null,
      statement: { debtId: null, balance: { amount: '3,084.17', label: 'Closing balance' }, limit: null, plans: [{ planId: null, remaining: { amount: '870.00', label: 'Plan balance' }, ends: '2027-03-21' }], purchases: [], paymentsShown: [] },
    })));
    expect(ex).toEqual({ kind: 'statement', statement: { balance: { amount: '3,084.17', label: 'Closing balance' }, plans: [{ remaining: { amount: '870.00', label: 'Plan balance' }, ends: '2027-03-21' }], purchases: [], paymentsShown: [] } });
    // And it still checks the same as a reply that left those fields out.
    const d = toDraft(ex, debtBudget(), 'gemini', seq());
    expect(d.statement).toMatchObject({ debtId: '', limit: { value: '' }, plans: [{ planId: '', ends: '2027-03-21' }] });
  });

  it('sends the key in a header (never in the address) with the document and the list of debts', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ candidates: [{ content: { parts: [{ text: '{"kind":"unknown"}' }] } }] });
    }) as unknown as typeof fetch;
    const ctx = buildContext(debtBudget(), '2026-11-16');
    expect(ctx.debts.find((d) => d.id === 'studentloan')).toMatchObject({ studentLoan: true });
    // A card plan goes by name only: given its expiry and balance, Gemini copied them over the
    // statement's (or misread the printed date towards them). The app matches plans by expiry itself.
    expect(ctx.debts.find((d) => d.id === 'gem')!.plans[0]).toEqual({ id: 'g1', name: 'Purchases Jun – Jul 2026', type: 'interest-free' });
    // Afterpay orders have nothing printed to match on, so they keep their dates and amounts.
    expect(ctx.debts.find((d) => d.id === 'afterpay')!.plans[1]).toMatchObject({ id: 'ap-2', purchaseDate: '2026-10-08', total: '24.66', nextInstalment: { date: '2026-11-19', amount: '6.17' } });
    await geminiProvider(fake).read({ name: 'a.jpg', mimeType: 'image/jpeg', base64: 'AAAA', bytes: 3 }, ctx, { key: 'k-123', model: 'gemini-3.5-flash-lite' });
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(calls[0].url).not.toContain('k-123');
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('k-123');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
    expect(body.contents[0].parts[1].text).toContain('"g1"');
    expect(body.generationConfig.responseFormat).toEqual({ text: { mimeType: 'APPLICATION_JSON', schema: RESPONSE_SCHEMA } });
    // A failed call becomes the right error.
    const failing = (async () => new Response(JSON.stringify({ error: { code: 'payment_required' } }), { status: 402 })) as unknown as typeof fetch;
    await expect(geminiProvider(failing).read({ name: 'a.pdf', mimeType: 'application/pdf', base64: 'AA', bytes: 1 }, ctx, { key: 'k', model: 'm' })).rejects.toMatchObject({ kind: 'no_credit' });
  });

  it('a photo this browser can’t redraw (HEIC outside Safari) is sent as it is, which Google reads', async () => {
    // There's no canvas here, so every photo takes the "can't redraw" path, as HEIC does in Chrome.
    const heic = await prepareFile(new File([new Uint8Array([1, 2, 3])], 'IMG_0412.HEIC', { type: '' }));
    expect(heic).toMatchObject({ mimeType: 'image/heic', base64: 'AQID', bytes: 3 });
    expect((await prepareFile(new File([new Uint8Array([1])], 'photo.heif', { type: 'image/heif' }))).mimeType).toBe('image/heif');
    await expect(prepareFile(new File([new Uint8Array([1])], 'scan.tiff', { type: 'image/tiff' }))).rejects.toMatchObject({ kind: 'bad_file' });
  });
});

/** A budget with debts like the real one: a student loan from salary, Gem, a Q card and Afterpay. */
function debtBudget(): Budget {
  const b = budget();
  for (const id of ['gem', 'qcard', 'afterpay']) {
    b.accounts.push({ id, name: id, kind: 'external', color: '#000', groupId: 'debt' });
    b.split.push({ accountId: id, amount: 0, mode: 'exact' });
  }
  b.debts = [
    { id: 'studentloan', name: 'Student loan', kind: 'loan', accountId: 'studentloan', plans: [], payroll: { perPay: 30000 }, balance: { amount: 2000000, asOf: '2026-11-01' } },
    {
      id: 'gem', name: 'Gem Visa', kind: 'card', rules: 'gem', accountId: 'gem', statementDay: 21, limit: 800000, balance: { amount: 300000, asOf: '2026-11-01' },
      plans: [
        { id: 'g1', name: 'Purchases Jun – Jul 2026', type: 'interest-free', original: 150000, remaining: 120000, asOf: '2026-11-01', purchaseDate: '2026-07-09', ends: '2027-01-20' },
        { id: 'g2', name: 'Purchases Aug – Sep 2026', type: 'interest-free', original: 100000, remaining: 90000, asOf: '2026-11-01', purchaseDate: '2026-09-09', ends: '2027-03-20' },
      ],
    },
    { id: 'qcard', name: 'Q Mastercard', kind: 'card', rules: 'mastercard', accountId: 'qcard', balance: { amount: 50000, asOf: '2026-11-01' }, plans: [] },
    {
      id: 'afterpay', name: 'Afterpay', kind: 'bnpl', rules: 'afterpay', accountId: 'afterpay',
      plans: [
        { id: 'ap-1', name: 'Spotlight NZ', type: 'afterpay', original: 4400, remaining: 1100, asOf: '2026-11-11', purchaseDate: '2026-09-24', instalments: [{ date: '2026-11-19', amount: 1100, label: '4 of 4' }] },
        { id: 'ap-2', name: 'FreshChoice', type: 'afterpay', original: 2466, remaining: 1233, asOf: '2026-11-11', purchaseDate: '2026-10-08', instalments: [{ date: '2026-11-19', amount: 617, label: '3 of 4' }, { date: '2026-12-03', amount: 616, label: '4 of 4' }] },
      ],
    },
  ];
  return b;
}

/** Ids that are the same every run, so a copy and the real change agree. */
const seq = () => { let n = 0; return () => `new${++n}`; };
const checkDoc = (b: Budget, ex: Extraction, today: string, edit?: (d: Draft) => void) => {
  const d = toDraft(ex, b, 'gemini', seq(), today);
  edit?.(d);
  return review(d, b, today);
};
/** Read, check and apply a document, as Confirm does. */
function upload(b: Budget, ex: Extraction, today: string, edit?: (d: Draft) => void) {
  const r = checkDoc(b, ex, today, edit);
  if (!r.proposal) throw new Error(`blocked: ${r.issues.map((i) => i.text).join(' / ')}`);
  applyProposal(b, r.proposal, today);
  return r;
}
const gemStatement = (date: string, plans: { planId?: string | null; remaining: string; ends: string }[], balance = '2800.00'): Extraction => ({
  kind: 'statement',
  statement: { debtId: 'gem', nameOnDocument: 'Gem Visa', balance: { amount: balance, label: 'Closing balance' }, statementDate: date, plans: plans.map((p) => ({ ...p, remaining: { amount: p.remaining } })) },
});
const debt = (b: Budget, id: string) => b.debts!.find((d) => d.id === id)!;

describe('reading documents: statements', () => {
  it('asks first when the debt isn’t one of yours, or is Afterpay', () => {
    const b = debtBudget();
    const blocks = (debtId: string) => checkDoc(b, { kind: 'statement', statement: { debtId, balance: { amount: '100.00' }, statementDate: '2026-11-10' } }, '2026-11-16').issues.filter((i) => i.level === 'block').map((i) => i.text).join(' ');
    expect(blocks('made-up')).toMatch(/Choose which debt/);
    expect(blocks('afterpay')).toMatch(/worked out from its orders/);
    expect(blocks('qcard')).toBe('');
    // A missing date or a silly amount is never saved.
    expect(checkDoc(b, { kind: 'statement', statement: { debtId: 'qcard', balance: { amount: 'lots' } } }, '2026-11-16').proposal).toBeNull();
  });

  it('an IRD myIR loan breakdown updates the student loan', () => {
    const b = debtBudget();
    const ird: Extraction = { kind: 'statement', statement: { debtId: null, nameOnDocument: 'myIR Loan breakdown', balance: { amount: '13158.52', label: 'Total loan balance' }, statementDate: '2026-11-16' } };
    const r = checkDoc(b, ird, '2026-11-16');
    expect(r.issues.filter((i) => i.level === 'block')).toEqual([]);
    expect(r.proposal).toMatchObject({ kind: 'statement', debtId: 'studentloan', balance: 1315852 });
    upload(b, ird, '2026-11-16');
    expect(owed(debt(b, 'studentloan'))).toBe(1315852);
    // Read into another field, or with the breakdown's lines as plans, it's still the total that counts.
    const odd: Extraction = { kind: 'statement', statement: { debtId: 'studentloan', appScreen: true, available: { amount: '13158.52', label: 'Total loan balance' },
      plans: [{ description: 'Compulsory fees', remaining: { amount: '22981.00' } }, { description: 'Total loan balance', remaining: { amount: '13158.52' } }] } };
    expect(checkDoc(b, odd, '2026-11-16').proposal).toMatchObject({ debtId: 'studentloan', balance: 1315852, date: '2026-11-16', plans: [], newPlans: [] });
    const blank = checkDoc(b, { kind: 'statement', statement: { debtId: 'studentloan' } }, '2026-11-16');
    expect(blank.issues.map((i) => i.text).join(' ')).toMatch(/Total loan balance/);
    // Later payslip deductions still come off it.
    expect(debt(b, 'studentloan').payroll).toBeTruthy();
  });

  it('matches Gem plans by their expiry date, not by name or a wrong id', () => {
    const b = debtBudget();
    const r = checkDoc(b, gemStatement('2026-11-10', [{ planId: 'g2', remaining: '1150.00', ends: '2027-01-20' }, { planId: null, remaining: '880.00', ends: '2027-03-22' }]), '2026-11-16');
    expect(r.proposal).toMatchObject({ kind: 'statement', plans: [{ planId: 'g1', remaining: 115000 }, { planId: 'g2', remaining: 88000, ends: '2027-03-22' }] });
  });

  it('the same statement twice changes nothing the second time', () => {
    const b = debtBudget();
    const doc = gemStatement('2026-11-10', [{ remaining: '1150.00', ends: '2027-01-20' }, { remaining: '880.00', ends: '2027-03-20' }]);
    upload(b, doc, '2026-11-16');
    const once = JSON.stringify(b.debts);
    upload(b, doc, '2026-11-16');
    expect(JSON.stringify(b.debts)).toBe(once);
    expect(debt(b, 'gem').balance).toEqual({ amount: 280000, asOf: '2026-11-10' });
  });

  it('an older statement: payments since then are counted once, and pay totals don’t change on a second upload', () => {
    const b = debtBudget();
    const today = '2026-11-25';
    // The app has already counted Gem's 21 November payment as paid.
    settleDue(debt(b, 'gem'), b.settings, today);
    const paidOn21 = (x: Budget) => (debt(x, 'gem').paid ?? []).filter((p) => p.date === '2026-11-21');
    expect(paidOn21(b).length).toBeGreaterThan(0);
    const doc = gemStatement('2026-11-15', [{ remaining: '1150.00', ends: '2027-01-20' }, { remaining: '880.00', ends: '2027-03-20' }]);
    upload(b, doc, today);
    const after = paidOn21(b);
    const keys = after.map((p) => `${p.date}|${p.planId ?? p.name}`);
    expect(new Set(keys).size).toBe(keys.length); // nothing counted twice
    // What's owed today is the statement's figure less what's been paid since.
    expect(owed(debt(b, 'gem'))).toBe(280000 - after.reduce((t, p) => t + p.amount, 0));
    const period = periodContaining('2026-11-21', b.settings);
    const payTotal = (x: Budget) => debtPaymentsIn(x, 'gem', period.start, period.end).reduce((t, p) => t + p.amount, 0);
    const first = { debts: JSON.stringify(b.debts), total: payTotal(b) };
    upload(b, doc, today);
    expect(payTotal(b)).toBe(first.total);
    expect(JSON.stringify(b.debts)).toBe(first.debts);
  });

  it('winds back payments saved before plans had ids (matched by name)', () => {
    const b = debtBudget();
    const gem = debt(b, 'gem');
    gem.paid = [{ date: '2026-11-12', amount: 5000, name: 'Purchases Jun – Jul 2026' }];
    windBack(gem, '2026-11-10');
    expect(gem.plans[0].remaining).toBe(125000);
    expect(gem.paid).toEqual([]);
  });

  it('warns when Gem’s balance is updated without its plans', () => {
    const r = checkDoc(debtBudget(), gemStatement('2026-11-10', []), '2026-11-16');
    expect(r.issues.map((i) => i.text).join(' ')).toMatch(/other purchases/);
  });

  it('purchases on a statement are already in its balance: never added again (Q card)', () => {
    const b = debtBudget();
    const r = upload(b, {
      kind: 'statement',
      statement: {
        debtId: 'qcard', balance: { amount: '612.40' }, statementDate: '2026-11-15',
        purchases: [{ date: '2026-11-02', description: 'Countdown', amount: { amount: '112.40' } }],
        paymentsShown: [{ date: '2026-11-05', amount: { amount: '200.00' } }],
        plans: [{ remaining: { amount: '112.40' }, ends: '2027-02-02' }],
      },
    }, '2026-11-16');
    expect(debt(b, 'qcard').plans).toEqual([]);
    expect(r.ignored.join(' ')).toMatch(/A purchase on the statement: already in what’s owed/);
    expect(r.ignored.join(' ')).toMatch(/Payment of \$200.*counted automatically/);
  });

  it('a Gem plan that isn’t one of yours is only added when ticked, and not twice', () => {
    const b = debtBudget();
    const doc = gemStatement('2026-11-10', [{ remaining: '1150.00', ends: '2027-01-20' }, { remaining: '880.00', ends: '2027-03-20' }, { remaining: '400.00', ends: '2027-05-10' }], '3200.00');
    const unticked = checkDoc(b, doc, '2026-11-16');
    expect(unticked.proposal).toMatchObject({ newPlans: [] });
    expect(unticked.ignored.join(' ')).toMatch(/didn’t match one of your plans/);
    upload(b, doc, '2026-11-16', (d) => { d.statement.plans[2].addAsNew = true; });
    expect(debt(b, 'gem').plans.map((p) => p.ends)).toEqual(['2027-01-20', '2027-03-20', '2027-05-10']);
    upload(b, doc, '2026-11-16', (d) => { d.statement.plans[2].addAsNew = true; });
    expect(debt(b, 'gem').plans).toHaveLength(3);
  });

  it('the rundown explains an older statement’s figure', () => {
    const b = debtBudget();
    const today = '2026-11-25';
    settleDue(debt(b, 'gem'), b.settings, today);
    const r = checkDoc(b, gemStatement('2026-11-15', [{ remaining: '1150.00', ends: '2027-01-20' }, { remaining: '880.00', ends: '2027-03-20' }]), today);
    const pv = preview(b, r.proposal!, today);
    expect(pv.lines[0]).toMatch(/^Gem Visa: .* → .* owed$/);
    expect(pv.explain.join(' ')).toMatch(/Payments planned since then count as paid/);
  });
});

describe('reading documents: Afterpay', () => {
  const screenshot: Extraction = {
    kind: 'afterpay',
    afterpay: {
      orders: [
        {
          planId: null, merchant: 'FreshChoice', purchaseDate: '2026-10-08', total: { amount: '24.66' },
          instalments: [
            { date: '2026-10-08', amount: '6.17', label: '1 of 4', paid: true }, { date: '2026-10-22', amount: '6.16', label: '2 of 4', paid: true },
            { date: '2026-11-19', amount: '6.17', label: '3 of 4' }, { date: '2026-12-03', amount: '6.16', label: '4 of 4' },
          ],
        },
        {
          merchant: 'Kmart', purchaseDate: '2026-11-15', total: { amount: '80.00' },
          instalments: [
            { date: '2026-11-15', amount: '20.00', label: '1 of 4', paid: true }, { date: '2026-11-29', amount: '20.00', label: '2 of 4' },
            { date: '2026-12-13', amount: '20.00', label: '3 of 4' }, { date: '2026-12-27', amount: '20.00', label: '4 of 4' },
          ],
        },
      ],
    },
  };

  it('keeps only instalments still to come, matches existing orders, adds new ones, and never sets a balance', () => {
    const b = debtBudget();
    const r = upload(b, screenshot, '2026-11-16');
    const ap = debt(b, 'afterpay');
    expect(ap.balance).toBeUndefined();
    expect(ap.plans.find((p) => p.id === 'ap-2')!.instalments).toEqual([{ date: '2026-11-19', amount: 617, label: '3 of 4' }, { date: '2026-12-03', amount: 616, label: '4 of 4' }]);
    expect(ap.plans.find((p) => p.name === 'Kmart')).toMatchObject({ original: 8000, remaining: 6000, purchaseDate: '2026-11-15' });
    expect(r.ignored.join(' ')).toMatch(/already paid or due before today/);
    expect(ap.plans.find((p) => p.id === 'ap-1')).toBeDefined(); // not on the screenshot: left as it is
  });

  it('the same screenshot twice adds nothing the second time', () => {
    const b = debtBudget();
    upload(b, screenshot, '2026-11-16');
    const once = JSON.stringify(debt(b, 'afterpay').plans);
    upload(b, screenshot, '2026-11-16');
    expect(JSON.stringify(debt(b, 'afterpay').plans)).toBe(once);
  });

  it('an instalment dated before today is already counted, even if not marked paid', () => {
    const b = debtBudget();
    upload(b, { kind: 'afterpay', afterpay: { orders: [{ merchant: 'Kmart', purchaseDate: '2026-11-01', total: { amount: '40.00' }, instalments: [{ date: '2026-11-01', amount: '10.00' }, { date: '2026-11-15', amount: '10.00' }, { date: '2026-11-29', amount: '10.00' }, { date: '2026-12-13', amount: '10.00' }] }] } }, '2026-11-16');
    expect(debt(b, 'afterpay').plans.find((p) => p.name === 'Kmart')!.instalments!.map((i) => i.date)).toEqual(['2026-11-29', '2026-12-13']);
  });
});

describe('reading documents: payslips', () => {
  const payslip = (payDay: string, net = '4012.34'): Extraction => ({
    kind: 'payslip',
    payslip: { payDay, net: { amount: net, label: 'Total Payments' }, taxableGross: { amount: '5500.00' }, paye: { amount: '1150.00' }, studentLoan: { amount: '337.66' } },
  });

  it('checks the date and the figures before anything is saved', () => {
    const b = debtBudget();
    expect(checkDoc(b, payslip('2027-03-19'), '2026-11-16').proposal).toBeNull(); // months in the future
    expect(checkDoc(b, payslip('2026-11-19', '0.00'), '2026-11-16').proposal).toBeNull();
    const r = checkDoc(b, payslip('2026-11-18'), '2026-11-16');
    expect(r.proposal).toMatchObject({ kind: 'payslip', slip: { payDay: '2026-11-18', net: 401234, studentLoan: 33766 } });
    expect(r.issues.map((i) => i.text).join(' ')).toMatch(/not the usual payday/);
    // Net isn't gross less the deductions: a note, not a block.
    expect(checkDoc(b, payslip('2026-11-19', '3000.00'), '2026-11-16').issues.some((i) => i.level === 'note' && /Net pay/.test(i.text))).toBe(true);
  });

  it('a payslip paid a day early moves that payday, records the pay and takes the student loan deduction off', () => {
    const b = debtBudget();
    b.payActuals['2026-11-19'] = 400000; // an amount typed in before the payslip came
    upload(b, payslip('2026-11-18'), '2026-11-16');
    expect(b.settings.paydayMoves?.['2026-11']).toBe('2026-11-18');
    expect(b.payActuals['2026-11-18']).toBe(401234);
    expect(owed(debt(b, 'studentloan'))).toBe(2000000 - 33766);
  });

  it('a statement for a debt you don’t have yet adds it, with its own payday account', () => {
    const b = debtBudget();
    upload(b, { kind: 'statement', statement: { debtId: null, nameOnDocument: 'Kiwibank Visa', balance: { amount: '950.00' }, statementDate: '2026-11-14' } }, '2026-11-16', (d) => { d.statement.debtId = NEW_DEBT; });
    expect(debt(b, 'new1')).toMatchObject({ name: 'Kiwibank Visa', balance: { amount: 95000 } });
    expect(b.split.some((l) => l.accountId === debt(b, 'new1').accountId)).toBe(true);
  });
});

describe('reading documents: card app screenshots', () => {
  const gemApp = (purchases: { date: string; description: string; amount: string }[], extra: object = {}): Extraction => ({
    kind: 'statement',
    statement: {
      debtId: 'gem', nameOnDocument: 'Gem Visa', appScreen: true, balance: { amount: '3,612.40', label: 'Current balance' }, available: { amount: '4,387.60' }, limit: { amount: '8,000.00' },
      purchases: purchases.map((p) => ({ ...p, amount: { amount: p.amount } })), ...extra,
    },
  });

  it('a screenshot with no date is what’s owed today', () => {
    const r = checkDoc(debtBudget(), gemApp([]), '2026-11-16');
    expect(r.proposal).toMatchObject({ kind: 'statement', debtId: 'gem', balance: 361240, date: '2026-11-16', newPlans: [] });
    // No “none of the Gem plans were updated” warning: a screenshot doesn't show them.
    expect(r.issues.map((i) => i.text).join(' ')).not.toMatch(/None of the Gem plans/);
  });

  it('a new Gem purchase of $250 or more becomes a 6-month interest-free plan; smaller ones are already in what’s owed', () => {
    const b = debtBudget();
    const r = upload(b, gemApp([
      { date: '2026-11-14', description: 'Harvey Norman Westgate', amount: '499.00' },
      { date: '2026-11-12', description: 'Countdown Henderson', amount: '82.13' },
    ]), '2026-11-16');
    // Gem months end on the 20th: 6 months from 14 Nov → 20 Apr 2027.
    expect(r.proposal).toMatchObject({ newPlans: [{ name: 'Harvey Norman Westgate', type: 'interest-free', months: 6, original: 49900, remaining: 49900, purchaseDate: '2026-11-14', ends: '2027-04-20' }] });
    expect(r.ignored).toContain('A purchase on the screenshot: already in what’s owed.');
    expect(debt(b, 'gem').plans.map((p) => p.name)).toContain('Harvey Norman Westgate');
    expect(owed(debt(b, 'gem'))).toBe(361240);
  });

  it('a purchase that’s already one of your plans (same amount) isn’t added again, and an unticked one isn’t added', () => {
    const b = debtBudget();
    const already = gemApp([{ date: '2026-09-09', description: 'Briscoes', amount: '1,000.00' }]); // plan g2's original amount
    const r = checkDoc(b, already, '2026-11-16');
    expect(r.proposal).toMatchObject({ newPlans: [] });
    expect(r.ignored[0]).toMatch(/already your plan “Purchases Aug – Sep 2026”/);
    const unticked = checkDoc(b, gemApp([{ date: '2026-11-14', description: 'Harvey Norman', amount: '499.00' }]), '2026-11-16', (d) => { d.statement.purchases[0].add = false; });
    expect(unticked.proposal).toMatchObject({ newPlans: [] });
    expect(unticked.ignored[0]).toMatch(/not added as a plan/);
  });

  it('Q Mastercard purchases are left to its balance (each rise already gets its own 3-month clock)', () => {
    const r = checkDoc(debtBudget(), { kind: 'statement', statement: { debtId: 'qcard', appScreen: true, balance: { amount: '702.10' }, purchases: [{ date: '2026-11-15', description: 'Bunnings', amount: { amount: '258.40' } }] } }, '2026-11-16');
    expect(r.proposal).toMatchObject({ debtId: 'qcard', balance: 70210, date: '2026-11-16', newPlans: [] });
  });

  it('a screen that only shows what’s available works out what’s owed from the limit', () => {
    const r = checkDoc(debtBudget(), gemApp([], { balance: undefined }), '2026-11-16');
    expect(r.proposal).toMatchObject({ balance: 800000 - 438760 });
    expect(r.issues.some((i) => i.level === 'note' && /limit less that/.test(i.text))).toBe(true);
  });

  it('a statement still needs its date', () => {
    const r = checkDoc(debtBudget(), { kind: 'statement', statement: { debtId: 'qcard', balance: { amount: '612.48' } } }, '2026-11-16');
    expect(r.proposal).toBeNull();
  });
});

describe('saved copies', () => {
  it('one a day: a copy is taken only if there isn’t one for today yet', () => {
    const now = new Date(2026, 10, 16, 21, 0);
    expect(needsCopy([], now)).toBe(true);
    expect(needsCopy([new Date(2026, 10, 15, 23, 59).toISOString()], now)).toBe(true);
    expect(needsCopy([new Date(2026, 10, 16, 0, 5).toISOString()], now)).toBe(false);
    expect(localDay(now)).toBe('2026-11-16');
  });

  it('kept for 3 months, then forgotten', () => {
    const now = new Date(2026, 10, 16, 12, 0);
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
    expect(KEEP_DAYS).toBe(90);
    expect(toForget([daysAgo(1), daysAgo(89), daysAgo(91), daysAgo(200)], now)).toEqual([daysAgo(91), daysAgo(200)]);
  });
});

// ---------------------------------------------------------------------------------------------
// Bank and card exports (CSV), read on the device. All made up.
// ---------------------------------------------------------------------------------------------

const qExport = [
  'Date,Card Number,Description,Amount',
  '15/11/26,9999,McDonalds 123 Queen St,-$12.50',
  '12/11/26,,Payment Received - Thank You,$100.00',
  '10/11/26,9999,"SUPERCHEAP AUTO 7 Mth 0% Int, 7 Mth Pmt Hol",-$40.00',
  '05/11/26,9999,Afterpay afterpay.co NZL,$0.00',
  '02/11/26,9999,MYLOTTO.CO.NZ NEW ZEALAND,-$7.00',
  '28/10/26,9999,Countdown Glen Eden,-$30.00',
].join('\n');

const csvDoc = (text: string): Extraction => ({ kind: 'transactions', transactions: readTransactionsCsv(text)! });

describe('reading bank and card exports', () => {
  it('reads a card export: newest first, quoted commas, $0 rows left out, the card number kept', () => {
    const r = readTransactionsCsv(qExport)!;
    expect(r).toMatchObject({ ending: '9999', card: true, skipped: 1 });
    expect(r.rows.map((t) => [t.date, t.amount])).toEqual([['2026-10-28', -3000], ['2026-11-02', -700], ['2026-11-10', -4000], ['2026-11-12', 10000], ['2026-11-15', -1250]]);
    expect(r.rows[2].description).toBe('SUPERCHEAP AUTO 7 Mth 0% Int, 7 Mth Pmt Hol');
  });

  it('reads a bank export with the account above the columns, a balance column, and separate money in and out', () => {
    const bank = readTransactionsCsv(['"Everyday Account","12-3456-0123456-00"', 'Date,Payee,Particulars,Code,Reference,Amount,Balance',
      '14/11/2026,Countdown Henderson,,,,-45.20,354.80', '15/11/2026,Transfer from savings,,,,100.00,454.80', '16/11/2026,McDonalds Albany,,,,-15.40,439.40'].join('\n'))!;
    expect(bank).toMatchObject({ ending: '3456', card: false });
    expect(bank.rows[2]).toMatchObject({ date: '2026-11-16', amount: -1540, balance: 43940 });
    const split = readTransactionsCsv('Date,Description,Debit,Credit\n01/11/2026,Countdown,12.50,\n02/11/2026,Pay,,500.00')!;
    expect(split.rows.map((t) => t.amount)).toEqual([-1250, 50000]);
    // A card export that writes spending as + and payments as −: turned round.
    const flipped = readTransactionsCsv('Transaction Date,Details,Amount\n2026-11-01,PAYMENT RECEIVED,-100.00\n2026-11-02,KMART,25.00')!;
    expect(flipped.rows.map((t) => t.amount)).toEqual([10000, -2500]);
    expect([csvDate('3 Nov 2026'), csvDate('03-Nov-26'), csvDate('31/02/2026'), csvAmount('(12.40)'), csvAmount('1,240.50 DR')]).toEqual(['2026-11-03', '2026-11-03', undefined, -1240, -124050]);
    expect(readTransactionsCsv('Name,Colour\nBob,blue')).toBeUndefined();
  });

  it('the first time, it asks which card it is: nothing is saved until you choose', () => {
    const r = checkDoc(debtBudget(), csvDoc(qExport), '2026-11-16');
    expect(r.proposal).toBeNull();
    expect(r.issues[0].text).toMatch(/Choose which card this is for/);
  });

  it('keeps the transactions on the card, works out what’s owed from the last checked balance, and fills in its history', () => {
    const b = debtBudget(); // the Q card: $500 checked on 1 Nov
    const r = upload(b, csvDoc(qExport), '2026-11-16', (d) => { d.transactions.target = 'debt:qcard'; });
    expect(r.proposal).toMatchObject({ kind: 'transactions', balance: { amount: 50000 + 700 + 4000 - 10000 + 1250, asOf: '2026-11-15' } });
    const q = debt(b, 'qcard');
    expect(q.transactions).toHaveLength(5);
    expect(q.ending).toBe('9999');
    expect(owed(q)).toBe(45950);
    expect(q.checked).toEqual({ amount: 45950, asOf: '2026-11-15' });
    // Before the $500 it knew of, worked back; after it, worked forward day by day.
    expect(q.history!.map((h) => [h.asOf, h.amount])).toEqual(expect.arrayContaining([['2026-10-28', 50000], ['2026-11-02', 50700], ['2026-11-10', 54700], ['2026-11-12', 44700], ['2026-11-15', 45950]]));

    // Next time it's matched by the card number (and shown, to check), and only what's new is added.
    const again = toDraft(csvDoc(`${qExport}\n16/11/26,9999,Countdown Glen Eden,-$20.00`), b, 'device', seq(), '2026-11-16');
    expect(again.transactions).toMatchObject({ target: 'debt:qcard', matchedBy: '9999' });
    const r2 = review(again, b, '2026-11-16');
    expect(r2.proposal).toMatchObject({ add: [{ date: '2026-11-16', amount: -2000 }], balance: { amount: 47950, asOf: '2026-11-16' } });
    expect(r2.ignored[0]).toMatch(/5 transactions already saved/);
    applyProposal(b, r2.proposal!, '2026-11-16');
    const r3 = checkDoc(b, csvDoc(qExport), '2026-11-16');
    expect(r3.proposal).toBeNull();
    expect(r3.issues.map((i) => i.text).join(' ')).toMatch(/Nothing new/);
  });

  it('what’s owed can be typed in instead, and isn’t guessed when there’s no checked balance to add to', () => {
    const b = debtBudget();
    debt(b, 'qcard').paid = [{ date: '2026-11-05', amount: 10000, name: 'Balance' }]; // payments were counted automatically
    const guessed = checkDoc(b, csvDoc(qExport), '2026-11-16', (d) => { d.transactions.target = 'debt:qcard'; });
    expect(guessed.proposal).toMatchObject({ kind: 'transactions' });
    expect((guessed.proposal as { balance?: unknown }).balance).toBeUndefined();
    expect(guessed.issues.map((i) => i.text).join(' ')).toMatch(/isn’t changed/);
    const typed = checkDoc(b, csvDoc(qExport), '2026-11-16', (d) => { d.transactions.target = 'debt:qcard'; d.transactions.amount = '612.40'; });
    expect(typed.proposal).toMatchObject({ balance: { amount: 61240, asOf: '2026-11-16' } });
  });

  it('a bank export goes on the account, with its balance from the export', () => {
    const b = debtBudget();
    const text = ['Date,Payee,Amount,Balance', '14/11/2026,Countdown Henderson,-45.20,354.80', '16/11/2026,McDonalds Albany,-15.40,339.40'].join('\n');
    upload(b, csvDoc(text), '2026-11-16', (d) => { d.transactions.target = 'account:everyday'; });
    expect(b.accountTransactions?.everyday).toHaveLength(2);
    expect(b.balances?.everyday).toEqual({ amount: 33940, asOf: '2026-11-16' });
  });

  it('puts purchases in categories by the shop, so Insights can show what adds up', () => {
    expect(categorize('McDonalds 123456 Queen St A NZL')).toEqual({ category: 'takeaways', shop: 'McDonald’s' });
    expect(categorize('MYLOTTO.CO.NZ NEW ZEALAND 5 Months No Payments No Interest').category).toBe('gambling'); // not "interest"
    expect(categorize('International Transaction Fee').category).toBe('fees');
    expect(categorize('Pak N Save Henderson Henderson').shop).toBe('Pak’nSave');
    // A shop you've put in another category stays there.
    expect(categorize('SOME ONLINE GAME CO London', { 'some online': 'gambling' })).toEqual({ category: 'gambling', shop: 'Some Online' });
    const s = summarize(readTransactionsCsv(qExport)!.rows, '2026-11-01', '2026-11-16');
    // Payments in aren't spending, and October is outside the dates.
    expect(s).toMatchObject({ total: 5950, count: 3, small: { count: 2, total: 1950 } });
    expect(s.categories[0]).toMatchObject({ category: 'transport', total: 4000 });
  });
});

describe('reading bank account statements', () => {
  it('a bank account statement comes back as the account’s transactions, not a card statement', () => {
    const reply = { candidates: [{ content: { parts: [{ text: JSON.stringify({
      kind: 'account', payslip: null, statement: null, afterpay: null, notes: null,
      account: { name: 'Go', number: '06-0999-0123456-00', closingBalance: { amount: '46.67', label: 'Balance' }, closingDate: '2026-06-15', rows: [
        { date: '2026-06-10', description: 'CREDIT TRANSFER', amount: '150.00', balance: '151.00' },
        { date: '2026-06-15', description: 'FRESHCHOICE', amount: '-4.49', balance: null },
      ] },
    }) }] } }] };
    const ex = parseReply(reply, '2026-11-16');
    expect(ex.kind).toBe('transactions');
    expect(ex.transactions).toEqual({ rows: [
      { date: '2026-06-10', description: 'CREDIT TRANSFER', amount: 15000, balance: 15100 },
      { date: '2026-06-15', description: 'FRESHCHOICE', amount: -449, balance: 4667 }, // the closing balance, on the last one
    ], ending: '3456', card: false, skipped: 0 });
  });

  it('a date that would be after today (a statement printed without years) is last year’s', () => {
    const r = fromStatementRows([{ date: '2026-12-20', description: 'Kmart', amount: '-10.00' }, { date: '2026-01-05', description: 'Pay', amount: '100.00' }, { description: 'Opening balance' }], { today: '2026-11-16' });
    expect(r.rows.map((t) => t.date)).toEqual(['2025-12-20', '2026-01-05']);
    expect(r.skipped).toBe(1);
    // An opening balance listed as if it were money in is left out.
    expect(fromStatementRows([{ date: '2025-12-11', description: 'Opening balance', amount: '35.50' }, { date: '2025-12-11', description: 'Balance brought forward from previous page', amount: '46.67' }], { today: '2026-11-16' }).rows).toEqual([]);
  });

  it('a long statement read a few pages at a time is put back together in order', () => {
    const part = (rows: [string, number][]): Extraction => ({ kind: 'transactions', transactions: { rows: rows.map(([date, amount]) => ({ date, description: 'x', amount })), card: false, skipped: 0 } });
    const all = mergeReads([part([['2026-01-02', -1], ['2026-01-03', -2]]), { kind: 'unknown' }, { ...part([['2026-01-03', -3], ['2026-01-09', 4]]), transactions: { rows: [{ date: '2026-01-03', description: 'x', amount: -3 }, { date: '2026-01-09', description: 'x', amount: 4 }], ending: '4910', card: false, skipped: 1 } }]);
    expect(all.kind).toBe('transactions');
    expect(all.transactions!.rows.map((t) => t.amount)).toEqual([-1, -2, -3, 4]);
    expect(all.transactions).toMatchObject({ ending: '4910', skipped: 1 });
    // A card statement over a few pages: its figures from the first, its plans from all.
    const st = mergeReads([
      { kind: 'statement', statement: { balance: { amount: '3084.17' }, statementDate: '2026-10-21', plans: [{ remaining: { amount: '1150.00' }, ends: '2027-01-20' }] } },
      { kind: 'statement', statement: { plans: [{ remaining: { amount: '870.00' }, ends: '2027-03-21' }] } },
    ]);
    expect(st.statement).toMatchObject({ balance: { amount: '3084.17' }, statementDate: '2026-10-21' });
    expect(st.statement!.plans).toHaveLength(2);
  });

  it('a page’s text keeps its columns, so withdrawals and deposits stay apart', () => {
    const text = layoutPage([
      { s: 'Date', x: 60, y: 700 }, { s: 'Withdrawals', x: 470, y: 700 }, { s: 'Deposits', x: 560, y: 700 },
      { s: '10 Jun', x: 60, y: 680 }, { s: 'PAY', x: 110, y: 680 }, { s: '150.00', x: 570, y: 680 },
      { s: '11 Jun', x: 60, y: 660 }, { s: 'KMART', x: 110, y: 660 }, { s: '8.49', x: 480, y: 660 },
    ]);
    const lines = text.split('\n');
    expect(lines[1].indexOf('150.00')).toBeGreaterThan(lines[0].indexOf('Deposits') - 3);
    expect(lines[2].indexOf('8.49')).toBeLessThan(lines[0].indexOf('Deposits'));
  });

  it('the account number is found in a statement’s file name; any account (not a card’s own) can be chosen', () => {
    expect(endingOf('06-0115-0123456-00_Statement_multiple.pdf')).toBe('3456');
    const b = debtBudget();
    b.accounts.push({ id: 'allowance', name: 'Allowance (other bank)', kind: 'external', color: '#000', groupId: 'lifestyle' });
    const targets = csvTargets(b).map((t) => t.value);
    expect(targets).toContain('account:allowance');
    expect(targets).toContain('account:everyday');
    expect(targets).not.toContain('account:gem'); // Gem's payment account: choose the card instead
    // Paying a card from the account isn't spending (it's counted on the card).
    expect(categorize('Q Mastercard Payment').category).toBe('transfers');
  });
});

describe('reading long bank statements quickly', () => {
  it('each transaction comes back as one line, split back into its parts', () => {
    expect(splitRow('2026-06-10|Pizza Hut Ho|-8.49|342.51')).toEqual({ date: '2026-06-10', description: 'Pizza Hut Ho', amount: '-8.49', balance: '342.51' });
    expect(splitRow('2026-06-10|Pizza Hut Ho|-8.49|')).toEqual({ date: '2026-06-10', description: 'Pizza Hut Ho', amount: '-8.49' });
    expect(splitRow('2026-06-10|A | B Ltd|-8.49|342.51').description).toBe('A | B Ltd');
  });

  it('the running balance puts right a sign read the wrong way round, and counts what doesn’t add up', () => {
    const r = fromStatementRows([
      { description: 'Opening balance', balance: '100.00' },
      { date: '2026-06-10', description: 'Pay', amount: '-50.00', balance: '150.00' }, // money in, read as out
      { date: '2026-06-11', description: 'Kmart', amount: '-20.00', balance: '130.00' },
      { date: '2026-06-12', description: 'Countdown', amount: '-10.00', balance: '100.00' }, // doesn't add up either way
    ], { today: '2026-11-16' });
    expect(r.rows.map((t) => t.amount)).toEqual([5000, -2000, -1000]);
    expect(r.unsure).toBe(1);
    const t = checkDoc(debtBudget(), { kind: 'transactions', transactions: r }, '2026-11-16', (d) => { d.transactions.target = 'account:everyday'; });
    expect(t.issues.map((i) => i.text).join(' ')).toMatch(/One transaction doesn’t add up/);
  });
});

describe('review fixes', () => {
  it('a bank export with bill payments and no balance column keeps its signs', () => {
    const r = readTransactionsCsv('Date,Payee,Amount\n01/11/2026,POWER CO BILL PAYMENT,-120.00\n02/11/2026,Countdown,-30.00\n03/11/2026,Salary,900.00')!;
    expect(r.card).toBe(false);
    expect(r.rows.map((t) => t.amount)).toEqual([-12000, -3000, 90000]);
  });

  it('a trailing minus is money out', () => {
    expect([csvAmount('45.20-'), csvAmount('$45.20-')]).toEqual([-4520, -4520]);
  });

  it('a statement read again with different wording isn’t saved twice', () => {
    const b = debtBudget();
    const doc = (desc: string): Extraction => ({ kind: 'transactions', transactions: { rows: [{ date: '2026-11-10', description: desc, amount: -4520 }], card: false, skipped: 0 } });
    upload(b, doc('Pak N Save R'), '2026-11-16', (d) => { d.transactions.target = 'account:everyday'; });
    const again = checkDoc(b, doc('PAK N SAVE R Mt Wgtn'), '2026-11-16', (d) => { d.transactions.target = 'account:everyday'; });
    expect(again.issues.map((i) => i.text).join(' ')).toMatch(/Nothing new/);
  });

  it('a shop with “charge” in its name isn’t a fee', () => {
    expect(categorize('ChargeNet NZ').category).not.toBe('fees');
    expect(categorize('Late payment charge').category).toBe('fees');
  });
});

it('a statement date that jumps backwards was misread: it takes the date above it, and is pointed out', () => {
  const r = fromStatementRows([
    { date: '2026-05-01', description: 'A', amount: '-1.00' }, { date: '2026-04-01', description: 'B', amount: '-2.00' }, { date: '2026-05-02', description: 'C', amount: '-3.00' },
  ], { today: '2026-11-16' });
  expect(r.rows.map((t) => t.date)).toEqual(['2026-05-01', '2026-05-01', '2026-05-02']);
  expect(r.unsure).toBe(1);
});

it('short capitals in a shop name stay capitals', () => {
  expect(categorize('SPARK NZ TRADING Auckland').shop).toBe('Spark NZ');
});

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

describe('card payments seen in a bank account', () => {
  const go = { id: 'a1', name: 'Go', number: '06-0999-0123456-00', type: 'CHECKING', institution: 'ANZ', balance: 500, transactions: true };
  const tx = (id: string, date: string, description: string, amount: number) => ({ account: 'a1', id, date, description, amount, balance: null, merchant: null });
  const links = { a1: 'account:everyday' };

  it('knows a transfer to Gem Visa or Q Mastercard from everything else', () => {
    const b = debtBudget();
    const t = (description: string, amount = -5000) => cardPaid(b, { date: '2026-11-16', description, amount })?.id;
    expect(t('Q Mastercard Fitzgerald Id1105532418')).toBe('qcard');
    expect(t('BP Q Mastercard Fitzgerald ID1105532418')).toBe('qcard');
    expect(t('Gem Visa Fitzgerald K 000000601073 002026242332')).toBe('gem');
    expect(t('BP Gem Visa Fitzgerald K 000000601073')).toBe('gem');
    expect(t('Gem Visa refund', 5000)).toBeUndefined(); // money in isn't a payment
    expect(t('Gemma’s Cafe')).toBeUndefined();
    expect(t('Countdown Henderson')).toBeUndefined();
    expect(t('Student loan')).toBeUndefined(); // repaid from salary, never from the account
  });

  it('a payment over what was planned comes off what’s owed, once', () => {
    const b = debtBudget();
    const data = { accounts: [go], transactions: [tx('t1', '2026-11-15', 'Q Mastercard Fitzgerald Id1105532418', -120)] };
    const r = applyBank(b, data, links, '2026-11-16', '2026-11-16T09:00:00.000Z');
    expect(r[0].cardPayments).toEqual([{ debt: 'Q Mastercard', amount: 12000, date: '2026-11-15', from: 'everyday', counted: 12000 }]);
    expect(owed(debt(b, 'qcard'))).toBe(38000);
    expect(debt(b, 'qcard').bankPayments).toHaveLength(1);
    // The same transfer on the next sync isn't counted again.
    applyBank(b, data, links, '2026-11-17');
    expect(owed(debt(b, 'qcard'))).toBe(38000);
    expect(b.bankSeen?.['account:everyday']).toBeTruthy();
  });

  it('a payment the plan already counts as paid isn’t taken off twice', () => {
    const b = debtBudget();
    const q = debt(b, 'qcard');
    q.paid = [{ date: '2026-11-14', amount: 12000, name: 'Other purchases', synthetic: true }];
    applyBank(b, { accounts: [go], transactions: [tx('t1', '2026-11-15', 'BP Q Mastercard Fitzgerald', -150)] }, links, '2026-11-16');
    expect(owed(q)).toBe(50000 - 3000); // only the $30 over the planned $120
    expect(q.bankPayments?.[0]).toMatchObject({ amount: 15000, counted: 3000 });
  });

  it('a balance checked after the payment already has it taken off', () => {
    const b = debtBudget();
    debt(b, 'qcard').balance = { amount: 40000, asOf: '2026-11-16' };
    applyBank(b, { accounts: [go], transactions: [tx('t1', '2026-11-15', 'Q Mastercard', -120)] }, links, '2026-11-16');
    expect(owed(debt(b, 'qcard'))).toBe(40000);
    expect(debt(b, 'qcard').bankPayments?.[0].counted).toBe(0);
  });

  it('old Afterpay payments in a bank account’s history never clear today’s orders', () => {
    const b = debtBudget();
    const ap = debt(b, 'afterpay');
    const before = owed(ap);
    // A sync that brings in a year of history: Afterpay instalments paid long before these orders.
    const old = Array.from({ length: 30 }, (_, i) => tx(`o${i}`, `2025-${String(6 + Math.floor(i / 5)).padStart(2, '0')}-0${1 + (i % 5)}`, 'Afterpay', -41.69));
    applyBank(b, { accounts: [go], transactions: old }, links, '2026-11-16');
    expect(owed(ap)).toBe(before);
    expect(ap.plans).toHaveLength(2);
    expect(ap.bankPayments?.every((p) => p.counted === 0)).toBe(true);
  });

  it('a card linked to the bank itself is left to the bank', () => {
    const b = debtBudget();
    b.bankLinks = { c1: 'debt:qcard' };
    expect(cardPaid(b, { date: '2026-11-16', description: 'Q Mastercard', amount: -100 })).toBeUndefined();
  });
});

describe('moving things up and down', () => {
  const list = () => ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  it('swaps with the next one shown, skipping ones that aren’t', () => {
    const l = list();
    expect(moveAmong(l, ['a', 'c', 'd'], 'c', -1)).toBe(true);
    expect(l.map((x) => x.id)).toEqual(['c', 'b', 'a', 'd']);
  });
  it('does nothing at either end', () => {
    const l = list();
    expect(moveAmong(l, ['a', 'b'], 'a', -1)).toBe(false);
    expect(moveAmong(l, ['a', 'b'], 'b', 1)).toBe(false);
    expect(l.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('telling cards and accounts apart', () => {
  it('a document names Gem Visa, Q Mastercard or Afterpay: it goes to that one', () => {
    const debts = debtBudget().debts!;
    expect(guessDebt(debts, 'Gem Visa statement')).toBe('gem');
    expect(guessDebt(debts, 'Q Mastercard')).toBe('qcard');
    expect(guessDebt(debts, 'Q Card by Latitude')).toBe('qcard');
    expect(guessDebt(debts, 'Afterpay orders')).toBe('afterpay');
    expect(guessDebt(debts, 'Latitude Financial')).toBeUndefined(); // Gem and Q both
  });
  it('a transfer between your own accounts is named by the account', () => {
    const b = debtBudget();
    b.accounts.push({ id: 'rent', name: 'Rent', kind: 'bank', color: '#000', groupId: 'g', number: '06-0115-0324910-055' });
    expect(transferTo(b, 'To: 06-0115-0324910-55 Debit Transfer 083615')).toEqual({ dir: 'to', name: 'Rent' });
    expect(transferTo(b, 'From: 06-0115-0324910-00 Credit Transfer 071301')).toBeUndefined();
  });
});

describe('Gem payment held in Misc bills until statement day', () => {
  it('Planner still funds Gem’s amount, but the money is in the hold account and only counted once in the payday total', () => {
    const b = budget();
    b.accounts.push(
      { id: 'gem', name: 'Gem Visa', kind: 'external', color: '#000', groupId: b.groups[0].id },
      { id: 'bills', name: 'Misc bills', kind: 'bank', color: '#000', groupId: b.groups[0].id },
    );
    b.split.push({ accountId: 'gem', amount: 0, mode: 'exact' }, { accountId: 'bills', amount: 0, mode: 'exact' });
    b.debts = [{
      id: 'gem', name: 'Gem Visa', kind: 'card', rules: 'gem', accountId: 'gem', holdAccountId: 'bills', statementDay: 21,
      balance: { amount: 180000, asOf: '2026-11-01' },
      plans: [{ id: 'g1', name: 'Purchases', type: 'interest-free', original: 180000, remaining: 180000, asOf: '2026-11-01', purchaseDate: '2026-07-09', ends: '2027-01-20' }],
    }];
    const p = periodContaining('2026-11-19', b.settings);
    const plan = planFor(b, p, '2026-11-19');
    const gem = plan.accounts.find((a) => a.account.id === 'gem')!;
    const bills = plan.accounts.find((a) => a.account.id === 'bills')!;
    expect(gem.funded).toBeGreaterThan(0);
    expect(bills.funded).toBe(gem.funded);
    // Payday total includes Misc bills once, not Gem again.
    expect(plan.totalSplit).toBe(bills.funded);
    expect(debtPaymentsIn(b, 'bills', p.start, p.end).reduce((t, x) => t + x.amount, 0)).toBe(gem.funded);
    expect(debtPaymentsIn(b, 'gem', p.start, p.end)).toEqual([]);
    // Misc bills lists the payment as Gem Visa, noted as stored until statement day / set on the debt.
    const gemLine = bills.dues.find((d) => d.item.name === 'Gem Visa');
    expect(gemLine).toBeTruthy();
    expect(gemLine!.item.note).toMatch(/Stored until the 21st/);
    expect(gemLine!.item.note).toMatch(/set on Gem Visa/);
  });
});

describe('extra paid off a debt for one pay', () => {
  it('Gem: a pay with extra (Optimise, this pay only) pays that much on its statement day, and owes that much less after', () => {
    const b = budget();
    b.accounts.push({ id: 'gem', name: 'Gem', kind: 'external', color: '#000', groupId: b.groups[0].id });
    b.split.push({ accountId: 'gem', amount: 10000, mode: 'fixed' });
    const gem: Debt = {
      id: 'gem', name: 'Gem Visa', kind: 'card', rules: 'gem', accountId: 'gem', statementDay: 21, balance: { amount: 400000, asOf: '2026-11-01' },
      plans: [{ id: 'g1', name: 'Purchases', type: 'interest-free', original: 400000, remaining: 400000, asOf: '2026-11-01', purchaseDate: '2026-07-09', ends: '2028-01-20' }],
    };
    b.debts = [gem];
    const steady = projectedOwed(gem, b.settings, '2027-03-31', debtPerPay(b, gem));
    expect(projectedOwed(gem, b.settings, '2027-03-31', debtPay(b, gem))).toBe(steady);
    b.overrides = { '2027-03-19': { gem: 160000 } };
    const pays = debtSchedules(gem, b.settings, debtPay(b, gem)).flatMap((x) => x.payments);
    expect(pays.find((p) => p.date === '2027-03-21')?.amount).toBe(160000);
    expect(pays.find((p) => p.date === '2027-04-21')?.amount).toBe(10000);
    expect(projectedOwed(gem, b.settings, '2027-03-20', debtPay(b, gem))).toBe(projectedOwed(gem, b.settings, '2027-03-20', debtPerPay(b, gem)));
    expect(projectedOwed(gem, b.settings, '2027-03-31', debtPay(b, gem))).toBe(steady - 150000);
  });
});

describe('a screenshot of a bank’s accounts and balances', () => {
  const screen = {
    kind: 'balances', notes: null,
    balances: {
      bank: 'ANZ', asOf: null,
      accounts: [
        ['Rent', '06-0115-0324910-53', '278.00'], ['Misc Bills', '06-0115-0324910-54', '0.06'], ['Car Maintenance', '06-0115-0324910-56', '0.00'],
        ['Food / Gas', '06-0115-0324910-55', '0.00'], ['Misc Saving', '06-0115-0324910-50', '0.00'], ['Weekly Allowance', '06-0115-0324910-00', '0.00'],
        ['Allowance Storage', '06-0115-0324910-57', '0.00'],
      ].map(([name, number, amount]) => ({ name, number, balance: { amount, label: 'Balance' }, available: { amount, label: 'Available' } })),
    },
  };
  const reply = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(screen) }] } }] };
  const accounts = [['rent', 'Rent', '53'], ['bills', 'Misc bills', '54'], ['car', 'Car maintenance', '56'], ['foodgas', 'Food and gas', '55'], ['miscsave', 'Misc savings', '50'], ['weekly', 'Weekly allowance', '00'], ['storage', 'Allowance storage', '57']];
  function bank(withNumbers: boolean): Budget {
    const b = budget();
    for (const [id, name, suffix] of accounts) {
      b.accounts.push({ id, name, kind: 'bank', color: '#000', groupId: b.groups[0].id, ...(withNumbers ? { number: `06-0115-0324910-${suffix}` } : {}) });
      b.balances = { ...(b.balances ?? {}), [id]: { amount: 5000, asOf: '2026-11-10' } };
    }
    return b;
  }

  it('updates every account on it, matched by number, as at today', () => {
    const b = bank(true);
    const ex = parseReply(reply);
    expect(ex.kind).toBe('balances');
    const d = toDraft(ex, b, 'gemini', seq(), '2026-11-18');
    expect(d.balances.rows.map((r) => [r.accountId, r.matchedBy])).toEqual(accounts.map(([id]) => [id, 'number']));
    const r = review(d, b, '2026-11-18');
    expect(r.issues.filter((i) => i.level === 'block')).toEqual([]);
    const after = applyProposal(structuredClone(b), r.proposal!, '2026-11-18');
    expect(after.balances!.rent).toEqual({ amount: 27800, asOf: '2026-11-18' });
    expect(after.balances!.bills).toEqual({ amount: 6, asOf: '2026-11-18' });
    expect(after.balances!.storage).toEqual({ amount: 0, asOf: '2026-11-18' });
    expect(preview(b, r.proposal!, '2026-11-18').lines[0]).toBe("Rent: balance $50 → $278, as at 18 Nov");
  });

  it('without saved numbers, matches by name ("Food / Gas" is Food and gas) and keeps the numbers for next time', () => {
    const b = bank(false);
    const d = toDraft(parseReply(reply), b, 'gemini', seq(), '2026-11-18');
    expect(d.balances.rows.map((r) => [r.accountId, r.matchedBy])).toEqual(accounts.map(([id]) => [id, 'name']));
    const after = applyProposal(structuredClone(b), review(d, b, '2026-11-18').proposal!, '2026-11-18');
    expect(after.accounts.find((a) => a.id === 'foodgas')!.number).toBe('06-0115-0324910-55');
  });

  it('an account it can’t match is asked about, and can be left out', () => {
    const b = bank(true);
    b.accounts = b.accounts.filter((a) => a.id !== 'car');
    const d = toDraft(parseReply(reply), b, 'gemini', seq(), '2026-11-18');
    expect(d.balances.rows[2].accountId).toBe('');
    expect(review(d, b, '2026-11-18').proposal).toBeNull();
    d.balances.rows[2].accountId = NOT_MINE;
    const r = review(d, b, '2026-11-18');
    expect(r.proposal).toMatchObject({ kind: 'balances' });
    expect(r.ignored).toEqual(['Car Maintenance: left out.']);
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
