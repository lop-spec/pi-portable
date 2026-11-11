import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, renameSync, readFileSync, statSync, utimesSync } from 'node:fs';
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

test('renamed titles remain searchable without overriding newest-first order', async t => {
  const old = { ...fixture(t, 'unrelated body'), name: '搜索加速', modified: '2025-01-01' };
  const recent = { ...fixture(t, '顺便提一下搜索加速'), modified: '2026-01-01' };
  const result = await searchSessionContents([recent, old], '搜索加速');
  assert.deepEqual(result.results.map(item => item.session.id), [recent.id, old.id]);
  assert.equal(result.results[1].match, '搜索加速');
});

test('space-separated words require AND, including words in different messages', async t => {
  const both = fixture(t, 'piweb sidebar');
  appendFileSync(both.path, entry('search performance', 'u2'));
  const only = fixture(t, 'piweb unrelated');
  const result = await searchSessionContents([only, both], 'piweb search');
  assert.deepEqual(result.results.map(item => item.session.id), [both.id]);
  assert.equal(result.truncated, false);
});

test('exact phrases keep their historical anchor without overriding time order', async t => {
  const scattered = fixture(t, 'piweb unrelated search');
  const phrase = { ...fixture(t, 'piweb search'), modified: '2025-01-01' };
  const result = await searchSessionContents([scattered, phrase], 'piweb search');
  assert.deepEqual(result.results.map(item => item.session.id), [scattered.id, phrase.id]);
  assert.equal(result.results[1].entryId, 'u1');
  assert.equal(result.results[1].match, 'piweb search');
});

test('time order is applied before the thirty-result cap, including older title matches', async t => {
  const common = fixture(t, 'needle');
  const recent = Array.from({length: 35}, (_, i) => ({...common, id:'recent-'+i}));
  const exact = { ...fixture(t, 'unrelated'), name: 'needle', modified: '2020-01-01' };
  const result = await searchSessionContents([...recent, exact], 'needle');
  assert.deepEqual(result.results.map(item => item.session.id), recent.slice(0, 30).map(item => item.id));
  assert.equal(result.truncated, true);
  const ascending = await searchSessionContents([...recent, exact], 'needle', undefined, 'asc');
  assert.equal(ascending.results[0].session.id, exact.id);
  assert.equal(ascending.results.length, 30);
  assert.equal(ascending.truncated, true);
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

test('same-size rewrite with a changed file timestamp refreshes the cache', async t => {
  const s = fixture(t, 'first needle'); await warmSessionSearch([s]);
  const changedTime = new Date(statSync(s.path).mtimeMs + 1000);
  writeFileSync(s.path, entry('other marker'));
  // NTFS can timestamp two quick writes at the same clock tick. This fixture
  // explicitly changes the fingerprint instead of depending on runner timing.
  utimesSync(s.path, changedTime, changedTime);
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

test('both directions select the chronological first thirty, not the same thirty reversed', async t => {
  const s = fixture(t);
  const sessions = Array.from({ length: 42 }, (_, index) => ({
    ...s, id: String(index), modified: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }));
  const originalIds = sessions.map(item => item.id);
  const newest = await searchSessionContents(sessions, 'needle');
  const reads = sessionSearchStats.fileReads;
  const oldest = await searchSessionContents(sessions, 'needle', undefined, 'asc');
  assert.deepEqual(newest.results.map(item => item.session.id), originalIds.slice().reverse().slice(0, 30));
  assert.deepEqual(oldest.results.map(item => item.session.id), originalIds.slice(0, 30));
  assert.equal(newest.truncated, true);
  assert.equal(oldest.truncated, true);
  assert.equal(sessionSearchStats.fileReads, reads, 'changing order reuses text cache');
  assert.deepEqual(sessions.map(item => item.id), originalIds, 'catalogue is not mutated');
});

test('time sorting compares instants across timezones and keeps unknown times last', async t => {
  const s = fixture(t);
  const sessions = [
    { ...s, id: 'unknown', modified: 'invalid' },
    { ...s, id: 'older', modified: '2026-01-01T09:00:00+08:00' },
    { ...s, id: 'newer', modified: '2026-01-01T02:00:00Z' },
    { ...s, id: 'same-time', modified: '2026-01-01T01:00:00Z' },
  ];
  assert.deepEqual((await searchSessionContents(sessions, 'needle')).results.map(item => item.session.id), ['newer', 'older', 'same-time', 'unknown']);
  assert.deepEqual((await searchSessionContents(sessions, 'needle', undefined, 'asc')).results.map(item => item.session.id), ['older', 'same-time', 'newer', 'unknown']);
});

test('sorting keeps empty, cancelled and complete searches honest', async t => {
  const s = fixture(t);
  assert.deepEqual(await searchSessionContents([s], '', undefined, 'asc'), { results: [], truncated: false });
  assert.deepEqual(await searchSessionContents([s], 'needle', AbortSignal.abort(), 'asc'), { results: [], truncated: true });
  assert.equal((await searchSessionContents([s], 'needle', undefined, 'asc')).truncated, false);
});

test('the UI requests time order and rejects stale responses; the API forwards a safe default', () => {
  const read = path => readFileSync(new URL('../assets/piweb-overlay/redesign/files/' + path, import.meta.url), 'utf8');
  const ui = read('components/SessionSearch.tsx');
  assert.match(ui, /useState<"desc" \| "asc">\("desc"\)/);
  assert.match(ui, /state\.query === search && state\.order === order/);
  assert.match(ui, /new URLSearchParams\(\{ q: search, order \}\)/);
  assert.match(ui, /controller\.abort\(\)/);
  assert.match(ui, /\[open, search, order\]/);
  assert.match(ui, /className="pw-search-sort"/);
  assert.match(ui, /previous === "desc" \? "asc" : "desc"/);
  assert.match(ui, /aria-label=\{t\(order === "desc"/);
  const route = read('app/api/sessions/search/route.ts');
  assert.match(route, /params\.get\("order"\) === "asc" \? "asc" : "desc"/);
  assert.match(route, /searchSessionContents\(sessions, query, request\.signal, order\)/);
});
