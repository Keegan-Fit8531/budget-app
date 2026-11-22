import { useState } from 'react';
import { fmtShort } from '../../core/dates';
import { cash } from '../../core/money';
import type { Account, Budget, Txn } from '../../core/types';
import { guessTransfer, isTransferOut, transferKey, transferTarget, unsortedTransfers, type EnvelopeStatus } from '../../engine/envelope';
import { useBudget } from '../../state/store';

/**
 * An account's envelopes on the Accounts card (Gas this month, Food this week): budget, spent, left, and
 * the transfers out that paid for one. A transfer the app can't place gets a question: which envelope?
 */
export function EnvelopeCards({ budget, account, envelopes, color, today }: {
  budget: Budget; account: Account; envelopes: EnvelopeStatus[]; color: string; today: string;
}) {
  const unsorted = unsortedTransfers(budget, account.id, today);
  if (!envelopes.length) return null;
  return (
    <div className="stack gap-8">
      {unsorted.map((t) => <TransferQuestion key={transferKey(account.id, t)} budget={budget} account={account} t={t} envelopes={envelopes} />)}
      {envelopes.map((e) => <EnvelopeCard key={e.item.id} budget={budget} account={account} e={e} envelopes={envelopes} color={color} />)}
    </div>
  );
}

function EnvelopeCard({ budget, account, e, envelopes, color }: {
  budget: Budget; account: Account; e: EnvelopeStatus; envelopes: EnvelopeStatus[]; color: string;
}) {
  const transfers = e.txns.filter((t) => isTransferOut(t));
  const kind = shopsFor(e.item.name);
  // Shared shops (Car gas / Scooter gas): say which fills come here.
  const limited = envelopes.find((x) => x.item.id !== e.item.id && x.item.envelopeUnder && kind && shopsFor(x.item.name) === kind);
  const split = e.item.envelopeUnder ? `under ${cash(e.item.envelopeUnder)}`
    : limited ? `${cash(limited.item.envelopeUnder!)} and over; smaller ones go to ${limited.item.name}` : '';
  const shops = kind || split ? ` (${[kind, split].filter(Boolean).join(', ')})` : '';
  return (
    <div className="stack gap-8">
      <div className="trio">
        <div className="stat">
          <span className="small muted">{e.item.name} · {e.label}</span>
          <b>{cash(e.budget)}</b>
          <span className="xs muted">{e.span} budget</span>
        </div>
        <div className="stat">
          <span className="small muted">Spent</span>
          <b>{cash(e.spent)}</b>
          <span className="xs muted">{e.txns.length ? `${e.txns.length} counted` : 'none yet'}</span>
        </div>
        <div className="stat">
          <span className="small muted">{e.over ? 'Over' : 'Left'}</span>
          <b className={e.over ? 'neg' : e.left > 0 ? 'pos' : ''}>{cash(Math.abs(e.left))}</b>
          <span className="xs muted">{e.over ? 'over budget' : `this ${e.span}`}</span>
        </div>
      </div>
      {(e.budget > 0 || e.spent > 0) && (
        <div className="parts" role="img" aria-label={`${cash(e.spent)} spent of ${cash(e.budget)}`}>
          {e.spent > 0 && <div title={`Spent ${cash(e.spent)}`} style={{ flex: Math.min(e.spent, e.budget || e.spent), background: e.over ? 'var(--bad)' : color }} />}
          {e.left > 0 && <div title={`Left ${cash(e.left)}`} style={{ flex: e.left, background: 'var(--good)' }} />}
          {e.over && e.budget > 0 && <div title={`Over ${cash(-e.left)}`} style={{ flex: -e.left, background: 'var(--bad)' }} />}
        </div>
      )}
      <p className="small muted">
        {e.over
          ? <>Over by {cash(-e.left)} this {e.span} — next {e.span}’s {cash(e.budget)} budget starts fresh.</>
          : <>Assumed spent this {e.span} (reserved in the account). Anything left when the {e.span} ends ({fmtShort(e.to)}) is yours — it doesn’t roll over.</>}
        {' '}Counts synced purchases{shops}, and money moved out to pay for them.
        {e.laterCount > 0 && <> Also keeps {cash(e.later)} for the {e.laterCount} more {e.span}{e.laterCount === 1 ? '' : 's'} before payday.</>}
      </p>
      {transfers.map((t) => <CountedTransfer key={transferKey(account.id, t)} budget={budget} account={account} t={t} envelopes={envelopes} />)}
    </div>
  );
}

