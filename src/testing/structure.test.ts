import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------------------------
// The folder rules in AGENTS.md ("Rules the code relies on"), checked so they can't drift:
// files stay small enough to read in one go, logic folders stay free of React, ui/ stays generic,
// and core/ only borrows types from the rest of the app. Each failure says what to change.
// ---------------------------------------------------------------------------------------------

/** The most lines a file may have. Past this, split it by its sections. */
const MAX_LINES = 500;
/** What a file should stay under. A new file over it fails; one already over may shrink but never grow. */
const AIM_LINES = 400;
/**
 * A file's size is its lines, or its non-space characters in lines of the code's average density, whichever
 * is more. So joining lines, dropping blank lines or squeezing out spaces never gets a file under a limit:
 * only moving code out does. (The averages across this code: 45 characters a line, 63 in stylesheets.)
 */
const CHARS_PER_LINE = 45;
const CSS_CHARS_PER_LINE = 63;
/**
 * The files already over AIM_LINES, at their size now (counted as above). Split one before adding to it.
 * When one shrinks, lower its number here (or remove it once it's under AIM_LINES): this list only gets shorter.
 */
const OVER_AIM: Record<string, number> = {
  '/src/services/reader/check/check.test.ts': 447,
  '/src/features/accounts/MonthTracker.tsx': 418,
  '/src/ui/styles/components.css': 417,
  '/src/services/reader/apply.ts': 413,
};

const code = import.meta.glob<string>(['/src/**/*.{ts,tsx}', '!/src/personal/**', '!/src/vite-env.d.ts'], { query: '?raw', import: 'default', eager: true });
// Vitest hands back CSS as an empty string, so stylesheets are read from disk to be measured too.
const styles = Object.fromEntries(Object.keys(import.meta.glob('/src/**/*.css')).map((f) => [f, readFileSync(`.${f}`, 'utf8')]));
const sources: Record<string, string> = { ...code, ...styles };
const paths = new Set(Object.keys(sources));

/** Resolve a relative import from `file` to a path under /src (without extension), like Vite does. */
function resolve(file: string, spec: string): string {
  const parts = file.split('/').slice(0, -1);
  for (const s of spec.split('/')) {
    if (s === '..') parts.pop();
    else if (s !== '.') parts.push(s);
  }
  return parts.join('/');
}

interface Import { spec: string; typeOnly: boolean; line: number }
/** Static imports and re-exports (`import … from`, `export … from`, `import '…'`). */
function importsOf(text: string): Import[] {
  const out: Import[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ spec: m[3], typeOnly: !!m[2], line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}
const isTsx = (file: string, spec: string) => spec.startsWith('.') && (spec.endsWith('.tsx') || paths.has(resolve(file, spec) + '.tsx'));
const layerOf = (file: string, spec: string) => (spec.startsWith('.') ? resolve(file, spec).split('/')[2] : undefined);

const pure = (f: string) => f.startsWith('/src/core/') || f.startsWith('/src/engine/') || /\/logic\//.test(f);
/** A file's size in lines: its real lines, or its non-space characters in average lines, whichever is more. */
function sizeInLines(text: string, perLine = CHARS_PER_LINE): number {
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return Math.max(lines, Math.ceil(text.replace(/\s/g, '').length / perLine));
}
const perLine = (f: string) => (f.endsWith('.css') ? CSS_CHARS_PER_LINE : CHARS_PER_LINE);
const sizes = Object.entries(sources).map(([f, text]) => [f, sizeInLines(text, perLine(f))] as const);
const counted = (f: string) => `lines (its lines, or its non-space characters at ${perLine(f)} a line, whichever is more)`;

describe('folder rules (AGENTS.md)', () => {
  it('squashing code onto fewer lines, or squeezing out spaces, makes a file no smaller', () => {
    const line = 'const total = items.reduce((sum, item) => sum + item.amount, 0);\n';
    const code = line.repeat(300);
    const squashed = line.trimEnd().repeat(300).replace(/ /g, '');
    expect(sizeInLines(squashed)).toBe(sizeInLines(code));
    expect(sizeInLines('\n'.repeat(10))).toBe(10);
  });

  it(`no file is longer than ${MAX_LINES} lines`, () => {
    const long = sizes
      .filter(([, n]) => n > MAX_LINES)
      .map(([f, n]) => `${f}: ${n} ${counted(f)} (split it by its sections and update the folder README)`);
    expect(long).toEqual([]);
  });

  it(`a file over ${AIM_LINES} lines doesn't grow`, () => {
    const bad = sizes.flatMap(([f, n]) => {
      if (n <= AIM_LINES) return [];
      const was = OVER_AIM[f];
      if (was === undefined) return [`${f}: ${n} ${counted(f)}, over ${AIM_LINES}. Split it by its sections (calculations into logic/) and update the folder README`];
      if (n > was) return [`${f}: grew from ${was} to ${n} ${counted(f)}. Split it before adding to it (joining lines doesn't help), and update OVER_AIM in this test`];
      return [];
    });
    expect(bad).toEqual([]);
  });

  it('OVER_AIM lists each big file at its size now, so the list only gets shorter', () => {
    const now = new Map(sizes);
    const stale = Object.entries(OVER_AIM).flatMap(([f, was]) => {
      const n = now.get(f);
      if (n === undefined) return [`${f} is gone: remove it from OVER_AIM`];
      if (n <= AIM_LINES) return [`${f} is ${n} lines now, under ${AIM_LINES}: remove it from OVER_AIM`];
      if (n < was) return [`${f} is ${n} lines now: lower its number in OVER_AIM to ${n}`];
      return [];
    });
    expect(stale).toEqual([]);
  });

  it('core/, engine/ and every logic/ folder are plain functions: no React, no components', () => {
    const bad: string[] = [];
    for (const [f, text] of Object.entries(sources)) {
      if (!pure(f) || f.endsWith('.css')) continue;
      if (f.endsWith('.tsx')) bad.push(`${f} is a component file: move it out of this logic folder`);
      for (const i of importsOf(text)) {
        if (/^react(-dom)?(\/|$)/.test(i.spec) || isTsx(f, i.spec)) bad.push(`${f}:${i.line} imports ${i.spec} (keep React in the *.tsx files around it)`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('ui/ knows nothing about the budget: it never imports app/, engine/, state/, features/, services/ or shared/', () => {
    const bad: string[] = [];
    for (const [f, text] of Object.entries(sources)) {
      if (!f.startsWith('/src/ui/')) continue;
      for (const i of importsOf(text)) {
        const layer = layerOf(f, i.spec);
        if (layer && ['app', 'engine', 'state', 'features', 'services', 'shared'].includes(layer)) bad.push(`${f}:${i.line} imports ${i.spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('core/ only takes types from the rest of the app, never code', () => {
    const bad: string[] = [];
    for (const [f, text] of Object.entries(sources)) {
      if (!f.startsWith('/src/core/') || f.endsWith('.test.ts')) continue;
      for (const i of importsOf(text)) {
        const layer = layerOf(f, i.spec);
        if (layer && layer !== 'core' && !i.typeOnly) bad.push(`${f}:${i.line} imports code from ${i.spec} (use \`import type\`, or move the code)`);
      }
    }
    expect(bad).toEqual([]);
  });
});
