import { describe, expect, it } from 'vitest';
import { billTracker } from './balances/billTracker';
import { depositFor } from './balances/deposits';
import { outflows } from './balances/outflows';
import { envelopeBudget, envelopeOn, envelopePerPay, envelopeWindow } from './setAside';
import { periodContaining } from './periods';
import { accountEnvelopes, envelopeHeld, envelopeStatus, guessTransfer, matchesEnvelope, transferKey, unsortedTransfers } from './envelope';
import { budget, foodGasBudget } from '../testing/fixtures';

describe('month envelope (Gas)', () => {
  it('funds a share of the monthly budget on each payday and tracks fuel spend', () => {
    const b = budget();
    b.accounts.push({ id: 'food', name: 'Food and gas', kind: 'bank', color: '#000', groupId: 'needs' });
    b.split.push({ accountId: 'food', amount: 0, mode: 'exact' });
    b.items.push(
      { id: 'gas', name: 'Gas', amount: 20000, frequency: 'monthly', start: '2026-11-01', accountId: 'food', envelope: 'month' as const },
      { id: 'food', name: 'Food', amount: 15000, frequency: 'weekly', start: '2026-11-03', accountId: 'food' },
    );
    const p = periodContaining('2026-11-19', b.settings);
    // Gas has no dated outflows — only its payday share.
    expect(outflows(b, 'food', p.start, p.end).every((o) => o.name !== 'Gas')).toBe(true);
    const share = envelopeOn(b, 'food', p.start);
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThanOrEqual(20000);
    // Exact need includes food weeks + gas share.
    expect(depositFor(b, 'food', p, '2026-11-14')).toBeGreaterThanOrEqual(share);

    b.accountTransactions = {
      food: [
        { date: '2026-11-05', description: 'Z ENERGY WELLINGTON', amount: -4500 },
        { date: '2026-11-12', description: 'BP CONNECT', amount: -3800 },
        { date: '2026-11-08', description: 'COUNTDOWN', amount: -9000 },
      ],
    };
    expect(matchesEnvelope({ name: 'Gas' }, b.accountTransactions!.food[0])).toBe(true);
    expect(matchesEnvelope({ name: 'Gas' }, b.accountTransactions!.food[2])).toBe(false);
    const st = envelopeStatus(b, b.items[0], '2026-11-14');
    expect(st.budget).toBe(20000);
    expect(st.spent).toBe(8300);
    expect(st.left).toBe(11700);
    expect(st.over).toBe(false);
    expect(accountEnvelopes(b, 'food', '2026-11-14')).toHaveLength(1);
  });

  it('marks over when fuel spend exceeds the month budget, and resets next month', () => {
    const b = budget();
    b.accounts.push({ id: 'food', name: 'Food and gas', kind: 'bank', color: '#000', groupId: 'needs' });
    b.items.push(
      { id: 'gas', name: 'Gas', amount: 10000, frequency: 'monthly', start: '2026-11-01', accountId: 'food', envelope: 'month' as const },
    );
    b.accountTransactions = {
      food: [
        { date: '2026-11-05', description: 'GULL', amount: -6000 },
        { date: '2026-11-20', description: 'CALTEX', amount: -5500 },
        { date: '2026-12-02', description: 'BP', amount: -4000 },
      ],
    };
    const nov = envelopeStatus(b, b.items[0], '2026-11-25');
    expect(nov.spent).toBe(11500);
    expect(nov.over).toBe(true);
    expect(nov.left).toBe(-1500);
    const dec = envelopeStatus(b, b.items[0], '2026-12-05');
    expect(dec.budget).toBe(10000);
    expect(dec.spent).toBe(4000);
    expect(dec.left).toBe(6000);
    expect(dec.over).toBe(false);
  });

  it('splits the monthly budget across paydays in the month', () => {
    const b = budget();
    const item = { id: 'gas', name: 'Gas', amount: 20000, frequency: 'monthly' as const, start: '2026-11-01', accountId: 'food', envelope: 'month' as const };
    const pays = ['2026-11-19']; // one payday in Nov for paydayDay 19
    // With one payday, the whole month budget goes on that pay.
    expect(envelopePerPay(item, '2026-11-19', b.settings)).toBe(20000);
    expect(envelopePerPay(item, pays[0], b.settings)).toBe(20000);
  });

  it('treats unspent gas budget as reserved: food + gas can make the account short', () => {
    const b = budget();
    b.accounts.push({ id: 'food', name: 'Food and gas', kind: 'bank', color: '#000', groupId: 'needs' });
    b.split.push({ accountId: 'food', amount: 0, mode: 'smooth' });
    // $200/week food × 5 = $1,000 this pay; gas month budgets $271.76 + $54.35 = $326.11.
    b.items.push(
      { id: 'food', name: 'Food', amount: 20000, frequency: 'weekly', start: '2026-11-19', accountId: 'food' },
      { id: 'car', name: 'Car gas', amount: 27176, frequency: 'monthly', start: '2026-11-01', accountId: 'food', envelope: 'month' as const },
      { id: 'scooter', name: 'Scooter gas', amount: 5435, frequency: 'monthly', start: '2026-11-01', accountId: 'food', envelope: 'month' as const },
    );
    b.balances = { food: { amount: 119575, asOf: '2026-11-19' } };
    const today = '2026-11-19';
    const t = billTracker(b, 'food', today);
    expect(t.toCome).toBe(100000);
    expect(t.spare).toBe(19575); // $195.75 after food alone — looked like buffer before
    const held = envelopeHeld(b, 'food', today);
    expect(held).toBe(32611);
    // Food $1,000 + gas $326.11 = $1,326.11 needed vs $1,195.75 → short $130.36
    expect(t.spare - held).toBe(-13036);
  });
});

