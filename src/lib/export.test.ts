import { describe, expect, it } from 'vitest';
import { periodContaining } from './engine';
import { exportFileName, exportablePeriods, monthSheets, periodLabel } from './export';
import { seedBudget } from './seed';
import type { Budget } from './types';

function budget(): Budget {
  const b = structuredClone(seedBudget);
  b.settings.paydayDay = 19;
  b.settings.expectedPay = 500000;
  b.accounts.push({ id: 'bills', name: 'Bills', kind: 'bank', color: '#000', groupId: 'needs' });
  b.split.push({ accountId: 'bills', amount: 120000, mode: 'fixed' });
  b.items.push({ id: 'rent', name: 'Rent', amount: 25000, frequency: 'weekly', start: '2026-11-20', accountId: 'bills' });
  return b;
}

type AnyCell = { value?: unknown } | null | undefined;
const values = (rows: unknown[][]) => rows.map((r) => r.map((c) => (c as AnyCell)?.value ?? null));

describe('month export', () => {
  const today = '2026-11-12';

  it('offers recorded past pays through the next 12 to come', () => {
    const b = budget();
    b.payActuals['2026-08-19'] = 480000;
    const list = exportablePeriods(b, today);
    expect(list[0].start).toBe('2026-08-19');
    expect(list[list.length - 1].start).toBe('2027-10-19');
    expect(new Set(list.map((p) => p.start)).size).toBe(list.length);
    expect(exportablePeriods(budget(), today)[0].start).toBe('2026-10-19');
  });

  it('writes the pay, the split and every payment as numbers that add up', () => {
    const b = budget();
    const p = periodContaining('2026-11-19', b.settings);
    const [summary, accounts, payments] = monthSheets(b, p, today);
    expect(periodLabel(p)).toBe('November 2026 pay');
    expect(exportFileName(p)).toBe('budget-2026-11-november-pay.xlsx');
    const s = values(summary.data);
    expect(s.find((r) => r[0] === 'Pay')![1]).toBe(5000);
    expect(s.find((r) => r[0] === 'Total sent to accounts')![1]).toBe(1200);
    expect(s.find((r) => r[0] === 'Left in pay account')![1]).toBe(3800);
    const a = values(accounts.data);
    expect(a.find((r) => r[0] === 'Bills')!.slice(3)).toEqual([1200, 1000, 200]);
    expect(a[a.length - 1].slice(3, 5)).toEqual([5000, 1000]);
    const pay = values(payments.data);
    // Rent on 20, 27 Nov and 4, 11 Dec (the next payday is Fri 18 Dec).
    expect(pay.slice(1, -1).map((r) => (r[0] as Date).toISOString().slice(0, 10))).toEqual(['2026-11-20', '2026-11-27', '2026-12-04', '2026-12-11']);
    expect(pay[pay.length - 1][4]).toBe(1000);
  });
});
