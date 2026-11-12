import { Donut, Legend } from '../components/Donut';
import { Icon } from '../components/Icon';
import { convert, planFor, plannedAverage, type View } from '../lib/engine';
import { PayNav, useViewPeriod, ViewModes } from '../lib/period';
import { money } from '../lib/money';
import { useBudget } from '../lib/store';
import type { RuleBucket } from '../lib/types';

const BUCKETS: { k: RuleBucket; label: string; color: string }[] = [
  { k: 'needs', label: 'Needs', color: '#14A38B' },
  { k: 'wants', label: 'Wants', color: '#E8B23A' },
  { k: 'savings', label: 'Savings and debt', color: '#E0527F' },
];

export function Insights() {
  const { budget } = useBudget();
  const { settings, accounts, groups } = budget;
  // Same views as the Planner: this pay, this pay per week / fortnight, or the next 12 pays averaged
  // per month / added up for the year.
  const { period, mode } = useViewPeriod();
  const plan = planFor(budget, period);
  const perPeriod = mode === 'period' || mode === 'week' || mode === 'fortnight';
  const scale = (c: number) => (mode === 'week' ? Math.round((c * 7) / period.days) : mode === 'fortnight' ? Math.round((c * 14) / period.days)
    : mode === 'period' ? c : convert(c, 'monthly', mode as View));
  const pay = scale(plan.pay);
  const live = accounts.filter((a) => !a.archived);
  const sent = new Map(live.filter((a) => a.id !== settings.payAccountId).map((a) => [a.id,
    scale(perPeriod ? plan.accounts.find((x) => x.account.id === a.id)?.funded ?? 0 : plannedAverage(budget, a.id).sent)]));
  const leftover = pay - [...sent.values()].reduce((t, x) => t + x, 0);
  const per = mode === 'period' ? 'this pay' : mode === 'week' ? 'a week' : mode === 'fortnight' ? 'a fortnight' : mode === 'month' ? 'a month' : 'a year';
  const perAccount = live.map((a) => ({
    account: a,
    amount: a.id === settings.payAccountId ? Math.max(0, leftover) : sent.get(a.id) ?? 0,
  })).filter((x) => x.amount > 0);

  const byGroup = groups.map((g) => ({
    group: g,
    amount: perAccount.filter((x) => x.account.groupId === g.id).reduce((s, x) => s + x.amount, 0),
    members: perAccount.filter((x) => x.account.groupId === g.id),
  }));

  const byBucket = BUCKETS.map((b) => {
    const amount = byGroup.filter((g) => g.group.bucket === b.k).reduce((s, g) => s + g.amount, 0);
    return { ...b, amount, pct: pay ? (amount / pay) * 100 : 0, target: settings.rule[b.k] };
  });

  const tips: string[] = [];
  for (const b of byBucket) {
    const diff = b.amount - (pay * b.target) / 100;
    if (Math.abs(b.pct - b.target) < 3) continue;
    const top = perAccount
      .filter((x) => groups.find((g) => g.id === x.account.groupId)?.bucket === b.k)
      .sort((x, y) => y.amount - x.amount)[0];
    if (diff > 0) {
      tips.push(`${b.label} is ${Math.round(b.pct)}% of pay, ${Math.round(b.pct - b.target)} points over the ${b.target}% target (${money(diff, { whole: true })} ${per}).${top ? ` The biggest part is ${top.account.name} at ${money(top.amount, { whole: true })}.` : ''}`);
    } else {
      tips.push(`${b.label} is ${Math.round(b.pct)}% of pay, under the ${b.target}% target by ${money(-diff, { whole: true })} ${per}.`);
    }
  }

  return (
    <>
      <header className="between">
        <PayNav title="Insights" />
        <ViewModes />
      </header>
      <p className="small muted" style={{ marginTop: -12 }}>
        {mode === 'period' ? `Where the ${money(pay)} pay goes.`
          : perPeriod ? `This pay's ${money(plan.pay)} as ${per}: ${money(pay)}.`
          : `The next 12 pays, ${mode === 'month' ? 'averaged per month' : 'added up for the year'}, against pay of ${money(pay)} ${per}.`}
      </p>

      <section className="grid-2">
        <div className="card" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 24 }}>
          <Donut size={190} slices={byGroup.map((g) => ({ label: g.group.name, value: g.amount, color: g.group.color }))}>
            <span className="small muted">{mode === 'period' ? 'This pay' : `Per ${mode}`}</span>
            <b style={{ fontSize: 19 }}>{money(pay, { whole: true })}</b>
          </Donut>
          <div style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h2 className="h2">By group</h2>
            <Legend slices={byGroup.map((g) => ({ label: g.group.name, value: g.amount, color: g.group.color }))} />
          </div>
        </div>

        <div className="card" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 24 }}>
          <Donut size={190} slices={perAccount.map((x) => ({ label: x.account.name, value: x.amount, color: x.account.color }))}>
            <span className="small muted">Accounts</span>
            <b style={{ fontSize: 19 }}>{perAccount.length}</b>
          </Donut>
          <div style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h2 className="h2">By account</h2>
            <Legend slices={perAccount.map((x) => ({ label: x.account.name, value: x.amount, color: x.account.color }))} />
          </div>
        </div>
      </section>

      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div className="between">
          <h2 className="h2">Compared with the {settings.rule.name} rule</h2>
          <a href="#/settings" className="btn small" style={{ textDecoration: 'none', color: 'inherit' }}>Change rule</a>
        </div>
        {byBucket.map((b) => (
          <div key={b.k}>
            <div className="between" style={{ fontSize: 14 }}>
              <b>{b.label}</b>
              <span><b>{Math.round(b.pct)}%</b><span className="muted"> · target {b.target}% · {money(b.amount, { whole: true })}</span></span>
            </div>
            <div className="bar">
              <div style={{ width: `${Math.min(100, b.pct)}%`, background: b.color }} />
              <span className="target" style={{ left: `${b.target}%` }} aria-hidden="true" />
            </div>
            <p className="small muted" style={{ marginTop: 6 }}>
              {groups.filter((g) => g.bucket === b.k).map((g) => g.name).join(', ') || 'No groups'}
            </p>
          </div>
        ))}
      </section>

      {tips.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 className="h2">Suggestions</h2>
          {tips.map((t) => <div className="tip" key={t}><Icon name="bulb" /><span>{t}</span></div>)}
        </section>
      )}
    </>
  );
}
