import { useEffect, useMemo, useState } from 'react';
import { fmtShort, todayISO } from '../../core/dates';
import { cash, parseMoney } from '../../core/money';
import { SYNCED } from '../../services/bank/BankCard';
import { useBudget } from '../../state/store';
import { Icon } from '../../ui/Icon';
import { Modal } from '../../ui/components';
import { GEM_PLAN_MONTHS } from './logic/gem';
import { answerPlan, estimateLeft, planAnswers, planQuestions, undoPlanAnswer, type PlanQuestion } from './logic/planCheck';

// Plan check: the Debts page's pop-up for big card purchases the bank can't say the plan of (a special
// deal, or an older 6-month plan). Opens by itself when a sync turns up one you haven't been shown, like
// Bill check on Accounts.

const SEEN_KEY = 'paydays.plancheck.seen';
const readSeen = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]); } catch { return new Set(); }
};
const writeSeen = (keys: Iterable<string>) => {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...keys].slice(-300))); } catch { /* private window: it just asks again */ }
};

/** The questions now, and whether the pop-up is open. Opens by itself after a sync (or on arrival) when there's a new one. */
export function usePlanCheck(): { questions: PlanQuestion[]; open: boolean; setOpen: (v: boolean) => void } {
  const { budget } = useBudget();
  const questions = useMemo(() => planQuestions(budget, todayISO()), [budget]);
  const [open, setOpen] = useState(false);
  const [synced, setSynced] = useState(0);
  useEffect(() => {
    const on = () => setSynced((n) => n + 1);
    window.addEventListener(SYNCED, on);
    return () => window.removeEventListener(SYNCED, on);
  }, []);
  const fresh = questions.filter((q) => !readSeen().has(q.key)).map((q) => q.key).join();
  useEffect(() => { if (fresh) setOpen(true); }, [fresh, synced]);
  useEffect(() => { if (open) writeSeen(new Set([...readSeen(), ...questions.map((q) => q.key)])); }, [open, questions]);
  return { questions, open, setOpen };
}

/** The header button: "Plan check" with how many are waiting (shown with none waiting too, while there are answers to undo). */
export function PlanCheckButton({ count, onClick }: { count: number; onClick: () => void }) {
  const { budget } = useBudget();
  if (!count && !planAnswers(budget).length) return null;
  return (
    <button className="btn" onClick={onClick} aria-label={count ? `Plan check: ${count} to look at` : 'Plan check: your answers'}>
      <Icon name="card" size={16} /> Plan check {count > 0 && <span className="pill">{count}</span>}
    </button>
  );
}

/** A length picked: what's left on it, before it's saved. */
function AskLeft({ q, months, onSave, onCancel }: { q: PlanQuestion; months: number; onSave: (left: number) => void; onCancel: () => void }) {
  const [text, setText] = useState((estimateLeft(q, months, todayISO()) / 100).toFixed(2));
  const left = parseMoney(text);
  const ok = left !== null && left >= 0 && left <= q.amount;
  return (
    <div className="stack gap-6">
      <span className="small">Left on it now (Gem app → My plans)</span>
      <div className="row wrap gap-6">
        <input className="input" style={{ maxWidth: 140 }} inputMode="decimal" autoFocus value={text} aria-label="Left on it now"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok && onSave(left!)} />
        <button className="btn small primary" disabled={!ok} onClick={() => ok && onSave(left!)}>Save</button>
        <button className="btn small ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function PlanCheckModal({ questions, onClose }: { questions: PlanQuestion[]; onClose: () => void }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const [asking, setAsking] = useState<{ key: string; months: number }>();
  const answer = (q: PlanQuestion, months: number, left: number) => update((b) => { answerPlan(b, q, months, left, today); return b; });
  const answers = useMemo(() => planAnswers(budget), [budget]);
  return (
    <Modal title="Plan check" sub="Big purchases not put on a 6-month plan: what plan is each on?" onClose={onClose}>
      {(close) => (
        <div className="stack gap-16">
          {!questions.length && !answers.length && (
            <div className="tip small"><Icon name="check" /><span>All sorted: every big purchase has its plan.</span></div>
          )}
          {questions.length > 0 && (
            <div className="check-list">
              {questions.map((q) => (
                <div className="check-row" key={`${q.debtId}-${q.key}`}>
                  <span className="check-icon"><Icon name="card" size={16} /></span>
                  <div className="stack gap-6 min0">
                    <b>{q.name} · {cash(q.amount)}</b>
                    <span className="small muted">{q.debtName} · {fmtShort(q.date)} {q.date.slice(0, 4)}{q.pending ? ' · pending' : ''}</span>
                    {asking?.key === q.key
                      ? <AskLeft q={q} months={asking.months} onSave={(left) => { answer(q, asking.months, Math.round(left * 100)); setAsking(undefined); }} onCancel={() => setAsking(undefined)} />
                      : (
                        <div className="row wrap gap-6">
                          {GEM_PLAN_MONTHS.map((m) => <button key={m} className="btn small" onClick={() => setAsking({ key: q.key, months: m })}>{m} months</button>)}
                          <button className="btn small ghost" onClick={() => answer(q, 0, 0)}>No plan or paid off</button>
                        </div>
                      )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {answers.length > 0 && (
            <section className="stack gap-8">
              <h3 className="h3">Your answers</h3>
              <div className="check-list">
                {answers.map((a) => (
                  <div className="check-row" key={`${a.debtId}-${a.key}`}>
                    <span className="check-icon"><Icon name="check" size={16} /></span>
                    <div className="row gap-6 min0" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="small min0">{a.title}</span>
                      <button className="btn small ghost" onClick={() => update((b) => { undoPlanAnswer(b, a.debtId, a.key); return b; })}>Undo</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn small ghost" onClick={close}>{questions.length ? 'Later' : 'Close'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
