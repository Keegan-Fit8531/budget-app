import { useEffect, useRef, useState } from 'react';
import { fmtShort, fmtSpan, todayISO } from '../../core/dates';
import { readBankConfig } from '../../services/bank/bankConfig';
import { localDay } from '../../state/versions';
import type { Period } from '../../engine/periods';
import { cash } from '../../core/money';
import { call } from '../../services/reader/gemini';
import { modelOf, readReaderConfig } from '../../services/reader/config';
import { errorMessage, ReaderError } from '../../services/reader/errors';
import { cycleSoFar, cycleTransactions, makeReview, parseReview, REVIEW_INSTRUCTIONS, REVIEW_SCHEMA, reviewDue, reviewFrom, reviewInput, saveReview, type MonthlyReview } from './logic/review';
import { useBudget } from '../../state/store';
import { otherShops } from './logic/spending';
import { allTxns, sortShops } from '../../services/reader/sortShops';
import { SYNCED } from '../../services/bank/BankCard';
import type { Budget } from '../../core/types';
import { Icon } from '../../ui/Icon';
import { Chevron, Collapse } from '../../ui/components';
import { showToast } from '../../ui/toast';

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
const SORT_TRIED = 'paydays.shops.tried';

/**
 * Shops in Other that haven't been asked about are sorted by Gemini straight after each bank sync, and
 * when the app opens (after an upload, say), while your Google key is set. Each shop is only ever
 * asked about once, so this only sends the new ones. After a failure it waits an hour.
 */
export function ShopSortAutoRun() {
  const { budget, update } = useBudget();
  const running = useRef(false);
  const latest = useRef(budget);
  latest.current = budget;
  useEffect(() => {
    const run = () => {
      if (running.current || !readReaderConfig() || !otherShops(allTxns(latest.current), latest.current).length) return;
      try { if (Date.now() - Number(localStorage.getItem(SORT_TRIED) ?? 0) < RETRY_MS) return; } catch { return; }
      running.current = true;
      sortShops(latest.current).then((got) => {
        const placed = Object.values(got).filter((c) => c !== 'other').length;
        update((b) => { b.shopGuesses = { ...(b.shopGuesses ?? {}), ...got }; return b; });
        if (placed) showToast(`Sorted ${placed} new shop${placed === 1 ? '' : 's'} out of Other.`);
      }).catch(() => {
        try { localStorage.setItem(SORT_TRIED, String(Date.now())); } catch { /* storage blocked */ }
      }).finally(() => { running.current = false; });
    };
    const t0 = setTimeout(run, 40_000); // on opening, once the bank's own sync has had its turn
    window.addEventListener(SYNCED, run);
    return () => { clearTimeout(t0); window.removeEventListener(SYNCED, run); };
  }, [update]);
  return null;
}
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
        showToast(`Your review of ${fmtSpan(r.from, r.to)} is ready in Insights.`, 7000);
      }).catch(() => { /* tried again later */ }).finally(() => { running.current = false; });
    };
    const t0 = setTimeout(run, 20_000); // after the bank's sync on opening
    const t = setInterval(run, 10 * 60 * 1000);
    document.addEventListener('visibilitychange', run);
    return () => { clearTimeout(t0); clearInterval(t); document.removeEventListener('visibilitychange', run); };
  }, [due, update]);
  return null;
}

const made = (iso: string) => new Date(iso).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** One of the review's three lists: a small tinted badge and its points. */
function Points({ title, items, icon, tone }: { title: string; items: string[]; icon: string; tone: 'good' | 'bad' | 'tips' }) {
  if (!items.length) return null;
  return (
    <section className={`rv-points ${tone}`}>
      <h3 className="rv-sub">{title}</h3>
      <ul>
        {items.map((t) => (
          <li key={t}><span className="rv-badge" aria-hidden="true"><Icon name={icon} size={14} /></span><span>{t}</span></li>
        ))}
      </ul>
    </section>
  );
}

