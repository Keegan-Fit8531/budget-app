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

/**
 * Where a Gemini read has got to: getting the file ready, then Google reading it (sent at `since`).
 * A long PDF is read in parts: `parts` of them, `done` so far, over `pages` pages.
 */
export type ReadStage = { step: 'preparing' } | { step: 'reading'; bytes: number; since: number; parts?: number; done?: number; pages?: number; read?: number };

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

/** Whether a PDF plainly has only a few pages (counted in the file, without opening it), so it's sent as it is. */
async function fewPages(file: File, most: number): Promise<boolean> {
  if (file.size > 2_000_000) return false;
  const n = (new TextDecoder('latin1').decode(await file.arrayBuffer()).match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
  return n > 0 && n <= most;
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
    const [{ isPdf, prepareFile }, { geminiProvider, PAGES_AT_ONCE }, { buildContext }] = await Promise.all([import('./prepare'), import('./gemini'), import('./prompt')]);
    const ctx = buildContext(budget, todayISO());
    const opts = { key: conf.key, model: modelOf(conf), signal: controller.signal };
    const provider = geminiProvider();
    let ex: Extraction | undefined;
    // A long PDF with text in it (a year of bank statements) is read as its text, a few pages at a time:
    // as one PDF, Gemini couldn't list hundreds of transactions in one reply.
    if (isPdf(file) && provider.readText && !(await fewPages(file, PAGES_AT_ONCE))) {
      const { hasText, readPdfPages } = await import('./pdftext');
      const pages = await readPdfPages(file).catch(() => [] as string[]);
      if (pages.length > PAGES_AT_ONCE && hasText(pages)) {
        if (controller.signal.aborted) throw new ReaderError('cancelled');
        const bytes = pages.reduce((t, p) => t + p.length, 0);
        const since = Date.now();
        const parts = Math.ceil(pages.length / PAGES_AT_ONCE);
        setStage({ step: 'reading', bytes, since, parts, done: 0, pages: pages.length, read: 0 });
        ex = await provider.readText(pages, ctx, opts, (done) => setStage({ step: 'reading', bytes, since, parts, done, pages: pages.length, read: Math.min(pages.length, done * PAGES_AT_ONCE) }));
      }
    }
    if (!ex) {
      const prepared = await prepareFile(file);
      if (controller.signal.aborted) throw new ReaderError('cancelled');
      setStage({ step: 'reading', bytes: prepared.bytes, since: Date.now() });
      ex = await provider.read(prepared, ctx, opts);
    }
    // A bank statement's file name often has the account number in it (06-0115-0123456-00_Statement.pdf).
    if (ex.kind === 'transactions' && ex.transactions && !ex.transactions.ending) {
      const { endingOf } = await import('../csv');
      const ending = endingOf(file.name);
      if (ending) ex = { ...ex, transactions: { ...ex.transactions, ending } };
    }
    return ex;
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
