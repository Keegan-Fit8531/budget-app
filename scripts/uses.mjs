// Where is this used? Lists every file in src/ that uses a function, type or file, so a change to shared
// logic reaches every page that shows it.
//   npm run uses -- envelopeHeld            files that use envelopeHeld, with the lines
//   npm run uses -- engine/envelope.ts      each thing the file exports, and the files that use it
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const src = join(root, 'src');
const arg = process.argv[2];
if (!arg) {
  console.log('Usage: npm run uses -- <name or file>, e.g. npm run uses -- envelopeHeld, or engine/envelope.ts');
  process.exit(1);
}

/** Every .ts / .tsx file under src/, except src/personal (your own data). */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (p === join(src, 'personal')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(src).map((p) => ({ p, rel: relative(src, p), text: readFileSync(p, 'utf8') }));
const isTest = (rel) => /\.test\.tsx?$/.test(rel);

/** Files (other than `skip`) that mention `name` as a whole word, with their line numbers. */
function usersOf(name, skip) {
  const re = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`);
  return files
    .filter((f) => f.p !== skip && re.test(f.text))
    .map((f) => ({ ...f, lines: f.text.split('\n').flatMap((l, i) => (re.test(l) ? [i + 1] : [])) }));
}

function print(users, indent = '') {
  const app = users.filter((u) => !isTest(u.rel));
  const tests = users.filter((u) => isTest(u.rel));
  if (!users.length) console.log(`${indent}(not used anywhere else)`);
  for (const u of app) console.log(`${indent}${u.rel}:${u.lines.slice(0, 6).join(',')}${u.lines.length > 6 ? ',…' : ''}`);
  if (tests.length) console.log(`${indent}tests: ${tests.map((u) => u.rel).join(', ')}`);
}

const asFile = files.find((f) => f.rel === arg || f.rel === `${arg}.ts` || f.rel === `${arg}.tsx`);
if (asFile) {
  // `export function x`, `export const x`, `export type X`, `export interface X`, and `export { a, b } from`.
  const names = new Set();
  for (const m of asFile.text.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of asFile.text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name.replace(/^type\s+/, ''));
    }
  }
  console.log(`${asFile.rel} exports ${names.size}:`);
  for (const name of [...names].sort()) {
    console.log(`\n${name}`);
    print(usersOf(name, asFile.p), '  ');
  }
} else {
  print(usersOf(arg));
}
