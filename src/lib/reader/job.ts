import { todayISO } from '../dates';
import type { Budget } from '../types';
import { modelOf, readReaderConfig } from './config';
import { ReaderError } from './errors';
import type { Extraction, ReaderSource } from './types';

// ---------------------------------------------------------------------------------------------
// Starting a read. Called once, from the file picker's change handler (not from a React effect, which
// runs twice in development and would send the document twice). The reader code itself is loaded
// only now, so it adds nothing to the app's first load.
// ---------------------------------------------------------------------------------------------

/** Where a Gemini read has got to: getting the file ready, then Google reading it (sent at `since`). */
export type ReadStage = { step: 'preparing' } | { step: 'reading'; bytes: number; since: number };

export interface ReadJob {
  file: File;
  source: ReaderSource;
  promise: Promise<Extraction>;
  cancel: () => void;
  /** Progress from 0 to 1 (the on-device reader reports it; Gemini doesn't). Returns an unsubscribe. */
  onProgress: (fn: (fraction: number) => void) => () => void;
  /** The stage a Gemini read is at (the latest is given straight away). Returns an unsubscribe. */
  onStage: (fn: (stage: ReadStage) => void) => () => void;
}

/** A bank or card export. Windows says a CSV is an Excel file, so its name counts too. */
export const isCsv = (f: Pick<File, 'type' | 'name'>) => f.type === 'text/csv' || /\.csv$/i.test(f.name);

export function startRead(file: File, budget: Budget, source: ReaderSource = 'gemini'): ReadJob {
  if (isCsv(file)) source = 'device';
  const controller = new AbortController();
  const listeners = new Set<(p: number) => void>();
  const stageListeners = new Set<(s: ReadStage) => void>();
  let stage: ReadStage = { step: 'preparing' };
  const setStage = (s: ReadStage) => { stage = s; stageListeners.forEach((l) => l(s)); };
  const promise = (async (): Promise<Extraction> => {
    // A bank or card export is read here, whatever was asked: it's already in columns, so it's never sent anywhere.
    if (isCsv(file)) {
      const { readTransactionsCsv } = await import('../csv');
      const read = readTransactionsCsv(await file.text());
      if (!read) throw new ReaderError('bad_file', { detail: 'Couldn’t find dates and amounts in that file. Export transactions from your bank or card as CSV and try again.' });
      return { kind: 'transactions', transactions: read };
    }
    if (source === 'device') {
      const { readOnDevice } = await import('./local');
      return readOnDevice(file, budget.debts ?? [], (p) => listeners.forEach((l) => l(p)));
    }
    const conf = readReaderConfig();
    if (!conf) throw new ReaderError('no_key');
    const [{ prepareFile }, { geminiProvider }, { buildContext }] = await Promise.all([import('./prepare'), import('./gemini'), import('./prompt')]);
    const prepared = await prepareFile(file);
    if (controller.signal.aborted) throw new ReaderError('cancelled');
    setStage({ step: 'reading', bytes: prepared.bytes, since: Date.now() });
    return geminiProvider().read(prepared, buildContext(budget, todayISO()), { key: conf.key, model: modelOf(conf), signal: controller.signal });
  })();
  promise.catch(() => { /* handled by whoever shows the job */ });
  return {
    file, source, promise,
    cancel: () => controller.abort(),
    onProgress: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onStage: (fn) => { stageListeners.add(fn); fn(stage); return () => { stageListeners.delete(fn); }; },
  };
}

/** Check a key with a tiny request (no document). Resolves if Google accepts it; throws a ReaderError if not. */
export async function testKey(key: string, model: string): Promise<void> {
  const { geminiProvider } = await import('./gemini');
  await geminiProvider().test({ key, model });
}
