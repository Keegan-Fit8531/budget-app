import { useState } from 'react';
import { Icon } from '../../ui/Icon';
import { addDays, fmtShort, ordinal, todayISO } from '../../core/dates';
import { applyPayment } from './logic/payments';
import { beforeStatement } from './logic/gem';
import { debtPay, owed } from './logic/amounts';
import { debtSchedules } from './logic/schedule';
import { cash, centsToInput, parseMoney } from '../../core/money';
import { useBudget } from '../../state/store';
import type { Debt } from '../../core/types';

/** Record money paid to a debt; it pays off whatever is due soonest first. */
export function PaymentModal({ debt, onClose, pick, embedded }: { debt: Debt; onClose: () => void; /** A "which debt" chooser, when opened from the Add button. */ pick?: React.ReactNode; embedded?: boolean }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const s = budget.settings;
  const [text, setText] = useState('');
  // Cards with a statement day: suggest paying on it (this month's, if it hasn't passed).
  const stmtDate = debt.statementDay ? (() => {
    const d = `${today.slice(0, 8)}${String(debt.statementDay).padStart(2, '0')}`;
    return d >= today ? d : today;
  })() : today;
  const [date, setDate] = useState(stmtDate);
  const [err, setErr] = useState('');
  const amount = parseMoney(text);

  const due = debtSchedules(debt, s, debtPay(budget, debt)).flatMap((x) => x.payments).sort((a, b) => a.date.localeCompare(b.date));
  const total = owed(debt);
  const nextDate = due[0]?.date;
  const nextTotal = due.filter((p) => p.date === nextDate).reduce((t, p) => t + p.amount, 0);
  const within = (days: number) => due.filter((p) => p.date <= addDays(today, days)).reduce((t, p) => t + p.amount, 0);
  const quick = [
    nextDate ? { label: `Next due (${fmtShort(nextDate)})`, amount: nextTotal } : null,
    { label: 'Due in 15 days', amount: within(15) },
    { label: 'Due in 30 days', amount: within(30) },
    { label: 'All of it', amount: total },
  ].filter((q, i, arr): q is { label: string; amount: number } => !!q && q.amount > 0 && arr.findIndex((x) => x?.amount === q.amount) === i);

  const preview = amount !== null && amount > 0 ? applyPayment(structuredClone(debt), amount, s, date) : null;

  function save() {
    if (amount === null || amount <= 0) return setErr('Enter how much you paid.');
    if (amount > total + 100) return setErr(`That's more than the ${cash(total)} owed.`);
    update((b) => {
      const d = (b.debts ?? []).find((x) => x.id === debt.id);
      if (d) applyPayment(d, amount, b.settings, date);
      return b;
    });
    onClose();
  }

  return (
    <div className={`modal-back${embedded ? ' inline' : ''}`} onClick={embedded ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pay-title" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2 id="pay-title" className="h2">{debt.name}: record a payment</h2>
          <button className="icon-btn plain" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        {pick}
        <p className="small muted">Pays off what's due soonest first, then the next due date, and so on. {cash(total)} owed.</p>
        <div className="row wrap gap-8">
          {quick.map((q) => (
            <button key={q.label} className="btn small" onClick={() => { setText(centsToInput(q.amount)); setErr(''); }}>
              {q.label}: {cash(q.amount)}
            </button>
          ))}
        </div>
        <div className="form-grid">
          <label className="field">Amount paid
            <input inputMode="decimal" autoFocus value={text} placeholder="0.00" onChange={(e) => { setText(e.target.value); setErr(''); }} onKeyDown={(e) => e.key === 'Enter' && save()} />
          </label>
          <label className="field">Date paid
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        {beforeStatement(debt, date) && (
          <div className="alert small" role="status">
            <Icon name="alert" />
            <span>That's before the statement on the {ordinal(debt.statementDay!)}, so it all goes on the oldest plan instead of being split, and the statement will still ask for this month's payment. Pay on or after the {ordinal(debt.statementDay!)}.</span>
          </div>
        )}
        {preview && (
          <div className="tip stack gap-6">
            <b>This pays off</b>
            {preview.applied.map((a, i) => (
              <div key={i} className="between small nowrap">
                <span>{a.planName} <span className="muted">· due {fmtShort(a.date)}{a.cleared ? '' : ' (part)'}</span></span>
                <b>{cash(a.amount)}</b>
              </div>
            ))}
            {preview.leftover > 0 && <span className="small">{cash(preview.leftover)} more than is scheduled — it comes off the balance.</span>}
            <span className="small muted">Left owing afterwards: {cash(Math.max(0, total - (amount ?? 0)))}</span>
          </div>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Record payment</button>
        </div>
      </div>
    </div>
  );
}
