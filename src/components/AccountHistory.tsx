import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { balanceToday, depositFor } from '../lib/balances';
import { fmtShort, todayISO } from '../lib/dates';
import { hasSetAsides, periodContaining, shiftPeriod } from '../lib/engine';
import { accountHistory, recordCost, removeCost } from '../lib/history';
import { cash, parseMoney } from '../lib/money';
import { asideNames } from '../lib/rebalance';
import { newId, useBudget } from '../lib/store';
import type { Account, AccountEvent } from '../lib/types';
import { Icon } from './Icon';

/** Record money spent from an account outside its plan (a tyre puncture): it comes off what's in the account. */
export function OneOffCostModal({ account: a, onClose }: { account: Account; onClose: () => void }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [err, setErr] = useState('');
  const cents = parseMoney(amount);
  const ok = cents !== null && cents > 0;
  const now = balanceToday(budget, a.id, today) ?? 0;
  const aside = hasSetAsides(budget, a.id);

  // What it changes: what's left in the account, and whether next payday sends more to make up for it.
  const effect = useMemo(() => {
    if (!ok) return null;
    const next = shiftPeriod(periodContaining(today, budget.settings), 1, budget.settings);
    const after = structuredClone(budget);
    recordCost(after, a.id, { amount: cents!, date, note: '' }, 'preview');
    return { next, before: depositFor(budget, a.id, next, today), after: depositFor(after, a.id, next, today) };
  }, [ok, cents, date, budget, a.id, today]);

  function save() {
    if (!note.trim()) return setErr('Say what it was, like Tyre puncture.');
    if (!ok) return setErr('Enter what it cost, like 180.00');
    if (!date || date > today) return setErr('Pick the day it was paid (today or earlier).');
    update((b) => { recordCost(b, a.id, { amount: cents!, date, note: note.trim() }, newId()); return b; });
    onClose();
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="oneoff-title" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="between nowrap">
          <div className="min0">
            <h2 id="oneoff-title" className="h2">One-off cost</h2>
            <span className="small muted">Paid from {a.name}</span>
          </div>
          <button className="icon-btn plain" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>

        <label className="field">What was it
          <input autoFocus value={note} placeholder="Tyre puncture" onChange={(e) => { setNote(e.target.value); setErr(''); }}
            onKeyDown={(e) => e.key === 'Enter' && save()} />
        </label>
        <div className="form-grid">
          <label className="field">Amount (NZD)
            <input inputMode="decimal" value={amount} placeholder="180.00" onChange={(e) => { setAmount(e.target.value); setErr(''); }}
              onKeyDown={(e) => e.key === 'Enter' && save()} />
          </label>
          <label className="field">Paid on
            <input type="date" value={date} max={today} onChange={(e) => { setDate(e.target.value); setErr(''); }} />
          </label>
        </div>

        <div className="tip small">
          <Icon name="bulb" />
          <span>
            {!ok
              ? <>It comes off the <b>{cash(now)}</b> in {a.name} and is kept in its history.</>
              : <>Takes <b>{cash(cents!)}</b> off the {cash(now)} in {a.name}, leaving <b className={now - cents! < 0 ? 'neg' : ''}>{cash(now - cents!)}</b>.</>}
            {effect && (effect.after > effect.before
              ? ` Next payday (${fmtShort(effect.next.start)}) sends ${cash(effect.after)} instead of ${cash(effect.before)} to make up for it.`
              : aside ? ` It's paid from what's put aside for ${asideNames(budget, a.id)}; payday still sends ${cash(effect.before)} as usual.` : '')}
          </span>
        </div>

        {err && <p className="error" role="alert">{err}</p>}
        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Record cost</button>
        </div>
      </div>
    </div>
  );
}

/** An account's history, latest first: balances entered and one-off costs (which can be removed). */
export function AccountHistoryList({ account: a }: { account: Account }) {
  const { budget, update } = useBudget();
  const list = accountHistory(budget, a.id);
  const [all, setAll] = useState(false);
  const [removing, setRemoving] = useState<AccountEvent | null>(null);
  const entry = budget.balances?.[a.id];
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, 6);

  function remove(putBack: boolean) {
    if (!removing) return;
    const id = removing.id;
    update((b) => { removeCost(b, a.id, id, putBack); return b; });
    setRemoving(null);
  }

  return (
    <div>
      <h3 className="h3">History</h3>
      {shown.map((e) => (
        <div key={e.id} className="list-row small">
          <span style={{ flex: '0 0 56px' }} className="muted">{fmtShort(e.date)}</span>
          <span className="grow min0">
            {e.kind === 'cost' ? e.note || 'One-off cost' : 'Balance updated'}
            <span className="xs muted block">{e.kind === 'cost' ? 'One-off cost' : 'From your banking app'}</span>
          </span>
          <b className="num">{e.kind === 'cost' ? `−${cash(e.amount)}` : cash(e.amount)}</b>
          {e.kind === 'cost'
            ? <button className="icon-btn mini plain" aria-label={`Remove ${e.note || 'one-off cost'} (${cash(e.amount)})`} onClick={() => setRemoving(e)}><Icon name="x" size={14} /></button>
            : <span style={{ width: 32, flex: '0 0 32px' }} />}
        </div>
      ))}
      {list.length > shown.length && <button className="btn small ghost" onClick={() => setAll(true)}>Show all {list.length}</button>}

      {removing && createPortal(
        <div className="modal-back" onClick={() => setRemoving(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="remove-cost-title" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="between nowrap">
              <h2 id="remove-cost-title" className="h2">Remove {removing.note || 'this cost'} ({cash(removing.amount)})?</h2>
              <button className="icon-btn plain" aria-label="Close" onClick={() => setRemoving(null)}><Icon name="x" /></button>
            </div>
            {entry ? (
              <>
                <p className="small muted">It comes out of the history either way. Choose what happens to the balance.</p>
                <button className="btn primary" onClick={() => remove(true)}>Put {cash(removing.amount)} back in {a.name}</button>
                <button className="btn" onClick={() => remove(false)}>Leave the balance as it is</button>
                <p className="small muted">Leave it if the balance already shows the real amount (e.g. you've updated it from your banking app since).</p>
              </>
            ) : <button className="btn primary" onClick={() => remove(false)}>Remove it</button>}
            <div className="row end">
              <button className="btn" onClick={() => setRemoving(null)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
