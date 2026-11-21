import type { BalanceResult } from '../../../engine/rebalance';

// ---------------------------------------------------------------------------------------------
// The payday amounts "Balance this pay" changed (e.g. Fixed → Steady), remembered per pay in this
// browser (localStorage), so the Planner's "Reset to defaults" can put them back.
// ---------------------------------------------------------------------------------------------

const MODES_KEY = 'paydays.balance.modes';

/** Remember what each account's payday amount was before balancing changed it (the first change wins). */
export function rememberModes(periodStart: string, toSteady: BalanceResult['toSteady']): void {
  try {
    const all = JSON.parse(localStorage.getItem(MODES_KEY) ?? '{}') as Record<string, Record<string, string>>;
    const mine = all[periodStart] ?? {};
    for (const t of toSteady) if (!(t.accountId in mine)) mine[t.accountId] = t.was;
    all[periodStart] = mine;
    localStorage.setItem(MODES_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}

/** What was remembered for this pay (account id → payday amount before), forgetting it. */
export function takeModes(periodStart: string): Record<string, string> {
  let modes: Record<string, string> = {};
  try {
    const all = JSON.parse(localStorage.getItem(MODES_KEY) ?? '{}') as Record<string, Record<string, string>>;
    modes = all[periodStart] ?? {};
    delete all[periodStart];
    localStorage.setItem(MODES_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
  return modes;
}

/** Whether balancing changed any payday amounts for this pay. */
export function modesChangedIn(periodStart: string): boolean {
  try { return !!JSON.parse(localStorage.getItem(MODES_KEY) ?? '{}')[periodStart]; } catch { return false; }
}
