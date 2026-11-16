import { useState } from 'react';
import { DEFAULT_MODEL, modelOf, readReaderConfig, writeReaderConfig } from '../lib/reader/config';
import { errorMessage, ReaderError } from '../lib/reader/errors';
import { testKey } from '../lib/reader/job';
import { Section } from './ui';

/** Settings → Reading documents: the Google key (kept in this browser only) and the model. */
export function ReaderCard() {
  const [conf, setConf] = useState(readReaderConfig);
  const [key, setKey] = useState('');
  const [model, setModel] = useState(conf?.model ?? '');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  function save(next: typeof conf) { writeReaderConfig(next); setConf(readReaderConfig()); }

  async function test(k = conf?.key, m = modelOf(conf)) {
    if (!k) return;
    setTesting(true);
    setMsg(null);
    try {
      await testKey(k, m);
      setMsg({ ok: true, text: `Google accepted the key, and ${m} is available. Reading documents is ready.` });
    } catch (e) {
      const em = errorMessage(e instanceof ReaderError ? e : new ReaderError('unreachable'));
      setMsg({ ok: false, text: `${em.title} ${em.body}` });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Section title="Reading documents" forceOpen={!!msg && !msg.ok}
      summary={conf ? 'With Google’s Gemini' : 'Off: add a Google key to read documents'}>
      <p className="small muted">
        Payslips, statements and Afterpay screenshots you upload are sent to Google’s Gemini to read, then shown to you to check before anything changes.
        With prepaid credit (paid use), Google doesn’t use them to train its models. The key is kept in this browser only: it isn’t in your budget, the repo or the app’s code.
      </p>

      {conf ? (
        <p className="small">A key is saved in this browser (ending …{conf.key.slice(-4)}).</p>
      ) : (
        <p className="small">No key yet. Follow “Set up Google credit” below, then paste the key here.</p>
      )}
      <div className="form-grid">
        <label className="field">{conf ? 'Replace the key' : 'Google key'}
          <input type="password" value={key} autoComplete="off" placeholder="AIza…" onChange={(e) => { setKey(e.target.value); setMsg(null); }} />
        </label>
      </div>
      <div className="row wrap">
        <button className="btn primary" disabled={!key.trim()} onClick={() => { save({ provider: 'gemini', key: key.trim(), model: conf?.model }); const k = key.trim(); setKey(''); void test(k, modelOf(conf)); }}>Save and test</button>
        {conf && <button className="btn" disabled={testing} onClick={() => void test()}>{testing ? 'Testing…' : 'Test key'}</button>}
        {conf && <button className="btn" onClick={() => { save(null); setMsg({ ok: true, text: 'Key removed from this browser.' }); }}>Remove key</button>}
      </div>
      {msg && <p className={`small ${msg.ok ? '' : 'error'}`} role="status">{msg.text}</p>}
      <p className="xs muted">Test key sends a tiny request with no document. It uses a fraction of a cent of credit.</p>

      <details className="small">
        <summary>Set up Google credit</summary>
        <ol className="small" style={{ paddingLeft: 18 }}>
          <li>Open <a href="https://aistudio.google.com/api-keys" target="_blank" rel="noreferrer">AI Studio → API keys</a> and make a key in a project of its own (e.g. “Paydays”).</li>
          <li>On that project’s row, choose <b>Set up billing</b>. Choose <b>Prepay</b> and buy the minimum (US$5). It lasts about a year.</li>
          <li>On <a href="https://aistudio.google.com/billing" target="_blank" rel="noreferrer">Billing</a>, leave <b>auto-reload off</b>, so it can never spend more than you’ve put in.</li>
          <li>Optional: set a monthly cap on <a href="https://aistudio.google.com/spend" target="_blank" rel="noreferrer">Spend</a>.</li>
          <li>Your limits are on <a href="https://aistudio.google.com/rate-limit" target="_blank" rel="noreferrer">Rate limits</a>.</li>
          <li>Paste the key above. To use it on your phone, show the QR code under <b>Sync across browsers</b>: it carries the key too.</li>
        </ol>
      </details>

      <details className="small">
        <summary>Advanced: model</summary>
        <p className="small muted">Google retires models from time to time. If uploads say Google didn’t recognise the model, put a current one from Google’s models page here. Leave it empty for {DEFAULT_MODEL}.</p>
        <div className="row wrap">
          <input value={model} placeholder={DEFAULT_MODEL} aria-label="Model" onChange={(e) => setModel(e.target.value)} />
          <button className="btn" disabled={!conf} onClick={() => { if (conf) { save({ ...conf, model: model.trim() || undefined }); void test(conf.key, model.trim() || DEFAULT_MODEL); } }}>Save model</button>
        </div>
      </details>
    </Section>
  );
}
