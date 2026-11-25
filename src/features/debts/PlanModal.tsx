import { useState } from 'react';
import { Icon } from '../../ui/Icon';
import { fmtShort, todayISO } from '../../core/dates';
import { GEM_PLAN_MONTHS, gemPlanEnds, gemPlanType } from './logic/gem/gem';
import { exactForFirstPlan, recordHistory, suggestPlan } from './logic/amounts';
import { PLAN_LABEL, planSchedule } from './logic/schedule';
import { periodContaining } from '../../engine/periods';
import { cash, centsToInput, parseMoney } from '../../core/money';
import { newId, useBudget } from '../../state/store';
import type { Debt, DebtPlan, PlanType } from '../../core/types';
import { Modal } from '../../ui/components';

export function PlanModal({ debt, plan, prefill, onClose, embedded }: { debt: Debt; plan?: DebtPlan; prefill?: number; onClose: () => void; embedded?: boolean }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const [name, setName] = useState(plan?.name ?? (prefill ? 'Existing balance' : ''));
  const [amount, setAmount] = useState(plan ? centsToInput(plan.original) : prefill ? centsToInput(prefill) : '');
  const [date, setDate] = useState(plan?.purchaseDate ?? today);
  const initial = plan ? { type: plan.type, months: plan.months } : prefill ? { type: 'balance' as PlanType, months: undefined } : suggestPlan(debt, 0);
  const [type, setType] = useState<PlanType>(initial.type);
  const [months, setMonths] = useState(String(initial.months ?? 6));
  const [typeTouched, setTypeTouched] = useState(!!plan || !!prefill);
  const [remaining, setRemaining] = useState(plan ? centsToInput(plan.remaining) : '');
  const [payment, setPayment] = useState(plan?.payment ? centsToInput(plan.payment) : '');
  const [ends, setEnds] = useState(plan?.ends ?? '');
  const [err, setErr] = useState('');
  const isPerson = debt.kind === 'person' || debt.kind === 'loan';

  const orig = parseMoney(amount);
  const rem = remaining.trim() === '' ? orig : parseMoney(remaining);

  function onAmount(v: string) {
    setAmount(v); setErr('');
    const c = parseMoney(v);
    if (!typeTouched && c !== null) {
      const sug = suggestPlan(debt, c);
      setType(sug.type);
      if (sug.months) setMonths(String(sug.months));
    }
  }
  function onMonths(v: string) {
    setMonths(v);
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return;
    if (debt.rules === 'gem') {
      setType(gemPlanType(n));
      setTypeTouched(true);
      // Gem months end on the 20th: treat the chosen length as months still left from today.
      setEnds(gemPlanEnds(today, n));
    }
  }

  const draft: DebtPlan | null = orig !== null && orig > 0 && rem !== null ? {
    id: plan?.id ?? 'draft', name: name || 'Purchase', type, original: orig, remaining: rem,
    asOf: remaining.trim() === '' && !plan ? date : today, purchaseDate: date,
    months: type === 'interest-free' || type === 'equal' ? Number(months) : undefined,
    payment: type === 'balance' ? (parseMoney(payment) ?? undefined) : undefined,
    ends: (type === 'interest-free' || type === 'equal') && ends ? ends : undefined,
    instalments: plan?.instalments && remaining.trim() === centsToInput(plan.remaining) ? plan.instalments : undefined,
  } : null;
  const preview = draft ? planSchedule(debt, draft, budget.settings) : null;

  function save() {
    if (!name.trim()) return setErr(isPerson ? 'Enter what it’s for.' : 'Enter what you bought.');
    if (!draft) return setErr('Enter an amount above $0.');
    if (draft.remaining < 0 || draft.remaining > draft.original * 1.5) return setErr('Check the amount still owed.');
    if (type === 'balance' && !(draft.payment && draft.payment > 0)) return setErr('Enter how much to pay each pay.');
    const next = { ...plan, ...draft, id: plan?.id ?? newId(), name: name.trim() }; // keep anything this form doesn't edit
    update((b) => {
      const d = (b.debts ?? []).find((x) => x.id === debt.id);
      if (!d) return b;
      const i = d.plans.findIndex((x) => x.id === next.id);
      if (i >= 0) d.plans[i] = next; else d.plans.push(next);
      // The first plan switches the payday amount to "pay exactly what's due".
      if (!plan) exactForFirstPlan(b, d);
      recordHistory(d, todayISO());
      return b;
    });
    onClose();
  }
  function remove() {
    update((b) => {
      const d = (b.debts ?? []).find((x) => x.id === debt.id);
      if (d) { d.plans = d.plans.filter((x) => x.id !== plan?.id); recordHistory(d, todayISO()); }
      return b;
    });
    onClose();
  }

  const nextPay = preview?.payments.find((p) => p.date >= periodContaining(today, budget.settings).start);

  return (
    <Modal title={plan ? `Edit ${plan.name}` : `${debt.name}: ${isPerson ? 'add amount owed' : 'add purchase'}`} onClose={onClose} inline={embedded}>
      <label className="field">{isPerson ? 'What it’s for' : 'What you bought'}
        <input autoFocus={!plan} value={name} onChange={(e) => { setName(e.target.value); setErr(''); }} placeholder={isPerson ? 'Scooter' : 'Couch'} />
      </label>
      <div className="form-grid">
        <label className="field">{isPerson ? 'Amount borrowed' : 'Purchase amount'}
          <input inputMode="decimal" value={amount} onChange={(e) => onAmount(e.target.value)} placeholder="1,200.00" />
        </label>
        <label className="field">{isPerson ? 'Date' : 'Purchase date'}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <div className="form-grid">
        <label className="field wide">Plan
          <select value={type} onChange={(e) => { setType(e.target.value as PlanType); setTypeTouched(true); }}>
            {(['interest-free', 'equal', 'afterpay', 'balance'] as PlanType[]).map((t) => <option key={t} value={t}>{PLAN_LABEL[t]}</option>)}
          </select>
        </label>
        {(type === 'interest-free' || type === 'equal') && (
          <label className="field">Months
            <select value={months} onChange={(e) => onMonths(e.target.value)}>
              {(debt.rules === 'gem' ? [...GEM_PLAN_MONTHS] : [3, 6, 12, 18, 24, 36, 48, 60]).map((m) => (
                <option key={m} value={m}>{m} months{debt.rules === 'gem' ? (m <= 6 ? ' · interest-free' : ' · equal payments') : ''}</option>
              ))}
            </select>
          </label>
        )}
        {(type === 'interest-free' || type === 'equal') && (
          <label className="field">{debt.rules === 'gem' ? 'Ends (Gem cycle on the 20th)' : 'Interest-free ends (optional)'}
            <input type="date" value={ends} onChange={(e) => setEnds(e.target.value)} />
          </label>
        )}
        {type === 'balance' && (
          <label className="field">Pay each payday
            <input inputMode="decimal" value={payment} onChange={(e) => setPayment(e.target.value)} placeholder="200.00" />
          </label>
        )}
      </div>
      <label className="field">Still owed today {plan ? '' : '(leave blank if nothing paid yet)'}
        <input inputMode="decimal" value={remaining} onChange={(e) => setRemaining(e.target.value)} placeholder={amount || '0.00'} />
      </label>
      {debt.rules === 'gem' && <p className="small muted">Gem: $250+ purchases are 6 months interest-free. Deals can be 12, 24, 36 or 60 months with equal payments. Pick the length to match the Gem app; the end date follows Gem’s month reset on the 20th.</p>}
      {debt.rules === 'mastercard' && <p className="small muted">Mastercard: every purchase is 3 months interest-free.</p>}

      {preview && (
        <div className="tip">
          <Icon name="bulb" />
          <span>
            {preview.payments.length === 0 && !preview.warning ? 'Nothing left to pay.' : null}
            {preview.payments.length > 0 && `${preview.payments.length} payment${preview.payments.length === 1 ? '' : 's'}`}
            {nextPay ? `, next ${cash(nextPay.amount)} on ${fmtShort(nextPay.date)}` : ''}
            {preview.paidOffBy ? `. Paid off by ${fmtShort(preview.paidOffBy)} ${preview.paidOffBy.slice(0, 4)}` : ''}
            {preview.deadline && type !== 'afterpay' ? `, before interest-free ends ${fmtShort(preview.deadline)} ${preview.deadline.slice(0, 4)}` : ''}
            {preview.interest ? `. About ${cash(preview.interest)} interest` : ''}
            {preview.payments.length > 0 ? '.' : ''}
            {preview.warning && <span className="error block">{preview.warning}</span>}
          </span>
        </div>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="between">
        {plan ? <button className="btn ghost danger" onClick={remove}>Delete</button> : <span />}
        <div className="row">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>{plan ? 'Save' : 'Add'}</button>
        </div>
      </div>
    </Modal>
  );
}
