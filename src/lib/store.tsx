import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { pullBudget, pushBudget, readSyncConfig, SyncError, takePairingFromUrl, writeSyncConfig, type SyncConfig } from './sync';
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
        // Your own one-off data updates, when they're on this computer (never in the published app).
        tidy(parsed);
        for (const m of Object.values(personal)) m.migrate(parsed);
        return bringUpToDate(parsed);
      }
    }
  } catch (e) {
    // Couldn't read what's saved: keep a copy before starting blank, so it's never overwritten and lost.
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) localStorage.setItem(`${KEY}.unreadable.${Date.now()}`, raw);
    } catch { /* storage blocked */ }
    console.error('Couldn\u2019t load the saved budget', e);
  }
  return bringUpToDate(structuredClone(seedBudget));
}

/** Fill in what older saves (or a backup, or the copy in the repo) may be missing. */
function tidy(b: Budget): Budget {
  // Lines saved before payday modes existed get an explicit mode.
  for (const line of b.split) {
    if (!line.mode) line.mode = line.auto ? 'exact' : 'fixed';
    delete line.auto;
  }
  b.flags = b.flags ?? [];
  b.debts = b.debts ?? [];
  b.savings = b.savings ?? [];
  // Costs named as set-asides (e.g. "Service set-aside") were always money kept in the account, never
  // paid out: say so once. Unticking "Put aside" afterwards sticks.
  if (!b.flags.includes('set-aside-costs')) {
    for (const i of b.items) if (i.frequency !== 'once' && /set.?aside/i.test(`${i.name} ${i.note ?? ''}`)) i.setAside = true;
    b.flags.push('set-aside-costs');
  }
  return b;
}

/**
 * Make a budget current as of today, wherever it came from (this browser, the repo, a backup, an
 * earlier version): payments due before today count as paid, then upcoming pays are balanced.
 */
