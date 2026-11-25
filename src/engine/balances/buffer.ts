import { fmtShort, todayISO, type ISODate } from '../../core/dates';
import { cash } from '../../core/money';
import type { Budget, Cents } from '../../core/types';
import { shiftPeriod, type Period } from '../periods';
import { depositFor } from './deposits';
import { fundedOut } from './outflows';

// ---------------------------------------------------------------------------------------------
// A steady account's buffer (Rent): how much of what's left after this pay's bills has to stay for
// later pays, worked out as a running balance. A weekly bill from a monthly pay gives 4- and 5-payment
// pays; the spare from the 4-payment pays in between covers a 5-payment one, so only the lowest the
// running balance falls below zero is held, not each 5-payment pay's own gap.
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

/** How far ahead the buffer looks: 12 pays, a year of monthly pays (each 5-payment pay in it). */
export const BUFFER_PAYS = 12;

export interface PayNet { period: Period; need: Cents; deposit: Cents }

export interface PotBuffer {
  /** What's left after the bills before `nextPayday` (the start of the run). */
  left: Cents;
  nextPayday: ISODate;
  /** Held for later pays: the lowest the running balance falls below zero. */
  buffer: Cents;
  /** left − buffer. Negative = the pot can't cover its bills by `lowest`'s pay: that much short. */
  free: Cents;
  /** The pays from `nextPayday` up to the lowest point, with what they need and get in total. */
  lowest?: { period: Period; pays: number; need: Cents; deposit: Cents };
  /** Each pay in the run. */
  run: PayNet[];
}

/**
 * The buffer for an account after `period`, given `left` = what's in it at the end of `period` after
 * its bills (for the pay you're in: balance − bills still to come; for a later pay: its projected end,
 * which includes the surplus built up before it). Runs the next `pays` pays on their real paydays, each
 * with what payday sends it then (`depositFor`: a changed or one-pay amount counts) less what's due
 * from its payday to the day before the next (`fundedOut`). Transfers in or out are already in `left`.
 */
export function potBuffer(b: Budget, accountId: string, period: Period, left: Cents, pays = BUFFER_PAYS, today: ISODate = todayISO()): PotBuffer {
  const run: PayNet[] = [];
  let p = period;
  for (let i = 0; i < pays; i++) {
    p = shiftPeriod(p, 1, b.settings);
    const need = fundedOut(b, accountId, p.start, p.end).reduce((t, o) => t + o.amount, 0);
    run.push({ period: p, need, deposit: depositFor(b, accountId, p, today) });
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
  if (!low || x.buffer <= 0) return `${head} · nothing to hold for the next ${x.run.length} pays · ${cash(x.left)} free`;
  const pay = `the ${fmtShort(low.period.start)} pay`;
  const why = low.pays === 1
    ? `needs ${cash(low.need)}, gets ${cash(low.deposit)}`
    : `the ${low.pays} pays to then need ${cash(low.need)}, get ${cash(low.deposit)}`;
  return x.free >= 0
    ? `${head} · ${cash(x.buffer)} held for ${pay} (${why}) · ${cash(x.free)} free`
    : `${head} · ${cash(x.buffer)} needed for ${pay} (${why}) · ${cash(-x.free)} short`;
}
