import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { searchSessionContents, warmSessionSearch, sessionSearchStats } from '../assets/piweb-overlay/merge/lib/session-search.ts';

const entry = (text, id = 'u1') => JSON.stringify({ type: 'message', id, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
function fixture(t, text = 'first needle') {
  const dir = mkdtempSync(join(tmpdir(), 'pi-search-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 's.jsonl'); writeFileSync(path, entry(text));
  return { id: dir, path, cwd: dir, firstMessage: 'first', created: '2026-01-01', modified: '2026-01-01', messageCount: 1 };
}

test('renamed titles are searchable and outrank newer incidental body matches', async t => {
  const old = { ...fixture(t, 'unrelated body'), name: '搜索加速', modified: '2025-01-01' };
  const recent = { ...fixture(t, '顺便提一下搜索加速'), modified: '2026-01-01' };
  const result = await searchSessionContents([recent, old], '搜索加速');
  assert.deepEqual(result.results.map(item => item.session.id), [old.id, recent.id]);
  assert.equal(result.results[0].match, '搜索加速');
});

test('space-separated words require AND, including words in different messages', async t => {
  const both = fixture(t, 'piweb sidebar');
  appendFileSync(both.path, entry('search performance', 'u2'));
  const only = fixture(t, 'piweb unrelated');
  const result = await searchSessionContents([only, both], 'piweb search');
  assert.deepEqual(result.results.map(item => item.session.id), [both.id]);
  assert.equal(result.truncated, false);
});

test('an exact phrase outranks scattered words and keeps its historical anchor', async t => {
  const scattered = fixture(t, 'piweb unrelated search');
  const phrase = { ...fixture(t, 'piweb search'), modified: '2025-01-01' };
  const result = await searchSessionContents([scattered, phrase], 'piweb search');
  assert.deepEqual(result.results.map(item => item.session.id), [phrase.id, scattered.id]);
  assert.equal(result.results[0].entryId, 'u1');
  assert.equal(result.results[0].match, 'piweb search');
});

test('ranking scans beyond thirty body hits to find the best old title', async t => {
  const common = fixture(t, 'needle');
  const recent = Array.from({length: 35}, (_, i) => ({...common, id:'recent-'+i}));
  const exact = { ...fixture(t, 'unrelated'), name: 'needle', modified: '2020-01-01' };
  const result = await searchSessionContents([...recent, exact], 'needle');
  assert.equal(result.results[0].session.id, exact.id);
  assert.equal(result.results.length, 30);
  assert.equal(result.truncated, true);
});

test('prewarming caches text once; different and repeated queries do not reread transcripts', async t => {
  const s = fixture(t);
  await warmSessionSearch([s]);
  const reads = sessionSearchStats.fileReads;
  for (const q of ['needle', 'FIRST', 'absent', 'needle']) {
    const result = await searchSessionContents([s], q);
    assert.equal(result.results.length, q === 'absent' ? 0 : 1);
    assert.equal(result.truncated, false);
  }
  assert.equal(sessionSearchStats.fileReads, reads);
});

test('overlapping queries and warm requests share a single file read', async t => {
  const s = fixture(t, 'a'.repeat(2 * 1024 * 1024) + ' needle');
  const before = sessionSearchStats.fileReads;
  const results = await Promise.all([searchSessionContents([s], 'needle'), searchSessionContents([s], 'absent'), warmSessionSearch([s])]);
  assert.equal(results[0].results[0].match, 'needle');
  assert.equal(sessionSearchStats.fileReads - before, 1);
});

test('appending refreshes only the changed file and exposes the new entry', async t => {
  const changed = fixture(t), stable = fixture(t);
  await warmSessionSearch([changed, stable]);
  const reads = sessionSearchStats.fileReads;
  appendFileSync(changed.path, entry('fresh append 中文', 'u2'));
  const result = await searchSessionContents([changed, stable], 'append');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].entryId, 'u2');
  assert.equal(sessionSearchStats.fileReads - reads, 1);
});

test('same-size rewrite cannot return a stale cached match', async t => {
  const s = fixture(t, 'first needle'); await warmSessionSearch([s]);
  writeFileSync(s.path, entry('other marker'));
  assert.equal((await searchSessionContents([s], 'needle')).results.length, 0);
  assert.equal((await searchSessionContents([s], 'marker')).results.length, 1);
});

test('truncate, remove and move are not negative cached', async t => {
  const s = fixture(t); await warmSessionSearch([s]);
  writeFileSync(s.path, '');
  assert.equal((await searchSessionContents([s], 'needle')).results.length, 0);
  writeFileSync(s.path, entry('restored needle'));
  const moved = s.path + '.moved'; renameSync(s.path, moved);
  assert.equal((await searchSessionContents([s], 'needle')).truncated, true);
  renameSync(moved, s.path);
  assert.equal((await searchSessionContents([s], 'restored')).results.length, 1);
});

test('cancelled queries do not read files or prevent later queries', async t => {
  const s = fixture(t); const reads = sessionSearchStats.fileReads;
  const result = await searchSessionContents([s], 'needle', AbortSignal.abort());
  assert.deepEqual(result, { results: [], truncated: true });
  assert.equal(sessionSearchStats.fileReads, reads);
  assert.equal((await searchSessionContents([s], 'needle')).results.length, 1);
});

test('prewarmed text keeps multi-block Unicode offsets and excludes tools and images', async t => {
  const s = fixture(t);
  writeFileSync(s.path, JSON.stringify({type:'message',id:'a1',message:{role:'assistant',content:[{type:'thinking',thinking:'secret'},{type:'text',text:'正文第一段'},{type:'image',data:'secret'},{type:'toolCall',arguments:{text:'secret'}},{type:'text',text:'中文 NEEDLE 后文'}]}})+'\n');
  await warmSessionSearch([s]);
  const result = await searchSessionContents([s], '段\n中文 needle');
  assert.equal(result.results[0].entryId, 'a1');
  assert.equal(result.results[0].blockIndex, 1);
  assert.equal((await searchSessionContents([s], 'secret')).results.length, 0);
});
