import { useEffect, useRef, useState } from 'react';
import { fmtShort, fmtSpan, todayISO } from '../lib/dates';
import { readBankConfig } from '../lib/bankConfig';
import { localDay } from '../lib/versions';
import type { Period } from '../lib/engine';
import { cash } from '../lib/money';
import { call } from '../lib/reader/gemini';
import { modelOf, readReaderConfig } from '../lib/reader/config';
import { errorMessage, ReaderError } from '../lib/reader/errors';
import { cycleSoFar, cycleTransactions, makeReview, parseReview, REVIEW_INSTRUCTIONS, REVIEW_SCHEMA, reviewDue, reviewFrom, reviewInput, saveReview, type MonthlyReview } from '../lib/review';
import { useBudget } from '../lib/store';
import type { Budget } from '../lib/types';
import { Icon } from './Icon';
import { showToast } from './toast';

/** Send a cycle to Gemini and make its review (throws a ReaderError when it can't). */
export async function generateReview(b: Budget, c: Period & { partial?: boolean }, fetchImpl?: typeof fetch): Promise<MonthlyReview> {
  const conf = readReaderConfig();
  if (!conf) throw new ReaderError('no_key');
  const r = await call({ key: conf.key, model: modelOf(conf) }, {
    systemInstruction: { parts: [{ text: REVIEW_INSTRUCTIONS }] },
    contents: [{ role: 'user', parts: [{ text: reviewInput(b, c) }] }],
    generationConfig: { responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: REVIEW_SCHEMA } }, maxOutputTokens: 4096 },
  }, fetchImpl);
  const text = r.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('');
  const words = parseReview(text);
  if (!words) throw new ReaderError('unusable');
  return makeReview(b, c, words, new Date().toISOString());
}

const TRIED = 'paydays.review.tried';
const RETRY_MS = 60 * 60 * 1000;

/**
 * Makes the review in the background on payday: once the cycle has ended and (with the bank connected
 * and updating automatically) the bank has synced since, so the last days are in. A failure is tried
 * again an hour later. Runs while the app is open, as your Google key is kept in this browser.
 */
export function ReviewAutoRun() {
  const { budget, update } = useBudget();
  const running = useRef(false);
  const latest = useRef(budget);
  latest.current = budget;
  const due = reviewDue(budget, todayISO())?.start;
  useEffect(() => {
    if (!due) return;
    const run = () => {
      const b = latest.current;
      const c = reviewDue(b, todayISO());
      if (!c || running.current || document.visibilityState === 'hidden' || !readReaderConfig()) return;
      const bank = readBankConfig();
      const linked = b.bankAuto !== false && !!b.bankLinks && Object.keys(b.bankLinks).length > 0;
      if (bank && linked && (!bank.lastSync || localDay(new Date(bank.lastSync)) < reviewFrom(c))) return; // wait for the bank's last days
      try { if (Date.now() - Number(localStorage.getItem(TRIED) ?? 0) < RETRY_MS) return; localStorage.setItem(TRIED, String(Date.now())); } catch { /* storage blocked */ }
      running.current = true;
      generateReview(b, c).then((r) => {
        update((x) => { saveReview(x, r); return x; });
        showToast(`This month’s insights are ready: Insights → ${fmtSpan(r.from, r.to)}.`, 7000);
      }).catch(() => { /* tried again later */ }).finally(() => { running.current = false; });
    };
    const t0 = setTimeout(run, 20_000); // after the bank's sync on opening
    const t = setInterval(run, 10 * 60 * 1000);
    document.addEventListener('visibilitychange', run);
    return () => { clearTimeout(t0); clearInterval(t); document.removeEventListener('visibilitychange', run); };
  }, [due, update]);
  return null;
}

function List({ title, items, icon, tone }: { title: string; items: string[]; icon: string; tone?: string }) {
  if (!items.length) return null;
  return (
    <div className="stack gap-4">
      <b className={tone}>{title}</b>
      {items.map((t) => <div className="list-row top small" key={t}><span className={tone ?? 'muted'} style={{ display: 'grid', marginTop: 2 }}><Icon name={icon} size={16} /></span><span>{t}</span></div>)}
    </div>
  );
}

