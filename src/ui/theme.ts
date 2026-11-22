/** Light, dark, or follow the device. Kept on this device only (not in the budget, so it isn't synced). */
export type Theme = 'auto' | 'light' | 'dark';

const KEY = 'paydays.theme';

export function readTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch { return 'auto'; }
}

/** Set on <html> as data-theme (index.html does the same before the app loads, so there's no flash). */
export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  // The phone's status bar / browser bar colour follows too.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const scheme = m.dataset.scheme ?? (m.dataset.scheme = m.media.includes('dark') ? 'dark' : 'light');
    m.media = t === 'auto' ? `(prefers-color-scheme: ${scheme})` : scheme === t ? 'all' : 'not all';
  });
}

export function saveTheme(t: Theme) {
  try { if (t === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* storage blocked */ }
  applyTheme(t);
}
