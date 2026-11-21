import { useState } from 'react';
import { Icon } from '../../ui/Icon';
import { Modal } from '../../ui/components';
import { fmtShort, todayISO } from '../../core/dates';
import { debtPerPay, owed, plannedOwed, recordHistory, unplanned } from './logic/amounts';
import { cash, centsToInput, parseMoney } from '../../core/money';
import { useBudget } from '../../state/store';
import type { Debt } from '../../core/types';
import { PlanModal } from './PlanModal';
import { PaymentModal } from './PaymentModal';
import { DebtModal } from './DebtModal';

/** Outstanding balance and available credit, editable either way round. */
export function BalanceEditor({ debt: d, used, onAddPlan, editing: startEditing, onDone }: { debt: Debt; used: number; onAddPlan: () => void; editing?: boolean; onDone?: () => void }) {
  const { budget, update } = useBudget();
  // Money owed outside a plan still gets paid from the payday amount; it's only unscheduled when that's $0.
  const unscheduled = debtPerPay(budget, d) === 0;
  const today = todayISO();
  const o = owed(d);
  const planned = plannedOwed(d);
  const extra = unplanned(d);
  const [editingState, setEditingState] = useState(!!startEditing);
  const editing = editingState;
  const setEditing = (v: boolean) => { setEditingState(v); if (!v) onDone?.(); };
  const [owedText, setOwedText] = useState(centsToInput(o));
  const [availText, setAvailText] = useState(d.limit ? centsToInput(d.limit - o) : '');
  const [err, setErr] = useState('');

  // Typing one fills in the other (owed + available = limit).
  function onOwed(v: string) {
    setOwedText(v); setErr('');
    const c = parseMoney(v);
    if (d.limit && c !== null) setAvailText(centsToInput(d.limit - c));
  }
  function onAvail(v: string) {
    setAvailText(v); setErr('');
    const c = parseMoney(v);
    if (d.limit && c !== null) setOwedText(centsToInput(d.limit - c));
  }
  function save() {
    const c = parseMoney(owedText);
    if (c === null || c < 0) return setErr('Enter what you owe, like 1,240.50');
    if (d.limit && c > d.limit * 1.2) return setErr('That\u2019s well over the credit limit. Check the amount, or update the limit with Edit.');
    update((b) => {
      const x = (b.debts ?? []).find((y) => y.id === d.id);
      if (x) { x.balance = { amount: c, asOf: today }; x.checked = { ...x.balance }; recordHistory(x, today); }
      return b;
    });
    setEditing(false);
  }
  function clear() {
    update((b) => { const x = (b.debts ?? []).find((y) => y.id === d.id); if (x) { delete x.balance; recordHistory(x, today); } return b; });
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="stack gap-8">
        <div className="form-grid">
          <label className="field">Owed now
            <input inputMode="decimal" autoFocus value={owedText} onChange={(e) => onOwed(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
          </label>
          {d.limit ? (
            <label className="field">Available credit
              <input inputMode="decimal" value={availText} onChange={(e) => onAvail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
            </label>
          ) : null}
        </div>
        {d.limit ? <p className="small muted">Enter either one; the other fills in from your {cash(d.limit, { whole: true })} limit.</p> : null}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row wrap">
          <button className="btn primary small" onClick={save}>Save balance</button>
          <button className="btn small" onClick={() => setEditing(false)}>Cancel</button>
          {d.balance && <button className="btn small ghost" onClick={clear}>Use plan totals instead</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="stack gap-6">
      {d.limit ? <div className="bar" style={{ marginTop: 0 }} role="img" aria-label={`${Math.round(used)}% of the limit used`}><div style={{ width: `${used}%`, background: used > 80 ? 'var(--bad)' : undefined }} /></div> : null}
      <p className="small muted">
        {d.balance ? `Balance checked ${fmtShort(d.balance.asOf)}${d.balance.asOf.slice(0, 4) !== today.slice(0, 4) ? ` ${d.balance.asOf.slice(0, 4)}` : ''}` : 'Owed is from the plans below'}{d.limit ? ` · ${Math.round(used)}% of the limit used` : ''}
      </p>
      {d.balance && extra > 0 && d.rules !== 'gem' && unscheduled && (
        <div className="tip">
          <Icon name="bulb" />
          <div className="stack gap-8">
            <span>{cash(extra)} of this isn't in a payment plan{planned ? ` (plans cover ${cash(planned)})` : ''}, so no payments are scheduled for it.</span>
            <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={onAddPlan}>Add it as a plan</button>
          </div>
        </div>
      )}
      {d.balance && planned > o && (
        <p className="small error">Your plans add up to {cash(planned)}, more than the {cash(o)} balance. Update the plans' amounts still owed.</p>
      )}
    </div>
  );
}

export type DebtTab = 'balance' | 'purchase' | 'payment' | 'details';

/** Everything you change on a debt, in one pop-up with a tab for each. */
export function DebtEditModal({ debt: d, tab: first = 'balance', onClose, onDelete }: { debt: Debt; tab?: DebtTab; onClose: () => void; onDelete: (d: Debt) => void }) {
  const [tab, setTab] = useState<DebtTab>(first);
  const isPerson = d.kind === 'person' || d.kind === 'loan';
  const used = d.limit ? Math.min(100, (owed(d) / d.limit) * 100) : 0;
  const tabs: { id: DebtTab; label: string }[] = [
    { id: 'balance', label: 'Balance' },
    ...(!d.payroll ? [{ id: 'purchase' as const, label: isPerson ? 'Add owed' : 'Purchase' }] : []),
    ...(!d.payroll && owed(d) > 0 ? [{ id: 'payment' as const, label: 'Payment' }] : []),
    { id: 'details', label: 'Details' },
  ];
  return (
    <Modal title={d.name} width={560} className="pinned" onClose={onClose}>
      {(close) => (
        <>
          <div className="modal-tabs">
            <div className="seg fill" role="tablist" aria-label={`${d.name}: what to change`}>
              {tabs.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
            </div>
          </div>
          <div role="tabpanel" className="stack gap-16">
            {tab === 'balance' && <BalanceEditor debt={d} used={used} editing onDone={close} onAddPlan={() => setTab('purchase')} />}
            {tab === 'purchase' && <PlanModal debt={d} embedded onClose={close} />}
            {tab === 'payment' && <PaymentModal debt={d} embedded onClose={close} />}
            {tab === 'details' && <DebtModal debt={d} embedded onClose={close} onDelete={onDelete} />}
          </div>
        </>
      )}
    </Modal>
  );
}