/** Insights → This month's insights: the latest review, past ones, and a button for the cycle so far. */
export function MonthlyInsights() {
  const { budget, update } = useBudget();
  const reviews = Object.values(budget.reviews ?? {}).sort((a, b) => (a.from < b.from ? 1 : -1));
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const r = reviews.find((x) => x.from === pick) ?? reviews[0];
  const hasKey = !!readReaderConfig();
  const today = todayISO();
  const due = reviewDue(budget, today);

  async function make(c: Period & { partial?: boolean }) {
    setBusy(true); setErr(null);
    try {
      const made = await generateReview(budget, c);
      update((b) => { saveReview(b, made); return b; });
      setPick(made.from);
    } catch (e) {
      const m = e instanceof ReaderError ? errorMessage(e) : { title: 'Something went wrong.', body: 'Try again.' };
      setErr(`${m.title} ${m.body}`);
    } finally { setBusy(false); }
  }

  const soFar = cycleSoFar(budget, today);
  const soFarCount = cycleTransactions(budget, soFar).length;
  const top = r ? Math.max(1, ...r.categories.map((c) => c.total)) : 1;
  return (
    <section className="card stack gap-16">
      <div>
        <h2 className="h2">{r?.partial ? 'This cycle so far' : 'This month’s insights'}</h2>
        {r && <p className="small muted">Pay cycle {fmtSpan(r.from, r.to)}{r.partial ? ' (so far)' : ''} · tracked from {fmtShort(r.from)} · made {new Date(r.made).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</p>}
      </div>
      {reviews.length > 1 && (
        <label className="field small">Past insights
          <select aria-label="Past insights" value={r?.from} onChange={(e) => setPick(e.target.value)}>
            {reviews.map((x) => <option key={x.from} value={x.from}>{fmtSpan(x.from, x.to)}{x.partial ? ' (so far)' : ''}</option>)}
          </select>
        </label>
      )}

      {!r && (
        <p className="note">
          Each payday, the pay cycle that just ended (every transaction from your bank connection and uploads, and your payslip) is sent to Google’s Gemini with your key, and what went well, what didn’t and tips come back here. It happens by itself in the background while the app is open.
          {!hasKey && ' Add your Google key in Settings → Reading documents first.'}
        </p>
      )}

      {r && (
        <>
          <div className="row wrap gap-16">
            {r.pay !== undefined && <div><span className="xs muted block">Pay</span><b className="fig-sm">{cash(r.pay, { whole: true })}</b></div>}
            <div><span className="xs muted block">Spent</span><b className="fig-sm">{cash(r.spent, { whole: true })}</b></div>
            <div><span className="xs muted block">Purchases</span><b className="fig-sm">{r.count}</b></div>
          </div>
          <div>
            <b className="block">{r.headline}</b>
            {r.summary && <p className="small muted" style={{ marginTop: 4 }}>{r.summary}</p>}
          </div>
          {r.categories.length > 0 && (
            <div className="stack gap-4">
              {r.categories.map((c) => (
                <div key={c.label} className="small">
                  <div className="between"><span>{c.label} <span className="muted">×{c.count}</span></span><b className="num">{cash(c.total, { whole: true })}</b></div>
                  <div className="bar" style={{ height: 6 }}><div style={{ width: `${(c.total / top) * 100}%` }} /></div>
                </div>
              ))}
            </div>
          )}
          <List title="Went well" items={r.good} icon="check" tone="pos" />
          <List title="Could be better" items={r.bad} icon="alert" tone="neg" />
          <List title="Tips for next cycle" items={r.tips} icon="bulb" />
          <p className="xs muted">From {r.sources.join(', ') || 'your transactions'}. Totals are worked out by the app; the words are Gemini’s.</p>
        </>
      )}

      <div className="row wrap gap-8">
        <button className="btn primary wrap-text" disabled={busy || !hasKey || !soFarCount} onClick={() => void make(soFar)}>{busy ? 'Working it out…' : `So far this cycle (${fmtShort(soFar.start)} to today)`}</button>
        {due && <button className="btn wrap-text" disabled={busy || !hasKey} onClick={() => void make(due)}>Make {fmtSpan(due.start, due.end)} now</button>}
      </div>
      {!soFarCount && <p className="small muted">No transactions since payday yet: they come from the bank connection, or upload a statement or export.</p>}
      {!hasKey && r && <p className="small muted">Add your Google key in Settings → Reading documents to make new ones.</p>}
      {err && <p className="small error" role="status">{err}</p>}
    </section>
  );
}