describe('week and fortnight envelopes (Food shop)', () => {
  const food = { id: 'shop', name: 'Food shop', amount: 20000, frequency: 'weekly' as const, start: '2026-11-05', accountId: 'food', envelope: 'week' as const };

  it('counts each week from the first date', () => {
    expect(envelopeWindow(food, '2026-11-05')).toEqual({ from: '2026-11-05', to: '2026-11-11' });
    expect(envelopeWindow(food, '2026-11-21')).toEqual({ from: '2026-11-19', to: '2026-11-25' });
    expect(envelopeWindow({ ...food, envelope: 'fortnight' }, '2026-11-21')).toEqual({ from: '2026-11-19', to: '2026-12-02' });
    expect(envelopeWindow({ ...food, envelope: undefined }, '2026-11-21')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
  });

  it('budgets per span and funds every week or fortnight that starts in the pay', () => {
    const b = budget();
    expect(envelopeBudget(food)).toBe(20000);
    expect(envelopeBudget({ ...food, envelope: 'fortnight' })).toBe(40000);
    // The 19 Nov pay runs to 17 Dec (19 Dec is a Saturday, so pay comes on the 18th): weeks start 19, 26 Nov, 3, 10, 17 Dec; fortnights 19 Nov, 3, 17 Dec.
    const p = periodContaining('2026-11-19', b.settings);
    expect(p.end).toBe('2026-12-17');
    expect(envelopePerPay(food, p.start, b.settings)).toBe(5 * 20000);
    expect(envelopePerPay({ ...food, envelope: 'fortnight' }, p.start, b.settings)).toBe(3 * 40000);
    // Stops after its end date, and starts no earlier than its first date.
    expect(envelopePerPay({ ...food, end: '2026-11-18' }, p.start, b.settings)).toBe(0);
    expect(envelopePerPay({ ...food, start: '2027-06-03' }, p.start, b.settings)).toBe(0);
  });

  it('tracks this week’s supermarket spend and resets the next week', () => {
    const b = budget();
    b.accounts.push({ id: 'food', name: 'Food and gas', kind: 'bank', color: '#000', groupId: 'needs' });
    b.items.push(food);
    b.accountTransactions = {
      food: [
        { date: '2026-11-17', description: 'PAK N SAVE PETONE', amount: -9000 },
        { date: '2026-11-20', description: 'COUNTDOWN', amount: -12000 },
        { date: '2026-11-21', description: 'Z ENERGY', amount: -5000 },
        { date: '2026-11-22', description: 'NEW WORLD', amount: -10000 },
      ],
    };
    const st = envelopeStatus(b, food, '2026-11-22');
    expect(st.span).toBe('week');
    expect([st.from, st.to]).toEqual(['2026-11-19', '2026-11-25']);
    expect(st.spent).toBe(22000);
    expect(st.over).toBe(true);
    expect(st.left).toBe(-2000);
    expect(envelopeStatus(b, food, '2026-11-26').spent).toBe(0);
    // This week's $200, plus the 3 later weeks (3, 10, 17 Dec) the 19 Nov pay funded.
    expect(envelopeHeld(b, 'food', '2026-11-26')).toBe(4 * 20000);
  });
});

describe('transfers that paid for an envelope', () => {
  // Food and gas (…-55) moves $50 to Everyday (…-00) after a supermarket shop on the Everyday card.
  function setup() {
    const b = foodGasBudget();
    b.items = b.items.filter((i) => i.id !== 'scoot');
    const move = { date: '2026-11-22', description: 'To: 06-0115-0324910-00 Debit Transfer 002552', amount: -5000 };
    b.pendingTransactions = { food: [move], day: [{ date: '2026-11-21', description: 'Freshchoice', amount: -5394 }] };
    return { b, move };
  }

  it('counts a transfer against the envelope whose purchase it paid for', () => {
    const { b, move } = setup();
    const g = guessTransfer(b, 'food', move)!;
    expect(g).toMatchObject({ itemIds: ['shop'], sure: true });
    expect(g.seen[0].txn.amount).toBe(-5394);
    const st = envelopeStatus(b, b.items.find((i) => i.id === 'shop')!, '2026-11-22');
    expect(st.spent).toBe(5000);
    expect(st.left).toBe(15000);
    expect(unsortedTransfers(b, 'food', '2026-11-22')).toEqual([]);
  });

  it('asks when nothing nearby explains it, or when two envelopes fit, and keeps your answer', () => {
    const { b, move } = setup();
    b.pendingTransactions!.day = [];
    expect(guessTransfer(b, 'food', move)).toBeUndefined();
    expect(unsortedTransfers(b, 'food', '2026-11-22')).toHaveLength(1);
    // Car gas and Scooter gas both match a fuel stop: not sure.
    b.items.push({ id: 'scoot', name: 'Scooter gas', amount: 5000, frequency: 'monthly', start: '2026-11-01', accountId: 'food', envelope: 'month' });
    b.pendingTransactions!.day = [{ date: '2026-11-22', description: 'Z ENERGY KILBIRNIE', amount: -4800 }];
    expect(guessTransfer(b, 'food', move)).toMatchObject({ sure: false });
    expect(unsortedTransfers(b, 'food', '2026-11-22')).toHaveLength(1);
    b.envelopeTransfers = { [transferKey('food', move)]: 'scoot' };
    expect(unsortedTransfers(b, 'food', '2026-11-22')).toEqual([]);
    expect(envelopeStatus(b, b.items.find((i) => i.id === 'scoot')!, '2026-11-22').spent).toBe(5000);
    // "Just moving money" counts against nothing, even when a purchase matched.
    b.envelopeTransfers = { [transferKey('food', move)]: '' };
    expect(envelopeStatus(b, b.items.find((i) => i.id === 'car')!, '2026-11-22').spent).toBe(0);
  });

  it('keeps the later weeks this pay funded as well as what is left this week', () => {
    const { b } = setup();
    // Pay 19 Nov – 17 Dec: this week (19–25 Nov) has $150 left, 4 more weeks to come, Car gas $250.
    const st = envelopeStatus(b, b.items.find((i) => i.id === 'shop')!, '2026-11-22');
    expect(st.laterCount).toBe(4);
    expect(envelopeHeld(b, 'food', '2026-11-22')).toBe(15000 + 4 * 20000 + 25000);
  });
});

describe('several transfers after several purchases', () => {
  // $50, $150 and $80 moved to Everyday after a $53.94 shop, a $111.67 shop and an $80.49 fill at U-Go.
  function setup() {
    const b = foodGasBudget();
    const moves = [5000, 15000, 8000].map((n, i) => ({ date: '2026-11-22', description: `To: 06-0115-0324910-00 Debit Transfer ${i}`, amount: -n }));
    b.pendingTransactions = {
      food: moves,
      day: [
        { date: '2026-11-21', description: 'Freshchoice', amount: -5394 },
        { date: '2026-11-22', description: 'Pak N Save S', amount: -11167 },
        { date: '2026-11-22', description: 'U-Go Epsom', amount: -8049 },
      ],
    };
    return { b, moves };
  }
  const status = (b: ReturnType<typeof foodGasBudget>, id: string) => envelopeStatus(b, b.items.find((i) => i.id === id)!, '2026-11-22');

  it('knows U-Go is fuel', () => {
    expect(matchesEnvelope({ name: 'Car gas' }, { description: 'U-Go Epsom', amount: -8049 })).toBe(true);
    expect(matchesEnvelope({ name: 'Food shop' }, { description: 'Pak N Save Fuel', amount: -6000 })).toBe(false);
  });

  it('gives each transfer its own purchase, so the fill counts as gas and the shops as food', () => {
    const { b, moves } = setup();
    expect(guessTransfer(b, 'food', moves[2])).toMatchObject({ itemIds: ['car'], sure: true });
    expect(guessTransfer(b, 'food', moves[2])!.seen[0].txn.description).toBe('U-Go Epsom');
    expect(guessTransfer(b, 'food', moves[1])).toMatchObject({ itemIds: ['shop'], sure: true });
    // The whole $150 counts, though the shop was $111.67: the rest left the account too.
    expect(status(b, 'shop').spent).toBe(20000);
    expect(status(b, 'car').spent).toBe(8000);
    expect(unsortedTransfers(b, 'food', '2026-11-22')).toEqual([]);
  });

  it('asks when the nearest purchase is not close and another envelope also fits', () => {
    const { b, moves } = setup();
    b.pendingTransactions!.food = [moves[2]];
    b.pendingTransactions!.day[2].amount = -9500; // the fill is $15 off; the $53.94 shop is $26 off
    expect(guessTransfer(b, 'food', moves[2])).toMatchObject({ itemIds: ['car', 'shop'], sure: false });
  });

  it('lets your answer for one transfer decide which purchase the others can take', () => {
    const { b, moves } = setup();
    b.envelopeTransfers = { [transferKey('food', moves[2])]: '' }; // the $80 was just moving money
    // The fill is free for the $50 now, but the $53.94 shop is within $5 of it and the fill isn't.
    expect(guessTransfer(b, 'food', moves[0])).toMatchObject({ itemIds: ['shop', 'car'], sure: true });
  });

  it('takes the purchase nearer in both amount and day when two envelopes each have one within $5', () => {
    const b = foodGasBudget();
    const move = { date: '2026-11-23', description: 'To: 06-0115-0324910-00 Debit Transfer 9', amount: -2000 };
    b.pendingTransactions = { food: [move], day: [
      { date: '2026-11-20', description: 'Freshchoice', amount: -2119 },
      { date: '2026-11-23', description: 'U-Go Epsom', amount: -2035 },
    ] };
    expect(guessTransfer(b, 'food', move)).toMatchObject({ itemIds: ['scoot', 'shop'], sure: true });
    expect(envelopeStatus(b, b.items.find((i) => i.id === 'scoot')!, '2026-11-23').spent).toBe(2000);
    // The shop on the same day as the fill: nearer in day, so it's yours to say.
    b.pendingTransactions.day[0].date = '2026-11-23';
    expect(guessTransfer(b, 'food', move)).toMatchObject({ sure: false });
  });
});

describe('two envelopes that share shops (Car gas and Scooter gas)', () => {
  function setup() {
    const b = budget();
    b.accounts.push({ id: 'food', name: 'Food and gas', kind: 'bank', color: '#000', groupId: 'needs' });
    b.items.push(
      { id: 'car', name: 'Car gas', amount: 25000, frequency: 'monthly', start: '2026-11-01', accountId: 'food', envelope: 'month' },
      { id: 'scoot', name: 'Scooter gas', amount: 5000, frequency: 'monthly', start: '2026-11-01', accountId: 'food', envelope: 'month', envelopeUnder: 5000 },
    );
    b.accountTransactions = { food: [
      { date: '2026-11-05', description: 'Z ENERGY KILBIRNIE', amount: -2200 },
      { date: '2026-11-09', description: 'BP CONNECT', amount: -8000 },
      { date: '2026-11-12', description: 'GULL', amount: -5000 },
    ] };
    return b;
  }
  const spent = (b: ReturnType<typeof budget>, id: string) => envelopeStatus(b, b.items.find((i) => i.id === id)!, '2026-11-20').spent;

  it('gives fills under the limit to Scooter gas and the rest to Car gas, never both', () => {
    const b = setup();
    expect(spent(b, 'scoot')).toBe(2200);
    expect(spent(b, 'car')).toBe(8000 + 5000); // $50 exactly isn't under $50
  });

  it('places a transfer by the fill it paid for', () => {
    const b = setup();
    b.accounts.find((a) => a.id === 'food')!.number = '06-0115-0324910-55';
    b.accounts.push({ id: 'day', name: 'Everyday', kind: 'bank', color: '#000', groupId: 'needs', number: '06-0115-0324910-00' });
    const move = { date: '2026-11-21', description: 'To: 06-0115-0324910-00 Debit Transfer 1', amount: -3000 };
    b.accountTransactions!.food.push(move);
    b.accountTransactions!.day = [{ date: '2026-11-20', description: 'Z ENERGY', amount: -3150 }];
    expect(guessTransfer(b, 'food', move)).toMatchObject({ itemIds: ['scoot'], sure: true });
    b.accountTransactions!.day = [{ date: '2026-11-20', description: 'Z ENERGY', amount: -7400 }];
    expect(guessTransfer(b, 'food', move)).toMatchObject({ itemIds: ['car'], sure: true });
  });
});

describe('the real Food and gas account (fixture)', () => {
  it('has nothing spare once this week, the later weeks and the gas are kept back', () => {
    const b = foodGasBudget();
    b.pendingTransactions = {
      food: [{ date: '2026-11-22', description: 'To: 06-0115-0324910-00 Debit Transfer 002552', amount: -5000 }],
      day: [{ date: '2026-11-21', description: 'Freshchoice', amount: -5394 }],
    };
    const today = '2026-11-22';
    const t = billTracker(b, 'food', today);
    // $150 left this week + 4 more weeks ($800) + Car gas $250 + Scooter gas $50 = the $1,250 in it.
    expect(envelopeHeld(b, 'food', today)).toBe(125000);
    expect(t.spare - envelopeHeld(b, 'food', today)).toBe(0);
  });
});
