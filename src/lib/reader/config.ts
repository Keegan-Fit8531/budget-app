// ---------------------------------------------------------------------------------------------
// Reading documents with Google's Gemini: the one place the model and limits are set, and the key,
// which is kept in this browser only (never in the budget, which is synced, and never in the code).
// ---------------------------------------------------------------------------------------------

/** The model used unless Settings names another. Google retires models, so this is the only place it's set. */
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** Give up waiting after this long. */
export const TIMEOUT_MS = 60_000;
/** PDFs are sent as they are, up to this size. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Photos are shrunk so their longest side is at most this many pixels. */
export const MAX_IMAGE_EDGE = 2000;

export interface ReaderConfig {
  provider: 'gemini';
  key: string;
  /** Overrides DEFAULT_MODEL when set. */
  model?: string;
}

const CONF_KEY = 'paydays.ai';

export function readReaderConfig(): ReaderConfig | null {
  try {
    const c = JSON.parse(localStorage.getItem(CONF_KEY) ?? 'null') as ReaderConfig | null;
    return c && typeof c.key === 'string' && c.key.trim() ? { provider: 'gemini', key: c.key.trim(), model: c.model?.trim() || undefined } : null;
  } catch { return null; }
}

export function writeReaderConfig(c: ReaderConfig | null): void {
  try { if (c && c.key.trim()) localStorage.setItem(CONF_KEY, JSON.stringify(c)); else localStorage.removeItem(CONF_KEY); } catch { /* storage blocked */ }
}

/** Keep the model chosen in Settings (or clear it) without touching the key. */
export function modelOf(c: ReaderConfig | null): string {
  return c?.model || DEFAULT_MODEL;
}
