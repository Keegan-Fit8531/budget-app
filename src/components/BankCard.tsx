import { useEffect, useRef, useState } from 'react';
import { applyBank, AUTO_EVERY_MS, BANK_URL, bankMessage, fetchBank, readBankConfig, sinceFor, suggestLink, writeBankConfig, type BankData } from '../lib/bank';
import { csvTargets } from '../lib/reader/check';
import { useBudget } from '../lib/store';
import { showToast } from './toast';
import { Section } from './ui';

/** Settings → Bank connection: the passphrase for your Akahu server function, and which account each bank account fills. */
export function BankCard() {
  const { budget, update } = useBudget();
  const [conf, setConf] = useState(readBankConfig);
  const [key, setKey] = useState('');
  const [data, setData] = useState<BankData | null>(null);
  const [links, setLinks] = useState<Record<string, string>>(budget.bankLinks ?? {});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const targets = csvTargets(budget);

  async function load(c = conf) {
    if (!c) return;
    setBusy(true); setMsg(null);
    try {
      const d = await fetchBank(c, sinceFor(c));
      setData(d);
      setLinks((cur) => Object.fromEntries(d.accounts.map((a) => [a.id, cur[a.id] ?? budget.bankLinks?.[a.id] ?? (suggestLink(budget, a) || '')])));
      setMsg({ ok: true, text: `Connected: ${d.accounts.length} account${d.accounts.length === 1 ? '' : 's'}, ${d.transactions.length} transactions to check. Choose where each account’s go, then Save and sync.` });
    } catch (e) { setMsg({ ok: false, text: bankMessage(e) }); } finally { setBusy(false); }
  }

  function save() {
    if (!data || !conf) return;
    let result: { name: string; added: number }[] = [];
    update((b) => { b.bankLinks = { ...(b.bankLinks ?? {}), ...links }; result = applyBank(b, data, links); return b; });
    const next = { ...conf, lastSync: new Date().toISOString() };
    writeBankConfig(next); setConf(next);
    const added = result.reduce((t, r) => t + r.added, 0);
    setMsg({ ok: true, text: added ? `Added ${added} new transaction${added === 1 ? '' : 's'}: ${result.filter((r) => r.added).map((r) => `${r.name} ${r.added}`).join(', ')}.` : 'Up to date: nothing new.' });
    setData(null);
  }

  return (
    <Section title="Bank connection" summary={conf ? `Akahu${conf.lastSync ? `: last synced ${new Date(conf.lastSync).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ': not synced yet'}` : 'Off: upload statements instead'}>
      <p className="small muted">Your bank’s transactions, read through Akahu (read-only: it can’t move money). Your Akahu tokens are kept in your own Supabase function, not here; this browser only keeps the passphrase. New transactions are added when the app opens (every few hours) or when you sync.</p>
      {!conf ? (
        <div className="row wrap gap-8">
          <input type="password" value={key} placeholder="Your PAYDAYS_KEY passphrase" aria-label="Passphrase" autoComplete="off" onChange={(e) => setKey(e.target.value)} />
          <button className="btn primary" disabled={key.trim().length < 12 || busy} onClick={() => { const c = { url: BANK_URL, key: key.trim() }; writeBankConfig(c); setConf(c); setKey(''); void load(c); }}>Connect</button>
        </div>
      ) : (
        <div className="row wrap gap-8">
          <button className="btn primary" disabled={busy} onClick={() => void load()}>{busy ? 'Checking…' : 'Sync now'}</button>
          <button className="btn" onClick={() => { writeBankConfig(null); setConf(null); setData(null); setMsg({ ok: true, text: 'Disconnected on this device. To stop all access, delete the personal app in Akahu.' }); }}>Disconnect</button>
        </div>
      )}
      {data && (
        <div className="stack gap-8">
          {data.accounts.map((a) => (
            <label key={a.id} className="field">{a.name}{a.institution ? ` (${a.institution}${a.number ? ` ${a.number}` : ''})` : ''}
              <select value={links[a.id] ?? ''} onChange={(e) => setLinks({ ...links, [a.id]: e.target.value })}>
                <option value="">Choose…</option>
                {targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                <option value="ignore">Don’t use this one</option>
              </select>
              {!a.transactions && <span className="xs muted">Akahu doesn’t give this account’s transactions (e.g. an investment).</span>}
            </label>
          ))}
          <div className="row end"><button className="btn primary" disabled={data.accounts.some((a) => !links[a.id])} onClick={save}>Save and sync</button></div>
        </div>
      )}
      {msg && <p className={`small${msg.ok ? '' : ' error'}`} role="status">{msg.text}</p>}
    </Section>
  );
}

/** Quietly adds new bank transactions when the app opens (at most every few hours), once accounts are linked in Settings. */
export function BankAutoSync() {
  const { budget, update } = useBudget();
  const done = useRef(false);
  const links = budget.bankLinks;
  useEffect(() => {
    const conf = readBankConfig();
    if (done.current || !conf || !links || !Object.keys(links).length) return;
    if (conf.lastSync && Date.now() - Date.parse(conf.lastSync) < AUTO_EVERY_MS) return;
    done.current = true;
    fetchBank(conf, sinceFor(conf)).then((d) => {
      let result: { name: string; added: number }[] = [];
      update((b) => { result = applyBank(b, d, b.bankLinks ?? {}); return b; });
      writeBankConfig({ ...conf, lastSync: new Date().toISOString() });
      const added = result.reduce((t, r) => t + r.added, 0);
      if (added) showToast(`Bank sync: ${added} new transaction${added === 1 ? '' : 's'} added.`);
    }).catch(() => { /* tried again next time; Settings shows the reason */ });
  }, [links, update]);
  return null;
}
