import type { Budget } from './types';

/**
 * Sync with a file in a private GitHub repo, so every browser sees the same budget. Each browser keeps
 * the repo name and a GitHub token (one that can only read and write that repo) in its own storage.
 */
export interface SyncConfig {
  /** owner/name of a private repo, e.g. you/budget-data */
  repo: string;
  /** File in the repo the budget is saved to. */
  path: string;
  token: string;
}

const CONF_KEY = 'paydays.sync';

export function readSyncConfig(): SyncConfig | null {
  try {
    const c = JSON.parse(localStorage.getItem(CONF_KEY) ?? 'null') as SyncConfig | null;
    return c && c.repo && c.token ? { ...c, path: c.path || 'budget.json' } : null;
  } catch { return null; }
}

export function writeSyncConfig(c: SyncConfig | null): void {
  try { if (c) localStorage.setItem(CONF_KEY, JSON.stringify(c)); else localStorage.removeItem(CONF_KEY); } catch { /* ignore */ }
}

export class SyncError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

function url(c: SyncConfig): string {
  const repo = c.repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  return `https://api.github.com/repos/${repo}/contents/${c.path.split('/').map(encodeURIComponent).join('/')}`;
}

function headers(c: SyncConfig): HeadersInit {
  return { Authorization: `Bearer ${c.token.trim()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

function explain(status: number): string {
  if (status === 401) return 'GitHub didn’t accept the token. It may have expired: make a new one.';
  if (status === 403) return 'The token can’t write to that repo. Give it Contents: Read and write.';
  if (status === 404) return 'Couldn’t find that repo. Check the name, and that the token can access it.';
  return `GitHub said ${status}. Try again in a moment.`;
}

export interface Remote { budget: Budget; sha: string }

/** The budget saved in the repo, or null if there's no file yet. */
export async function pullBudget(c: SyncConfig): Promise<Remote | null> {
  let res: Response;
  try { res = await fetch(url(c), { headers: headers(c), cache: 'no-store' }); } catch { throw new SyncError('Offline: couldn’t reach GitHub.', 0); }
  if (res.status === 404) {
    // Tell a missing file apart from a missing (or inaccessible) repo.
    const repo = await fetch(url(c).replace(/\/contents\/.*$/, ''), { headers: headers(c), cache: 'no-store' }).catch(() => null);
    if (repo?.ok) return null;
    throw new SyncError(explain(404), 404);
  }
  if (!res.ok) throw new SyncError(explain(res.status), res.status);
  const json = await res.json() as { content: string; sha: string };
  const budget = JSON.parse(fromBase64(json.content)) as Budget;
  if (budget.version !== 1 || !Array.isArray(budget.accounts)) throw new SyncError('The file in the repo isn’t a budget.', 422);
  return { budget, sha: json.sha };
}

/** Save the budget to the repo. `sha` is the version being replaced (none for a new file). Returns the new sha. */
export async function pushBudget(c: SyncConfig, budget: Budget, sha?: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url(c), {
      method: 'PUT', headers: headers(c),
      body: JSON.stringify({ message: `Budget saved ${new Date().toISOString()}`, content: toBase64(JSON.stringify(budget, null, 2)), ...(sha ? { sha } : {}) }),
    });
  } catch { throw new SyncError('Offline: couldn’t reach GitHub.', 0); }
  if (!res.ok) throw new SyncError(res.status === 409 || res.status === 422 ? 'Changed in another browser.' : explain(res.status), res.status);
  return ((await res.json()) as { content: { sha: string } }).content.sha;
}

// ---------------------------------------------------------------------------------------------
// Connect another device by QR code: a link to this app carrying the repo and token after the #.
// The part after # is never sent to any server; the app reads it, saves it, and removes it from the
// address and history straight away. The link stops working after 10 minutes.
// ---------------------------------------------------------------------------------------------

const PAIR_PREFIX = '#/connect/';
const PAIR_MINUTES = 10;

const b64url = (s: string) => toBase64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => fromBase64(s.replace(/-/g, '+').replace(/_/g, '/'));

/** A link that connects another device to the same repo (shown as a QR code). */
export function pairingLink(c: SyncConfig, now = Date.now()): string {
  const payload = b64url(JSON.stringify({ r: c.repo, p: c.path, t: c.token, e: now + PAIR_MINUTES * 60_000 }));
  return `${location.origin}${location.pathname}${PAIR_PREFIX}${payload}`;
}

export type PairingResult = { ok: true; config: SyncConfig } | { ok: false; reason: string } | null;

/**
 * If the app was opened from a connect link: save the connection for this browser and take the link out
 * of the address bar and history. Null when it wasn't opened from one.
 */
export function takePairingFromUrl(now = Date.now()): PairingResult {
  if (!location.hash.startsWith(PAIR_PREFIX)) return null;
  const payload = location.hash.slice(PAIR_PREFIX.length);
  history.replaceState(null, '', `${location.pathname}#/settings`);
  try {
    const d = JSON.parse(unb64url(payload)) as { r: string; p?: string; t: string; e: number };
    if (!d.r || !d.t) return { ok: false, reason: 'That QR code isn’t a connect code.' };
    if (now > d.e) return { ok: false, reason: 'That QR code has expired. Show a new one on your other device.' };
    const config = { repo: d.r, path: d.p || 'budget.json', token: d.t };
    writeSyncConfig(config);
    return { ok: true, config };
  } catch {
    return { ok: false, reason: 'That QR code couldn’t be read.' };
  }
}
