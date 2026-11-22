import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { freezePaySplitFrom, paySplitLocked } from '../engine/balances/freeze';
import { pullBudget, pushBudget, readSyncConfig, SyncError, takePairingFromUrl, writeSyncConfig, type SyncConfig } from '../services/sync/sync';
import { todayISO } from '../core/dates';
import { periodContaining } from '../engine/periods';
import { autoBalance } from '../engine/rebalance';
import { seedBudget } from '../core/seed';
import type { Budget } from '../core/types';
import { keepCopy, listCopies, localDay, readCopy, type SavedVersion } from './versions';
import { bringUpToDate, tidy } from './upgrade';

const KEY = 'paydays.budget.v1';

// Only present on your own computer (src/personal is never committed), so the published app has none.
const personal = import.meta.glob<{ migrate: (b: Budget) => void }>('../personal/migrate.ts', { eager: true });

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

/** Once per locked pay: restore the frozen split from today’s morning copy when the Planner has drifted. */
async function restoreSplitFromMorningCopy(current: Budget): Promise<Budget | null> {
  const today = todayISO();
  const p = periodContaining(today, current.settings);
  if (!paySplitLocked(current, p, today)) return null;
  const flag = `split-morning-${p.start}`;
  if (current.flags?.includes(flag)) return null;
  const infos = await listCopies();
  const day = localDay(new Date());
  // Prefer today’s first-edit copy; on payday itself, the newest earlier copy is “how it stood this morning”.
  const morning = infos.find((i) => localDay(new Date(i.at)) === day) ?? (p.start === today ? infos[0] : undefined);
  if (!morning) return null;
  const copy = await readCopy(morning.at);
  if (!copy?.budget) return null;
  const b = structuredClone(current);
  freezePaySplitFrom(b, p, copy.budget, today);
  b.flags = [...(b.flags ?? []), flag];
  return autoBalance(b);
}

// Saved copies (one a day, kept 3 months) are in versions.ts.

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
          setBudget((cur) => { keepCopy(cur); return bringUpToDate(remote.budget); });
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

  // Locked pay this cycle: put back this morning’s split from the daily copy when the Planner has drifted.
  // Re-checks after saves so the first-edit-of-day copy (taken before the change) can restore the split.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await restoreSplitFromMorningCopy(latest.current);
      if (cancelled || !next) return;
      setBudget(() => stamp(next));
    })();
    return () => { cancelled = true; };
  }, [budget.updatedAt]);

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

  const update = useCallback((fn: (b: Budget) => Budget) => setBudget((b) => { keepCopy(b); return stamp(autoBalance(fn(structuredClone(b)))); }), []);
  const replace = useCallback((b: Budget) => setBudget((cur) => { keepCopy(cur, true); return stamp(bringUpToDate(structuredClone(b))); }), []);
  const reset = useCallback(() => setBudget((cur) => { keepCopy(cur, true); return stamp(autoBalance(structuredClone(seedBudget))); }), []);
  const restoreVersion = useCallback((v: SavedVersion) => setBudget((cur) => { keepCopy(cur, true); return stamp(bringUpToDate(structuredClone(v.budget))); }), []);

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
