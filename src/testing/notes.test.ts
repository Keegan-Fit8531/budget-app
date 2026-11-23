import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------------------------
// The notes (AGENTS.md and the READMEs) are how an AI, or a person, finds its way around without reading
// the whole app, so they have to stay true and short:
// - every folder in src has a README.md, naming every file and folder in it;
// - AGENTS.md and each README stay under a size limit. When one fails, cut: shorten the longest lines,
//   drop lists of every export, move a feature's detail to its own folder's README. Don't raise the limit.
// See AGENTS.md → "Keeping the notes short".
// ---------------------------------------------------------------------------------------------

// Paths only (nothing is imported). src/personal is your own data, kept on your computer only.
const files = Object.keys(import.meta.glob(['/src/**/*', '!/src/personal/**']));
// (Vite needs each glob's options written out in place.)
const readmes = import.meta.glob<string>(['/src/**/README.md', '!/src/personal/**'], { query: '?raw', import: 'default', eager: true });
const otherNotes = import.meta.glob<string>('/scripts/README.md', { query: '?raw', import: 'default', eager: true });
const agents = Object.values(import.meta.glob<string>('/AGENTS.md', { query: '?raw', import: 'default', eager: true }))[0] ?? '';

/** Every agent reads all of AGENTS.md, so it's the tightest. */
const AGENTS_MAX_CHARS = 14_000;
const AGENTS_MAX_LINE = 260;
/** A README line is one file (what it's for, its main exports) or one gotcha. */
const README_MAX_CHARS = 7_000;
const README_MAX_LINE = 600;

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'));
const folders = new Set<string>();
for (const f of files) for (let d = dirOf(f); d.startsWith('/src'); d = dirOf(d)) folders.add(d);

const longLines = (path: string, text: string, max: number) =>
  text.split('\n').flatMap((l, i) => (l.length > max ? [`${path}:${i + 1} is ${l.length} characters (limit ${max})`] : []));

describe('folder READMEs', () => {
  it('every folder in src has a README.md', () => {
    const missing = [...folders].filter((d) => !readmes[`${d}/README.md`]).sort();
    expect(missing, 'add a README.md to each of these folders').toEqual([]);
  });

  it('each README names every file and folder in it', () => {
    const unlisted: string[] = [];
    for (const d of folders) {
      const text = readmes[`${d}/README.md`];
      if (!text) continue;
      const here = new Set<string>();
      for (const f of files) {
        if (!f.startsWith(d + '/')) continue;
        const rest = f.slice(d.length + 1);
        here.add(rest.includes('/') ? rest.slice(0, rest.indexOf('/')) + '/' : rest);
      }
      for (const name of here) {
        if (name === 'README.md') continue;
        if (!text.includes(name)) unlisted.push(`${d}/README.md doesn't mention ${name}`);
      }
    }
    expect(unlisted.sort(), 'describe these in their folder README').toEqual([]);
  });
});

describe('notes stay short', () => {
  it('AGENTS.md is under its limits', () => {
    expect(agents.length, 'AGENTS.md is read whole by every agent').toBeGreaterThan(0);
    const over = longLines('AGENTS.md', agents, AGENTS_MAX_LINE);
    if (agents.length > AGENTS_MAX_CHARS) over.push(`AGENTS.md is ${agents.length} characters (limit ${AGENTS_MAX_CHARS})`);
    expect(over, 'cut these: AGENTS.md routes to the READMEs, it does not repeat them').toEqual([]);
  });

  it('each README is under its limits', () => {
    const over: string[] = [];
    for (const [path, text] of Object.entries({ ...readmes, ...otherNotes })) {
      over.push(...longLines(path, text, README_MAX_LINE));
      if (text.length > README_MAX_CHARS) over.push(`${path} is ${text.length} characters (limit ${README_MAX_CHARS})`);
    }
    expect(over.sort(), 'cut these: one line per file, main exports only, gotchas one bullet each').toEqual([]);
  });
});
