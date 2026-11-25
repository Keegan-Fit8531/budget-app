import { useState } from 'react';
import { nextColor } from '../../core/colors';
import { todayISO } from '../../core/dates';
import { centsToInput, parseMoney } from '../../core/money';
import { isKiwiSaver, recordReading } from './logic/kiwisaver';
import { newId, useBudget } from '../../state/store';
import type { SavingsGoal } from '../../core/types';
import { Modal } from '../../ui/components';

export function GoalModal({ goal, onClose }: { goal?: SavingsGoal; onClose: () => void }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const usedByGoals = new Set((budget.savings ?? []).filter((g) => g.id !== goal?.id).map((g) => g.accountId));
  const debtAccounts = new Set((budget.debts ?? []).map((d) => d.accountId));
  const options = budget.accounts.filter((a) => !a.archived && a.id !== budget.settings.payAccountId && !debtAccounts.has(a.id) && !usedByGoals.has(a.id));
  const [name, setName] = useState(goal?.name ?? '');
  const [accountId, setAccountId] = useState(goal?.accountId ?? 'new');
  const [balance, setBalance] = useState(goal ? centsToInput(goal.balance) : '');
  const [target, setTarget] = useState(goal?.target !== undefined ? centsToInput(goal.target) : '');
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '');
  const [other, setOther] = useState(goal?.otherPerPay ? centsToInput(goal.otherPerPay) : '');
  const [note, setNote] = useState(goal?.note ?? '');
  const [kiwi, setKiwi] = useState(goal ? isKiwiSaver(goal) : false);
  const [err, setErr] = useState('');

  function save() {
    if (!name.trim()) return setErr('Enter a name.');
    const bal = balance.trim() === '' ? 0 : parseMoney(balance);
    const tgt = target.trim() === '' ? undefined : parseMoney(target);
    const oth = other.trim() === '' ? undefined : parseMoney(other);
    if (bal === null || bal < 0) return setErr('Check the amount saved.');
    if (tgt === null || (tgt !== undefined && tgt <= 0)) return setErr('Check the target amount.');
    if (oth === null) return setErr('Check the other contributions.');
    update((b) => {
      b.savings = b.savings ?? [];
      let accId = accountId;
      if (accId === 'new') {
        accId = newId();
        const groupId = b.groups.find((g) => g.id === 'savings')?.id ?? b.groups.find((g) => g.bucket === 'savings')?.id ?? b.groups[0]?.id ?? '';
        b.accounts.push({ id: accId, name: name.trim(), kind: 'bank', color: nextColor(b.accounts.map((x) => x.color)), groupId });
        if (!kiwi) b.split.push({ accountId: accId, amount: 0 });
      }
      // KiwiSaver is paid from your salary: payday sends it nothing, so an empty payday line goes.
      if (kiwi) b.split = b.split.filter((l) => l.accountId !== accId || l.amount !== 0 || (l.mode ?? 'fixed') !== 'fixed' || l.auto);
      const balanceChanged = !goal || goal.balance !== bal;
      // Keep everything the form doesn't edit (costs, money added…) from the saved goal.
      const existing = goal ? b.savings.find((x) => x.id === goal.id) : undefined;
      const next: SavingsGoal = {
        ...existing,
        id: goal?.id ?? newId(), name: name.trim(), accountId: accId, balance: bal,
        asOf: balanceChanged ? today : goal!.asOf, target: tgt, targetDate: targetDate || undefined,
        otherPerPay: kiwi ? undefined : oth || undefined, note: note.trim() || undefined,
        kiwisaver: kiwi === /kiwi\s?saver/i.test(name.trim()) ? undefined : kiwi,
      };
      if (kiwi) {
        next.targetDate = undefined;
        // Its balance over time is its history of gains and losses.
        if (balanceChanged || !next.readings?.length) recordReading(next, { date: next.asOf, balance: bal });
      }
      const i = b.savings.findIndex((x) => x.id === next.id);
      if (i >= 0) b.savings[i] = next; else b.savings.push(next);
      return b;
    });
    onClose();
  }
  function remove() {
    if (!goal || !confirm(`Remove the ${goal.name} goal? The account stays in your payday split.`)) return;
    update((b) => ({ ...b, savings: (b.savings ?? []).filter((x) => x.id !== goal.id) }));
    onClose();
  }

  return (
    <Modal title={goal ? `Edit ${goal.name}` : 'Add a savings goal'} onClose={onClose}>
      <label className="field">Name
        <input autoFocus={!goal} value={name} onChange={(e) => { setName(e.target.value); setErr(''); }} placeholder="Emergency fund" />
      </label>
      <label className="field">Saved in
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="new">A new account</option>
          {options.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={kiwi} onChange={(e) => setKiwi(e.target.checked)} />
        <span>KiwiSaver: taken from my pay, and I can’t add to it or take it out</span>
      </label>
      <div className="form-grid">
        <label className="field">{kiwi ? 'Balance' : 'Saved so far'}
          <input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0.00" />
        </label>
        <label className="field">Target (optional)
          <input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="20,000.00" />
        </label>
        {!kiwi && (
          <>
            <label className="field">Target date (optional)
              <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
            </label>
            <label className="field">Others add each pay (optional)
              <input inputMode="decimal" value={other} onChange={(e) => setOther(e.target.value)} placeholder="e.g. a partner's share" />
            </label>
          </>
        )}
      </div>
      <label className="field">Note (optional)
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {targetDate && targetDate <= today && <p className="small muted">That target date has passed, so nothing more is planned for this goal. Pick a later date to keep saving towards it.</p>}
      <p className="small muted">{kiwi
        ? 'Payday sends it nothing. Each balance you enter (or the bank connection brings in) is kept, to chart its gains and losses.'
        : 'Update "saved so far" whenever you check your balance. Investment fund returns aren\'t predicted.'}</p>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="between">
        {goal ? <button className="btn ghost danger" onClick={remove}>Remove goal</button> : <span />}
        <div className="row">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>{goal ? 'Save' : 'Add'}</button>
        </div>
      </div>
    </Modal>
  );
}
