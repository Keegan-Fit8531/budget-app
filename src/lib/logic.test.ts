import { describe, expect, it } from 'vitest';
import { balanceToday, billTracker, depositFor, estimateBalance } from './balances';
import { addDays } from './dates';
import { applyPayment, debtSchedules, planSchedule, recordHistory, settleDue } from './debts';
import { classifyText, matchDebt, parseDate, parseStatementText, recordStatement } from './documents';
import { clearPaydayMove, periodContaining, recordPayday, shiftPeriod } from './engine';
import { projectedAt, removeSpend, spendFromGoal } from './goalcosts';
import { autoBalance, balancedMode } from './rebalance';
import { forecast } from './savings';
import { seedBudget } from './seed';
import type { Budget, Debt, SavingsGoal } from './types';

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
    // $200 is set aside on the 19th of each month, from an account that gets $200 a pay and has nothing in it.
    const b = budget();
    b.accounts.push({ id: 'car', name: 'Car', kind: 'bank', color: '#000', groupId: 'needs' });
    b.split.push({ accountId: 'car', amount: 20000, mode: 'fixed' });
    b.items.push({ id: 'c', name: 'Service set-aside', amount: 20000, frequency: 'monthly', start: '2026-01-19', accountId: 'car' });
    b.balances = { car: { amount: 0, asOf: '2026-11-11' } };
    const today = '2026-11-14';

    // Paid on the 19th, each set-aside comes out on payday: nothing to adjust.
    autoBalance(b, today);
    expect(b.overrides?.['2026-11-19']?.car).toBeUndefined();

    // Paid on the 20th, 19 Nov's comes out the day before payday with nothing there, so the pay
    // starting Fri 20 Nov is topped up to cover it as well as 19 Dec's.
    b.settings.paydayDay = 20;
    autoBalance(b, today);
    expect(b.overrides?.['2026-11-20']?.car).toBe(40000);
    expect(b.autoBalanced?.['2026-11-20']?.car).toMatchObject({ prev: null, to: 40000 });
    // An amount set by hand for that pay, and a past pay's record, to check they're left alone.
    b.overrides!['2026-11-20'].food = 12300;
    b.autoBalanced!['2026-10-20'] = { car: { prev: null, to: 25000, reason: 'An earlier pay' } };
    b.overrides!['2026-10-20'] = { car: 25000 };

    // Back to the 19th: no pay starts on 20 Nov any more, so its top-up goes rather than lingering…
    b.settings.paydayDay = 19;
    autoBalance(b, today);
    expect(b.autoBalanced?.['2026-11-20']).toBeUndefined();
    expect(b.overrides?.['2026-11-20']).toEqual({ food: 12300 }); // …but what you set yourself stays
    expect(b.overrides?.['2026-11-19']?.car).toBeUndefined();
    expect(depositFor(b, 'car', periodContaining('2026-11-19', b.settings), today)).toBe(20000);
    // A pay that had already started keeps its record (it's history, and comes back if the payday does).
    expect(b.autoBalanced?.['2026-10-20']).toBeDefined();
    expect(b.overrides?.['2026-10-20']).toEqual({ car: 25000 });
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
