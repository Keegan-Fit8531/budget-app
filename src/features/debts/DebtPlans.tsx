import { fmtShort, todayISO } from '../../core/dates';
import { cash } from '../../core/money';
import type { Debt, DebtPlan } from '../../core/types';
import type { Period } from '../../engine/periods';
import { Disclosure } from '../../ui/components';
import { planAt, planProgress } from './logic/activity';
import { PLAN_LABEL, type PlanSchedule } from './logic/schedule';

/** A debt card's payment plans: all of them paid against their total, then each plan's progress, months left and next payment. */
export function DebtPlans({ debt: d, schedules, period, onEdit }: { debt: Debt; schedules: PlanSchedule[]; period: Period; onEdit: (p: DebtPlan) => void }) {
  const today = todayISO();
  // Looking at a later pay: each plan as it will be then, after the payments before it.
  const at = period.start > today ? period.start : today;
  const shown = schedules.filter((sch) => !sch.synthetic)
    .map((sch) => ({ ...sch, plan: planAt(sch.plan, sch.payments, at, today) }))
    .sort((a, b) => (d.rules === 'gem' ? (a.deadline ?? '').localeCompare(b.deadline ?? '') : 0));
  if (!shown.length) return <p className="small muted">No payment plans yet. Add purchases to schedule payments.</p>;
  const total = shown.reduce((t, x) => t + x.plan.original, 0);
  const paid = shown.reduce((t, x) => t + Math.max(0, x.plan.original - x.plan.remaining), 0);
  return (
    <Disclosure title="Payment plans" meta={`${cash(paid, { whole: true })} of ${cash(total, { whole: true })} paid`}>
      <div className="stack gap-8">
        {shown.map((sch) => {
          const p = sch.plan;
          const next = sch.payments.find((x) => x.date >= period.start);
          const prog = planProgress(p, at, sch.deadline);
          const done = p.original > 0 ? Math.max(0, Math.min(100, (prog.paid / p.original) * 100)) : 0;
          const label = next && p.instalments?.find((i) => i.date === next.date)?.label;
          return (
            <button key={p.id} className="plan-row" onClick={() => onEdit(p)}>
              <div className="between nowrap">
                <b className="min0">{p.name}</b>
                <b className="num">{cash(p.remaining)}</b>
              </div>
              <span className="small muted">{PLAN_LABEL[p.type]} · bought {fmtShort(p.purchaseDate)} {p.purchaseDate.slice(0, 4)}</span>
              <div className="bar" style={{ marginTop: 2 }} role="img" aria-label={`${Math.round(done)}% paid off`}><div style={{ width: `${done}%` }} /></div>
              <span className="small">
                {cash(prog.paid)} of {cash(prog.total)} paid
                {prog.months ? ` · ${prog.monthsLeft} of ${prog.months} months left` : ''}
                {p.instalments?.length ? ` · ${p.instalments.length} left` : ''}
              </span>
              {p.remaining > 0 && (
                <span className="small muted">
                  {[
                    next ? `Next ${cash(next.amount)} on ${fmtShort(next.date)}${label ? ` (${label})` : ''}` : null,
                    sch.paidOffBy ? `paid off by ${fmtShort(sch.paidOffBy)} ${sch.paidOffBy.slice(0, 4)}` : null,
                    sch.deadline && p.type !== 'afterpay' ? `interest-free until ${fmtShort(sch.deadline)} ${sch.deadline.slice(0, 4)}` : null,
                    sch.interest ? `${cash(sch.interest)} interest` : null,
                  ].filter(Boolean).join(' · ')}
                </span>
              )}
              {sch.warning && <span className="small error">{sch.warning}</span>}
            </button>
          );
        })}
      </div>
    </Disclosure>
  );
}
