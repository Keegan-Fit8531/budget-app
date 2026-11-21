import { describe, expect, it } from 'vitest';
import { esctRate, isKiwiSaver, kiwiHistory, kiwiPerPay, recordReading, slipContribution } from './kiwisaver';
import { applyProposal, preview } from '../../../services/reader/apply';
import { NEW_GOAL } from '../../../services/reader/check/draft';
import { review } from '../../../services/reader/check/review';
import { toDraft } from '../../../services/reader/check/toDraft';
import { mergeReads, parseReply } from '../../../services/reader/gemini';
import { seedBudget } from '../../../core/seed';
import type { Budget, SavingsGoal } from '../../../core/types';
import type { Extraction } from '../../../services/reader/types';

const budget = (): Budget => structuredClone(seedBudget);
const fig = (amount: string, label?: string) => ({ amount, ...(label ? { label } : {}) });
let n = 0;
const ids = () => `id${++n}`;

// A Kernel "Full breakdown" and the funds screen (13 Nov 2026).
const kernel: Extraction = {
  kind: 'kiwisaver',
  kiwisaver: {
    provider: 'Kernel KiwiSaver Plan', date: '2026-11-13', since: '2023-10-10',
    balance: fig('31614.19', 'Closing value'), opening: fig('6880.27', 'Opening value'),
    employee: fig('8850.22'), voluntary: fig('0.00'), employer: fig('6165.95'), government: fig('1303.58'), withdrawals: fig('0.00'),
    earnings: fig('8645.99', 'Investment Earnings or Losses (before tax)'), tax: fig('-231.82', 'PIE Tax'),
    funds: [{ name: 'Global 100', amount: fig('1348.76') }, { name: 'High Growth', amount: fig('28897.93') }, { name: 'S&P 500 (Unhedged)', amount: fig('1367.50') }],
  },
};

