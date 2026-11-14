import { useState } from 'react';
import { convert } from '../lib/engine';
import { todayISO } from '../lib/dates';
import { cash, centsToInput, parseMoney } from '../lib/money';
import { newId, useBudget } from '../lib/store';
import type { Frequency, Item } from '../lib/types';
import { Icon } from './Icon';

const FREQS: { v: Frequency; label: string }[] = [
  { v: 'once', label: 'One-off' },
  { v: 'weekly', label: 'Weekly' },
  { v: 'fortnightly', label: 'Fortnightly' },
  { v: 'monthly', label: 'Monthly' },
  { v: 'yearly', label: 'Yearly' },
];

export function ItemModal({ item, accountId, onClose }: { item?: Item; accountId?: string; onClose: () => void }) {
  const { budget, update } = useBudget();
  const accounts = budget.accounts.filter((a) => !a.archived && a.kind === 'bank');
  const [name, setName] = useState(item?.name ?? '');
  const [amount, setAmount] = useState(item ? centsToInput(item.amount) : '');
  const [freq, setFreq] = useState<Frequency>(item?.frequency ?? 'once');
  const [start, setStart] = useState(item?.start ?? todayISO());
  const [end, setEnd] = useState(item?.end ?? '');
  const [acc, setAcc] = useState(item?.accountId ?? accountId ?? budget.settings.payAccountId);
  const [note, setNote] = useState(item?.note ?? '');
  const [inWeeks, setInWeeks] = useState(item?.showInWeeks ?? false);
  const [skip, setSkip] = useState(String(item?.skipIfWithin ?? 0));
  const [err, setErr] = useState('');

  const cents = parseMoney(amount);

  function save() {
    if (!name.trim()) return setErr('Enter a name.');
    if (cents === null || cents <= 0) return setErr('Enter an amount above $0.');
    if (!start) return setErr('Pick a date.');
    if (end && end < start) return setErr('The end date is before the start date.');
    const next: Item = {
      ...item, // keep anything this form doesn't edit
      id: item?.id ?? newId(), name: name.trim(), amount: cents, frequency: freq, start,
      end: freq !== 'once' && end ? end : undefined, accountId: acc, note: note.trim() || undefined,
      showInWeeks: freq === 'weekly' ? inWeeks : undefined,
      skipIfWithin: freq === 'weekly' && Number(skip) > 0 ? Number(skip) : undefined,
    };
    update((b) => {
      const i = b.items.findIndex((x) => x.id === next.id);
      if (i >= 0) b.items[i] = next; else b.items.push(next);
      return b;
    });
    onClose();
  }

  function remove() {
    if (!item) return;
    update((b) => ({ ...b, items: b.items.filter((x) => x.id !== item.id) }));
    onClose();
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="item-title" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2 id="item-title" className="h2">{item ? 'Edit cost' : 'Add a cost'}</h2>
          <button className="icon-btn plain" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>

        <label className="field">Name
          <input autoFocus value={name} onChange={(e) => { setName(e.target.value); setErr(''); }} placeholder="Netflix" />
        </label>

        <div className="form-grid">
          <label className="field">Amount (NZD)
            <input inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setErr(''); }} placeholder="18.00" />
          </label>
          <label className="field">How often
            <select value={freq} onChange={(e) => setFreq(e.target.value as Frequency)}>
              {FREQS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
            </select>
          </label>
        </div>

        {cents !== null && cents > 0 && freq !== 'once' && (
          <div className="conv" aria-label="Same cost in other frequencies">
            <span>{cash(convert(cents, freq, 'week'))} / week</span>
            <span>{cash(convert(cents, freq, 'fortnight'))} / fortnight</span>
            <span>{cash(convert(cents, freq, 'month'))} / month avg</span>
            <span>{cash(convert(cents, freq, 'year'))} / year</span>
          </div>
        )}

        <div className="form-grid">
          <label className="field">{freq === 'once' ? 'Date' : 'First date'}
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          {freq !== 'once' && (
            <label className="field">End date (optional)
              <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
          )}
        </div>
        {freq === 'weekly' || freq === 'fortnightly' ? <p className="small muted">Repeats on the same weekday as the first date.</p> : null}
        {freq === 'monthly' ? <p className="small muted">Repeats on the same day each month (or the last day in shorter months).</p> : null}

        <label className="field">Comes out of
          <select value={acc} onChange={(e) => setAcc(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>

        <label className="field">Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        {freq === 'weekly' && (
          <label className="check-row">
            <input type="checkbox" checked={inWeeks} onChange={(e) => setInWeeks(e.target.checked)} style={{ width: 20, height: 20, accentColor: 'var(--brand)' }} />
            <span>Show in "Weeks this pay" on the Planner</span>
          </label>
        )}
        {freq === 'weekly' && (
          <label className="field">Skip it when it lands close to payday
            <select value={skip} onChange={(e) => setSkip(e.target.value)}>
              <option value="0">Never skip</option>
              <option value="1">Skip if it's the day before payday</option>
              <option value="2">Skip if within 2 days of payday</option>
              <option value="3">Skip if within 3 days of payday</option>
            </select>
          </label>
        )}

        {err && <p className="error" role="alert">{err}</p>}

        <div className="between">
          {item ? <button className="btn ghost danger" onClick={remove}>Delete</button> : <span />}
          <div className="row">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save}>{item ? 'Save' : 'Add'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
