import { describe, expect, it } from 'vitest';
import { estimateBalance } from './balances/estimate';
import { depositFor } from './balances/deposits';
import { outflows } from './balances/outflows';
import { asideMaxSaved, asideSplit, setAsidePerPay } from './setAside';
import { averageNeed, planFor } from './plan';
import { periodContaining, shiftPeriod } from './periods';
import { autoBalance, balancedMode, balancePay } from './rebalance';
import type { Budget } from '../core/types';
import { budget } from '../testing/fixtures';

describe('max saved on money put aside', () => {
  it('stops adding once spare after bills reaches the cap (e.g. Haircut $60)', () => {
    const b = budget();
    b.accounts.push({ id: 'bills', name: 'Misc bills', kind: 'bank', color: '#000', groupId: 'needs' });
    b.split.push({ accountId: 'bills', amount: 0, mode: 'exact' });
    b.items.push(
      { id: 'power', name: 'Power', amount: 10000, frequency: 'monthly', start: '2026-11-15', accountId: 'bills' },
      { id: 'cut', name: 'Haircut', amount: 2000, frequency: 'monthly', start: '2026-11-01', accountId: 'bills', setAside: true, maxSaved: 6000 },
    );
    // $100 bill still to come + $60 already aside → spare for Haircut is $60 → add nothing.
    b.balances = { bills: { amount: 16000, asOf: '2026-11-14' } };
    const p = periodContaining('2026-11-19', b.settings);
    expect(depositFor(b, 'bills', p, '2026-11-14')).toBe(10000);
    // Only $40 aside so far → still room for $20.
    b.balances = { bills: { amount: 14000, asOf: '2026-11-14' } };
    expect(depositFor(b, 'bills', p, '2026-11-14')).toBe(12000);
  });

  it('exposes the account max so Accounts can show it (Haircut max $60)', () => {
    const b = budget();
    b.accounts.push({ id: 'bills', name: 'Misc bills', kind: 'bank', color: '#000', groupId: 'needs' });
    b.items.push(
      { id: 'cut', name: 'Haircut', amount: 2000, frequency: 'monthly', start: '2026-11-01', accountId: 'bills', setAside: true, maxSaved: 6000 },
    );
    expect(asideMaxSaved(b, 'bills')).toBe(6000);
    // Uncapped set-aside on the same account → no single account max.
    b.items.push({ id: 'tyres', name: 'Tyres', amount: 5000, frequency: 'monthly', start: '2026-11-01', accountId: 'bills', setAside: true });
    expect(asideMaxSaved(b, 'bills')).toBeUndefined();
  });

  it("splits what's put aside across set-asides: capped ones up to their max, the rest to an uncapped one", () => {
    const b = budget();
    b.items.push(
      { id: 'cut', name: 'Haircut', amount: 2000, frequency: 'monthly', start: '2026-11-01', accountId: 'bills', setAside: true, maxSaved: 6000 },
      { id: 'tyres', name: 'Tyres', amount: 5000, frequency: 'monthly', start: '2026-11-01', accountId: 'bills', setAside: true },
    );
    expect(asideSplit(b, 'bills', 4000).map((x) => [x.item.id, x.amount])).toEqual([['cut', 4000]]);
    expect(asideSplit(b, 'bills', 10000).map((x) => [x.item.id, x.amount])).toEqual([['cut', 6000], ['tyres', 4000]]);
    // Two without a max share by their monthly amounts.
    b.items.push({ id: 'wof', name: 'WOF', amount: 2000, frequency: 'monthly', start: '2026-11-01', accountId: 'bills', setAside: true });
    expect(asideSplit(b, 'bills', 13000).map((x) => [x.item.id, x.amount])).toEqual([['cut', 6000], ['tyres', 5000], ['wof', 2000]]);
    b.items.splice(1);
    expect(asideSplit(b, 'bills', 10000).map((x) => [x.item.id, x.amount])).toEqual([['cut', 6000]]);
  });

  it('does not treat an over-max Haircut account as having no spare at all', () => {
    const b = budget();
    b.settings.expectedPay = 500000;
    b.accounts.push(
      { id: 'bills', name: 'Misc bills', kind: 'bank', color: '#000', groupId: 'needs' },
      { id: 'short', name: 'Short', kind: 'bank', color: '#000', groupId: 'needs' },
    );
    b.split.push({ accountId: 'bills', amount: 0, mode: 'exact' }, { accountId: 'short', amount: 0, mode: 'exact' });
    b.items.push(
      { id: 'cut', name: 'Haircut', amount: 2000, frequency: 'monthly', start: '2026-11-01', accountId: 'bills', setAside: true, maxSaved: 6000 },
      { id: 'bill', name: 'Power', amount: 50000, frequency: 'monthly', start: '2026-11-25', accountId: 'short' },
    );
    // $189.73 left → $60 for Haircut, $129.73 above the max (already in the account).
    b.balances = { bills: { amount: 18973, asOf: '2026-11-14' } };
    const p = periodContaining('2026-11-19', b.settings);
    const r = balancePay(b, p, '2026-11-14');
    expect(r.notSpare.find((x) => x.accountId === 'bills')?.reason ?? '').not.toMatch(/none of it is spare/);
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
