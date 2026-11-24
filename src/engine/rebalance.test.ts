import { describe, expect, it } from 'vitest';
import { periodContaining, shiftPeriod } from './periods';
import { autoBalance, balancedMode, balancePay } from './rebalance';
import { depositFor } from './balances/deposits';
import { estimateBalance } from './balances/estimate';
import { budget, heldGemBudget } from '../testing/fixtures';

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

  it("a short pay doesn't trim Misc bills for Gem held there unless Gem itself is sent more than recommended", () => {
    // Misc bills sends its $100 bill plus Gem's $100; Fun's $4,900 leaves the $5,000 pay $100 short.
    const b = heldGemBudget();
    delete b.balances;
    b.accounts.push({ id: 'fun', name: 'Fun', kind: 'bank', color: '#000', groupId: 'lifestyle' });
    b.split.push({ accountId: 'fun', amount: 490000, mode: 'fixed' });
    const p = periodContaining('2026-12-20', b.settings);
    expect(balancePay(b, p, '2026-11-25').changes.find((c) => c.accountId === 'bills')).toBeUndefined();
    // Gem set to $300 a pay ($200 over what's recommended), so $300 short: that $200 comes off Misc bills' send.
    b.split.find((l) => l.accountId === 'gem')!.mode = 'fixed';
    b.split.find((l) => l.accountId === 'gem')!.amount = 30000;
    const c = balancePay(b, p, '2026-11-25').changes.find((x) => x.accountId === 'bills')!;
    expect(c.from - c.to).toBe(20000);
    expect(c.reason).toMatch(/saves no interest/);
  });
});

describe('putting leftover aside in a Steady account', () => {
  // Rent $400 every Friday, Steady, after the 20 Nov rent: the 18 Dec pay has 5 rents.
  const rentBudget = (balance: number, round = 0) => {
    const b = budget();
    b.settings.autoBalance = true;
    b.accounts.push({ id: 'rent', name: 'Rent', kind: 'bank', color: '#000', groupId: 'needs', round });
    b.split.push({ accountId: 'rent', amount: 170000, mode: 'smooth' });
    b.items.push({ id: 'r', name: 'Rent', amount: 40000, frequency: 'weekly', start: '2026-01-09', accountId: 'rent' });
    b.balances = { rent: { amount: balance, asOf: '2026-11-20' } };
    return autoBalance(b, '2026-11-22');
  };

  it('adds nothing when the buffer lasts the next year (a dip two years out is too far away)', () => {
    expect(rentBudget(157500).overrides?.['2026-12-18']?.rent).toBeUndefined();
  });

  it('adds just what the buffer is short within the next year', () => {
    expect(rentBudget(152500).autoBalanced?.['2026-12-18']?.rent?.reason).toMatch(/aside for the next 5-week pay/);
  });

  it('an account set to whole dollars sends whole dollars every pay, and never goes below $0', () => {
    for (const balance of [152500, 157500, 160000]) {
      const b = rentBudget(balance, 100);
      let p = periodContaining('2026-12-18', b.settings);
      for (let i = 0; i < 24; i++) {
        expect(depositFor(b, 'rent', p, '2026-11-22') % 100).toBe(0);
        expect(estimateBalance(b, 'rent', p.end, '2026-11-22')).toBeGreaterThanOrEqual(0);
        p = shiftPeriod(p, 1, b.settings);
      }
    }
  });
});
