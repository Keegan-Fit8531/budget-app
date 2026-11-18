import { SyncPill } from '../components/SyncPill';
import { useEffect, useMemo, useState } from 'react';
import { DebtChart } from '../components/DebtChart';
import { Icon } from '../components/Icon';
import { AccIcon, CardColumns, Modal, Collapse, DetailsToggle, Disclosure, MoveButtons, ReorderToggle, useFlip, FlatDetails } from '../components/ui';
import { moveAmong } from '../lib/order';
import { bankSync } from '../lib/bank';
import { PaydayControl } from '../components/PaydayControl';
import { TransactionList } from '../components/Transactions';
import { nextColor } from '../lib/colors';
import { addDays, fmtDay, fmtShort, monthName, ordinal, todayISO, type ISODate } from '../lib/dates';
import { applyPayment, beforeStatement, debtAdvice, debtPay, debtPerPay, debtSchedules, exactForFirstPlan, GEM_PLAN_MONTHS, gemPlan, gemPlanEnds, gemPlanType, historyOwed, offRecommended as isOffRecommended, owed, type DebtAdvice, PLAN_LABEL, plannedOwed, planSchedule, projectedOwed, recordHistory, suggestPlan, unplanned } from '../lib/debts';
import { periodContaining, planFor, upcomingPayPeriod } from '../lib/engine';
import { DayPicker, useDayView } from '../components/DayPicker';
import { cash, centsToInput, parseMoney } from '../lib/money';
import { newId, useBudget } from '../lib/store';
import type { Cents, Debt, DebtPlan, PlanType } from '../lib/types';

const KIND_LABEL: Record<Debt['kind'], string> = { card: 'Credit card', bnpl: 'Buy now, pay later', person: 'Person', loan: 'Loan' };

function monthYear(d: ISODate) { return `${monthName(d).slice(0, 3)} ${d.slice(0, 4)}`; }

