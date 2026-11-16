import { lazy, Suspense, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { owed } from '../lib/debts';
import { startRead, type ReadJob } from '../lib/reader/job';
import { cash } from '../lib/money';
import { useBudget } from '../lib/store';
import { DebtModal, PaymentModal } from '../pages/Debts';
import { ErrorBoundary } from './ErrorBoundary';
import { GoalModal } from '../pages/Savings';
import { Icon } from './Icon';
import { ItemModal } from './ItemModal';

// Loaded only when a document is chosen.
const UploadQueue = lazy(() => import('./UploadFlow').then((m) => ({ default: m.UploadQueue })));

type Adding = 'menu' | 'cost' | 'goal' | 'debt' | 'pay';
/** The most documents read at once. */
const MAX_FILES = 12;

/**
 * The one "add" button: a cost, a savings goal, a debt, or a document (a payslip, a card or loan
 * statement, or Afterpay orders, as a PDF, photo or screenshot; or a bank or card export as CSV) that's
 * read and shown for you to check.
 */
export function AddMenu({ render }: { render: (open: () => void) => React.ReactNode }) {
  const [adding, setAdding] = useState<Adding | null>(null);
  const [jobs, setJobs] = useState<ReadJob[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const close = () => setAdding(null);
  const { budget } = useBudget();
  const owing = (budget.debts ?? []).some((d) => !d.payroll && owed(d) > 0);
  const choices: { id: string; icon: string; title: string; hint: string; go: () => void }[] = [
    { id: 'doc', icon: 'upload', title: 'Upload a payslip or statement', hint: 'PDF, photo or screenshot (read by Google’s Gemini), or a bank or card export as CSV (read on this device). Choose several at once if you like: each is shown to you to check.', go: () => fileRef.current?.click() },
    { id: 'cost', icon: 'transfer', title: 'Cost', hint: 'A bill, rent or regular transfer, or money put aside each pay for a WOF or tyres.', go: () => setAdding('cost') },
    { id: 'goal', icon: 'piggy', title: 'Savings goal', hint: 'Something to save towards, with a target and a date.', go: () => setAdding('goal') },
    { id: 'debt', icon: 'card', title: 'Debt', hint: 'A card, Afterpay, a loan or someone you owe.', go: () => setAdding('debt') },
    ...(owing ? [{ id: 'pay', icon: 'check', title: 'Payment you made', hint: 'Money you paid into a card or other debt, outside the payday split.', go: () => setAdding('pay') }] : []),
  ];
  return (
    <>
      {render(() => setAdding('menu'))}
      <input ref={fileRef} type="file" accept="application/pdf,image/*,.csv,text/csv" multiple hidden
        onChange={(e) => {
          // Reading starts here, once per file chosen (not in an effect, which runs twice in development):
          // all of them at once, so each is ready by the time you've checked the one before.
          const files = [...(e.target.files ?? [])].slice(0, MAX_FILES);
          if (files.length) { setJobs(files.map((f) => startRead(f, budget))); close(); }
          e.target.value = '';
        }} />
      {/* On the page itself, not inside the sidebar or bottom bar the button sits in. */}
      {createPortal(<>
      {adding === 'menu' && (
        <div className="modal-back" onClick={close}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-title" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="between">
              <h2 id="add-title" className="h2">Add</h2>
              <button className="icon-btn plain" aria-label="Close" onClick={close}><Icon name="x" /></button>
            </div>
            <div className="stack gap-8">
              {choices.map((c) => (
                <button key={c.id} className="add-choice" onClick={c.go}>
                  <span className="add-choice-icon"><Icon name={c.icon} size={20} /></span>
                  <span className="min0">
                    <b>{c.title}</b>
                    <span className="small muted block">{c.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {adding === 'cost' && <ItemModal onClose={close} />}
      {adding === 'goal' && <GoalModal onClose={close} />}
      {adding === 'debt' && <DebtModal onClose={close} onDelete={close} />}
      {adding === 'pay' && <PayAnyDebt onClose={close} />}
      {jobs && (
        // Outside the page's own error boundary, so it has its own: a failure here mustn't blank the app.
        <ErrorBoundary key={jobs.map((j) => j.file.name + j.file.lastModified).join('|')} onClose={() => { jobs.forEach((j) => j.cancel()); setJobs(null); }}>
          <Suspense fallback={null}><UploadQueue jobs={jobs} onClose={() => setJobs(null)} /></Suspense>
        </ErrorBoundary>
      )}
      </>, document.body)}
    </>
  );
}

/** Record a payment from the Add button: choose which debt it went to, then the usual payment form. */
function PayAnyDebt({ onClose }: { onClose: () => void }) {
  const { budget } = useBudget();
  const debts = (budget.debts ?? []).filter((d) => !d.payroll && owed(d) > 0);
  const [id, setId] = useState(debts[0]?.id ?? '');
  const debt = debts.find((d) => d.id === id) ?? debts[0];
  if (!debt) return null;
  return (
    <PaymentModal key={debt.id} debt={debt} onClose={onClose} pick={debts.length > 1 && (
      <label className="field">Paid into
        <select value={debt.id} onChange={(e) => setId(e.target.value)}>
          {debts.map((d) => <option key={d.id} value={d.id}>{d.name} · {cash(owed(d))} owed</option>)}
        </select>
      </label>
    )} />
  );
}