function bringUpToDate(b: Budget): Budget {
  tidy(b);
  settleAll(b);
  return autoBalance(b);
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

export type SyncStatus =
  | { state: 'off' }
  | { state: 'syncing' }
  | { state: 'synced'; at: string }
  | { state: 'error'; message: string };

interface Store {
  budget: Budget;
  update: (fn: (b: Budget) => Budget) => void;
  replace: (b: Budget) => void;
  reset: () => void;
  /** Go back to an earlier version (the current one is kept first, so this can be undone too). */
  restoreVersion: (v: SavedVersion) => void;
  /** Syncing with a private GitHub repo, so every browser has the same budget. */
  sync: SyncStatus;
  connectSync: (c: SyncConfig) => Promise<void>;
  disconnectSync: () => void;
  syncNow: () => void;
}

const Ctx = createContext<Store | null>(null);

const stamp = (b: Budget): Budget => { b.updatedAt = new Date().toISOString(); return b; };
const newer = (a: Budget, b: Budget) => (a.updatedAt ?? '') > (b.updatedAt ?? '');

// Opened from a "connect this device" QR code? Save that connection before anything else runs.
const pairing = takePairingFromUrl();

export function BudgetProvider({ children }: { children: ReactNode }) {
  const [budget, setBudget] = useState<Budget>(load);
  const [sync, setSync] = useState<SyncStatus>(() => pairing && !pairing.ok
    ? { state: 'error', message: pairing.reason }
    : readSyncConfig() ? { state: 'syncing' } : { state: 'off' });
  // A device that's just been connected takes the budget from the repo (what it had is kept in Earlier versions).
  const preferRemote = useRef(!!pairing?.ok);
  // The repo file's version and the change last saved there, so only real changes are sent.
  const sha = useRef<string | undefined>(undefined);
  const savedAt = useRef<string | undefined>(undefined);
  const latest = useRef(budget);
  latest.current = budget;
  const busy = useRef(false);
  // Bumped to try a save again when a sync was already running.
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(budget)); } catch { /* ignore */ }
  }, [budget]);

  /** Bring this browser and the repo together: the newest copy wins (the other is kept in Earlier versions). */
  const reconcile = useCallback(async () => {
    const c = readSyncConfig();
    if (!c) { setSync({ state: 'off' }); return; }
    if (busy.current) return;
    busy.current = true;
    setSync({ state: 'syncing' });
    try {
      const remote = await pullBudget(c);
      const local = latest.current;
      if (remote && (preferRemote.current || newer(remote.budget, local) || !local.updatedAt)) {
        preferRemote.current = false;
        sha.current = remote.sha;
        savedAt.current = remote.budget.updatedAt;
        if (remote.budget.updatedAt !== local.updatedAt) {
          setBudget((cur) => { keepVersion(cur, true); return bringUpToDate(remote.budget); });
        }
      } else {
        sha.current = remote?.sha;
        if (!remote || local.updatedAt !== remote.budget.updatedAt) {
          sha.current = await pushBudget(c, local, sha.current);
        }
        savedAt.current = local.updatedAt;
      }
      setSync({ state: 'synced', at: new Date().toISOString() });
    } catch (e) {
      setSync({ state: 'error', message: e instanceof SyncError ? e.message : 'Couldn\u2019t sync.' });
    } finally {
      busy.current = false;
    }
  }, []);

  // Sync when the app opens and whenever you come back to it (e.g. after using it in another browser).
  useEffect(() => {
    void reconcile();
    const onShow = () => { if (document.visibilityState === 'visible') void reconcile(); };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('online', onShow);
    return () => { document.removeEventListener('visibilitychange', onShow); window.removeEventListener('online', onShow); };
  }, [reconcile]);

  // Left open past midnight (or reopened another day): payments that have fallen due since count as paid.
  useEffect(() => {
    let day = todayISO();
    const check = () => {
      if (todayISO() === day) return;
      day = todayISO();
      setBudget((cur) => bringUpToDate(structuredClone(cur)));
    };
    const t = setInterval(check, 60_000);
    document.addEventListener('visibilitychange', check);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', check); };
  }, []);

  // Save your changes to the repo a moment after you make them.
  useEffect(() => {
    const c = readSyncConfig();
    if (!c || !budget.updatedAt || budget.updatedAt === savedAt.current) return;
    const t = setTimeout(async () => {
      if (busy.current) { setRetry((n) => n + 1); return; } // a sync is running: try again shortly
      busy.current = true;
      setSync({ state: 'syncing' });
      try {
        const b = latest.current;
        sha.current = await pushBudget(c, b, sha.current);
        savedAt.current = b.updatedAt;
        setSync({ state: 'synced', at: new Date().toISOString() });
        busy.current = false;
      } catch (e) {
        busy.current = false;
        // Changed in another browser since: work out which copy is newest.
        if (e instanceof SyncError && (e.status === 409 || e.status === 422)) void reconcile();
        else setSync({ state: 'error', message: e instanceof SyncError ? e.message : 'Couldn\u2019t sync.' });
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [budget, reconcile, retry]);

  const update = useCallback((fn: (b: Budget) => Budget) => setBudget((b) => { keepVersion(b); return stamp(autoBalance(fn(structuredClone(b)))); }), []);
  const replace = useCallback((b: Budget) => setBudget((cur) => { keepVersion(cur, true); return stamp(bringUpToDate(structuredClone(b))); }), []);
  const reset = useCallback(() => setBudget((cur) => { keepVersion(cur, true); return stamp(autoBalance(structuredClone(seedBudget))); }), []);
  const restoreVersion = useCallback((v: SavedVersion) => setBudget((cur) => { keepVersion(cur, true); return stamp(bringUpToDate(structuredClone(v.budget))); }), []);

  const connectSync = useCallback(async (c: SyncConfig) => {
    await pullBudget(c); // checks the repo and token before saving them
    writeSyncConfig(c);
    sha.current = undefined;
    savedAt.current = undefined;
    preferRemote.current = true; // connecting: the repo's budget comes to this browser
    await reconcile();
  }, [reconcile]);
  const disconnectSync = useCallback(() => { writeSyncConfig(null); sha.current = undefined; setSync({ state: 'off' }); }, []);
  const syncNow = useCallback(() => { void reconcile(); }, [reconcile]);

  return <Ctx.Provider value={{ budget, update, replace, reset, restoreVersion, sync, connectSync, disconnectSync, syncNow }}>{children}</Ctx.Provider>;
}

export function useBudget(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useBudget must be inside BudgetProvider');
  return s;
}

export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}