describe('KiwiSaver', () => {
  it('is a goal marked as one, or called KiwiSaver', () => {
    expect(isKiwiSaver({ name: 'KiwiSaver' })).toBe(true);
    expect(isKiwiSaver({ name: 'Kiwi Saver (Kernel)' })).toBe(true);
    expect(isKiwiSaver({ name: 'Retirement', kiwisaver: true })).toBe(true);
    expect(isKiwiSaver({ name: 'KiwiSaver', kiwisaver: false })).toBe(false);
    expect(isKiwiSaver({ name: 'Wedding' })).toBe(false);
  });

  it('what a payslip puts in: yours, plus your employer’s after ESCT', () => {
    expect(esctRate(5_000_000)).toBe(0.175);
    expect(esctRate(13_867_000)).toBe(0.33);
    // $11,291.67 taxable a month (about $135K a year with the employer's share): 33% ESCT.
    expect(slipContribution({ net: 672451, taxableGross: 1129167, kiwisaver: 39521, employerKiwisaver: 26486 })).toEqual({ you: 39521, employer: 17746, total: 57267 });
  });

  it('a Kernel breakdown read by Gemini: a new KiwiSaver goal with its opening and closing values, funds and returns', () => {
    const b = budget();
    const d = toDraft(kernel, b, 'gemini', ids, '2026-11-16');
    expect(d.kiwisaver.goalId).toBe(NEW_GOAL);
    const r = review(d, b, '2026-11-16');
    expect(r.issues.filter((i) => i.level === 'block')).toEqual([]);
    // Opening + contributions + earnings − tax is the closing value, so there's nothing to check.
    expect(r.issues).toEqual([]);
    const pv = preview(b, r.proposal!, '2026-11-16');
    expect(pv.lines).toContain('Funds: Global 100 $1,348.76 · High Growth $28,897.93 · S&P 500 (Unhedged) $1,367.50');
    expect(pv.lines).toContain('10 Oct 2023 to 13 Nov 2026: $16,319.75 went in, earned $8,414.17 after PIE tax.');
    applyProposal(b, r.proposal!, '2026-11-16');
    const g = b.savings!.find(isKiwiSaver)!;
    expect(g).toMatchObject({ name: 'KiwiSaver', balance: 3161419, asOf: '2026-11-13', kiwisaver: true, note: 'Kernel KiwiSaver Plan' });
    expect(b.split.some((l) => l.accountId === g.accountId)).toBe(false);
    expect(g.funds!.map((f) => f.name)).toEqual(['Global 100', 'High Growth', 'S&P 500 (Unhedged)']);
    const h = kiwiHistory(b, g);
    expect(h.map((p) => [p.date, p.balance])).toEqual([['2023-10-10', 688027], ['2026-11-13', 3161419]]);
    expect(h[1]).toMatchObject({ returns: 841417, putIn: 2320002, gain: 841417, stated: true });
    expect(h[1].funds.map((f) => f.value)).toEqual([134876, 2889793, 136750]);
  });

  it('a later statement goes to the same goal, and a bank balance in between is worked out from the statement’s contributions', () => {
    const b = budget();
    upload(b, kernel);
    const g = () => b.savings!.find(isKiwiSaver)!;
    // The bank connection brings in a balance a month later.
    recordReading(g(), { date: '2026-12-13', balance: 3250000 });
    expect(g()).toMatchObject({ balance: 3250000, asOf: '2026-12-13' });
    const h = kiwiHistory(b, g());
    // No statement covers it and there are no payslips: what went in isn't known, so it all counts as returns.
    expect(h[2]).toMatchObject({ gain: 88581, stated: false, inKnown: false });
    // Funds are shared out from the last split.
    expect(h[2].fundsEstimated).toBe(true);
    expect(h[2].funds.reduce((t, f) => t + f.value, 0)).toBeCloseTo(3250000, -1);
    // With a payslip, a payday's contributions come off.
    b.payslips = { '2026-11-19': { payDay: '2026-11-19', net: 672451, taxableGross: 1129167, kiwisaver: 39521, employerKiwisaver: 26486 } };
    expect(kiwiHistory(b, g())[2]).toMatchObject({ gain: 88581 - 57267, inKnown: true });
    expect(kiwiPerPay(b)?.total).toBe(57267);
    // An older balance (a statement from last year) slots in, the goal's balance stays.
    recordReading(g(), { date: '2025-11-13', balance: 2000000 });
    expect(g().balance).toBe(3250000);
    // Between two statement dates, the statement's average contribution per day is used.
    const mid = kiwiHistory(b, g()).find((p) => p.date === '2025-11-13')!;
    expect(mid.inKnown).toBe(true);
    // $16,319.75 went in over 1,130 days; 765 of them are before this balance.
    expect(mid.putIn).toBe(688027 + Math.round((1631975 * 765) / 1130));
  });

  it('an older statement for a KiwiSaver the bank connection set up keeps the bank’s newer balance', () => {
    const b = budget();
    b.savings = [{ id: 'ks', name: 'KiwiSaver', accountId: 'ks', balance: 3170000, asOf: '2026-11-17', note: 'Balance from Kernel Wealth through the bank connection.' }];
    const d = toDraft(kernel, b, 'gemini', ids, '2026-11-17');
    expect(d.kiwisaver.goalId).toBe('ks');
    const r = review(d, b, '2026-11-17');
    expect(r.issues.map((i) => i.text)).toContain('This is from 13 Nov, before the balance you have (17 Nov), so it’s added to the history and the balance stays.');
    applyProposal(b, r.proposal!, '2026-11-17');
    expect(b.savings[0]).toMatchObject({ balance: 3170000, asOf: '2026-11-17' });
    expect(b.savings[0].readings!.map((x) => x.date)).toEqual(['2023-10-10', '2026-11-13', '2026-11-17']);
    expect(kiwiHistory(b, b.savings[0]).map((p) => p.returns)).toEqual([0, 841417, 841417 + 3170000 - 3161419]);
  });

  it('a later balance the same day keeps the fund values it doesn’t give', () => {
    const goal: SavingsGoal = { id: 'k', name: 'KiwiSaver', accountId: 'k', balance: 0, asOf: '2026-01-01' };
    recordReading(goal, { date: '2026-11-13', balance: 3161419, funds: { 'High Growth': 2889793, 'Global 100': 271626 } });
    recordReading(goal, { date: '2026-11-13', balance: 3161500 });
    expect(goal.readings).toEqual([{ date: '2026-11-13', balance: 3161500, funds: { 'High Growth': 2889793, 'Global 100': 271626 } }]);
    expect(goal.funds!.map((f) => f.name)).toEqual(['High Growth', 'Global 100']);
    expect(goal.funds![0].color).not.toBe(goal.funds![1].color);
  });

  it('flags a breakdown that doesn’t add up, and blocks one with no date', () => {
    const b = budget();
    const bad = structuredClone(kernel);
    bad.kiwisaver!.balance = fig('35000.00');
    expect(review(toDraft(bad, b, 'gemini', ids, '2026-11-16'), b, '2026-11-16').issues.map((i) => i.text).join(' ')).toMatch(/come to \$31,614\.19, not the \$35,000 balance/);
    const undated = structuredClone(kernel);
    delete undated.kiwisaver!.date;
    expect(review(toDraft(undated, b, 'gemini', ids, '2026-11-16'), b, '2026-11-16').proposal).toBeNull();
  });

  it('Gemini’s reply: a KiwiSaver form, and a long PDF’s parts as one with each fund once', () => {
    const reply = { candidates: [{ content: { parts: [{ text: JSON.stringify({ kind: 'kiwisaver', payslip: null, statement: null, account: null, afterpay: null, kiwisaver: { ...kernel.kiwisaver, returns: null }, notes: null }) }] } }] };
    expect(parseReply(reply as never).kiwisaver?.balance?.amount).toBe('31614.19');
    const a: Extraction = { kind: 'kiwisaver', kiwisaver: { date: '2026-11-13', balance: fig('31614.19'), funds: [{ name: 'High Growth', amount: fig('28897.93') }] } };
    const c: Extraction = { kind: 'kiwisaver', kiwisaver: { since: '2023-10-10', funds: [{ name: 'high growth', amount: fig('28897.93') }, { name: 'Global 100', amount: fig('1348.76') }] } };
    expect(mergeReads([a, c]).kiwisaver).toEqual({ date: '2026-11-13', balance: fig('31614.19'), since: '2023-10-10', funds: [{ name: 'High Growth', amount: fig('28897.93') }, { name: 'Global 100', amount: fig('1348.76') }] });
  });
});

