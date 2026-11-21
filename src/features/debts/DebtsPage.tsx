import { SyncPill } from '../../shared/SyncPill';
import { useEffect, useMemo, useState } from 'react';
import { DebtChart } from './DebtChart';
import { Icon } from '../../ui/Icon';
import {
  AccIcon, CardColumns, Collapse, DetailsToggle, Disclosure, MoveButtons, ReorderToggle, useFlip, FlatDetails,
} from '../../ui/components';
import { moveAmong } from '../../core/order';
import { bankSync } from '../../services/bank/bank';
import { PaydayControl } from '../../shared/PaydayControl';
import { TransactionList } from '../../shared/Transactions';
import { fmtDay, fmtShort, monthName, ordinal, todayISO, type ISODate } from '../../core/dates';
import { gemPlan } from './logic/gem';
import { debtAdvice, offRecommended as isOffRecommended, type DebtAdvice } from './logic/advice';
import { debtPay, historyOwed, owed, projectedOwed, unplanned } from './logic/amounts';
import { debtSchedules, PLAN_LABEL } from './logic/schedule';
import { upcomingPayPeriod } from '../../engine/periods';
import { planFor } from '../../engine/plan';
import { DayPicker, useDayView } from '../../shared/DayPicker';
import { cash, centsToInput, parseMoney } from '../../core/money';
import { useBudget } from '../../state/store';
import type { Cents, Debt, DebtPlan } from '../../core/types';
import { BalanceEditor, type DebtTab, DebtEditModal } from './DebtEditModal';
import { PaymentModal } from './PaymentModal';
import { PlanModal } from './PlanModal';
import { DebtModal } from './DebtModal';
import { KIND_LABEL } from './logic/labels';

function monthYear(d: ISODate) { return `${monthName(d).slice(0, 3)} ${d.slice(0, 4)}`; }

