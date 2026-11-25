import { fmtShort, ordinal, todayISO } from '../../core/dates';
import { cash } from '../../core/money';
import type { Debt } from '../../core/types';
import { paySplitLocked } from '../../engine/balances/freeze';
import type { AccountPlan } from '../../engine/plan';
import type { Period } from '../../engine/periods';
import { PaydayControl } from '../../shared/PaydayControl';
import { useBudget } from '../../state/store';
import { endHeld, heldNow, resumeHeld } from './logic/held/held';

/**
 * A debt card's Payday section: what payday sends it, and for a debt held in a bank account (Gem in Misc
 * bills) what's been paid from there this month, with "No more this month". Once payday has sent a pay,
 * it isn't called short: a change applies from the next pay.
 */
export function DebtPayday({ debt: d, funded, period }: { debt: Debt; funded?: AccountPlan; period: Period }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const sent = paySplitLocked(budget, period, today) ? period.start : undefined;
  const hold = budget.accounts.find((a) => a.id === d.holdAccountId)?.name ?? 'another account';
  const held = sent ? heldNow(budget, d, today) : undefined;
  const amount = cash(funded?.funded ?? 0);
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      {d.holdAccountId && (
        <p className="small muted" style={{ marginBottom: 8 }}>
          {sent ? `Payday sent ${amount} for ${d.name} to ` : `Payday shows ${amount} for ${d.name}; it’s stored in `}<b>{hold}</b>{sent ? ', kept there' : ''} until {d.statementDay ? `the ${ordinal(d.statementDay)}` : 'statement day'}. Change that under Edit → details.
        </p>
      )}
      {held && (held.toCome > 0 || held.ended) && (
        <div className="row wrap gap-6" style={{ marginBottom: 8, alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="small">
            {held.ended
              ? <>{hold} paid <b>{cash(held.paid)}</b> for {fmtShort(held.date)}. No more this month.</>
              : <>{hold} has paid <b>{cash(held.paid)}</b> for {fmtShort(held.date)}; <b>{cash(held.toCome)}</b> is still to send.</>}
          </span>
          {held.ended
            ? <button className="btn small ghost" onClick={() => update((b) => { resumeHeld(b, d.id, held.date); return b; })}>Undo</button>
            : <button className="btn small" onClick={() => update((b) => { endHeld(b, d.id, held, today); return b; })}>{held.paid ? 'No more this month' : 'Not paying this month'}</button>}
        </div>
      )}
      <PaydayControl accountId={d.accountId} sends={funded?.funded ?? 0} needs={funded?.need ?? 0} sentOn={sent}
        autoLabel="Pay exactly what's due each payday"
        autoHint="Adds up this pay's plan payments and Afterpay instalments." />
      {!sent && funded && funded.diff !== null && funded.diff < 0 && (
        <p className="small error" style={{ marginTop: 6 }}>This pay's plans need {cash(funded.need)}, so sending {cash(funded.funded)} is {cash(-funded.diff)} short.</p>
      )}
    </div>
  );
}
