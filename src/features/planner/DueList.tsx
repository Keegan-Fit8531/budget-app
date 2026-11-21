import { addDays, fmtDay, type ISODate } from '../../core/dates';
import { cash } from '../../core/money';
import type { Account } from '../../core/types';
import type { Due } from '../../engine/plan';
import { Dot } from '../../ui/components';

// ---------------------------------------------------------------------------------------------
// The Planner's list of payments due: before the next pay (in the pay you're in), or in the pay
// being viewed. One heading per day with that day's total; the first 8, then Show all.
// ---------------------------------------------------------------------------------------------

/** Payments in date order, grouped by day. */
function dayGroups<T extends { date: string }>(list: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const d of list) m.set(d.date, [...(m.get(d.date) ?? []), d]);
  return [...m];
}

export function DueList({ accounts, upcoming, showAll, onToggle, isCurrent, today }: {
  accounts: Account[];
  /** Everything due (in the pay you're in, from today). */
  upcoming: Due[];
  showAll: boolean;
  onToggle: () => void;
  /** The pay being viewed is the one you're in. */
  isCurrent: boolean;
  today: ISODate;
}) {
  const dues = showAll ? upcoming : upcoming.slice(0, 8);
  return (
    <section className="card">
      <div className="card-head" style={{ marginBottom: 8 }}>
        <h2 className="h2">{isCurrent ? 'Coming up before next pay' : 'Due this period'}</h2>
        <span className="small muted">{upcoming.length} payment{upcoming.length === 1 ? '' : 's'}</span>
      </div>
      {dues.length === 0 && <p className="muted small">Nothing else due this period.</p>}
      {/* One heading per day (Today, Tomorrow, Wed 18 Nov) with that day's total, then what's due. */}
      {dayGroups(dues).map(([date, list]) => (
        <div key={date} className="due-day">
          <div className="due-day-head">
            <span>{date === today ? 'Today' : date === addDays(today, 1) ? 'Tomorrow' : fmtDay(date)}</span>
            {list.length > 1 && <span className="num">{cash(list.reduce((t, d) => t + d.item.amount, 0))}</span>}
          </div>
          {list.map((d, i) => {
            const acc = accounts.find((a) => a.id === d.item.accountId);
            return (
              <div className="list-row" key={`${d.item.id}-${d.date}-${i}`}>
                <Dot color={acc?.color} />
                <span className="grow">
                  {d.item.name}
                  {acc && acc.name !== d.item.name && <span className="small muted"> · {acc.name}</span>}
                </span>
                <b className="num">{cash(d.item.amount)}</b>
              </div>
            );
          })}
        </div>
      ))}
      {upcoming.length > 8 && (
        <button className="btn small ghost" style={{ marginTop: 8 }} onClick={onToggle}>
          {showAll ? 'Show fewer' : `Show all ${upcoming.length}`}
        </button>
      )}
    </section>
  );
}
