import { cash, centsToInput } from '../../core/money';
import type { Cents } from '../../core/types';
import type { AccountPlan } from '../../engine/plan';
import { Disclosure, Dot } from '../../ui/components';
import { Icon } from '../../ui/Icon';

// ---------------------------------------------------------------------------------------------
// "What's different this pay" on the Planner: each account sending noticeably more or less than
// usual, and why (an extra week, a yearly or one-off cost, or an amount changed for this pay only),
// with Change / Reset for an amount set for this pay only. The notes are worked out on the page.
// ---------------------------------------------------------------------------------------------

/** One account that's different this pay. */
export interface PayNote { a: AccountPlan; usual: Cents; extra: Cents; why: string[] }

/** An account's amount for this pay only, being typed in. */
export interface AdjEdit { id: string; text: string; err?: boolean }

export function PayNotes({ notes, usualTotal, pay, short, thisPay, adjEdit, setAdjEdit, saveAdj, resetAdj }: {
  notes: PayNote[];
  /** What a normal pay sends, all accounts together. */
  usualTotal: Cents;
  pay: Cents;
  /** The pay is short: the panel opens by itself. */
  short: boolean;
  /** Amounts set for this pay only, by account. */
  thisPay: Record<string, Cents>;
  adjEdit: AdjEdit | null;
  setAdjEdit: (e: AdjEdit | null) => void;
  saveAdj: () => void;
  /** Remove an account's amount for this pay only. */
  resetAdj: (accountId: string) => void;
}) {
  return (
    <Disclosure ruled wide title="What's different this pay" meta={notes.length || undefined}
      storageKey="paydays.planner.notes" forceOpen={short}>
      <div className="notes-list">
        {notes.map((x) => (
          <div key={x.a.account.id} className="notes-row">
            <Dot color={x.a.account.color} />
            <span className="min0">
              <b>{x.a.account.name}</b>
              {x.why.map((w) => <span key={w} className="small muted block">{w}</span>)}
              {x.why.length === 0 && <span className="small muted block">Usually about {cash(x.usual, { whole: true })}</span>}
              {x.a.account.id in thisPay && adjEdit?.id !== x.a.account.id && (
                <button className="btn link small" onClick={() => setAdjEdit({ id: x.a.account.id, text: centsToInput(x.a.funded) })}>Change</button>
              )}
            </span>
            <span className="num right">
              <b>{cash(x.a.funded)}</b>
              {Math.abs(x.extra) > 2000 && <span className={`small block ${x.extra > 0 ? 'neg' : 'pos'}`}>{x.extra > 0 ? '+' : '−'}{cash(Math.abs(x.extra), { whole: true })}</span>}
            </span>
            {adjEdit?.id === x.a.account.id && (
              <div className="row nowrap gap-6" style={{ gridColumn: '2 / -1', marginTop: 6 }}>
                <input className="input" inputMode="decimal" autoFocus aria-label={`${x.a.account.name} this pay`} aria-invalid={adjEdit.err || undefined}
                  value={adjEdit.text} style={{ flex: '1 1 0', minWidth: 0, maxWidth: 130, fontWeight: 600 }}
                  onChange={(e) => setAdjEdit({ ...adjEdit, text: e.target.value, err: false })}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveAdj(); if (e.key === 'Escape') setAdjEdit(null); }} />
                <button className="btn small primary" onClick={saveAdj}>Save</button>
                <button className="btn small" onClick={() => resetAdj(x.a.account.id)}>Reset ({cash(x.a.usual ?? x.usual, { whole: true })})</button>
                <button className="icon-btn mini plain" aria-label="Cancel" onClick={() => setAdjEdit(null)}><Icon name="x" size={16} /></button>
              </div>
            )}
          </div>
        ))}
        {usualTotal > pay && (
          <span className="small muted">Even in a normal pay your budget is {cash(usualTotal - pay, { whole: true })} more than your pay.</span>
        )}
      </div>
    </Disclosure>
  );
}
