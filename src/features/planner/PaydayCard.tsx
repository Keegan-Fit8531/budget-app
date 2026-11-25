import { fmtShort, monthName, ordinal, type ISODate } from '../../core/dates';
import { cash } from '../../core/money';
import type { Budget, Cents, EnvelopeSpan } from '../../core/types';
import { accountMode, keepsBuffer } from '../../engine/balances/outflows';
import { BUFFER_PAYS, bufferLine, potBuffer } from '../../engine/balances/buffer';
import { leftoverBeforeBudget, topsUp } from '../../engine/balances/topUps';
import { envelopeSpentBy } from '../../engine/balances/estimate';
import { firstBudgetPay, shiftPeriod, type Period } from '../../engine/periods';
import { isAuto, type AccountPlan } from '../../engine/plan';
import { envelopeBudget, envelopeSpan, isEnvelope, isHeldInAccount, isSetAside } from '../../engine/setAside';
import type { ViewMode } from '../../state/period';
import { AccIcon, Modal } from '../../ui/components';
import { Icon } from '../../ui/Icon';
import type { AccountTab } from '../accounts/AccountEdit';

// ---------------------------------------------------------------------------------------------
// One account's card in the Planner's payday split, and the details pop-up it opens: what payday
// sends it this pay (or on average), whether it ends short or with a buffer, and each cost due.
// ---------------------------------------------------------------------------------------------

/** How the Planner is showing amounts: worked out once on the page and passed to each card. */
export interface PlannerView {
  mode: ViewMode;
  /** Any view but "this period". */
  avg: boolean;
  /** Week / Fortnight: this pay, split by its number of days. */
  split: boolean;
  /** Month avg / Year: what's planned over the next 12 pays. */
  longRun: boolean;
  /** The pay is in (or estimated from the last one received). */
  known: boolean;
  /** An amount for this pay, shown in the view's terms. */
  v: (c: Cents) => Cents;
  /** What's left after the plan, in the view's terms. */
  leftover: Cents;
  /** Month avg / Year: each account's planned average (null in the other views). */
  planned: Map<string, { sent: Cents; need: Cents }> | null;
  period: Period;
  today: ISODate;
}

