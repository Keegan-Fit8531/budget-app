import { describe, expect, it } from 'vitest';
import { money, parseMoney } from './money';
import type { Budget } from './types';
import { looksLikeBudget } from './valid';
import { moveAmong } from './order';
import { budget } from '../testing/fixtures';

describe('checking what comes in', () => {
  it('a lone "." or "-" is not an amount', () => {
    for (const bad of ['', '.', '-', '-.', 'abc', '1.234', '1..2']) expect(parseMoney(bad), bad).toBeNull();
    expect(parseMoney('.5')).toBe(50);
    expect(parseMoney('$1,234.56')).toBe(123456);
    expect(parseMoney('-20')).toBe(-2000);
    expect(parseMoney(money(-12050))).toBe(-12050); // an amount as shown ("−$120.50"), pasted back in
  });

  it('a backup or the synced file has to have the shape of a budget', () => {
    expect(looksLikeBudget(budget())).toBe(true);
    expect(looksLikeBudget(JSON.parse(JSON.stringify(budget())))).toBe(true);
    const cut = budget() as Partial<Budget>;
    delete cut.split;
    for (const bad of [null, 'budget', [], { version: 1, accounts: [] }, { ...budget(), version: 2 }, cut, { ...budget(), items: [null] }]) expect(looksLikeBudget(bad)).toBe(false);
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
