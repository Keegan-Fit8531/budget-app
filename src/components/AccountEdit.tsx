import { useState } from 'react';
import { centsToInput, cash, parseMoney } from '../lib/money';
import { balanceToday } from '../lib/balances';
import { fmtShort, todayISO } from '../lib/dates';
import { setBalance } from '../lib/history';
import { newId, useBudget } from '../lib/store';
import type { Account } from '../lib/types';
import { AccountPayday } from '../pages/Deposits';
import { OneOffCostForm } from './AccountHistory';
import { Modal } from './ui';

export type AccountTab = 'balance' | 'cost' | 'payday';

/**
 * Everything you change on an account, in one pop-up with a tab for each: its balance, a one-off cost
 * paid from it, and what payday sends it (with the costs paid from it).
 */
export function AccountEditModal({ account: a, tab: first = 'balance', onClose }: { account: Account; tab?: AccountTab; onClose: () => void }) {
  const { budget } = useBudget();
  const entry = budget.balances?.[a.id];
  const [tab, setTab] = useState<AccountTab>(entry || first === 'payday' ? first : 'balance');
  const tabs: { id: AccountTab; label: string }[] = [
    { id: 'balance', label: 'Balance' },
    ...(entry ? [{ id: 'cost' as const, label: 'One-off cost' }] : []),
    { id: 'payday', label: 'Payday and costs' },
  ];
  return (
    <Modal title={a.name} width={tab === 'payday' ? 720 : 480} onClose={onClose}>
      {(close) => (
        <>
          <div className="seg fill modal-tabs" role="tablist" aria-label={`${a.name}: what to change`}>
            {tabs.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
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