export function DebtsPage() {
  const { budget, update } = useBudget();
  const debts = useMemo(() => budget.debts ?? [], [budget.debts]);
  const today = todayISO();
  const s = budget.settings;
  // Which pay and day to look at: today in the pay you're in now, by default.
  const dv = useDayView('paydays.debts.view', { endOfPay: true });
  const period = dv.view;
  const day = dv.day;
  const plan = useMemo(() => planFor(budget, period), [budget, period]);
  /** What a debt owes at the end of the chosen day: now (today), projected (later), or from its history (earlier). */
  const owedOn = (d: Debt): Cents | undefined => day === today ? owed(d) : day > today ? projectedOwed(d, s, day, debtPay(budget, d)) : historyOwed(d, day);
  const [planModal, setPlanModal] = useState<{ debt: Debt; plan?: DebtPlan; prefill?: number } | null>(null);
  const [debtModal, setDebtModal] = useState<{ debt?: Debt } | null>(null);
  const [payModal, setPayModal] = useState<Debt | null>(null);
  const [reorder, setReorder] = useState(false);
  const order = debts.map((d) => d.id);
  const flip = useFlip(order.join());
  const move = (id: string, dir: -1 | 1) => { flip.capture(); update((b) => { moveAmong(b.debts ?? [], order, id, dir); return b; }); };
  // Every card starts closed.
  const [open, setOpen] = useState<string[]>([]);
  const toggle = (id: string) => setOpen((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));
  const [editDebt, setEditDebt] = useState<{ debt: Debt; tab?: DebtTab } | null>(null);

  // Recommended payments are for the next payday.
  // Recommendations are for the pay being viewed (or the next one to come, if that pay has already started).
  const nextPeriod = useMemo(() => (period.start > today ? period : upcomingPayPeriod(budget, today)), [budget, today, period]);
  // Payroll-deducted debts (e.g. student loan) aren't paid from the split, so they're not in the recommendations.
  const advice = useMemo(() => debts.filter((d) => !d.payroll).map((d) => debtAdvice(budget, d, nextPeriod)), [budget, debts, nextPeriod]);
  const recTotal = advice.reduce((t, a) => t + a.recommended, 0);
  const sendTotal = advice.reduce((t, a) => t + a.sending, 0);
  function applyRecommended(list: DebtAdvice[]) {
    update((b) => {
      for (const a of list) {
        const line = b.split.find((l) => l.accountId === a.debt.accountId);
        if (!line) continue;
        delete line.auto;
        if (a.apply.mode === 'exact') line.mode = 'exact';
        else { line.mode = 'fixed'; line.amount = a.apply.amount; }
      }
      return b;
    });
  }


  const totalOwed = debts.reduce((t, d) => t + owed(d), 0);
  const onDay = debts.map((d) => owedOn(d));
  const totalOnDay = onDay.every((v) => v !== undefined) ? onDay.reduce<number>((t, v) => t + (v ?? 0), 0) : undefined;
  const totalLimit = debts.reduce((t, d) => t + (d.limit ?? 0), 0);
  const cardOwed = debts.filter((d) => d.limit).reduce((t, d) => t + (owedOn(d) ?? owed(d)), 0);
  const ends = debts.flatMap((d) => debtSchedules(d, s, debtPay(budget, d))).map((x) => x.paidOffBy).filter(Boolean) as ISODate[];
  const debtFree = debts.some((d) => d.plans.some((p) => p.remaining > 0)) && ends.length ? ends.sort()[ends.length - 1] : undefined;

  const offRecommended = advice.filter(isOffRecommended);
  // Where what's owed came from: the bank connection, or the last balance you checked (a payment seen
  // leaving your bank since then keeps it current, so it shows as synced on that day).
  const sourcePill = (d: Debt) => {
    // Someone you owe, or a loan from your salary: nothing to keep up to date.
    if (d.payroll || d.kind === 'person') return null;
    const sync = bankSync(budget, `debt:${d.id}`);
    if (sync.linked) return <SyncPill source="bank" at={sync.at ?? d.balance?.asOf} />;
    // The latest of: a document or balance you gave it, or a payment seen leaving your bank.
    const seen = d.bankPayments?.[d.bankPayments.length - 1]?.date;
    const planDays = d.rules === 'afterpay' || d.kind === 'bnpl' ? d.plans.map((p) => p.asOf) : [];
    const at = [d.checkedOn, d.checked?.asOf, d.balance?.asOf, seen, ...planDays].filter(Boolean).sort().pop();
    return at ? <SyncPill source="entered" at={at} /> : <SyncPill source="none" />;
  };


  return (
    <>
      <DayPicker dv={dv} title="Debts">
        <div className="page-actions">
          {debts.length > 1 && <ReorderToggle on={reorder} onChange={setReorder} />}
          <button className="btn primary" onClick={() => setDebtModal({})}><Icon name="plus" /> Add debt</button>
        </div>
      </DayPicker>

      <section className="stats">
        <div className="stat">
          <span className="small muted">{day === today ? 'Total owed today' : `Owed on ${fmtDay(day)}`}</span>
          <b>{totalOnDay !== undefined ? cash(totalOnDay) : '—'}</b>
          {day !== today && <span className="small muted">{day > today ? `projected · ${cash(totalOwed, { whole: true })} today` : totalOnDay === undefined ? 'no record that far back' : 'from your records'}</span>}
        </div>
        <div className="stat"><span className="small muted">Credit used</span><b>{totalLimit ? `${Math.round((cardOwed / totalLimit) * 100)}%` : '—'}</b><span className="small muted">{cash(cardOwed, { whole: true })} of {cash(totalLimit, { whole: true })}</span></div>
        {advice.length > 0 && (
          <div className="stat">
            <span className="small muted">{fmtShort(nextPeriod.start)} pay sends</span>
            <b>{cash(sendTotal)}</b>
            <span className={`small ${sendTotal < recTotal ? 'neg' : 'muted'}`}>{sendTotal === recTotal ? 'as recommended' : `recommended ${cash(recTotal)}`}</span>
          </div>
        )}
        <div className="stat"><span className="small muted">Debt-free by</span><b>{debtFree ? monthYear(debtFree) : totalOwed ? '—' : 'Now'}</b></div>
      </section>

      {/* Recommended against what's being sent, worked out for each debt on its own terms. */}
      {offRecommended.length > 0 && (
        <div className="tip between">
          <span>
            <b>{offRecommended.length === 1 ? `${offRecommended[0].debt.name} isn't` : `${offRecommended.length} debts aren't`} on the recommended amount</b> for your {fmtShort(nextPeriod.start)} pay
            ({fmtShort(nextPeriod.start)} – {fmtShort(nextPeriod.end)}). Open a debt to see why.
          </span>
          <button className="btn small primary" onClick={() => applyRecommended(offRecommended)}>Use {offRecommended.length === 1 ? 'recommended' : 'all recommended'}</button>
        </div>
      )}

      {debts.length === 0 && <p className="note">No debts yet. Add a card, Afterpay, a loan or someone you owe to plan its payments.</p>}

      <CardColumns innerRef={flip.ref} className={reorder ? 'reordering' : undefined}>
      {debts.map((d, i) => {
        const acc = budget.accounts.find((a) => a.id === d.accountId) ?? (d.color ? { color: d.color } : undefined);
        const schedules = debtSchedules(d, s, debtPay(budget, d));
        const gem = d.rules === 'gem' && d.plans.length + unplanned(d) > 0 ? gemPlan(d, s, debtPay(budget, d)) : null;
        const o = owed(d);
        const oDay = owedOn(d);
        const used = d.limit ? Math.min(100, (o / d.limit) * 100) : 0;
        const funded = plan.accounts.find((a) => a.account.id === d.accountId);
        const isOpen = open.includes(d.id);
        const adv = advice.find((a) => a.debt.id === d.id);
        const diff = adv ? (adv.extra ? adv.usual : adv.sending) - adv.recommended : 0;
        const upcoming = schedules.flatMap((x) => x.payments).filter((x) => x.date > day).sort((a, b) => a.date.localeCompare(b.date));
        const nextAmt = upcoming[0] ? upcoming.filter((x) => x.date === upcoming[0].date).reduce((t, x) => t + x.amount, 0) : 0;
        const offBy = schedules.map((x) => x.paidOffBy).filter(Boolean).sort().pop();
        const perPay = adv ? adv.sending : d.payroll?.perPay;
        return (
          <section key={d.id} className="card acct" data-flip={d.id}>
            <div className="acct-head">
              <AccIcon color={acc?.color} name={d.kind === 'person' || d.payroll ? 'send' : 'card'} />
              <div className="grow min0">
                <h2 className="h2 clip">{d.name}</h2>
                <p className="small muted clip">
                  {KIND_LABEL[d.kind]}{d.rate ? ` · ${d.rate}% p.a.` : ''}
                  {d.holdAccountId ? ` · stored in ${budget.accounts.find((a) => a.id === d.holdAccountId)?.name ?? 'another account'} until the ${d.statementDay ? ordinal(d.statementDay) : 'statement'}` : ''}
                </p>
              </div>
              <div className="acct-side">
                {sourcePill(d)}
                {reorder
                  ? <MoveButtons name={d.name} first={i === 0} last={i === debts.length - 1} onMove={(dir) => move(d.id, dir)} />
                  : <button className="icon-btn mini has-tip tip-left" data-tip="Edit" aria-label={`Edit ${d.name}: balance, purchases, payments, details`} onClick={() => setEditDebt({ debt: d })}><Icon name="edit" size={14} /></button>}
              </div>
            </div>

            {(
                <div className="acct-fig">
                  <b className="fig">{cash(day === today ? o : oDay ?? o)}</b>
                  {day !== today && (
                    <span className="xs muted note-line">{oDay !== undefined ? `${day > today ? 'Projected' : 'Owed'} ${fmtShort(day)} · ${cash(o)} today` : `No record for ${fmtShort(day)} · ${cash(o)} today`}</span>
                  )}
                </div>
              )}

            <div className="trio">
              <div className="stat">
                <span className="small muted">Next payment</span>
                <b>{upcoming[0] ? cash(nextAmt) : '—'}</b>
                <span className="xs muted">{upcoming[0] ? fmtShort(upcoming[0].date) : 'none planned'}</span>
              </div>
              <div className="stat">
                <span className="small muted">Each pay</span>
                <b>{perPay !== undefined ? cash(perPay) : '—'}</b>
                <span className={`xs ${diff < 0 && !adv?.extra ? 'neg' : 'muted'}`}>{d.payroll ? 'from your salary' : !adv ? '' : adv.extra ? `incl. ${cash(adv.extra)} extra this pay` : diff === 0 ? 'as recommended' : diff < 0 ? `${cash(-diff)} under` : `${cash(diff)} over`}</span>
              </div>
              {d.limit ? (
                <div className="stat">
                  <span className="small muted">Available</span>
                  <b className={d.limit - o < 0 ? 'neg' : ''}>{cash(d.limit - o, { whole: true })}</b>
                  <span className="xs muted">of {cash(d.limit, { whole: true })}</span>
                </div>
              ) : (
                <div className="stat">
                  <span className="small muted">Paid off</span>
                  <b>{o === 0 ? 'Done' : offBy ? monthYear(offBy) : '—'}</b>
                  <span className="xs muted">{o === 0 ? 'nothing owed' : offBy ? 'at this rate' : 'no end date'}</span>
                </div>
              )}
            </div>

            <Collapse open={isOpen} stacked><FlatDetails.Provider value>
            <div className="acct-body sections">
            {d.payroll && <p className="small muted">Taken from your salary: about {cash(d.payroll.perPay)} each payday, before pay reaches you. Not part of the payday split.</p>}
            {adv && (
              <div className="stack gap-8">
                <AllocationRow advice={adv} onApply={() => applyRecommended([adv])} />
                <p className="small muted"><b>Why {cash(adv.recommended)}</b> for the {fmtShort(nextPeriod.start)} pay: {adv.reason}</p>
              </div>
            )}

            <BalanceEditor debt={d} used={used} onAddPlan={() => setPlanModal({ debt: d, prefill: unplanned(d) })} />

            {gem && (
              <div className="tip stack gap-8">
                <div className="row top gap-8">
                  <Icon name="bulb" />
                  <span>
                    <b>{cash(gem.recommended)}</b> a pay clears interest-free purchases before they end.
                    Gem’s own minimum is only {cash(gem.minimum)}
                    {gem.instalmentsDue > 0 ? ` (including ${cash(gem.instalmentsDue)} for equal-payment plans)` : ''}.
                    Gem applies each payment itself — you can’t pick which plan it goes to.
                  </span>
                </div>
                <div className="trio">
                  <div className="stat" style={{ background: 'var(--card)' }}><span className="small muted">No interest</span><b>{cash(gem.recommended)}</b><span className="xs muted">a pay</span></div>
                  <div className="stat" style={{ background: 'var(--card)' }}><span className="small muted">Minimum</span><b>{cash(gem.minimum)}</b><span className="xs muted">this month</span></div>
                  <div className="stat" style={{ background: 'var(--card)' }}><span className="small muted">You pay</span><b className={gem.perPay < gem.recommended ? 'neg' : ''}>{cash(gem.perPay)}</b><span className="xs muted">a pay</span></div>
                </div>
                {gem.perPay < gem.recommended && (
                  <span className="small error">At {cash(gem.perPay)} a pay, some interest-free plans won’t clear in time.</span>
                )}
              </div>
            )}

            {d.plans.length === 0 && <p className="small muted">No payment plans yet. Add purchases to schedule payments.</p>}
            {schedules.filter((sch) => !sch.synthetic)
              .sort((a, b) => (d.rules === 'gem' ? (a.deadline ?? '').localeCompare(b.deadline ?? '') : 0))
              .map((sch) => {
              const p = sch.plan;
              const next = sch.payments.find((x) => x.date >= period.start);
              const done = p.original > 0 ? Math.max(0, Math.min(100, ((p.original - p.remaining) / p.original) * 100)) : 0;
              return (
                <button key={p.id} className="plan-row" onClick={() => setPlanModal({ debt: d, plan: p })}>
                  <div className="between nowrap">
                    <b className="min0">{p.name}</b>
                    <b className="num">{cash(p.remaining)}</b>
                  </div>
                  <span className="small muted">
                    {PLAN_LABEL[p.type]}{p.months && p.type !== 'afterpay' && p.type !== 'balance' ? ` · ${p.months} months` : ''}
                    {' · '}bought {fmtShort(p.purchaseDate)} for {cash(p.original)}
                  </span>
                  <div className="bar" style={{ marginTop: 2 }} role="img" aria-label={`${Math.round(done)}% paid off`}><div style={{ width: `${done}%` }} /></div>
                  <span className="small">
                    {p.remaining <= 0 ? 'Paid off'
                      : [
                        next ? `Next ${cash(next.amount)} on ${fmtShort(next.date)}${p.instalments?.find((i) => i.date === next.date)?.label ? ` (${p.instalments.find((i) => i.date === next.date)!.label})` : ''}` : null,
                        p.instalments?.length ? `${p.instalments.length} left` : null,
                        sch.paidOffBy ? `paid off by ${fmtShort(sch.paidOffBy)} ${sch.paidOffBy.slice(0, 4)}` : null,
                        sch.deadline && p.type !== 'afterpay' ? `interest-free until ${fmtShort(sch.deadline)} ${sch.deadline.slice(0, 4)}` : null,
                        sch.interest ? `${cash(sch.interest)} interest` : null,
                      ].filter(Boolean).join(' · ')}
                  </span>
                  {sch.warning && <span className="small error">{sch.warning}</span>}
                </button>
              );
            })}

            {(d.bankPayments?.length ?? 0) > 0 && <BankPayments debt={d} />}
            <TransactionList items={d.transactions ?? []} card />

            {!d.payroll && <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              {d.holdAccountId && d.statementDay && (
                <p className="small muted" style={{ marginBottom: 8 }}>
                  Payday shows {cash(funded?.funded ?? 0)} for {d.name}; it’s stored in <b>{budget.accounts.find((a) => a.id === d.holdAccountId)?.name ?? 'another account'}</b> until the {ordinal(d.statementDay)}. Change that under Edit → details.
                </p>
              )}
              <PaydayControl accountId={d.accountId} sends={funded?.funded ?? 0} needs={funded?.need ?? 0}
                autoLabel="Pay exactly what's due each payday"
                autoHint="Adds up this pay's plan payments and Afterpay instalments." />
              {funded && funded.diff !== null && funded.diff < 0 && (
                <p className="small error" style={{ marginTop: 6 }}>This pay's plans need {cash(funded.need)}, so sending {cash(funded.funded)} is {cash(-funded.diff)} short.</p>
              )}
            </div>}
            </div>
            </FlatDetails.Provider></Collapse>
            <DetailsToggle open={isOpen} onChange={() => toggle(d.id)} />
          </section>
        );
      })}
      </CardColumns>

      {debts.length > 0 && <DebtChart budget={budget} />}

      {editDebt && (() => { const live = debts.find((x) => x.id === editDebt.debt.id); return live ? <DebtEditModal debt={live} tab={editDebt.tab} onClose={() => setEditDebt(null)} onDelete={(dd) => {
        update((b) => {
          b.debts = (b.debts ?? []).filter((x) => x.id !== dd.id);
          const a = b.accounts.find((x) => x.id === dd.accountId);
          if (a) a.archived = true;
          return b;
        });
        setEditDebt(null);
      }} /> : null; })()}
      {payModal && <PaymentModal debt={payModal} onClose={() => setPayModal(null)} />}
      {planModal && <PlanModal debt={planModal.debt} plan={planModal.plan} prefill={planModal.prefill} onClose={() => setPlanModal(null)} />}
      {debtModal && <DebtModal debt={debtModal.debt} onClose={() => setDebtModal(null)} onDelete={(d) => {
        update((b) => {
          b.debts = (b.debts ?? []).filter((x) => x.id !== d.id);
          const a = b.accounts.find((x) => x.id === d.accountId);
          if (a) a.archived = true;
          return b;
        });
        setDebtModal(null);
      }} />}
    </>
  );
}