export function Debts() {
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
                    Gem splits each payment itself:{' '}
                    {gem.instalmentsDue > 0 && <><b>equal-payment plans' monthly amounts first</b> ({cash(gem.instalmentsDue)}), then </>}
                    other purchases{unplanned(d) > 0 ? ` (${cash(unplanned(d))})` : ''}, then <b>interest-free plans in order of expiry date</b>, soonest first.
                    You can't choose which plan a payment goes to.
                  </span>
                </div>
                <div className="trio">
                  <div className="stat" style={{ background: 'var(--card)' }}><span className="small muted">No interest</span><b>{cash(gem.recommended)}</b><span className="xs muted">a pay</span></div>
                  <div className="stat" style={{ background: 'var(--card)' }}><span className="small muted">Minimum</span><b>{cash(gem.minimum)}</b><span className="xs muted">this month</span></div>
                  <div className="stat" style={{ background: 'var(--card)' }}><span className="small muted">You pay</span><b className={gem.perPay < gem.recommended ? 'neg' : ''}>{cash(gem.perPay)}</b><span className="xs muted">a pay</span></div>
                </div>
                {gem.perPay < gem.recommended && (
                  <span className="small error">At {cash(gem.perPay)} a pay, some interest-free plans won't be cleared in time. See the warnings below.</span>
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

function PlanModal({ debt, plan, prefill, onClose, embedded }: { debt: Debt; plan?: DebtPlan; prefill?: number; onClose: () => void; embedded?: boolean }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const [name, setName] = useState(plan?.name ?? (prefill ? 'Existing balance' : ''));
  const [amount, setAmount] = useState(plan ? centsToInput(plan.original) : prefill ? centsToInput(prefill) : '');
  const [date, setDate] = useState(plan?.purchaseDate ?? today);
  const initial = plan ? { type: plan.type, months: plan.months } : prefill ? { type: 'balance' as PlanType, months: undefined } : suggestPlan(debt, 0);
  const [type, setType] = useState<PlanType>(initial.type);
  const [months, setMonths] = useState(String(initial.months ?? 6));
  const [typeTouched, setTypeTouched] = useState(!!plan || !!prefill);
  const [remaining, setRemaining] = useState(plan ? centsToInput(plan.remaining) : '');
  const [payment, setPayment] = useState(plan?.payment ? centsToInput(plan.payment) : '');
  const [ends, setEnds] = useState(plan?.ends ?? '');
  const [err, setErr] = useState('');
  const isPerson = debt.kind === 'person' || debt.kind === 'loan';

  const orig = parseMoney(amount);
  const rem = remaining.trim() === '' ? orig : parseMoney(remaining);

  function onAmount(v: string) {
    setAmount(v); setErr('');
    const c = parseMoney(v);
    if (!typeTouched && c !== null) {
      const sug = suggestPlan(debt, c);
      setType(sug.type);
      if (sug.months) setMonths(String(sug.months));
    }
  }
  function onMonths(v: string) {
    setMonths(v);
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return;
    if (debt.rules === 'gem') {
      setType(gemPlanType(n));
      setTypeTouched(true);
      // Gem months end on the 20th: treat the chosen length as months still left from today.
      setEnds(gemPlanEnds(today, n));
    }
  }

  const draft: DebtPlan | null = orig !== null && orig > 0 && rem !== null ? {
    id: plan?.id ?? 'draft', name: name || 'Purchase', type, original: orig, remaining: rem,
    asOf: remaining.trim() === '' && !plan ? date : today, purchaseDate: date,
    months: type === 'interest-free' || type === 'equal' ? Number(months) : undefined,
    payment: type === 'balance' ? (parseMoney(payment) ?? undefined) : undefined,
    ends: (type === 'interest-free' || type === 'equal') && ends ? ends : undefined,
    instalments: plan?.instalments && remaining.trim() === centsToInput(plan.remaining) ? plan.instalments : undefined,
  } : null;
  const preview = draft ? planSchedule(debt, draft, budget.settings) : null;

  function save() {
    if (!name.trim()) return setErr(isPerson ? 'Enter what it’s for.' : 'Enter what you bought.');
    if (!draft) return setErr('Enter an amount above $0.');
    if (draft.remaining < 0 || draft.remaining > draft.original * 1.5) return setErr('Check the amount still owed.');
    if (type === 'balance' && !(draft.payment && draft.payment > 0)) return setErr('Enter how much to pay each pay.');
    const next = { ...plan, ...draft, id: plan?.id ?? newId(), name: name.trim() }; // keep anything this form doesn't edit
    update((b) => {
      const d = (b.debts ?? []).find((x) => x.id === debt.id);
      if (!d) return b;
      const i = d.plans.findIndex((x) => x.id === next.id);
      if (i >= 0) d.plans[i] = next; else d.plans.push(next);
      // The first plan switches the payday amount to "pay exactly what's due".
      if (!plan) exactForFirstPlan(b, d);
      recordHistory(d, todayISO());
      return b;
    });
    onClose();
  }
  function remove() {
    update((b) => {
      const d = (b.debts ?? []).find((x) => x.id === debt.id);
      if (d) { d.plans = d.plans.filter((x) => x.id !== plan?.id); recordHistory(d, todayISO()); }
      return b;
    });
    onClose();
  }

  const nextPay = preview?.payments.find((p) => p.date >= periodContaining(today, budget.settings).start);

  return (
    <div className={`modal-back${embedded ? ' inline' : ''}`} onClick={embedded ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="plan-title" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2 id="plan-title" className="h2">{plan ? `Edit ${plan.name}` : `${debt.name}: ${isPerson ? 'add amount owed' : 'add purchase'}`}</h2>
          <button className="icon-btn plain" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <label className="field">{isPerson ? 'What it’s for' : 'What you bought'}
          <input autoFocus={!plan} value={name} onChange={(e) => { setName(e.target.value); setErr(''); }} placeholder={isPerson ? 'Scooter' : 'Couch'} />
        </label>
        <div className="form-grid">
          <label className="field">{isPerson ? 'Amount borrowed' : 'Purchase amount'}
            <input inputMode="decimal" value={amount} onChange={(e) => onAmount(e.target.value)} placeholder="1,200.00" />
          </label>
          <label className="field">{isPerson ? 'Date' : 'Purchase date'}
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <div className="form-grid">
          <label className="field wide">Plan
            <select value={type} onChange={(e) => { setType(e.target.value as PlanType); setTypeTouched(true); }}>
              {(['interest-free', 'equal', 'afterpay', 'balance'] as PlanType[]).map((t) => <option key={t} value={t}>{PLAN_LABEL[t]}</option>)}
            </select>
          </label>
          {(type === 'interest-free' || type === 'equal') && (
            <label className="field">Months
              <select value={months} onChange={(e) => onMonths(e.target.value)}>
                {(debt.rules === 'gem' ? [...GEM_PLAN_MONTHS] : [3, 6, 12, 18, 24, 36, 48, 60]).map((m) => (
                  <option key={m} value={m}>{m} months{debt.rules === 'gem' ? (m <= 6 ? ' · interest-free' : ' · equal payments') : ''}</option>
                ))}
              </select>
            </label>
          )}
          {(type === 'interest-free' || type === 'equal') && (
            <label className="field">{debt.rules === 'gem' ? 'Ends (Gem cycle on the 20th)' : 'Interest-free ends (optional)'}
              <input type="date" value={ends} onChange={(e) => setEnds(e.target.value)} />
            </label>
          )}
          {type === 'balance' && (
            <label className="field">Pay each payday
              <input inputMode="decimal" value={payment} onChange={(e) => setPayment(e.target.value)} placeholder="200.00" />
            </label>
          )}
        </div>
        <label className="field">Still owed today {plan ? '' : '(leave blank if nothing paid yet)'}
          <input inputMode="decimal" value={remaining} onChange={(e) => setRemaining(e.target.value)} placeholder={amount || '0.00'} />
        </label>
        {debt.rules === 'gem' && <p className="small muted">Gem: $250+ purchases are 6 months interest-free. Deals can be 12, 24, 36 or 60 months with equal payments. Pick the length to match the Gem app; the end date follows Gem’s month reset on the 20th.</p>}
        {debt.rules === 'mastercard' && <p className="small muted">Mastercard: every purchase is 3 months interest-free.</p>}

        {preview && (
          <div className="tip">
            <Icon name="bulb" />
            <span>
              {preview.payments.length === 0 && !preview.warning ? 'Nothing left to pay.' : null}
              {preview.payments.length > 0 && `${preview.payments.length} payment${preview.payments.length === 1 ? '' : 's'}`}
              {nextPay ? `, next ${cash(nextPay.amount)} on ${fmtShort(nextPay.date)}` : ''}
              {preview.paidOffBy ? `. Paid off by ${fmtShort(preview.paidOffBy)} ${preview.paidOffBy.slice(0, 4)}` : ''}
              {preview.deadline && type !== 'afterpay' ? `, before interest-free ends ${fmtShort(preview.deadline)} ${preview.deadline.slice(0, 4)}` : ''}
              {preview.interest ? `. About ${cash(preview.interest)} interest` : ''}
              {preview.payments.length > 0 ? '.' : ''}
              {preview.warning && <span className="error block">{preview.warning}</span>}
            </span>
          </div>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="between">
          {plan ? <button className="btn ghost danger" onClick={remove}>Delete</button> : <span />}
          <div className="row">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save}>{plan ? 'Save' : 'Add'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

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

/** Outstanding balance and available credit, editable either way round. */
function BalanceEditor({ debt: d, used, onAddPlan, editing: startEditing, onDone }: { debt: Debt; used: number; onAddPlan: () => void; editing?: boolean; onDone?: () => void }) {
  const { budget, update } = useBudget();
  // Money owed outside a plan still gets paid from the payday amount; it's only unscheduled when that's $0.
  const unscheduled = debtPerPay(budget, d) === 0;
  const today = todayISO();
  const o = owed(d);
  const planned = plannedOwed(d);
  const extra = unplanned(d);
  const [editingState, setEditingState] = useState(!!startEditing);
  const editing = editingState;
  const setEditing = (v: boolean) => { setEditingState(v); if (!v) onDone?.(); };
  const [owedText, setOwedText] = useState(centsToInput(o));
  const [availText, setAvailText] = useState(d.limit ? centsToInput(d.limit - o) : '');
  const [err, setErr] = useState('');

  // Typing one fills in the other (owed + available = limit).
  function onOwed(v: string) {
    setOwedText(v); setErr('');
    const c = parseMoney(v);
    if (d.limit && c !== null) setAvailText(centsToInput(d.limit - c));
  }
  function onAvail(v: string) {
    setAvailText(v); setErr('');
    const c = parseMoney(v);
    if (d.limit && c !== null) setOwedText(centsToInput(d.limit - c));
  }
  function save() {
    const c = parseMoney(owedText);
    if (c === null || c < 0) return setErr('Enter what you owe, like 1,240.50');
    if (d.limit && c > d.limit * 1.2) return setErr('That\u2019s well over the credit limit. Check the amount, or update the limit with Edit.');
    update((b) => {
      const x = (b.debts ?? []).find((y) => y.id === d.id);
      if (x) { x.balance = { amount: c, asOf: today }; x.checked = { ...x.balance }; recordHistory(x, today); }
      return b;
    });
    setEditing(false);
  }
  function clear() {
    update((b) => { const x = (b.debts ?? []).find((y) => y.id === d.id); if (x) { delete x.balance; recordHistory(x, today); } return b; });
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="stack gap-8">
        <div className="form-grid">
          <label className="field">Owed now
            <input inputMode="decimal" autoFocus value={owedText} onChange={(e) => onOwed(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
          </label>
          {d.limit ? (
            <label className="field">Available credit
              <input inputMode="decimal" value={availText} onChange={(e) => onAvail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
            </label>
          ) : null}
        </div>
        {d.limit ? <p className="small muted">Enter either one; the other fills in from your {cash(d.limit, { whole: true })} limit.</p> : null}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row wrap">
          <button className="btn primary small" onClick={save}>Save balance</button>
          <button className="btn small" onClick={() => setEditing(false)}>Cancel</button>
          {d.balance && <button className="btn small ghost" onClick={clear}>Use plan totals instead</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="stack gap-6">
      {d.limit ? <div className="bar" style={{ marginTop: 0 }} role="img" aria-label={`${Math.round(used)}% of the limit used`}><div style={{ width: `${used}%`, background: used > 80 ? 'var(--bad)' : undefined }} /></div> : null}
      <p className="small muted">
        {d.balance ? `Balance checked ${fmtShort(d.balance.asOf)}${d.balance.asOf.slice(0, 4) !== today.slice(0, 4) ? ` ${d.balance.asOf.slice(0, 4)}` : ''}` : 'Owed is from the plans below'}{d.limit ? ` · ${Math.round(used)}% of the limit used` : ''}
      </p>
      {d.balance && extra > 0 && d.rules !== 'gem' && unscheduled && (
        <div className="tip">
          <Icon name="bulb" />
          <div className="stack gap-8">
            <span>{cash(extra)} of this isn't in a payment plan{planned ? ` (plans cover ${cash(planned)})` : ''}, so no payments are scheduled for it.</span>
            <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={onAddPlan}>Add it as a plan</button>
          </div>
        </div>
      )}
      {d.balance && planned > o && (
        <p className="small error">Your plans add up to {cash(planned)}, more than the {cash(o)} balance. Update the plans' amounts still owed.</p>
      )}
    </div>
  );
}

/** Record money paid to a debt; it pays off whatever is due soonest first. */
export function PaymentModal({ debt, onClose, pick, embedded }: { debt: Debt; onClose: () => void; /** A "which debt" chooser, when opened from the Add button. */ pick?: React.ReactNode; embedded?: boolean }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const s = budget.settings;
  const [text, setText] = useState('');
  // Cards with a statement day: suggest paying on it (this month's, if it hasn't passed).
  const stmtDate = debt.statementDay ? (() => {
    const d = `${today.slice(0, 8)}${String(debt.statementDay).padStart(2, '0')}`;
    return d >= today ? d : today;
  })() : today;
  const [date, setDate] = useState(stmtDate);
  const [err, setErr] = useState('');
  const amount = parseMoney(text);

  const due = debtSchedules(debt, s, debtPay(budget, debt)).flatMap((x) => x.payments).sort((a, b) => a.date.localeCompare(b.date));
  const total = owed(debt);
  const nextDate = due[0]?.date;
  const nextTotal = due.filter((p) => p.date === nextDate).reduce((t, p) => t + p.amount, 0);
  const within = (days: number) => due.filter((p) => p.date <= addDays(today, days)).reduce((t, p) => t + p.amount, 0);
  const quick = [
    nextDate ? { label: `Next due (${fmtShort(nextDate)})`, amount: nextTotal } : null,
    { label: 'Due in 15 days', amount: within(15) },
    { label: 'Due in 30 days', amount: within(30) },
    { label: 'All of it', amount: total },
  ].filter((q, i, arr): q is { label: string; amount: number } => !!q && q.amount > 0 && arr.findIndex((x) => x?.amount === q.amount) === i);

  const preview = amount !== null && amount > 0 ? applyPayment(structuredClone(debt), amount, s, date) : null;

  function save() {
    if (amount === null || amount <= 0) return setErr('Enter how much you paid.');
    if (amount > total + 100) return setErr(`That's more than the ${cash(total)} owed.`);
    update((b) => {
      const d = (b.debts ?? []).find((x) => x.id === debt.id);
      if (d) applyPayment(d, amount, b.settings, date);
      return b;
    });
    onClose();
  }

  return (
    <div className={`modal-back${embedded ? ' inline' : ''}`} onClick={embedded ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pay-title" onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <h2 id="pay-title" className="h2">{debt.name}: record a payment</h2>
          <button className="icon-btn plain" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        {pick}
        <p className="small muted">Pays off what's due soonest first, then the next due date, and so on. {cash(total)} owed.</p>
        <div className="row wrap gap-8">
          {quick.map((q) => (
            <button key={q.label} className="btn small" onClick={() => { setText(centsToInput(q.amount)); setErr(''); }}>
              {q.label}: {cash(q.amount)}
            </button>
          ))}
        </div>
        <div className="form-grid">
          <label className="field">Amount paid
            <input inputMode="decimal" autoFocus value={text} placeholder="0.00" onChange={(e) => { setText(e.target.value); setErr(''); }} onKeyDown={(e) => e.key === 'Enter' && save()} />
          </label>
          <label className="field">Date paid
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        {beforeStatement(debt, date) && (
          <div className="alert small" role="status">
            <Icon name="alert" />
            <span>That's before the statement on the {ordinal(debt.statementDay!)}, so it all goes on the oldest plan instead of being split, and the statement will still ask for this month's payment. Pay on or after the {ordinal(debt.statementDay!)}.</span>
          </div>
        )}
        {preview && (
          <div className="tip stack gap-6">
            <b>This pays off</b>
            {preview.applied.map((a, i) => (
              <div key={i} className="between small nowrap">
                <span>{a.planName} <span className="muted">· due {fmtShort(a.date)}{a.cleared ? '' : ' (part)'}</span></span>
                <b>{cash(a.amount)}</b>
              </div>
            ))}
            {preview.leftover > 0 && <span className="small">{cash(preview.leftover)} more than is scheduled — it comes off the balance.</span>}
            <span className="small muted">Left owing afterwards: {cash(Math.max(0, total - (amount ?? 0)))}</span>
          </div>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Record payment</button>
        </div>
      </div>
    </div>
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

type DebtTab = 'balance' | 'purchase' | 'payment' | 'details';

/** Everything you change on a debt, in one pop-up with a tab for each. */
function DebtEditModal({ debt: d, tab: first = 'balance', onClose, onDelete }: { debt: Debt; tab?: DebtTab; onClose: () => void; onDelete: (d: Debt) => void }) {
  const [tab, setTab] = useState<DebtTab>(first);
  const isPerson = d.kind === 'person' || d.kind === 'loan';
  const used = d.limit ? Math.min(100, (owed(d) / d.limit) * 100) : 0;
  const tabs: { id: DebtTab; label: string }[] = [
    { id: 'balance', label: 'Balance' },
    ...(!d.payroll ? [{ id: 'purchase' as const, label: isPerson ? 'Add owed' : 'Purchase' }] : []),
    ...(!d.payroll && owed(d) > 0 ? [{ id: 'payment' as const, label: 'Payment' }] : []),
    { id: 'details', label: 'Details' },
  ];
  return (
    <Modal title={d.name} width={560} className="pinned" onClose={onClose}>
      {(close) => (
        <>
          <div className="modal-tabs">
            <div className="seg fill" role="tablist" aria-label={`${d.name}: what to change`}>
              {tabs.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
            </div>
          </div>
          <div role="tabpanel" className="stack gap-16">
            {tab === 'balance' && <BalanceEditor debt={d} used={used} editing onDone={close} onAddPlan={() => setTab('purchase')} />}
            {tab === 'purchase' && <PlanModal debt={d} embedded onClose={close} />}
            {tab === 'payment' && <PaymentModal debt={d} embedded onClose={close} />}
            {tab === 'details' && <DebtModal debt={d} embedded onClose={close} onDelete={onDelete} />}
          </div>
        </>
      )}
    </Modal>
  );
}
