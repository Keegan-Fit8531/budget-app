import { fmtShort, todayISO, type ISODate } from '../../core/dates';
import { cash } from '../../core/money';
import type { Budget, Cents } from '../../core/types';
import { shiftPeriod, type Period } from '../periods';
import { depositFor } from './deposits';
import { fundedOut } from './outflows';

// ---------------------------------------------------------------------------------------------
// A steady account's buffer (Rent): how much of what's left after this pay's bills has to stay for the
// next pay that needs more than payday sends it (a 5-Friday rent pay), worked out as a running balance
// up to and including that pay. The spare from 4-payment pays before it counts towards it, so a
// 5-payment pay after two 4-payment ones needs nothing held. Later 5-payment pays aren't counted: the
// owner wants the buffer to be what's needed until the next one.
// ---------------------------------------------------------------------------------------------

/**
 * The lowest the running total of `nets` falls below zero (0 if it never does), and where:
 * `at` is the index of that lowest point (-1 when nothing needs holding).
 */
export function runningLow(nets: Cents[]): { buffer: Cents; at: number } {
  let run = 0;
  let low = 0;
  let at = -1;
  nets.forEach((n, i) => {
    run += n;
    if (run < low) { low = run; at = i; }
  });
  return { buffer: low < 0 ? -low : 0, at };
}

export interface PayNet { period: Period; need: Cents; deposit: Cents }

export interface PotBuffer {
  /** What's left after the bills before `nextPayday` (the start of the run). */
  left: Cents;
  nextPayday: ISODate;
  /** Held for the next short pay: the lowest the running balance falls below zero up to it. */
  buffer: Cents;
  /** left − buffer. Negative = the pot can't cover its bills by `lowest`'s pay: that much short. */
  free: Cents;
  /** The pays from `nextPayday` up to the lowest point, with what they need and get in total. */
  lowest?: { period: Period; pays: number; need: Cents; deposit: Cents };
  /** Each pay in the run: up to and including the next short pay (need > deposit), at most `pays`. */
  run: PayNet[];
}

/**
 * The buffer for an account after `period`, given `left` = what's in it at the end of `period` after
 * its bills (for the pay you're in: balance − bills still to come; for a later pay: its projected end,
 * which includes the surplus built up before it). Runs pay by pay on their real paydays, each with what
 * payday sends it then (`depositFor`: a changed or one-pay amount counts) less what's due from its
 * payday to the day before the next (`fundedOut`), up to the first pay that needs more than it gets
 * (looking at most `pays` ahead). Transfers in or out are already in `left`.
 */
export function potBuffer(b: Budget, accountId: string, period: Period, left: Cents, pays = 13, today: ISODate = todayISO()): PotBuffer {
  const run: PayNet[] = [];
  let p = period;
  for (let i = 0; i < pays; i++) {
    p = shiftPeriod(p, 1, b.settings);
    const need = fundedOut(b, accountId, p.start, p.end).reduce((t, o) => t + o.amount, 0);
    const deposit = depositFor(b, accountId, p, today);
    run.push({ period: p, need, deposit });
    if (need > deposit) break;
  }
  const { buffer, at } = runningLow(run.map((r) => r.deposit - r.need));
  const upTo = run.slice(0, at + 1);
  const lowest = at < 0 ? undefined : {
    period: run[at].period,
    pays: at + 1,
    need: upTo.reduce((t, r) => t + r.need, 0),
    deposit: upTo.reduce((t, r) => t + r.deposit, 0),
  };
  return { left, nextPayday: period.nextPayday, buffer, free: left - buffer, lowest, run };
}

/**
 * The buffer in words, for a card's details:
 * "$374.51 left after bills before 18 Dec · $270.49 held for the 18 Dec pay (needs $2,075, gets $1,804.51) · $104.02 free".
 * When the lowest point is several pays away it names that pay and adds up the pays to it.
 */
export function bufferLine(x: PotBuffer): string {
  const head = `${cash(x.left)} left after bills before ${fmtShort(x.nextPayday)}`;
  const low = x.lowest;
  if (!low || x.buffer <= 0) {
    const last = x.run[x.run.length - 1];
    const upTo = last && last.need > last.deposit ? `the ${fmtShort(last.period.start)} pay is covered` : `nothing to hold for the next ${x.run.length} pays`;
    return `${head} · ${upTo} · ${cash(x.left)} free`;
  }
  const pay = `the ${fmtShort(low.period.start)} pay`;
  const why = low.pays === 1
    ? `needs ${cash(low.need)}, gets ${cash(low.deposit)}`
    : `the ${low.pays} pays to then need ${cash(low.need)}, get ${cash(low.deposit)}`;
  return x.free >= 0
    ? `${head} · ${cash(x.buffer)} held for ${pay} (${why}) · ${cash(x.free)} free`
    : `${head} · ${cash(x.buffer)} needed for ${pay} (${why}) · ${cash(-x.free)} short`;
}
