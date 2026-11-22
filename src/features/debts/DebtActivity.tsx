import { addDays, fmtShort, todayISO } from '../../core/dates';
import { cash } from '../../core/money';
import type { Debt } from '../../core/types';
import { cleanDescription } from '../insights/logic/spending';
import { useBudget } from '../../state/store';
import { Disclosure } from '../../ui/components';
import { paydayHistory, paymentRows, type PaymentRow } from './logic/activity';

/** What a payment row's status line says. */
function stateOf(r: PaymentRow): string {
  if (r.state === 'pending') return 'Pending';
  if (r.state === 'received') return r.on && r.on !== r.date ? `Received ${fmtShort(r.on)}` : 'Received';
  if (r.counted) return r.counted === r.amount ? 'Taken off what’s owed' : `${cash(r.amount - r.counted)} planned, ${cash(r.counted)} extra taken off`;
  return '';
}

/** Payments to a debt: from your bank (pending until the card shows them) and any the card shows from elsewhere. */
export function DebtPayments({ debt: d, linked }: { debt: Debt; linked: boolean }) {
  const { budget } = useBudget();
  const rows = paymentRows(d, linked, todayISO());
  if (!rows.length) return null;
  const name = (id: string) => budget.accounts.find((a) => a.id === id)?.name ?? 'your bank';
  const pending = rows.filter((r) => r.state === 'pending').length;
  return (
    <Disclosure title="Payments" meta={`${pending ? `${pending} pending · ` : ''}latest ${fmtShort(rows[0].date)}`}>
      <div>
        {rows.slice(0, 12).map((r, i) => (
          <div key={`${r.date}-${i}`} className={`list-row small${r.state === 'pending' ? ' pending' : ''}`}>
            <span style={{ flex: '0 0 56px' }} className="muted">{fmtShort(r.date)}</span>
            <span className="grow min0">{r.from ? `From ${name(r.from)}` : cleanDescription(r.description ?? 'Payment')}
              {stateOf(r) && <span className="xs muted block">{stateOf(r)}</span>}
            </span>
            <b className="num">{cash(r.amount)}</b>
          </div>
        ))}
      </div>
    </Disclosure>
  );
}

/** What payday sent for a debt each pay (for a held debt, into the account that keeps it). */
export function DebtPaydayHistory({ debt: d }: { debt: Debt }) {
  const { budget } = useBudget();
  const rows = paydayHistory(budget, d, todayISO());
  if (!rows.length) return null;
  const hold = budget.accounts.find((a) => a.id === d.holdAccountId)?.name;
  return (
    <Disclosure title="Payday history" meta={`last ${rows.length} pay${rows.length === 1 ? '' : 's'}`}>
      <div>
        {rows.map((r) => (
          <div key={r.start} className="list-row small">
            <span style={{ flex: '0 0 56px' }} className="muted">{fmtShort(r.start)}</span>
            <span className="grow min0">{hold ? `Into ${hold}` : 'Sent'}</span>
            <b className="num">{cash(r.amount)}</b>
          </div>
        ))}
      </div>
    </Disclosure>
  );
}

/** What the latest statement asks for (Gem: what avoids interest), beside the app's own recommendation. */
export function StatementDueLine({ debt: d }: { debt: Debt }) {
  const due = d.statementDue;
  // Only until a few days after it's due (or a month on): an older statement's figure is out of date.
  if (!due || (due.by ? addDays(due.by, 3) : addDays(due.date, 35)) < todayISO()) return null;
  const parts = [
    due.avoidInterest !== undefined ? `${cash(due.avoidInterest)} to avoid interest` : null,
    due.minimum !== undefined ? `minimum ${cash(due.minimum)}` : null,
  ].filter(Boolean).join(' · ');
  return <p className="small muted"><b>{fmtShort(due.date)} statement:</b> {parts}{due.by ? `, due ${fmtShort(due.by)}` : ''}</p>;
}