/** Insights → Cycle review: the latest review, past ones, and a button for the cycle so far. */
export function MonthlyInsights() {
  const { budget, update } = useBudget();
  const reviews = Object.values(budget.reviews ?? {}).sort((a, b) => (a.from < b.from ? 1 : -1));
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Once there's one to read it opens and closes from its heading, and stays as you left it.
  const [open, setOpenState] = useState(() => { try { return localStorage.getItem('paydays.insights.open') !== 'closed'; } catch { return true; } });
  const setOpen = (v: boolean) => { setOpenState(v); try { localStorage.setItem('paydays.insights.open', v ? 'open' : 'closed'); } catch { /* ignore */ } };
  const r = reviews.find((x) => x.from === pick) ?? reviews[0];
  const hasKey = !!readReaderConfig();
  const today = todayISO();
  const due = reviewDue(budget, today);

  async function make(c: Period & { partial?: boolean }) {
    setBusy(true); setErr(null);
    try {
      const got = await generateReview(budget, c);
      update((b) => { saveReview(b, got); return b; });
      setPick(got.from);
      setOpen(true);
    } catch (e) {
      const m = e instanceof ReaderError ? errorMessage(e) : { title: 'Something went wrong.', body: 'Try again.' };
      setErr(`${m.title} ${m.body}`);
    } finally { setBusy(false); }
  }

  const soFar = cycleSoFar(budget, today);
  const soFarCount = cycleTransactions(budget, soFar).length;
  const hasSoFar = reviews.some((x) => x.from === soFar.start);
  const spent = r ? Math.max(1, r.spent) : 1;
  const top = r ? Math.max(1, ...r.categories.map((c) => c.total)) : 1;
  return (
    <section className="card stack gap-12">
      <button type="button" className="disc-head wide" style={{ minHeight: 0 }} aria-expanded={!r || open} disabled={!r} onClick={() => setOpen(!open)}>
        <span className="disc-title min0">
          <span className="h2 block">Cycle review</span>
          <span className="small muted block" style={{ fontWeight: 500 }}>
            {r ? <>{fmtSpan(r.from, r.to)}{r.partial && <> · <span className="pill rv-pill">In progress</span></>}</>
              : 'A summary of each pay cycle’s spending, written on payday'}
          </span>
        </span>
        {r && <Chevron />}
      </button>
      <Collapse open={!r || open} stacked><div className="stack gap-20" style={{ paddingTop: 4 }}>
      {!r && (
        <div className="rv-empty">
          <span className="rv-badge lg" aria-hidden="true"><Icon name="bulb" size={18} /></span>
          <div className="stack gap-4">
            <b>No reviews yet</b>
            <p className="small muted">
              On payday, the cycle that just ended is summarised for you: where your money went, what went well, what to watch and what to try next.
              It runs in the background while the app is open, using your transactions and payslip.
            </p>
            {!hasKey && <p className="small muted">To turn it on, add your Google API key in <a href="#/settings">Settings → Reading documents</a>.</p>}
          </div>
        </div>
      )}

      {r && (
        <>
          {reviews.length > 1 && (
            <label className="field small rv-pick">Pay cycle
              <select aria-label="Pay cycle" value={r.from} onChange={(e) => setPick(e.target.value)}>
                {reviews.map((x) => <option key={x.from} value={x.from}>{fmtSpan(x.from, x.to)}{x.partial ? ' (in progress)' : ''}</option>)}
              </select>
            </label>
          )}

          <div className="rv-stats">
            {r.pay !== undefined && <div className="stat tight"><span className="xs muted">Net pay</span><b className="num">{cash(r.pay, { whole: true })}</b></div>}
            <div className="stat tight"><span className="xs muted">Spent</span><b className="num">{cash(r.spent, { whole: true })}</b></div>
            <div className="stat tight"><span className="xs muted">Purchases</span><b className="num">{r.count}</b></div>
          </div>

          <div className="rv-lead">
            <p className="rv-headline">{r.headline}</p>
            {r.summary && <p className="small muted">{r.summary}</p>}
          </div>

          {r.categories.length > 0 && (
            <section className="stack gap-8">
              <h3 className="rv-sub">Where it went</h3>
              <div className="bar-list">
                {r.categories.map((c) => (
                  <div key={c.label} className="bar-list-row">
                    <span className="clip">{c.label} <span className="xs muted">· {c.count} {c.count === 1 ? 'purchase' : 'purchases'}</span></span>
                    <b className="num">{cash(c.total, { whole: true })}</b>
                    <span className="xs muted num right">{Math.round((c.total / spent) * 100)}%</span>
                    <div className="track"><div style={{ width: `${(c.total / top) * 100}%`, background: 'var(--brand-2)' }} /></div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="rv-grid">
            <Points title="What went well" items={r.good} icon="check" tone="good" />
            <Points title="What to watch" items={r.bad} icon="alert" tone="bad" />
            <Points title="Try next cycle" items={r.tips} icon="bulb" tone="tips" />
          </div>
        </>
      )}

      <div className="rv-foot">
        <div className="row wrap gap-8">
          <button className="btn primary wrap-text" disabled={busy || !hasKey || !soFarCount} onClick={() => void make(soFar)}>
            {busy ? 'Analysing…'
              // One for this cycle already: it's brought up to date with what's come in since.
              : hasSoFar ? <><Icon name="sync" size={16} /> Refresh this cycle</>
              : 'Review this cycle so far'}
          </button>
          {due && <button className="btn wrap-text" disabled={busy || !hasKey} onClick={() => void make(due)}>Review {fmtSpan(due.start, due.end)}</button>}
        </div>
        {err && <p className="small error" role="status">{err}</p>}
        {!soFarCount && <p className="xs muted">No transactions since {fmtShort(soFar.start)} yet. Connect your bank or upload a statement to add them.</p>}
        {!hasKey && r && <p className="xs muted">Add your Google API key in <a href="#/settings">Settings → Reading documents</a> to create new reviews.</p>}
        {r && <p className="xs muted">Updated {made(r.made)} · Totals from {r.sources.join(', ') || 'your transactions'} · Commentary by Gemini</p>}
      </div>
      </div></Collapse>
    </section>
  );
}
