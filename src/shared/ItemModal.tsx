import { useState } from 'react';
import { convert } from '../engine/frequency';
import { envelopeBudget, setAsidePerPay } from '../engine/setAside';
import { addDays, todayISO, weekday, WEEKDAY_NAMES } from '../core/dates';
import { cash, centsToInput, parseMoney } from '../core/money';
import { newId, useBudget } from '../state/store';
import type { EnvelopeSpan, Frequency, Item } from '../core/types';
import { Icon } from '../ui/Icon';

const FREQS: { v: Frequency; label: string }[] = [
  { v: 'once', label: 'One-off' },
  { v: 'weekly', label: 'Weekly' },
  { v: 'fortnightly', label: 'Fortnightly' },
  { v: 'monthly', label: 'Monthly' },
  { v: 'yearly', label: 'Yearly' },
];

const SPANS: { v: EnvelopeSpan; label: string }[] = [
  { v: 'week', label: 'Week' },
  { v: 'fortnight', label: 'Fortnight' },
  { v: 'month', label: 'Month' },
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
  const [aside, setAside] = useState(item?.setAside ?? false);
  const [envelope, setEnvelope] = useState(item?.envelope !== undefined);
  // Until a timeframe is picked, it follows how often (weekly → a week's envelope).
  const [spanPick, setSpanPick] = useState<EnvelopeSpan | null>(item?.envelope ?? null);
  const [maxSaved, setMaxSaved] = useState(item?.maxSaved ? centsToInput(item.maxSaved) : '');
  const [under, setUnder] = useState(item?.envelopeUnder ? centsToInput(item.envelopeUnder) : '');
  const [err, setErr] = useState('');

  const cents = parseMoney(amount);
  // Money put aside each pay (a WOF, tyres): only for something that repeats.
  const keep = aside && !envelope && freq !== 'once';
  const envOn = envelope && freq !== 'once';
  const weekly = freq === 'weekly' && !keep && !envOn;
  const span: EnvelopeSpan = spanPick ?? (freq === 'weekly' ? 'week' : freq === 'fortnightly' ? 'fortnight' : 'month');

  function save() {
    if (!name.trim()) return setErr('Enter a name.');
    if (cents === null || cents <= 0) return setErr('Enter an amount above $0.');
    if (!start) return setErr('Pick a date.');
    if (end && end < start) return setErr('The end date is before the start date.');
    let cap: number | undefined;
    if (keep && maxSaved.trim() !== '') {
      const parsed = parseMoney(maxSaved);
      if (parsed === null || parsed <= 0) return setErr('Max saved should be an amount above $0, or left blank.');
      cap = parsed;
    }
    let limit: number | undefined;
    if (envOn && under.trim() !== '') {
      const parsed = parseMoney(under);
      if (parsed === null || parsed <= 0) return setErr('"Only purchases under" should be an amount above $0, or left blank.');
      limit = parsed;
    }
    const next: Item = {
      ...item, // keep anything this form doesn't edit
      id: item?.id ?? newId(), name: name.trim(), amount: cents, frequency: freq, start,
      end: freq !== 'once' && end ? end : undefined, accountId: acc, note: note.trim() || undefined,
      showInWeeks: weekly ? inWeeks : undefined,
      skipIfWithin: weekly && Number(skip) > 0 ? Number(skip) : undefined,
      setAside: keep || undefined,
      envelope: envOn ? span : undefined,
      ...(cap ? { maxSaved: cap } : {}),
      ...(limit ? { envelopeUnder: limit } : {}),
    };
    if (!cap) delete next.maxSaved;
    if (!limit) delete next.envelopeUnder;
    if (!keep) delete next.setAside;
    if (!envOn) delete next.envelope;
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

        {freq !== 'once' && (
          <label className="check-row" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={aside} disabled={envelope} onChange={(e) => { setAside(e.target.checked); if (e.target.checked) setEnvelope(false); }} style={{ width: 20, height: 20, flex: 'none', marginTop: 2, accentColor: 'var(--brand)' }} />
            <span>
              Put aside, don't pay out
              <span className="small muted block">
                {keep && cents !== null && cents > 0
                  ? <>Each payday puts <b>{cash(setAsidePerPay({ amount: cents, frequency: freq }))}</b> aside in the account. It stays there until you need it, so the balance builds up.</>
                  : 'For costs that come up now and then, like a WOF, tyres or a service: each payday puts its share aside and it stays in the account until you need it.'}
              </span>
            </span>
          </label>
        )}

        {freq !== 'once' && (
          <label className="check-row" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={envelope} disabled={aside} onChange={(e) => { setEnvelope(e.target.checked); if (e.target.checked) setAside(false); }} style={{ width: 20, height: 20, flex: 'none', marginTop: 2, accentColor: 'var(--brand)' }} />
            <span>
              Put aside for the {envOn ? span : 'week, fortnight or month'}
              <span className="small muted block">
                {envOn && cents !== null && cents > 0
                  ? <>This {span}’s budget is <b>{cash(envelopeBudget({ amount: cents, frequency: freq, envelope: span }))}</b>. Payday funds it; bank purchases that match (e.g. supermarkets for Food, fuel for Gas) count against it. What’s left at the end of the {span} is yours — it doesn’t roll over.</>
                  : 'For everyday spending like food or gas: set a total for the week, fortnight or month, track what is left from synced purchases, and keep any leftover as spare when it ends.'}
              </span>
            </span>
          </label>
        )}

        {envOn && (
          <label className="field">Timeframe
            <select value={span} onChange={(e) => setSpanPick(e.target.value as EnvelopeSpan)}>
              {SPANS.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}
            </select>
          </label>
        )}

        {envOn && (
          <label className="field">Only purchases under (optional)
            <input inputMode="decimal" value={under} onChange={(e) => { setUnder(e.target.value); setErr(''); }} placeholder="50.00" />
            <span className="small muted">For two envelopes that use the same shops, like Scooter gas and Car gas: fills under this go here, bigger ones to the other.</span>
          </label>
        )}

        {keep && (
          <label className="field">Max saved (optional)
            <input inputMode="decimal" value={maxSaved} onChange={(e) => { setMaxSaved(e.target.value); setErr(''); }} placeholder="60.00" />
            <span className="small muted">Once this much is already aside after bills, payday stops adding more until you spend some (e.g. Haircut $60).</span>
          </label>
        )}

        <div className="form-grid">
          <label className="field">{keep || envOn ? 'Start putting aside from' : freq === 'once' ? 'Date' : 'First date'}
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          {freq !== 'once' && (
            <label className="field">{keep || envOn ? 'Stop on (optional)' : 'End date (optional)'}
              <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
          )}
        </div>
        {keep ? <p className="small muted">Starts on the first payday on or after this date.</p> : null}
        {envOn && span === 'month' ? <p className="small muted">Budget resets each calendar month. Leftover at month end is spare to spend on yourself.</p> : null}
        {envOn && span !== 'month' && start ? <p className="small muted">Each {span} runs {WEEKDAY_NAMES[weekday(start)]} to {span === 'fortnight' ? 'the ' : ''}{WEEKDAY_NAMES[weekday(addDays(start, -1))]}{span === 'fortnight' ? ' after next' : ''}, counting from this date. Leftover when it ends is spare to spend on yourself.</p> : null}
        {!keep && !envOn && (freq === 'weekly' || freq === 'fortnightly') ? <p className="small muted">Repeats on the same weekday as the first date.</p> : null}
        {!keep && !envOn && freq === 'monthly' ? <p className="small muted">Repeats on the same day each month (or the last day in shorter months).</p> : null}

        <label className="field">{keep || envOn ? 'Kept in' : 'Comes out of'}
          <select value={acc} onChange={(e) => setAcc(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>

        <label className="field">Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        {weekly && (
          <label className="check-row">
            <input type="checkbox" checked={inWeeks} onChange={(e) => setInWeeks(e.target.checked)} style={{ width: 20, height: 20, accentColor: 'var(--brand)' }} />
            <span>Show in "Weeks this pay" on the Planner</span>
          </label>
        )}
        {weekly && (
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
