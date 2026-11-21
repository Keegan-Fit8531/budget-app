import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------------------------
// Every folder in src has a README.md, and it names every file and folder in it. The READMEs are how
// an AI (or a person) finds its way around without reading the whole app, so they have to stay true:
// add, rename or remove a file and this fails until its folder's README says so.
// See AGENTS.md → "Keeping the READMEs current".
// ---------------------------------------------------------------------------------------------

// Paths only (nothing is imported). src/personal is your own data, kept on your computer only.
const files = Object.keys(import.meta.glob(['/src/**/*', '!/src/personal/**']));
const readmes = import.meta.glob<string>(['/src/**/README.md', '!/src/personal/**'], { query: '?raw', import: 'default', eager: true });

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'));
const folders = new Set<string>();
for (const f of files) for (let d = dirOf(f); d.startsWith('/src'); d = dirOf(d)) folders.add(d);

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
