import { useEffect, useMemo, useState } from 'react';
import { fmtShort, todayISO } from '../../core/dates';
import { cash, parseMoney } from '../../core/money';
import { SYNCED } from '../../services/bank/BankCard';
import { useBudget } from '../../state/store';
import { Icon } from '../../ui/Icon';
import { Modal } from '../../ui/components';
import { answeredChecks, billChecks, type BillCheck, type CheckKind } from './logic/billCheck';

// The bill check pop-up: after a bank sync, what the bank shows about your bills (a different day or
// amount, a bill paid on another card to make up for, one not seen at all), each with a change to make
// or a "no". Opens by itself when a sync turns up something you haven't been shown.

const ICON: Record<CheckKind, string> = { day: 'calendar', amount: 'receipt', move: 'transfer', late: 'alert', held: 'card' };

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

/** The header button: "Bill check" with how many are waiting (shown with none waiting too, while there are answers to undo). */
export function BillCheckButton({ count, onClick }: { count: number; onClick: () => void }) {
  const { budget } = useBudget();
  const answers = useMemo(() => answeredChecks(budget, todayISO()).length, [budget]);
  if (!count && !answers) return null;
  return (
    <button className="btn" onClick={onClick} aria-label={count ? `Bill check: ${count} to look at` : 'Bill check: your answers'}>
      <Icon name="receipt" size={16} /> Bill check {count > 0 && <span className="pill">{count}</span>}
    </button>
  );
}

/** "Still to send from Misc bills": how much, before it's saved. */
function AskAmount({ c, onSave, onCancel }: { c: BillCheck; onSave: (amount: number) => void; onCancel: () => void }) {
  const [text, setText] = useState((c.ask!.initial / 100).toFixed(2));
  const amount = parseMoney(text);
  const ok = amount !== null && amount >= 0;
  return (
    <div className="stack gap-6">
      <span className="small">{c.ask!.prompt}</span>
      <div className="row wrap gap-6">
        <input className="input" style={{ maxWidth: 140 }} inputMode="decimal" autoFocus value={text} aria-label={c.ask!.prompt}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok && onSave(amount!)} />
        <button className="btn small primary" disabled={!ok} onClick={() => ok && onSave(amount!)}>Save</button>
        <button className="btn small ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function BillCheckModal({ checks, onClose }: { checks: BillCheck[]; onClose: () => void }) {
  const { budget, update } = useBudget();
  const today = todayISO();
  const [asking, setAsking] = useState<string>();
  const answer = (c: BillCheck, change: boolean, amount?: number) => update((b) => {
    if (change) c.apply?.run(b);
    if (amount !== undefined) c.ask?.run(b, amount);
    b.billChecks = { ...(b.billChecks ?? {}), [c.key]: today };
    return b;
  });
  const answers = useMemo(() => answeredChecks(budget, today), [budget, today]);
  const undo = (key: string) => update((b) => { answers.find((a) => a.key === key)?.undo(b); return b; });
  const accounts = budget.accounts.filter((a) => checks.some((c) => c.accountId === a.id));
  return (
    <Modal title="Bill check" sub="What the bank shows about your bills" onClose={onClose}>
      {(close) => (
        <div className="stack gap-16">
          {!checks.length && !answers.length && (
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
                      {asking === c.key ? (
                        <AskAmount c={c} onSave={(amount) => { answer(c, false, amount); setAsking(undefined); }} onCancel={() => setAsking(undefined)} />
                      ) : (
                        <div className="row wrap gap-6">
                          {c.apply && <button className="btn small primary" onClick={() => answer(c, true)}>{c.apply.label}</button>}
                          {c.ask && <button className="btn small primary" onClick={() => setAsking(c.key)}>{c.ask.label}</button>}
                          <button className={`btn small${c.apply || c.ask ? ' ghost' : ''}`} onClick={() => answer(c, false)}>{c.skip}</button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {answers.length > 0 && (
            <section className="stack gap-8">
              <h3 className="h3">Your answers</h3>
              <div className="check-list">
                {answers.map((a) => (
                  <div className="check-row" key={a.key}>
                    <span className="check-icon"><Icon name="check" size={16} /></span>
                    <div className="row gap-6 min0" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="small min0">{a.title}</span>
                      <button className="btn small ghost" onClick={() => undo(a.key)}>Undo</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn small ghost" onClick={close}>{checks.length ? 'Later' : 'Close'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
