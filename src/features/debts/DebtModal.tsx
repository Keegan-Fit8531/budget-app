import { useState } from 'react';
import { Icon } from '../../ui/Icon';
import { nextColor } from '../../core/colors';
import { centsToInput, parseMoney } from '../../core/money';
import { newId, useBudget } from '../../state/store';
import type { Debt } from '../../core/types';
import { KIND_LABEL } from './logic/labels';

export function DebtModal({ debt, onClose, onDelete, embedded }: { debt?: Debt; onClose: () => void; onDelete: (d: Debt) => void; embedded?: boolean }) {
  const { budget, update } = useBudget();
  const [name, setName] = useState(debt?.name ?? '');
  const [kind, setKind] = useState<Debt['kind']>(debt?.kind ?? 'card');
  const [rules, setRules] = useState<string>(debt?.rules ?? '');
  const [limit, setLimit] = useState(debt?.limit ? centsToInput(debt.limit) : '');
  const [rate, setRate] = useState(debt?.rate !== undefined ? String(debt.rate) : '');
  const [stmt, setStmt] = useState(debt?.statementDay ? String(debt.statementDay) : '');
  const [hold, setHold] = useState(debt?.holdAccountId ?? '');
  const [err, setErr] = useState('');
  // Bank accounts that can hold a card payment until statement day (not this debt's own payday account).
  const holdOptions = budget.accounts.filter((a) => !a.archived && a.kind === 'bank' && a.id !== budget.settings.payAccountId && a.id !== debt?.accountId);

  function save() {
    if (!name.trim()) return setErr('Enter a name.');
    // Only the fields shown for this type are checked and saved. A limit or rate that isn't shown is
    // left as it was; card rules and a statement day don't apply to other types, so they're cleared.
    const lim = kind === 'person' ? debt?.limit : limit.trim() === '' ? undefined : parseMoney(limit);
    if (lim === null) return setErr('Check the credit limit.');
    const r = kind === 'bnpl' ? debt?.rate : rate.trim() === '' ? undefined : Number(rate);
    const sd = kind !== 'card' || stmt.trim() === '' ? undefined : Number(stmt);
    const rl = (kind === 'card' || kind === 'bnpl' ? rules || undefined : undefined) as Debt['rules'];
    const holdId = kind === 'card' && sd && hold ? hold : undefined;
    if (sd !== undefined && (!Number.isInteger(sd) || sd < 1 || sd > 28)) return setErr('Statement day should be a day of the month from 1 to 28.');
    if (r !== undefined && (Number.isNaN(r) || r < 0 || r > 100)) return setErr('Interest rate should be between 0 and 100%.');
    if (hold && !sd) return setErr('Set a statement day to store the payment in another account until then.');
    update((b) => {
      b.debts = b.debts ?? [];
      if (debt) {
        const d = b.debts.find((x) => x.id === debt.id)!;
        Object.assign(d, { name: name.trim(), kind, rules: rl, limit: lim, rate: r, statementDay: sd, holdAccountId: holdId });
        if (!holdId) delete d.holdAccountId;
        const a = b.accounts.find((x) => x.id === d.accountId);
        if (a) a.name = name.trim();
        // Storing the payment elsewhere: keep a real send amount on the debt card. A $0 fixed amount
        // would schedule nothing and hide Gem from the Planner.
        if (holdId) {
          const line = b.split.find((l) => l.accountId === d.accountId);
          if (!line) b.split.push({ accountId: d.accountId, amount: 0, mode: 'exact' });
          else if (line.mode !== 'fixed' || !(line.amount > 0)) { line.mode = 'exact'; delete line.auto; }
        }
      } else {
        const id = newId();
        const groupId = b.groups.find((g) => g.id === 'debt')?.id ?? b.groups.find((g) => g.bucket === 'savings')?.id ?? b.groups[0]?.id ?? '';
        b.accounts.push({ id, name: name.trim(), kind: 'external', color: nextColor(b.accounts.map((x) => x.color)), groupId });
        b.split.push({ accountId: id, amount: 0, mode: 'exact' });
        b.debts.push({ id, name: name.trim(), kind, rules: rl, accountId: id, limit: lim, rate: r, statementDay: sd, ...(holdId ? { holdAccountId: holdId } : {}), plans: [] });
      }
      return b;
    });
    onClose();
  }

  return (
    <div className={`modal-back${embedded ? ' inline' : ''}`} onClick={embedded ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="debt-title" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2 id="debt-title" className="h2">{debt ? `Edit ${debt.name}` : 'Add a debt'}</h2>
          <button className="icon-btn plain" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <label className="field">Name
          <input autoFocus={!debt} value={name} onChange={(e) => { setName(e.target.value); setErr(''); }} placeholder="Gem Visa" />
        </label>
        <div className="form-grid">
          <label className="field">Type
            <select value={kind} onChange={(e) => setKind(e.target.value as Debt['kind'])}>
              {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          {(kind === 'card' || kind === 'bnpl') && (
            <label className="field">Purchase rules
              <select value={rules} onChange={(e) => {
                setRules(e.target.value);
                if (e.target.value === 'gem' && !stmt.trim()) setStmt('21');
              }}>
                <option value="">None</option>
                <option value="gem">Gem ($250+ is 6 months interest-free)</option>
                <option value="mastercard">3 months interest-free on everything</option>
                <option value="afterpay">Afterpay (4 fortnightly)</option>
              </select>
            </label>
          )}
        </div>
        <div className="form-grid">
          {kind !== 'person' && (
            <label className="field">Credit limit (optional)
              <input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="8,000.00" />
            </label>
          )}
          {kind === 'card' && (
            <label className="field">Statement day (optional)
              <input inputMode="numeric" value={stmt} onChange={(e) => setStmt(e.target.value)} placeholder="21" />
            </label>
          )}
          {kind !== 'bnpl' && (
            <label className="field">Interest rate % p.a. (optional)
              <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0" />
            </label>
          )}
        </div>
        {kind === 'card' && (
          <label className="field">Store payment in until statement day
            <select value={hold} onChange={(e) => setHold(e.target.value)} disabled={!stmt.trim()}>
              <option value="">Send on payday (no holding account)</option>
              {holdOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        )}
        {kind === 'card' && <p className="small muted">With a statement day, payments are planned for that day each month (Gem: the 21st). Store the payment in Misc bills (or similar) so payday still shows this card’s amount, but the money sits there until the {stmt.trim() || '21'}st — paying Gem earlier can go on the oldest plan instead of this month’s payment.</p>}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="between">
          {debt ? <button className="btn ghost danger" onClick={() => { if (confirm(`Remove ${debt.name} and its plans?`)) onDelete(debt); }}>Remove debt</button> : <span />}
          <div className="row">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save}>{debt ? 'Save' : 'Add'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