function upload(b: Budget, ex: Extraction) {
  const r = review(toDraft(ex, b, 'gemini', ids, '2026-11-16'), b, '2026-11-16');
  if (!r.proposal) throw new Error(r.issues.map((i) => i.text).join(' / '));
  applyProposal(b, r.proposal, '2026-11-16');
}

describe('KiwiSaver month by month', () => {
  it('fills the months between two balances from the account’s contributions, landing on each real balance', async () => {
    const { kiwiMonths } = await import('./kiwisaver');
    const goal = {
      id: 'k', name: 'KiwiSaver', accountId: 'ks', balance: 160000, asOf: '2026-04-30', kiwisaver: true,
      readings: [
        { date: '2026-01-15', balance: 100000 },
        { date: '2026-04-30', balance: 160000, statement: { since: '2026-01-15', employee: 30000, employer: 20000 } },
      ],
    };
    const b = {
      settings: { paydayDay: 19, saturday: 'friday', sunday: 'monday' }, payslips: {},
      accountTransactions: { ks: [
        { date: '2026-02-10', description: 'IRDRemittedContribution', amount: 20000 },
        { date: '2026-03-10', description: 'IRDRemittedContribution', amount: 20000 },
        { date: '2026-04-10', description: 'IRDRemittedContribution', amount: 10000 },
      ] },
    } as never;
    const m = kiwiMonths(b, goal as never);
    expect(m[0]).toMatchObject({ date: '2026-01-15', balance: 100000, actual: true });
    expect(m[m.length - 1]).toMatchObject({ date: '2026-04-30', balance: 160000, actual: true, putIn: 150000 });
    expect(m.map((x) => x.date)).toEqual(['2026-01-15', '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    // What went in steps with each contribution.
    expect(m.map((x) => x.added)).toEqual([0, 0, 20000, 20000, 10000]);
    // Between balances it's estimated, and goes up rather than jumping at the end.
    expect(m[2].actual).toBe(false);
    expect(m[2].balance).toBeGreaterThan(100000);
    expect(m[2].balance).toBeLessThan(160000);
  });
});
