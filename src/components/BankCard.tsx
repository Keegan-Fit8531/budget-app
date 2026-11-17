import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Budget } from '../lib/types';
import { addGoalFor, applyBank, AUTO_EVERY_MS, BANK_URL, bankMessage, fetchBank, readBankConfig, sinceFor, suggestLink, writeBankConfig, type BankData, type BankResult } from '../lib/bank';
import { cash } from '../lib/money';
import { csvTargets } from '../lib/reader/check';
import { newId, useBudget } from '../lib/store';
import { showToast } from './toast';
import { Section } from './ui';

const NEW_GOAL = 'saving:new';

/** What a sync did, in a sentence. */
function said(result: BankResult[]): string {
  const added = result.reduce((t, r) => t + r.added, 0);
  const parts = [
    added && `${added} new transaction${added === 1 ? '' : 's'} (${result.filter((r) => r.added).map((r) => `${r.name} ${r.added}`).join(', ')})`,
    ...result.filter((r) => r.balance !== undefined).map((r) => `${r.name} now ${cash(r.balance!, { whole: true })}`),
    // Payments to Gem Visa, Q Mastercard and other cards seen leaving a bank account.
    ...result.flatMap((r) => r.cardPayments ?? []).map((p) => `${cash(p.amount)} paid to ${p.debt}`),
  ].filter(Boolean);
  return parts.length ? `Added ${parts.join('; ')}.` : 'Up to date: nothing new.';
}

