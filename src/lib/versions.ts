import { owed } from './debts';
import { cash } from './money';
import type { Budget } from './types';

// ---------------------------------------------------------------------------------------------
// Saved copies: one copy of the whole budget a day, taken before that day's first change (so it's how
// things were when the day began), kept for 3 months. If an upload or an edit goes wrong, Settings
// puts a copy back. They're kept in IndexedDB, which has room for months of copies (localStorage only
// holds about 5 MB). A short list of copies is kept apart from the copies themselves, so Settings can
// show it without loading every budget.
// ---------------------------------------------------------------------------------------------

export interface SavedVersion { at: string; budget: Budget }
export interface CopyInfo { at: string; summary: string }

export const KEEP_DAYS = 90;
/** Copies taken before a restore or a backup are extra; this keeps them from piling up. */
const MAX_COPIES = 150;
const DB_NAME = 'paydays';
const LIST = 'copies';
const BUDGETS = 'budgets';
/** Where copies used to be kept (the last 30 changes); moved over once. */
const OLD_KEY = 'paydays.versions.v1';

/** The day (YYYY-MM-DD) a time falls on, here. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whether today's copy is still to be taken. */
export function needsCopy(ats: string[], now: Date): boolean {
  const today = localDay(now);
  return !ats.some((at) => localDay(new Date(at)) === today);
}

/** Copies to forget: older than KEEP_DAYS days, and any beyond MAX_COPIES (oldest first). */
export function toForget(ats: string[], now: Date): string[] {
  const cutoff = now.getTime() - KEEP_DAYS * 86_400_000;
  const newest = [...ats].sort().reverse();
  return newest.filter((at, i) => Date.parse(at) < cutoff || i >= MAX_COPIES);
}

/** A line to tell copies apart. */
export function describe(b: Budget): string {
  const debts = (b.debts ?? []).filter((d) => !d.payroll);
  const owing = debts.reduce((t, d) => t + Math.max(0, owed(d)), 0);
  const saved = (b.savings ?? []).reduce((t, g) => t + Math.max(0, g.balance ?? 0), 0);
  return `${cash(saved, { whole: true })} saved · ${cash(owing, { whole: true })} owed on ${debts.length} debt${debts.length === 1 ? '' : 's'}`;
}

// ---------- IndexedDB ----------

let opening: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(LIST, { keyPath: 'at' });
        req.result.createObjectStore(BUDGETS, { keyPath: 'at' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    opening.catch(() => { opening = null; });
  }
  return opening;
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });
}

/** Add copies (unless `onlyIfNone` and today has one) and forget old ones, in one go. */
async function store(copies: SavedVersion[], onlyIfNone: boolean, now: Date): Promise<void> {
  const tx = (await db()).transaction([LIST, BUDGETS], 'readwrite');
  const list = tx.objectStore(LIST);
  const budgets = tx.objectStore(BUDGETS);
  const keys = list.getAllKeys();
  keys.onsuccess = () => {
    const ats = keys.result as string[];
    const adding = onlyIfNone && !needsCopy(ats, now) ? [] : copies;
    for (const c of adding) {
      list.put({ at: c.at, summary: describe(c.budget) } satisfies CopyInfo);
      budgets.put(c);
    }
    for (const at of toForget([...ats, ...adding.map((c) => c.at)], now)) { list.delete(at); budgets.delete(at); }
  };
  await finished(tx);
}

/** Copies kept before (in localStorage) move over once, then that space is freed. */
const moved: Promise<void> = (async () => {
  if (typeof indexedDB === 'undefined' || typeof localStorage === 'undefined') return;
  try {
    // Upload Undo was replaced by these copies: its record (a copy of what an upload changed) goes.
    localStorage.removeItem('paydays.lastUpload');
    const old = JSON.parse(localStorage.getItem(OLD_KEY) ?? 'null') as SavedVersion[] | null;
    if (!Array.isArray(old)) return;
    if (old.length) await store(old.filter((v) => v && v.at && v.budget), false, new Date());
    localStorage.removeItem(OLD_KEY);
  } catch { /* leave them where they are */ }
})();

/** The copies kept, newest first (empty if this browser can't keep them). */
export async function listCopies(): Promise<CopyInfo[]> {
  try {
    await moved;
    const tx = (await db()).transaction(LIST, 'readonly');
    const req = tx.objectStore(LIST).getAll();
    await finished(tx);
    return (req.result as CopyInfo[]).sort((a, b) => b.at.localeCompare(a.at));
  } catch { return []; }
}

export async function readCopy(at: string): Promise<SavedVersion | undefined> {
  try {
    const tx = (await db()).transaction(BUDGETS, 'readonly');
    const req = tx.objectStore(BUDGETS).get(at);
    await finished(tx);
    return req.result as SavedVersion | undefined;
  } catch { return undefined; }
}

// ---------- Taking copies ----------

let lastDay: string | undefined;

/**
 * Keep a copy of `b`, the budget as it is before a change: the first change of each day, or always
 * when `force` (before a restore, a backup or a fresh start, so that can be switched back).
 */
export function keepCopy(b: Budget, force = false): void {
  const now = new Date();
  const day = localDay(now);
  if (!force && lastDay === day) return;
  lastDay = day;
  if (typeof indexedDB === 'undefined') return;
  const copy = { at: now.toISOString(), budget: structuredClone(b) };
  void moved.then(() => store([copy], !force, now)).catch(() => { /* this browser can't keep copies */ });
}
