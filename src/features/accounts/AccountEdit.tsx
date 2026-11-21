import { useState } from 'react';
import { centsToInput, cash, parseMoney } from '../../core/money';
import { balanceToday } from '../../engine/balances/estimate';
import { fmtShort, todayISO } from '../../core/dates';
import { setBalance } from './logic/history';
import { newId, useBudget } from '../../state/store';
import type { Account } from '../../core/types';
import { AccountPayday } from './Deposits';
import { OneOffCostForm } from './AccountHistory';
import { Modal } from '../../ui/components';

export type AccountTab = 'balance' | 'cost' | 'payday';

/**
 * Everything you change on an account, in one pop-up with a tab for each: its balance, a one-off cost
 * paid from it, and what payday sends it (with the costs paid from it).
 */
export function AccountEditModal({ account: a, tab: first = 'balance', onClose }: { account: Account; tab?: AccountTab; onClose: () => void }) {
  const { budget } = useBudget();
  const entry = budget.balances?.[a.id];
  // Caller picks the tab (e.g. Payday send from the Planner); Accounts defaults to Balance.
  const [tab, setTab] = useState<AccountTab>(first);
  const tabs: { id: AccountTab; label: string }[] = [
    { id: 'balance', label: 'Balance' },
    ...(entry ? [{ id: 'cost' as const, label: 'One-off cost' }] : []),
    { id: 'payday', label: 'Payday send' },
  ];
  return (
    // One size for every tab, and pinned to the top, so switching tabs doesn't move or resize the pop-up.
    <Modal title={a.name} width={680} className="pinned" onClose={onClose}>
      {(close) => (
        <>
          <div className="modal-tabs">
            <div className="seg fill" role="tablist" aria-label={`${a.name}: what to change`}>
              {tabs.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
            </div>
          </div>
          <div role="tabpanel" className="stack gap-16">
            {tab === 'balance' && <BalanceForm account={a} onDone={close} />}
            {tab === 'cost' && <OneOffCostForm account={a} onDone={close} />}
            {tab === 'payday' && <AccountPayday account={a} />}
          </div>
        </>
      )}
    </Modal>
  );
}

/** What's in the account now, from your banking app. */
function BalanceForm({ account: a, onDone }: { account: Account; onDone: () => void }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const entry = budget.balances?.[a.id];
  const now = balanceToday(budget, a.id, today);
  const [text, setText] = useState(entry ? centsToInput(now ?? entry.amount) : '');
  const [err, setErr] = useState('');
  function save() {
    const c = parseMoney(text);
    if (c === null) return setErr('Enter the balance, like 705.00');
    update((b) => { setBalance(b, a.id, c, today, newId()); return b; });
    onDone();
  }
  return (
    <>
      <label className="field">Balance right now
        <input inputMode="decimal" autoFocus value={text} placeholder="0.00" onChange={(e) => { setText(e.target.value); setErr(''); }} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </label>
      <p className="small muted">
        {entry ? `Last entered: ${cash(entry.amount)} on ${fmtShort(entry.asOf)}.` : 'Enter what your banking app shows.'} Payments and paydays since are counted from here.
      </p>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row end">
        <button className="btn" onClick={onDone}>Cancel</button>
        <button className="btn primary" onClick={save}>Save balance</button>
      </div>
    </>
  );
}
