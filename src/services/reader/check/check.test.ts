import { describe, expect, it } from 'vitest';
import { depositFor } from '../../../engine/balances/deposits';
import { settleDue } from '../../../features/debts/logic/payments';
import { owed } from '../../../features/debts/logic/amounts';
import { debtPaymentsIn } from '../../../features/debts/logic/funding';
import { periodContaining } from '../../../engine/periods';
import type { Budget } from '../../../core/types';
import { applyProposal, preview, windBack } from '../apply';
import { NEW_DEBT, NOT_MINE } from './draft';
import { review } from './review';
import { toDraft } from './toDraft';
import { parseReply } from '../gemini';
import type { Extraction } from '../types';
import { guessDebt } from './toDraft';
import { ownTransfer } from '../../../engine/transfers';
import { budget, debtBudget, seq, checkDoc, upload, gemStatement, debt } from '../../../testing/fixtures';

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

  it('the balance is the statement’s; plans still adding up to more come down to match, unlisted ones first', () => {
    const b = debtBudget();
    const r = upload(b, gemStatement('2026-11-16', [{ remaining: '880.00', ends: '2027-03-20' }], '1500.00'), '2026-11-16');
    expect(debt(b, 'gem').balance).toEqual({ amount: 150000, asOf: '2026-11-16' });
    expect(debt(b, 'gem').plans.map((p) => [p.id, p.remaining])).toEqual([['g1', 62000], ['g2', 88000]]);
    expect(preview(debtBudget(), r.proposal!, '2026-11-16').lines.join(' ')).toMatch(/Jul 2026: \$1,200(\.00)? → \$620(\.00)? left, to match/);
  });

  it('a plan the statement shows finished ($0) is taken off', () => {
    const b = debtBudget();
    upload(b, gemStatement('2026-11-16', [{ remaining: '0.00', ends: '2027-01-20' }, { remaining: '900.00', ends: '2027-03-20' }], '900.00'), '2026-11-16');
    expect(debt(b, 'gem').plans.map((p) => [p.id, p.remaining])).toEqual([['g2', 90000]]);
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

  it('Upcoming payments: only what’s still due stays; other orders are marked paid off', () => {
    const b = debtBudget();
    // Screen like Afterpay’s Upcoming payments: only PHOTOGEAR $37.25 left (4 of 4).
    const upcoming: Extraction = {
      kind: 'afterpay',
      afterpay: {
        listsAllDue: true,
        orders: [{
          merchant: 'PHOTOGEAR',
          instalments: [{ date: '2026-12-31', amount: '37.25', label: '4 of 4', paid: false }],
        }],
      },
    };
    // Existing orders that should clear, plus Photogear still owing more than one instalment.
    const ap = debt(b, 'afterpay');
    ap.plans.push({
      id: 'ap-photo', name: 'Photogear', type: 'afterpay', original: 14900, remaining: 7450, asOf: '2026-11-01', purchaseDate: '2026-10-01',
      instalments: [
        { date: '2026-11-19', amount: 3725, label: '3 of 4' },
        { date: '2026-12-31', amount: 3725, label: '4 of 4' },
      ],
    });
    const before = ap.plans.length;
    expect(before).toBeGreaterThan(1);
    const pay = periodContaining('2026-11-19', b.settings);
    const sentBefore = depositFor(b, ap.accountId, pay, '2026-11-19');
    expect(sentBefore).toBeGreaterThan(0);
    const r = upload(b, upcoming, '2026-11-19');
    expect(r.issues.filter((i) => i.level === 'block')).toEqual([]);
    const after = debt(b, 'afterpay');
    expect(after.plans.map((p) => p.name)).toEqual(['Photogear']);
    expect(after.plans[0].instalments).toEqual([{ date: '2026-12-31', amount: 3725, label: '4 of 4' }]);
    expect(after.plans[0].remaining).toBe(3725);
    expect(r.issues.some((i) => i.level === 'note' && /paid off/i.test(i.text))).toBe(true);
    // Dropped in-period instalments stay on this pay (so leftover doesn’t invent spare cash).
    expect(after.paid?.some((x) => x.date === '2026-11-19' && x.amount === 3725)).toBe(true);
    expect(depositFor(b, ap.accountId, pay, '2026-11-19')).toBe(sentBefore);
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
    expect(ownTransfer(b, { description: 'To: 06-0115-0324910-55 Debit Transfer 083615' })).toMatchObject({ dir: 'to', account: { name: 'Rent' } });
    expect(ownTransfer(b, { description: '06-0115-0324910-055 DEBIT TRANSFER', amount: -100 })).toMatchObject({ dir: 'to', account: { name: 'Rent' } });
    expect(ownTransfer(b, { description: 'From: 06-0115-0324910-00 Credit Transfer 071301' })).toBeUndefined();
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
