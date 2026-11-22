import { useEffect, useMemo, useState } from 'react';
import { fmtShort, todayISO } from '../../core/dates';
import { cash } from '../../core/money';
import { SYNCED } from '../../services/bank/BankCard';
import { useBudget } from '../../state/store';
import { Icon } from '../../ui/Icon';
import { Modal } from '../../ui/components';
import { billChecks, type BillCheck, type CheckKind } from './logic/billCheck';

// The bill check pop-up: after a bank sync, what the bank shows about your bills (a different day or
// amount, a bill paid on another card to make up for, one not seen at all), each with a change to make
// or a "no". Opens by itself when a sync turns up something you haven't been shown.

const ICON: Record<CheckKind, string> = { day: 'calendar', amount: 'receipt', move: 'transfer', late: 'alert' };

/** Check keys already shown in a pop-up on this device, so it only opens by itself for new ones. */
const SEEN_KEY = 'paydays.billcheck.seen';
const readSeen = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]); } catch { return new Set(); }
};
const writeSeen = (keys: Iterable<string>) => {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...keys].slice(-300))); } catch { /* private window: it just asks again */ }
};

/** The checks now, and whether the pop-up is open. Opens by itself after a bank sync (or on arrival) when there's something new. */
export function useBillCheck(): { checks: BillCheck[]; open: boolean; setOpen: (v: boolean) => void } {
  const { budget } = useBudget();
  const checks = useMemo(() => billChecks(budget, todayISO()), [budget]);
  const [open, setOpen] = useState(false);
  const [synced, setSynced] = useState(0);
  useEffect(() => {
    const on = () => setSynced((n) => n + 1);
    window.addEventListener(SYNCED, on);
    return () => window.removeEventListener(SYNCED, on);
  }, []);
  const fresh = checks.filter((c) => !readSeen().has(c.key)).map((c) => c.key).join();
  useEffect(() => {
    if (fresh) setOpen(true);
  }, [fresh, synced]);
  useEffect(() => {
    if (open) writeSeen(new Set([...readSeen(), ...checks.map((c) => c.key)]));
  }, [open, checks]);
  return { checks, open, setOpen };
}

/** "Weekly allowance card: 19 Oct $83 · 19 Nov $83": where it was paid said once when it's always the same place. */
function seenLine(c: BillCheck, home: string): string {
  const places = new Set(c.seen.map((s) => s.where));
  const one = places.size === 1 ? [...places][0] : undefined;
  const each = c.seen.map((s) => `${fmtShort(s.date)} ${cash(s.amount)}${!one && s.where !== home ? ` (${s.where})` : ''}`).join(' · ');
  return `${one && one !== home ? one : 'Bank'}: ${each}`;
}

/** The header button: "Bill check" with how many are waiting. */
export function BillCheckButton({ count, onClick }: { count: number; onClick: () => void }) {
  if (!count) return null;
  return (
    <button className="btn" onClick={onClick} aria-label={`Bill check: ${count} to look at`}>
      <Icon name="receipt" size={16} /> Bill check <span className="pill">{count}</span>
    </button>
  );
}

export function BillCheckModal({ checks, onClose }: { checks: BillCheck[]; onClose: () => void }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const answer = (c: BillCheck, change: boolean) => update((b) => {
    if (change) c.apply?.run(b);
    b.billChecks = { ...(b.billChecks ?? {}), [c.key]: today };
    return b;
  });
  const accounts = budget.accounts.filter((a) => checks.some((c) => c.accountId === a.id));
  return (
    <Modal title="Bill check" sub="What the bank shows about your bills" onClose={onClose}>
      {(close) => (
        <div className="stack gap-16">
          {!checks.length && (
            <div className="tip small"><Icon name="check" /><span>All sorted: every bill lines up with what the bank shows.</span></div>
          )}
          {accounts.map((a) => (
            <section className="stack gap-8" key={a.id}>
              <h3 className="h3">{a.name}</h3>
              <div className="check-list">
                {checks.filter((c) => c.accountId === a.id).map((c) => (
                  <div className="check-row" key={c.key}>
                    <span className="check-icon"><Icon name={ICON[c.kind]} size={16} /></span>
                    <div className="stack gap-6 min0">
                      <b>{c.title}</b>
                      <span className="small muted">{c.detail}</span>
                      {c.seen.length > 0 && (
                        <span className="xs muted">{seenLine(c, a.name)}</span>
                      )}
                      <div className="row wrap gap-6">
                        {c.apply && <button className="btn small primary" onClick={() => answer(c, true)}>{c.apply.label}</button>}
                        <button className={`btn small${c.apply ? ' ghost' : ''}`} onClick={() => answer(c, false)}>{c.skip}</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn small ghost" onClick={close}>{checks.length ? 'Later' : 'Close'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
