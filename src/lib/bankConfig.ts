// The bank connection's settings for this browser (kept apart from bank.ts, so the QR code can set
// them without loading the rest of the bank code).

/** Your server function (it reads from Akahu with your tokens). */
export const BANK_URL = 'https://ardxcgyhyxicnxxzzxdp.supabase.co/functions/v1/akahu-sync';
const CONF_KEY = 'paydays.bank';

export interface BankConfig { url: string; key: string; lastSync?: string; lastRefresh?: string }

export function readBankConfig(): BankConfig | null {
  try {
    const c = JSON.parse(localStorage.getItem(CONF_KEY) ?? 'null') as BankConfig | null;
    return c?.key ? { ...c, url: c.url || BANK_URL } : null;
  } catch { return null; }
}

export function writeBankConfig(c: BankConfig | null): void {
  try { if (c) localStorage.setItem(CONF_KEY, JSON.stringify(c)); else localStorage.removeItem(CONF_KEY); } catch { /* storage blocked */ }
}