/** Settings → Bank connection: the passphrase for your Akahu server function, and what each bank account fills. */
export function BankCard() {
  const { budget, update } = useBudget();
  const [conf, setConf] = useState(readBankConfig);
  const [key, setKey] = useState('');
  const [data, setData] = useState<BankData | null>(null);
  const [links, setLinks] = useState<Record<string, string>>(budget.bankLinks ?? {});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const targets = csvTargets(budget);
  const goals = budget.savings ?? [];

  async function load(c = conf) {
    if (!c) return;
    setBusy(true); setMsg(null);
    try {
      const d = await fetchBank(c, sinceFor(c), undefined, true);
      writeBankConfig({ ...c, lastRefresh: new Date().toISOString() });
      setData(d);
      setLinks((cur) => Object.fromEntries(d.accounts.map((a) => [a.id, cur[a.id] ?? budget.bankLinks?.[a.id] ?? (suggestLink(budget, a) || '')])));
      setMsg({ ok: true, text: `Connected: ${d.accounts.length} account${d.accounts.length === 1 ? '' : 's'}. Check where each one goes, then Save and sync.` });
    } catch (e) { setMsg({ ok: false, text: bankMessage(e) }); } finally { setBusy(false); }
  }

  function save() {
    if (!data || !conf) return;
    let result: BankResult[] = [];
    update((b) => {
      const chosen = { ...links };
      // A new savings goal for an account (KiwiSaver), made once and then linked to it.
      for (const a of data.accounts) if (chosen[a.id] === NEW_GOAL) chosen[a.id] = addGoalFor(b, a, newId(), newId());
      b.bankLinks = { ...(b.bankLinks ?? {}), ...chosen };
      result = applyBank(b, data, chosen);
      return b;
    });
    const next = { ...(readBankConfig() ?? conf), lastSync: new Date().toISOString() };
    writeBankConfig(next); setConf(next);
    setMsg({ ok: true, text: said(result) });
    setData(null);
  }

  return (
    <Section title="Bank connection" summary={conf ? `Akahu${conf.lastSync ? `: last synced ${new Date(conf.lastSync).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ': not synced yet'}` : 'Off: upload statements instead'}>
      <p className="small muted">Your bank’s transactions and balances, read through Akahu (read-only: it can’t move money). Your Akahu tokens are kept in your own Supabase function, not here; this browser only keeps the passphrase. It updates by itself every hour while the app is open, and asks your bank for the latest each time.</p>
      {!conf ? (
        <div className="row wrap gap-8">
          <input type="password" value={key} placeholder="Your PAYDAYS_KEY passphrase" aria-label="Passphrase" autoComplete="off" onChange={(e) => setKey(e.target.value)} />
          <button className="btn primary" disabled={key.trim().length < 12 || busy} onClick={() => { const c = { url: BANK_URL, key: key.trim() }; writeBankConfig(c); setConf(c); setKey(''); void load(c); }}>Connect</button>
        </div>
      ) : (
        <>
        <label className="check-row small">
          <input type="checkbox" checked={budget.bankAuto !== false} onChange={(e) => update((b) => { b.bankAuto = e.target.checked ? undefined : false; return b; })} />
          <span><b>Update automatically from the bank</b><span className="xs muted block">{budget.bankAuto !== false
            ? 'Linked accounts’ transactions and balances update by themselves. Turn off to go back to entering balances and uploading statements yourself.'
            : 'Manual mode: nothing updates by itself and balances are left to you. Sync now still adds transactions.'}</span></span>
        </label>
        <div className="row wrap gap-8">
          <button className="btn primary" disabled={busy} onClick={() => void load()}>{busy ? 'Checking…' : 'Sync now'}</button>
          <button className="btn" onClick={() => { writeBankConfig(null); setConf(null); setData(null); setMsg({ ok: true, text: 'Disconnected on this device. To stop all access, delete the personal app in Akahu.' }); }}>Disconnect</button>
        </div>
        </>
      )}
      {data && (
        <div className="stack gap-8">
          {data.accounts.map((a) => (
            <label key={a.id} className="field">{a.name}{a.institution ? ` (${a.institution}${a.number ? ` ${a.number}` : ''})` : ''}{a.balance !== null && !a.transactions ? `: ${cash(Math.round(a.balance * 100), { whole: true })}` : ''}
              <select value={links[a.id] ?? ''} onChange={(e) => setLinks({ ...links, [a.id]: e.target.value })}>
                <option value="">Choose…</option>
                {a.transactions && targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                {goals.length > 0 && <optgroup label="Savings goal (its balance follows this account)">{goals.map((g) => <option key={g.id} value={`saving:${g.id}`}>{g.name}</option>)}</optgroup>}
                <option value={NEW_GOAL}>+ New savings goal (e.g. KiwiSaver)</option>
                <option value="ignore">Don’t use this one</option>
              </select>
              {!a.transactions && <span className="xs muted">Only its balance comes through (an investment or KiwiSaver): link it to a savings goal to keep the goal’s balance up to date.</span>}
            </label>
          ))}
          <div className="row end"><button className="btn primary" disabled={data.accounts.some((a) => !links[a.id])} onClick={save}>Save and sync</button></div>
        </div>
      )}
      {msg && <p className={`small${msg.ok ? '' : ' error'}`} role="status">{msg.text}</p>}
    </Section>
  );
}

// One sync at a time, whoever asks (the hourly check, or tapping a Synced pill). Pills spin while it runs.
let running = false;
const watchers = new Set<() => void>();
const setRunning = (v: boolean) => { running = v; watchers.forEach((f) => f()); };

/** Whether a bank sync is running now. */
export function useBankSyncing(): boolean {
  return useSyncExternalStore((f) => { watchers.add(f); return () => { watchers.delete(f); }; }, () => running);
}

/**
 * Sync with the bank now: ask it for the latest, and add what's new. `force` goes ahead even if it
 * synced within the hour (tapping a pill); otherwise it waits for the hour to pass. Says what it did.
 */
export async function syncBank(update: (f: (b: Budget) => Budget) => void, force = false): Promise<void> {
  const conf = readBankConfig();
  if (!conf) { if (force) showToast('The bank connection isn’t set up on this device: connect it in Settings → Bank connection.'); return; }
  if (running) return;
  if (!force && conf.lastSync && Date.now() - Date.parse(conf.lastSync) < AUTO_EVERY_MS) return;
  setRunning(true);
  try {
    const d = await fetchBank(conf, sinceFor(conf), undefined, true);
    let result: BankResult[] = [];
    update((b) => { result = applyBank(b, d, b.bankLinks ?? {}); return b; });
    const now = new Date().toISOString();
    writeBankConfig({ ...conf, lastSync: now, lastRefresh: now });
    if (force || result.some((r) => r.added || r.cardPayments?.length)) showToast(`Bank sync: ${said(result)}`);
  } catch (e) {
    if (force) showToast(`Bank sync didn’t work: ${bankMessage(e)}`);
  } finally { setRunning(false); }
}

/**
 * Keeps the bank connection up to date while the app is open: when it opens or comes back on screen,
 * and every hour, once accounts are linked in Settings. Asks the bank for the latest (Akahu allows that
 * once an hour); what the bank sends then comes in on the next sync.
 */
export function BankAutoSync() {
  const { budget, update } = useBudget();
  const hasLinks = budget.bankAuto !== false && !!budget.bankLinks && Object.keys(budget.bankLinks).length > 0;
  useEffect(() => {
    if (!hasLinks) return;
    const run = () => { if (document.visibilityState !== 'hidden') void syncBank(update); };
    run();
    const t = setInterval(run, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', run);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', run); };
  }, [hasLinks, update]);
  return null;
}
