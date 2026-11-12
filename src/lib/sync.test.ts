import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedBudget } from './seed';
import { pullBudget, pushBudget, SyncError, type SyncConfig } from './sync';

const c: SyncConfig = { repo: 'me/budget-data', path: 'budget.json', token: 't' };

/** A pretend GitHub contents API holding one file. */
function fakeGitHub() {
  const file: { content?: string; sha?: string } = {};
  let n = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.includes('/contents/')) return new Response('{}', { status: 200 }); // the repo exists
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { content: string; sha?: string };
      if (file.sha !== body.sha) return new Response('{}', { status: 409 });
      file.content = body.content; file.sha = `v${++n}`;
      return Response.json({ content: { sha: file.sha } });
    }
    return file.sha ? Response.json({ content: file.content, sha: file.sha }) : new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe('sync with a private GitHub repo', () => {
  it('no file yet: pull gives nothing, and the first push creates it', async () => {
    fakeGitHub();
    expect(await pullBudget(c)).toBeNull();
    const b = { ...structuredClone(seedBudget), updatedAt: '2026-11-13T00:00:00Z' };
    const sha = await pushBudget(c, b);
    expect(sha).toBe('v1');
    expect((await pullBudget(c))!.budget).toEqual(b);
  });
  it('keeps names and symbols intact (e.g. "Café · ā")', async () => {
    fakeGitHub();
    const b = structuredClone(seedBudget);
    b.accounts[0].name = 'Café · ā';
    await pushBudget(c, b);
    expect((await pullBudget(c))!.budget.accounts[0].name).toBe('Café · ā');
  });
  it('saving over a copy changed in another browser is refused, so nothing is lost', async () => {
    fakeGitHub();
    const first = await pushBudget(c, seedBudget);
    await pushBudget(c, seedBudget, first); // another browser saves
    await expect(pushBudget(c, seedBudget, first)).rejects.toMatchObject({ status: 409 });
  });
  it('a bad token says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    await expect(pullBudget(c)).rejects.toBeInstanceOf(SyncError);
    await expect(pullBudget(c)).rejects.toThrow(/token/);
  });
});
