import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { todayISO } from './dates';
import { debtPerPay, settleDue } from './debts';
import { autoBalance } from './rebalance';
import { seedBudget } from './seed';
import type { Budget } from './types';

const KEY = 'paydays.budget.v1';

// Only present on your own computer (src/lib/personal is never committed), so the published app has none.
const personal = import.meta.glob<{ migrate: (b: Budget) => void }>('./personal/migrate.ts', { eager: true });

function load(): Budget {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Budget;
      if (parsed.version === 1) {
        // Lines saved before payday modes existed get an explicit mode.
        for (const line of parsed.split) {
          if (!line.mode) line.mode = line.auto ? 'exact' : 'fixed';
          delete line.auto;
        }
        parsed.flags = parsed.flags ?? [];
        parsed.debts = parsed.debts ?? [];
        parsed.savings = parsed.savings ?? [];
        // Your own one-off data updates, when they're on this computer (never in the published app).
        for (const m of Object.values(personal)) m.migrate(parsed);
        settleAll(parsed);
        return autoBalance(parsed);
      }
    }
  } catch { /* storage blocked or corrupt — fall back to seed */ }
  const fresh = structuredClone(seedBudget);
  settleAll(fresh);
  return autoBalance(fresh);
}

/** Count instalments and plan payments dated before today as paid (they're automatic). */
function settleAll(b: Budget) {
  const today = todayISO();
  for (const d of b.debts ?? []) settleDue(d, b.settings, today, debtPerPay(b, d));
}

// ---------- Earlier versions (automatic, so nothing is lost to a bad edit) ----------
const HISTORY_KEY = 'paydays.versions.v1';
const MAX_VERSIONS = 30;
const MIN_GAP_MS = 2 * 60 * 1000;

export interface SavedVersion { at: string; budget: Budget }

export function readVersions(): SavedVersion[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); } catch { return []; }
}

/** Keep a copy of the data before a change (at most one every 2 minutes, the last 30). */
function keepVersion(b: Budget, force = false) {
  try {
    const list = readVersions();
    const last = list[0];
    if (!force && last && Date.now() - Date.parse(last.at) < MIN_GAP_MS) return;
    if (last && JSON.stringify(last.budget) === JSON.stringify(b)) return;
    list.unshift({ at: new Date().toISOString(), budget: b });
    while (list.length > MAX_VERSIONS) list.pop();
    // If storage is full, drop the oldest copies until it fits.
    for (;;) {
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); break; } catch { if (list.length <= 1) break; list.pop(); }
    }
  } catch { /* ignore */ }
}

interface Store {
  budget: Budget;
  update: (fn: (b: Budget) => Budget) => void;
  replace: (b: Budget) => void;
  reset: () => void;
  /** Go back to an earlier version (the current one is kept first, so this can be undone too). */
  restoreVersion: (v: SavedVersion) => void;
}

const Ctx = createContext<Store | null>(null);

export function BudgetProvider({ children }: { children: ReactNode }) {
  const [budget, setBudget] = useState<Budget>(load);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(budget)); } catch { /* ignore */ }
  }, [budget]);

  const update = useCallback((fn: (b: Budget) => Budget) => setBudget((b) => { keepVersion(b); return autoBalance(fn(structuredClone(b))); }), []);
  const replace = useCallback((b: Budget) => setBudget((cur) => { keepVersion(cur, true); return autoBalance(b); }), []);
  const reset = useCallback(() => setBudget((cur) => { keepVersion(cur, true); return autoBalance(structuredClone(seedBudget)); }), []);
  const restoreVersion = useCallback((v: SavedVersion) => setBudget((cur) => { keepVersion(cur, true); return autoBalance(structuredClone(v.budget)); }), []);

  return <Ctx.Provider value={{ budget, update, replace, reset, restoreVersion }}>{children}</Ctx.Provider>;
}

export function useBudget(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useBudget must be inside BudgetProvider');
  return s;
}

export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}
