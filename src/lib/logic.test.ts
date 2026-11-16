import { describe, expect, it } from 'vitest';
import { balanceToday, billTracker, depositFor, estimateBalance, outflows } from './balances';
import { applyAllocation, existingExtras, undoAllocation } from './allocate';
import { addDays } from './dates';
import { applyPayment, debtPaymentsIn, debtSchedules, owed, paidIn, planSchedule, recordHistory, settleDue } from './debts';
import { classifyText, matchDebt, parseDate, parseStatementText, recordStatement } from './documents';
import { averageNeed, clearPaydayMove, periodContaining, planFor, recordPayday, setAsidePerPay, shiftPeriod } from './engine';
import { projectedAt, removeSpend, spendFromGoal } from './goalcosts';
import { autoBalance, balancedMode, balancePay } from './rebalance';
import { accountHistory, recordCost, removeCost, setBalance } from './history';
import { parseMoney } from './money';
import { forecast } from './savings';
import { seedBudget } from './seed';
import type { Budget, Debt, SavingsGoal } from './types';
import { looksLikeBudget } from './valid';
import { applyProposal, preview, windBack } from './reader/apply';
import { NEW_DEBT, review, toCents, toDraft, validDate, type Draft } from './reader/check';
import { classifyHttpError, nextPacificMidnight, nzTime, ReaderError } from './reader/errors';
import { geminiProvider, parseReply } from './reader/gemini';
import { prepareFile } from './reader/prepare';
import { buildContext, RESPONSE_SCHEMA } from './reader/prompt';
import type { Extraction } from './reader/types';
import { buildUndo, undoKeeps, undoUpload } from './reader/undo';

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
    expect(ctx.debts.find((d) => d.id === 'studentloan')).toMatchObject({ neverAStatement: true });
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
  const d = toDraft(ex, b, 'gemini', seq());
  edit?.(d);
  return review(d, b, today);
};
/** Read, check and apply a document, as Confirm does. Returns what Undo would need too. */
function upload(b: Budget, ex: Extraction, today: string, edit?: (d: Draft) => void) {
  const r = checkDoc(b, ex, today, edit);
  if (!r.proposal) throw new Error(`blocked: ${r.issues.map((i) => i.text).join(' / ')}`);
  const before = structuredClone(b);
  applyProposal(b, r.proposal, today);
  return { ...r, undo: buildUndo(before, b, r.proposal, 'doc.pdf', 'Doc') };
}
const gemStatement = (date: string, plans: { planId?: string | null; remaining: string; ends: string }[], balance = '2800.00'): Extraction => ({
  kind: 'statement',
  statement: { debtId: 'gem', nameOnDocument: 'Gem Visa', balance: { amount: balance, label: 'Closing balance' }, statementDate: date, plans: plans.map((p) => ({ ...p, remaining: { amount: p.remaining } })) },
});
const debt = (b: Budget, id: string) => b.debts!.find((d) => d.id === id)!;

describe('reading documents: statements', () => {
  it('asks first when the debt isn’t one of yours, is the student loan, or is Afterpay', () => {
    const b = debtBudget();
    const blocks = (debtId: string) => checkDoc(b, { kind: 'statement', statement: { debtId, balance: { amount: '100.00' }, statementDate: '2026-11-10' } }, '2026-11-16').issues.filter((i) => i.level === 'block').map((i) => i.text).join(' ');
    expect(blocks('studentloan')).toMatch(/Choose which debt/);
    expect(blocks('made-up')).toMatch(/Choose which debt/);
    expect(blocks('afterpay')).toMatch(/worked out from its orders/);
    expect(blocks('qcard')).toBe('');
    // A missing date or a silly amount is never saved.
    expect(checkDoc(b, { kind: 'statement', statement: { debtId: 'qcard', balance: { amount: 'lots' } } }, '2026-11-16').proposal).toBeNull();
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
    expect(r.ignored.join(' ')).toMatch(/Countdown.*already included/);
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

describe('reading documents: payslips and Undo', () => {
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

  it('Undo puts back a payslip that moved a payday: the pay, the payday and the student loan', () => {
    const b = debtBudget();
    b.payActuals['2026-11-19'] = 400000; // an amount typed in before the payslip came
    const before = structuredClone(b);
    const { undo } = upload(b, payslip('2026-11-18'), '2026-11-16');
    expect(b.settings.paydayMoves?.['2026-11']).toBe('2026-11-18');
    expect(b.payActuals['2026-11-18']).toBe(401234);
    expect(owed(debt(b, 'studentloan'))).toBe(2000000 - 33766);
    const kept = undoUpload(b, undo, '2026-11-16');
    expect(kept).toEqual([]);
    expect(b.settings.paydayMoves?.['2026-11']).toBeUndefined();
    expect(b.payActuals).toEqual(before.payActuals);
    expect(b.payslips ?? {}).toEqual(before.payslips ?? {});
    expect(debt(b, 'studentloan')).toEqual(debt(before, 'studentloan'));
  });

  it('Undo puts a statement back exactly', () => {
    const b = debtBudget();
    const before = structuredClone(b);
    const { undo } = upload(b, gemStatement('2026-11-10', [{ remaining: '1150.00', ends: '2027-01-20' }, { remaining: '880.00', ends: '2027-03-20' }]), '2026-11-16');
    expect(undoUpload(b, undo, '2026-11-16')).toEqual([]);
    expect(b.debts).toEqual(before.debts);
  });

  it('Undo keeps what you’ve changed since, and says so', () => {
    const b = debtBudget();
    const { undo } = upload(b, gemStatement('2026-11-10', [{ remaining: '1150.00', ends: '2027-01-20' }]), '2026-11-16');
    debt(b, 'gem').limit = 900000; // you edited Gem afterwards
    const mine = structuredClone(debt(b, 'gem'));
    expect(undoKeeps(b, undo, '2026-11-16')).toEqual(['Kept your later change to Gem Visa.']);
    expect(undoUpload(b, undo, '2026-11-16')).toEqual(['Kept your later change to Gem Visa.']);
    expect(debt(b, 'gem')).toEqual(mine);
  });

  it('Undo still works after payments have been counted automatically overnight', () => {
    const b = debtBudget();
    const before = structuredClone(b);
    const { undo } = upload(b, { kind: 'statement', statement: { debtId: 'qcard', balance: { amount: '612.40' }, statementDate: '2026-11-18' } }, '2026-11-18');
    // Payday (the 19th) passes: the app counts the card's payment as paid.
    expect(settleDue(debt(b, 'qcard'), b.settings, '2026-11-20')).toBe(true);
    expect(undoUpload(b, undo, '2026-11-20')).toEqual([]);
    const expected = structuredClone(debt(before, 'qcard'));
    settleDue(expected, before.settings, '2026-11-20');
    expect(debt(b, 'qcard').balance).toEqual(expected.balance);
  });

  it('Undo removes a debt the upload added, with its payday account', () => {
    const b = debtBudget();
    const before = structuredClone(b);
    const { undo } = upload(b, { kind: 'statement', statement: { debtId: null, nameOnDocument: 'Kiwibank Visa', balance: { amount: '950.00' }, statementDate: '2026-11-14' } }, '2026-11-16', (d) => { d.statement.debtId = NEW_DEBT; });
    expect(debt(b, 'new1')).toMatchObject({ name: 'Kiwibank Visa', balance: { amount: 95000 } });
    undoUpload(b, undo, '2026-11-16');
    expect(b.debts).toEqual(before.debts);
    expect(b.accounts).toEqual(before.accounts);
    expect(b.split).toEqual(before.split);
  });
});
