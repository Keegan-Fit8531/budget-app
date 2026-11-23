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
 * The files already over AIM_LINES, at their size now. Split one before adding to it. When one shrinks,
 * lower its number here (or remove it once it's under AIM_LINES): this list only ever gets shorter.
 */
const OVER_AIM: Record<string, number> = {
  '/src/features/accounts/MonthTracker.tsx': 418,
  '/src/services/reader/check/check.test.ts': 406,
};

const sources = import.meta.glob<string>(['/src/**/*.{ts,tsx,css}', '!/src/personal/**', '!/src/vite-env.d.ts'], { query: '?raw', import: 'default', eager: true });
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
/** Lines as an editor counts them (a final newline doesn't start another line). */
const lineCount = (text: string) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
const sizes = Object.entries(sources).map(([f, text]) => [f, lineCount(text)] as const);

describe('folder rules (AGENTS.md)', () => {
  it(`no file is longer than ${MAX_LINES} lines`, () => {
    const long = sizes
      .filter(([, n]) => n > MAX_LINES)
      .map(([f, n]) => `${f}: ${n} lines (split it by its sections and update the folder README)`);
    expect(long).toEqual([]);
  });

  it(`a file over ${AIM_LINES} lines doesn't grow`, () => {
    const bad = sizes.flatMap(([f, n]) => {
      if (n <= AIM_LINES) return [];
      const was = OVER_AIM[f];
      if (was === undefined) return [`${f}: ${n} lines, over ${AIM_LINES}. Split it by its sections (calculations into logic/) and update the folder README`];
      if (n > was) return [`${f}: grew from ${was} to ${n} lines. Split it before adding to it, and update OVER_AIM in this test`];
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