/** "$50 moved to Weekly allowance on 22 Nov", and the purchase that explains it when there is one. */
function describe(budget: Budget, account: Account, t: Txn) {
  const to = transferTarget(budget, t);
  const guess = guessTransfer(budget, account.id, t);
  const p = guess?.seen[0];
  const where = p && p.accountId !== to?.id ? ` in ${budget.accounts.find((a) => a.id === p.accountId)?.name ?? 'another account'}` : '';
  return {
    guess,
    text: `${cash(-t.amount)} moved to ${to?.name ?? 'another account'} on ${fmtShort(t.date)}`,
    reason: p ? `${p.txn.merchant || p.txn.description} ${cash(-p.txn.amount)} on ${fmtShort(p.txn.date)}${where}` : '',
  };
}

/** A transfer already counted against an envelope (by you, or matched to a purchase), with a way to change it. */
function CountedTransfer({ budget, account, t, envelopes }: { budget: Budget; account: Account; t: Txn; envelopes: EnvelopeStatus[] }) {
  const [changing, setChanging] = useState(false);
  const { text, reason } = describe(budget, account, t);
  const mine = budget.envelopeTransfers?.[transferKey(account.id, t)] !== undefined;
  if (changing) return <TransferQuestion budget={budget} account={account} t={t} envelopes={envelopes} onDone={() => setChanging(false)} />;
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <p className="small muted grow">
        Includes {text}{mine ? ' (you said so)' : reason ? `, matched to ${reason}` : ''}.
      </p>
      <button className="btn small ghost" onClick={() => setChanging(true)}>Change</button>
    </div>
  );
}

/** Which envelope did this transfer pay for? Your answer is kept (`budget.envelopeTransfers`). */
function TransferQuestion({ budget, account, t, envelopes, onDone }: {
  budget: Budget; account: Account; t: Txn; envelopes: EnvelopeStatus[]; onDone?: () => void;
}) {
  const { update } = useBudget();
  const { text, reason, guess } = describe(budget, account, t);
  const key = transferKey(account.id, t);
  // Likely envelopes first (nearest purchase), then the rest.
  const order = [...envelopes].sort((x, y) => rank(guess?.itemIds, x.item.id) - rank(guess?.itemIds, y.item.id));
  const pick = (id: string) => {
    update((b) => { b.envelopeTransfers = { ...(b.envelopeTransfers ?? {}), [key]: id }; return b; });
    onDone?.();
  };
  return (
    <div className="stack gap-6">
      <p className="small">
        <b>{text}.</b> Was it to pay for something from an envelope?
        {reason ? <span className="muted"> {reason} looks like it.</span> : null}
      </p>
      <div className="row wrap gap-6">
        {order.map((e) => (
          <button key={e.item.id} className="btn small" onClick={() => pick(e.item.id)}>{e.item.name}</button>
        ))}
        <button className="btn small ghost" onClick={() => pick('')}>No, just moving money</button>
        {onDone && <button className="btn small ghost" onClick={onDone}>Cancel</button>}
      </div>
    </div>
  );
}

/** The shops an envelope counts, as `engine/envelopeMatch.ts` → `matchesEnvelope` decides them. */
const shopsFor = (name: string) => (/gas|fuel|petrol/i.test(name) ? 'fuel shops' : /food|grocer|supermarket/i.test(name) ? 'supermarkets' : '');

const rank = (ids: string[] | undefined, id: string) => {
  const i = ids?.indexOf(id) ?? -1;
  return i < 0 ? 99 : i;
};
