import { useState } from 'react';
import { fmtShort } from '../../core/dates';
import { cash } from '../../core/money';
import { PartsBar } from '../../ui/PartsBar';
import type { Account, Budget, Txn } from '../../core/types';
import { guessTransfer, isTransferOut, transferKey, unsortedTransfers, type EnvelopeStatus } from '../../engine/envelope';
import { ownTransfer } from '../../engine/transfers';
import { useBudget } from '../../state/store';
import { Disclosure, ShortList } from '../../ui/components';

/**
 * An account's envelopes at a glance (Gas this month, Food this week): one line each with what's left
 * and a thin bar. A transfer out the app can't place is asked about here, since it needs an answer.
 * The explanation and what counted are in `EnvelopeDetails`, behind the card's Details.
 */
export function EnvelopeSummary({ budget, account, envelopes, color, today }: {
  budget: Budget; account: Account; envelopes: EnvelopeStatus[]; color: string; today: string;
}) {
  const unsorted = unsortedTransfers(budget, account.id, today);
  if (!envelopes.length) return null;
  return (
    <div className="stack gap-12">
      {unsorted.map((t) => <TransferQuestion key={transferKey(account.id, t)} budget={budget} account={account} t={t} envelopes={envelopes} />)}
      {envelopes.map((e) => <EnvelopeRow key={e.item.id} e={e} color={color} />)}
    </div>
  );
}

/** "Food shop · this week        $150 of $200 left", over a thin spent / left bar. */
function EnvelopeRow({ e, color }: { e: EnvelopeStatus; color: string }) {
  return (
    <div className="env-row">
      <div className="env-line">
        <span className="clip min0"><span className="strong">{e.item.name}</span><span className="muted small"> · this {e.span}</span></span>
        <span className="num small">
          <b className={e.over ? 'neg' : e.left > 0 ? 'pos' : ''}>{cash(Math.abs(e.left))}</b>
          <span className="muted"> {e.over ? `over ${cash(e.budget)}` : `of ${cash(e.budget)} left`}</span>
        </span>
      </div>
      {(e.budget > 0 || e.spent > 0) && (
        <PartsBar thin label={`${e.item.name} this ${e.span}`} parts={[
          { label: `Spent this ${e.span}`, value: Math.min(e.spent, e.budget || e.spent), color: e.over ? 'var(--bad)' : color },
          { label: `Left of ${cash(e.budget)}`, value: Math.max(0, e.left), color: 'var(--good)' },
          { label: `Over ${cash(e.budget)}`, value: e.over && e.budget > 0 ? -e.left : 0, color: 'var(--bad)' },
        ]} />
      )}
    </div>
  );
}

/**
 * Each envelope's details, for inside the card's Details: how it works, what counted against it, and
 * each transfer out it counted (with Change).
 */
export function EnvelopeDetails({ budget, account, envelopes }: { budget: Budget; account: Account; envelopes: EnvelopeStatus[] }) {
  return (
    <>
      {envelopes.map((e) => <EnvelopeDetail key={e.item.id} budget={budget} account={account} e={e} envelopes={envelopes} />)}
    </>
  );
}

function EnvelopeDetail({ budget, account, e, envelopes }: {
  budget: Budget; account: Account; e: EnvelopeStatus; envelopes: EnvelopeStatus[];
}) {
  const transfers = e.txns.filter((t) => isTransferOut(t));
  const bought = e.txns.filter((t) => !isTransferOut(t));
  const kind = shopsFor(e.item.name);
  // Shared shops (Car gas / Scooter gas): say which fills come here.
  const limited = envelopes.find((x) => x.item.id !== e.item.id && x.item.envelopeUnder && kind && shopsFor(x.item.name) === kind);
  const split = e.item.envelopeUnder ? `under ${cash(e.item.envelopeUnder)}`
    : limited ? `${cash(limited.item.envelopeUnder!)} and over; smaller ones go to ${limited.item.name}` : '';
  const shops = kind || split ? ` (${[kind, split].filter(Boolean).join(', ')})` : '';
  return (
    <Disclosure title={`${e.item.name} · ${e.label}`} meta={`${cash(e.spent)} of ${cash(e.budget)} spent`}>
      <p className="small muted">
        {e.over
          ? <>Over by {cash(-e.left)} this {e.span}. Next {e.span}’s {cash(e.budget)} starts fresh.</>
          : <>Reserved until {fmtShort(e.to)}; what’s left then is yours (it doesn’t roll over).</>}
        {' '}Counts purchases{shops} and money moved out to pay for them.
        {e.laterCount > 0 && <> Also keeps {cash(e.later)} for the {e.laterCount} more {e.span}{e.laterCount === 1 ? '' : 's'} before payday.</>}
      </p>
      {bought.length > 0 && (
        <ShortList>
          {bought.map((t, i) => (
            <div className="list-row small" key={`${t.date}-${t.amount}-${i}`}>
              <span style={{ flex: '0 0 72px' }} className="muted">{fmtShort(t.date)}</span>
              <span className="grow clip">{t.merchant || t.description}</span>
              <span className="num">{cash(-t.amount)}</span>
            </div>
          ))}
        </ShortList>
      )}
      {transfers.map((t) => <CountedTransfer key={transferKey(account.id, t)} budget={budget} account={account} t={t} envelopes={envelopes} />)}
    </Disclosure>
  );
}

/** "$50 moved to Weekly allowance on 22 Nov", and the purchase that explains it when there is one. */
function describe(budget: Budget, account: Account, t: Txn) {
  const to = ownTransfer(budget, t)?.account;
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
        {text}{mine ? ' (you said so)' : reason ? `, matched to ${reason}` : ''}.
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
