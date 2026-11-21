import { describe, expect, it } from 'vitest';
import { KEEP_DAYS, localDay, needsCopy, toForget } from './versions';

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