/** Recommended vs allocated for a debt, editable in place, with a one-tap Apply. */
function AllocationRow({ advice: a, onApply }: { advice: DebtAdvice; onApply: () => void }) {
  const { update } = useBudget();
  // The steady amount each pay; extra for this pay only is shown beside it.
  const each = a.extra ? a.usual : a.sending;
  const [text, setText] = useState(centsToInput(each));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(centsToInput(each)); }, [each, focused]);
  const diff = each - a.recommended;

  function commit() {
    setFocused(false);
    const c = parseMoney(text);
    if (c === null || c < 0) { setText(centsToInput(each)); return; }
    if (c === each) return;
    // Typing an amount sets a fixed payday amount for this debt.
    update((b) => {
      const line = b.split.find((l) => l.accountId === a.debt.accountId);
      if (line) { line.mode = 'fixed'; line.amount = c; delete line.auto; }
      else b.split.push({ accountId: a.debt.accountId, amount: c, mode: 'fixed' });
      return b;
    });
  }

  return (
    <div className="row wrap bottom gap-8">
      <div className="stat tight" style={{ minWidth: 120 }}>
        <span className="small muted">Recommended</span>
        <b>{cash(a.recommended)}</b>
      </div>
      <label className="field" style={{ width: 150 }}>
        <span>Sent each pay</span>
        <input inputMode="decimal" value={text} aria-label={`${a.debt.name} amount each pay`}
          onFocus={() => setFocused(true)} onChange={(e) => setText(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          style={{ fontWeight: 600 }} />
      </label>
      {diff !== 0 && (
        <>
          <span className={`small ${diff < 0 ? 'neg' : 'muted'}`} style={{ paddingBottom: 12 }}>
            {diff < 0 ? `${cash(-diff)} under` : `${cash(diff)} over`}
          </span>
          <button className="btn primary" onClick={onApply}>Use {cash(a.recommended)}</button>
        </>
      )}
      {diff === 0 && <span className="small muted" style={{ paddingBottom: 12 }}>As recommended</span>}
      {a.extra ? <span className="small muted" style={{ paddingBottom: 12, flexBasis: '100%' }}>Plus {cash(a.extra)} extra this pay only, so {cash(a.sending)} goes to {a.debt.name}. It comes off what's owed in the forecast.</span> : null}
    </div>
  );
}

/** Payments to a card seen leaving your bank accounts (it can't be linked itself, e.g. Gem Visa). */
function BankPayments({ debt: d }: { debt: Debt }) {
  const { budget } = useBudget();
  const list = (d.bankPayments ?? []).slice().reverse();
  const name = (id: string) => budget.accounts.find((a) => a.id === id)?.name ?? 'your bank';
  return (
    <Disclosure title="Paid from your bank" meta={`${list.length} · latest ${fmtShort(list[0].date)}`}>
      <div>
        {list.slice(0, 12).map((p, i) => (
          <div key={`${p.date}-${i}`} className="list-row small">
            <span style={{ flex: '0 0 56px' }} className="muted">{fmtShort(p.date)}</span>
            <span className="grow min0">From {name(p.from)}
              <span className="xs muted block">{p.counted === p.amount ? 'Taken off what’s owed' : p.counted > 0 ? `${cash(p.amount - p.counted)} was a planned payment; ${cash(p.counted)} extra taken off` : 'Already counted: a planned payment, or in a balance checked since'}</span>
            </span>
            <b className="num">{cash(p.amount)}</b>
          </div>
        ))}
      </div>
    </Disclosure>
  );
}