export function PaydayCard({ budget, a, view, why, isOpen, onOpen, onClose, onEdit }: {
  budget: Budget;
  a: AccountPlan;
  view: PlannerView;
  /** Why this account is different this pay (the same notes as "What's different this pay"). */
  why: string[];
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Open the account's settings on a tab (the page closes this card's pop-up first). */
  onEdit: (tab: AccountTab) => void;
}) {
  const { mode, avg, split, longRun, known, v, leftover, planned, period, today } = view;
  const isPay = a.account.id === budget.settings.payAccountId;
  const auto = isAuto(budget, a.account.id);
  const steadyMode = accountMode(budget, a.account.id) === 'smooth';
  const funded = !avg ? a.funded : isPay ? leftover : split ? v(a.funded) : v(planned?.get(a.account.id)?.sent ?? 0);
  const need = split ? v(a.need) : longRun ? v(planned?.get(a.account.id)?.need ?? 0) : a.need;
  // With a balance entered, the pill shows what the account ends the period with —
  // after reserving unspent month envelopes (Gas assumed spent this month).
  const rawEnds = !avg ? a.endBalance : undefined;
  // Envelope money is assumed spent: unspent now, and (a later pay) what each payday till then funds.
  const gasHeld = rawEnds !== undefined ? envelopeSpentBy(budget, a.account.id, period.end, today) : 0;
  const ends = rawEnds !== undefined ? rawEnds - gasHeld : undefined;
  const diff = ends !== undefined ? null : a.diff === null || auto ? null : funded - need;
  // Steady (e.g. rent): "Buffer" is what the pays after this one need of what it ends with, as a running
  // balance from this pay's end (which includes what earlier pays built up) — not the whole ending balance.
  const pot = ends !== undefined && ends > 0 && keepsBuffer(budget, a.account.id)
    ? potBuffer(budget, a.account.id, period, ends, BUFFER_PAYS, today) : undefined;
  const bufferFor = pot && pot.buffer > 0 ? pot.lowest : undefined;
  const bufferShort = bufferFor && pot!.free < 0 ? -pot!.free : undefined;
  const bufferShown = bufferFor ? pot!.buffer : undefined;
  // Money put aside on payday (a WOF, tyres) isn't a payment: it's counted on its own.
  const paying = a.dues.filter((d) => !isHeldInAccount(d.item));
  const asideTotal = a.need - paying.reduce((t, d) => t + d.item.amount, 0);
  const asidePart = asideTotal > 0 ? `${cash(asideTotal)} put aside` : '';
  const billBreakdown = a.breakdown.filter((x) => !isHeldInAccount(x.item));
  // "5 × $275" when every cost repeats the same number of times (e.g. weekly food + gas), else a count.
  const sameCount = billBreakdown.length > 0 && billBreakdown.every((x) => x.count === billBreakdown[0].count);
  const times = [sameCount && billBreakdown[0].count > 1
    ? `${billBreakdown[0].count} × ${cash(billBreakdown.reduce((s, x) => s + x.item.amount, 0))}`
    : paying.length || !asidePart ? `${paying.length} payment${paying.length === 1 ? '' : 's'} due` : '', asidePart].filter(Boolean).join(' + ');
  const detail = auto
    ? (longRun ? (steadyMode ? 'Level amount' : 'Average')
      : !steadyMode && topsUp(budget, a.account.id)
        ? (a.funded < a.need ? `${cash(a.need, { whole: true })} of bills − ${cash(a.need - a.funded, { whole: true })} already there`
          : asidePart ? times : `${a.dues.length} bills, nothing left over`)
        : times)
    : isPay
    ? (known ? 'Pay lands here · what’s left' : 'Pay lands here · shows once pay is in')
    : a.diff === null
      ? (a.account.kind === 'external' ? 'Sent on payday' : 'No costs set')
      : longRun
        ? `${cash(need)} needed on average`
        : sameCount && billBreakdown[0].item.frequency !== 'monthly'
          ? times
          : asidePart && !paying.length ? `${asidePart} · nothing paid out` : `${paying.length} costs due · ${cash(a.need)}${asidePart ? `, incl. ${asidePart}` : ''}`;
  // Everything about the account beyond its amount lives in a pop-up, opened by tapping the card.
  const adjusted = a.usual !== undefined && a.usual !== a.funded;
  // Only a problem (short) or something to act on (spare) is coloured; the rest stays quiet.
  const endTip = ends === undefined ? ''
    : ends < 0
      ? (gasHeld > 0
        ? `Short after bills and ${cash(gasHeld)} budgeted for envelopes (assumed spent)`
        : 'Estimated balance at the end of this pay period')
    : pot && bufferFor
      ? `${bufferLine(pot)}${gasHeld ? ` (after ${cash(gasHeld)} for envelopes)` : ''}.`
      : gasHeld > 0 ? `Ends about ${cash(ends)} after ${cash(gasHeld)} for envelopes (assumed spent)`
      : steadyMode ? `Estimated balance at the end of this pay (a level amount evens out 4- and 5-week pays)`
      : 'Estimated balance at the end of this pay period';
  const pill = (
    <>
      {diff !== null && diff !== 0 && (
        <span className={`pill ${diff < 0 ? 'bad' : 'good'}`}>{diff < 0 ? `${cash(-diff, { whole: Math.abs(diff) >= 10000 })} short` : `+${cash(diff, { whole: diff >= 10000 })} spare`}</span>
      )}
      {diff === 0 && <span className="pill">Exactly right</span>}
      {ends !== undefined && (
        <span className={`pill ${ends < 0 || bufferShort !== undefined ? 'bad' : ''}`} title={endTip}>
          {ends < 0
            ? `${cash(-ends)} short`
            : bufferShort !== undefined && bufferFor
              ? `${cash(bufferShort)} short by ${fmtShort(bufferFor.period.start)}`
            : bufferShown !== undefined
              ? `Buffer ${cash(bufferShown)}`
              : `Ends ${cash(ends)}`}
        </span>
      )}
    </>
  );
  const amount = <>{isPay && !known ? '—' : cash(funded)}{split && !(isPay && !known) && <small className="muted small" style={{ fontWeight: 500 }}> /{mode === 'week' ? 'wk' : 'fn'}</small>}</>;
  const amountClass = funded < 0 && (known || !isPay) ? 'neg' : '';
  const icon = <AccIcon color={a.account.color} name={a.account.kind === 'external' ? 'send' : isPay ? 'wallet' : 'bank'} />;
  // Each cost this pay (e.g. food, car gas, scooter gas, or every bill in Misc bills).
  const byName = new Map<string, { name: string; amount: Cents; dates: string[]; aside: boolean; envelope?: boolean; note?: string; maxSaved?: Cents; envelopeBudget?: Cents; span?: EnvelopeSpan }>();
  if (!longRun) for (const d of a.dues) {
    const held = isHeldInAccount(d.item);
    // An envelope's due is this pay's funding (`env-<id>`); its span budget comes from the cost itself.
    const env = isEnvelope(d.item) ? budget.items.find((x) => `env-${x.id}` === d.item.id) ?? d.item : undefined;
    const r = byName.get(`${held}|${d.item.name}`) ?? {
      name: d.item.name, amount: 0, dates: [], aside: isSetAside(d.item), envelope: isEnvelope(d.item), note: d.item.note,
      maxSaved: d.item.maxSaved && d.item.maxSaved > 0 ? d.item.maxSaved : undefined,
      envelopeBudget: env ? envelopeBudget(env) : undefined,
      span: env ? envelopeSpan(env) : undefined,
    };
    r.amount += d.item.amount; r.dates.push(d.date);
    if (!r.note && d.item.note) r.note = d.item.note;
    if (!r.maxSaved && d.item.maxSaved && d.item.maxSaved > 0) r.maxSaved = d.item.maxSaved;
    byName.set(`${held}|${d.item.name}`, r);
  }
  const rows = [...byName.values()];
  // The budget's first pay starts from what the pay before it left in the account (or left short).
  const carry = avg || isPay || period.start !== firstBudgetPay(budget, today).start
    || !(keepsBuffer(budget, a.account.id) || topsUp(budget, a.account.id))
    ? 0 : leftoverBeforeBudget(budget, a.account.id);
  const isDebt = (budget.debts ?? []).some((d) => d.accountId === a.account.id);
  const debt = (budget.debts ?? []).find((d) => d.accountId === a.account.id);
  const holdAcc = debt?.holdAccountId ? budget.accounts.find((x) => x.id === debt.holdAccountId) : undefined;
  const holdNote = debt?.holdAccountId && holdAcc && debt.statementDay
    ? `Stored in ${holdAcc.name} until the ${ordinal(debt.statementDay)}`
    : undefined;
  const isGoal = (budget.savings ?? []).some((g) => g.accountId === a.account.id);
  return (
    <>
    <button className="acc-card" aria-haspopup="dialog"
      aria-label={`${a.account.name}: details`} onClick={onOpen}>
      <div className="between nowrap">{icon}{pill}</div>
      <p className="acc-name">{a.account.name}</p>
      {holdNote && <p className="xs muted" style={{ margin: '2px 0 0' }}>{holdNote}</p>}
      <div className="between nowrap bottom">
        <p className={`amt ${amountClass}`}>{amount}</p>
        <span className="acc-more" aria-hidden="true"><Icon name="info" size={18} /></span>
      </div>
    </button>
    {isOpen && (
      <Modal title={<span className="row nowrap min0">{icon}<span className="clip">{a.account.name}</span></span>}
        sub={`${monthName(period.start)} pay · ${fmtShort(period.start)} – ${fmtShort(period.end)}`} onClose={onClose}>
        <div className="stat">
          <div className="between nowrap">
            <span className="small muted">{isPay ? 'Left here after the plan' : longRun ? 'Sent on average' : 'Payday sends'}</span>
            {pill}
          </div>
          <b className={`fig ${amountClass}`}>{amount}</b>
          <span className="small muted">{detail}</span>
          {holdNote && debt && (
            <span className="small">
              Held in <b>{holdAcc!.name}</b> until the {ordinal(debt.statementDay!)}
              {debt.statementDay ? ` — send to ${a.account.name} on or after that day, not on payday` : ''}.
            </span>
          )}
          {adjusted && <span className="small">Adjusted this pay · usually {cash(a.usual!)}</span>}
          {carry !== 0 && (
            <span className={`small ${carry < 0 ? 'neg' : 'pos'}`}>
              {carry < 0 ? `Includes ${cash(-carry, { whole: true })} the ${monthName(shiftPeriod(period, -1, budget.settings).start)} pay left short` : `${cash(carry, { whole: true })} left from ${monthName(shiftPeriod(period, -1, budget.settings).start)} counted`}
            </span>
          )}
        </div>

        {why.length > 0 && (
          <div className="tip small stack gap-4">
            <b>Different this pay</b>
            {why.map((w) => <span key={w}>{w}</span>)}
          </div>
        )}

        {rows.length > 0 && (
          <div>
            <div className="between" style={{ marginBottom: 6 }}>
              <h3 className="h3">{rows.length} cost{rows.length === 1 ? '' : 's'} this pay{split ? `, per ${mode}` : ''}</h3>
              <b className="num">{cash(v(a.need))}</b>
            </div>
            <div className="cost-rows">
              {rows.map((r) => {
                const each = r.amount / r.dates.length;
                const same = r.dates.length > 1 && Number.isInteger(each);
                return (
                  <span key={`${r.aside || r.envelope}|${r.name}`} className="cost-row">
                    <span className="min0">
                      <span className="cost-name">{r.name}</span>
                      <span className="cost-meta muted">
                        {r.envelope
                          ? `${r.span === 'week' ? 'Week' : r.span === 'fortnight' ? 'Fortnight' : 'Month'} envelope${r.envelopeBudget ? ` ${cash(r.envelopeBudget)}` : ''} · resets each ${r.span ?? 'month'} · leftover is yours`
                          : r.aside
                          ? `Put aside on payday, stays in the account${r.maxSaved ? ` · max ${cash(r.maxSaved)}` : ''}`
                          : same ? `${r.dates.length} × ${cash(each, { whole: each % 100 === 0 })}` : r.dates.length === 1 ? fmtShort(r.dates[0]) : `${r.dates.length} payments`}
                        {/* Week / Fortnight: say what the whole pay is, since the amount on the right is per week */}
                        {split ? `${same ? ' =' : ' ·'} ${cash(r.amount)} this pay` : ''}
                        {r.note ? ` · ${r.note}` : ''}
                      </span>
                    </span>
                    <b className="num">{cash(v(r.amount))}{split && <small className="muted" style={{ fontWeight: 500 }}> /{mode === 'week' ? 'wk' : 'fn'}</small>}</b>
                  </span>
                );
              })}
            </div>
          </div>
        )}
        {rows.length === 0 && !isPay && !longRun && <p className="small muted">{a.account.kind === 'external' ? 'Sent on payday; no costs come out of it.' : 'No costs come out of this account this pay.'}</p>}

        {/* Quick links to where this account is set up. */}
        <div className="quick-links">
          <span className="small muted">Go to</span>
          {isDebt && <a className="btn small" href="#/debts"><Icon name="card" size={16} /> Debt and payment plans</a>}
          {isGoal && <a className="btn small" href="#/savings"><Icon name="piggy" size={16} /> Savings goal</a>}
          {(!isDebt && !isGoal || budget.items.some((i) => i.accountId === a.account.id)) && (
            <button type="button" className="btn small" onClick={() => onEdit('payday')}>
              <Icon name="edit" size={16} /> {isPay ? 'Account settings' : 'Account settings · Payday send'}
            </button>
          )}
          {!isDebt && !isGoal && !isPay && a.account.kind === 'bank' && (
            <button type="button" className="btn small" onClick={() => onEdit('balance')}>
              <Icon name="wallet" size={16} /> {budget.balances?.[a.account.id] ? 'Update balance' : 'Enter balance'}
            </button>
          )}
        </div>
      </Modal>
    )}
    </>
  );
}
