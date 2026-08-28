import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const CANONICAL_SCHEMA_VERSION = 2;
export const OUTCOMES = Object.freeze([
  '已采纳', '已纠正', '已确认', '已完成', '待处理', '不支持', '仅讨论',
]);
const STRONG_RELATIVE_SCORE_RATIO = 0.7;

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function chars(value) {
  return [...String(value || '')];
}

function charLength(value) {
  return chars(value).length;
}

function normalizeSpace(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function begin(db) {
  db.exec('BEGIN IMMEDIATE');
}

function commit(db) {
  db.exec('COMMIT');
}

function rollback(db) {
  try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
}

function safeJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '-' + crypto.randomBytes(5).toString('hex') + '.tmp';
  fs.writeFileSync(temporary, value, 'utf8');
  try {
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already moved */ }
  }
}

function hasTable(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?"
  ).get(name));
}

export function logicalInputId(sessionId, turnId) {
  return 'i_' + sha256(String(sessionId || '') + '\u0000' + String(turnId || '')).slice(0, 24);
}

export function canonicalEventId(sessionId, turnId) {
  return 'e_live_' + sha256(String(sessionId || '') + '\u0000' + String(turnId || '')).slice(0, 24);
}

function normalizedCategoryPath(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return null;
  const labels = value.map((item) => normalizeSpace(item));
  if (labels.some((label) =>
    charLength(label) < 1 || charLength(label) > 5 || /[\\/|>\r\n]/u.test(label)
  )) return null;
  return labels;
}

function categoryKey(categoryPath) {
  return JSON.stringify(categoryPath);
}

export function categoryId(categoryPath) {
  const normalized = normalizedCategoryPath(categoryPath);
  if (!normalized) throw new Error('分类路径必须是1-3级且每级1-5个字');
  return sha256(categoryKey(normalized));
}

export function ensureCanonicalSchema(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS memory_events (',
    ' event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, semantic_full TEXT NOT NULL,',
    ' summary20 TEXT NOT NULL, outcome TEXT NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL,',
    ' source TEXT NOT NULL, needs_category INTEGER NOT NULL DEFAULT 0,',
    ' created_at TEXT NOT NULL, updated_at TEXT NOT NULL',
    ');',
    'CREATE INDEX IF NOT EXISTS memory_events_session_idx ON memory_events(session_id,last_at DESC);',
    'CREATE INDEX IF NOT EXISTS memory_events_time_idx ON memory_events(last_at DESC);',
    'CREATE TABLE IF NOT EXISTS memory_event_inputs (',
    ' input_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,',
    ' selected_turn_key TEXT NOT NULL, ordinal INTEGER NOT NULL',
    ');',
    'CREATE INDEX IF NOT EXISTS memory_event_inputs_event_idx ON memory_event_inputs(event_id,ordinal);',
    'CREATE TABLE IF NOT EXISTS memory_event_turns (',
    ' turn_key TEXT PRIMARY KEY, event_id TEXT NOT NULL, input_id TEXT NOT NULL,',
    ' source_key TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 0',
    ');',
    'CREATE INDEX IF NOT EXISTS memory_event_turns_event_idx ON memory_event_turns(event_id,input_id);',
    'CREATE TABLE IF NOT EXISTS memory_contexts (',
    ' input_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL,',
    ' selected_turn_key TEXT NOT NULL, created_at TEXT NOT NULL',
    ');',
    'CREATE TABLE IF NOT EXISTS memory_context_turns (',
    ' turn_key TEXT PRIMARY KEY, input_id TEXT NOT NULL, source_key TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 0',
    ');',
    'CREATE INDEX IF NOT EXISTS memory_context_turns_input_idx ON memory_context_turns(input_id);',
    'CREATE TABLE IF NOT EXISTS memory_raw_fallbacks (',
    ' turn_key TEXT PRIMARY KEY, input_id TEXT NOT NULL, source_key TEXT NOT NULL,',
    ' session_id TEXT NOT NULL, kind TEXT NOT NULL, turn_id TEXT NOT NULL, timestamp TEXT NOT NULL,',
    ' prompt TEXT NOT NULL, answer TEXT NOT NULL',
    ');',
    'CREATE INDEX IF NOT EXISTS memory_raw_fallbacks_input_idx ON memory_raw_fallbacks(input_id);',
    'CREATE TABLE IF NOT EXISTS memory_inbox (',
    ' input_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,',
    ' selected_turn_key TEXT NOT NULL, content_hash TEXT NOT NULL, reason TEXT NOT NULL,',
    ' created_at TEXT NOT NULL, updated_at TEXT NOT NULL',
    ');',
    'CREATE TABLE IF NOT EXISTS categories (',
    ' category_id TEXT PRIMARY KEY, parent_id TEXT, level INTEGER NOT NULL, label TEXT NOT NULL,',
    ' path_json TEXT NOT NULL UNIQUE, event_count INTEGER NOT NULL DEFAULT 0,',
    ' split_needed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL',
    ');',
    'CREATE INDEX IF NOT EXISTS categories_parent_idx ON categories(parent_id,label);',
    'CREATE TABLE IF NOT EXISTS event_categories (',
    ' event_id TEXT NOT NULL, category_id TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,',
    ' assigned_at TEXT NOT NULL, PRIMARY KEY(event_id,category_id)',
    ');',
    'CREATE INDEX IF NOT EXISTS event_categories_category_idx ON event_categories(category_id,is_primary,event_id);',
    'CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);',
    "CREATE VIRTUAL TABLE IF NOT EXISTS memory_events_fts USING fts5(",
    " event_id UNINDEXED, summary_terms, semantic_terms, category_terms,",
    " tokenize='unicode61 remove_diacritics 2'",
    ');',
  ].join('\n'));
  return db;
}

function assertCanonicalReadable(db) {
  for (const table of [
    'memory_events', 'memory_event_inputs', 'memory_event_turns', 'memory_contexts',
    'memory_context_turns', 'memory_raw_fallbacks', 'memory_inbox', 'categories',
    'event_categories', 'memory_meta', 'memory_events_fts',
  ]) {
    if (!hasTable(db, table)) throw new Error('canonical memory schema missing: ' + table);
  }
  return db;
}

function semanticTokens(value, maxTokens = 4096) {
  const text = normalizeSpace(value).toLowerCase();
  const out = new Set();
  for (const hit of text.matchAll(/[a-z0-9][a-z0-9_.:-]{1,95}/g)) {
    out.add(hit[0]);
    if (out.size >= maxTokens) break;
  }
  if (out.size < maxTokens) {
    for (const run of text.match(/[\p{Script=Han}]{2,}/gu) || []) {
      const units = chars(run);
      if (units.length <= 8) out.add(run);
      for (let index = 0; index < units.length - 1 && out.size < maxTokens; index += 1) {
        out.add(units.slice(index, index + 2).join(''));
        if (index + 2 < units.length) out.add(units.slice(index, index + 3).join(''));
      }
      if (out.size >= maxTokens) break;
    }
  }
  return [...out].slice(0, maxTokens);
}

function ftsExpression(value, columns = []) {
  const scope = columns.length ? '{' + columns.join(' ') + '} : ' : '';
  return semanticTokens(value, 64).map((token) =>
    scope + '"' + token.replace(/"/g, '""') + '"'
  ).join(' OR ');
}

function eventCategoryPaths(db, eventId) {
  return db.prepare([
    'SELECT c.path_json pathJson,ec.is_primary isPrimary',
    'FROM event_categories ec JOIN categories c ON c.category_id=ec.category_id',
    'WHERE ec.event_id=? ORDER BY ec.is_primary DESC,c.level DESC,c.path_json',
  ].join(' ')).all(eventId).map((row) => safeJson(row.pathJson, [])).filter((row) => row.length);
}

function indexEvent(db, eventId) {
  db.prepare('DELETE FROM memory_events_fts WHERE event_id=?').run(eventId);
  const event = db.prepare('SELECT * FROM memory_events WHERE event_id=?').get(eventId);
  if (!event) return;
  const categoryPaths = eventCategoryPaths(db, eventId);
  const categoryText = categoryPaths.map((item) => item.join(' ')).join(' ');
  db.prepare([
    'INSERT INTO memory_events_fts(event_id,summary_terms,semantic_terms,category_terms)',
    'VALUES(?,?,?,?)',
  ].join(' ')).run(
    eventId,
    semanticTokens(event.summary20, 256).join(' '),
    semanticTokens(event.semantic_full, 4096).join(' '),
    semanticTokens(categoryText, 512).join(' ')
  );
}

function rebuildFts(db) {
  db.prepare('DELETE FROM memory_events_fts').run();
  for (const row of db.prepare('SELECT event_id eventId FROM memory_events ORDER BY event_id').all()) {
    indexEvent(db, row.eventId);
  }
}

function ensureCategory(db, categoryPath, leafLimit = 50) {
  const normalized = normalizedCategoryPath(categoryPath);
  if (!normalized) throw new Error('分类路径无效: ' + JSON.stringify(categoryPath));
  const createdAt = nowIso();
  let parentId = null;
  for (let index = 0; index < normalized.length; index += 1) {
    const currentPath = normalized.slice(0, index + 1);
    const currentId = categoryId(currentPath);
    db.prepare([
      'INSERT INTO categories(category_id,parent_id,level,label,path_json,event_count,split_needed,created_at,updated_at)',
      'VALUES(?,?,?,?,?,0,0,?,?)',
      'ON CONFLICT(category_id) DO UPDATE SET parent_id=excluded.parent_id,level=excluded.level,',
      'label=excluded.label,path_json=excluded.path_json,updated_at=excluded.updated_at',
    ].join(' ')).run(
      currentId, parentId, index + 1, currentPath[index], categoryKey(currentPath), createdAt, createdAt
    );
    parentId = currentId;
  }
  const leafId = categoryId(normalized);
  const count = Number(db.prepare(
    'SELECT count(DISTINCT event_id) count FROM event_categories WHERE category_id=?'
  ).get(leafId)?.count || 0);
  db.prepare('UPDATE categories SET split_needed=? WHERE category_id=?')
    .run(count > leafLimit ? 1 : 0, leafId);
  return leafId;
}

function validatePurifiedArtifact(artifact, leafLimit) {
  const scalar = (sql, ...args) => Number(artifact.prepare(sql).get(...args)?.count || 0);
  const logicalInputs = scalar('SELECT count(*) count FROM input_turns');
  const sourceRows = scalar('SELECT count(*) count FROM raw_rows');
  const covered = scalar([
    'SELECT count(*) count FROM (',
    'SELECT input_id FROM event_members UNION SELECT input_id FROM context_items',
    ')',
  ].join(' '));
  const duplicateCoverage = scalar([
    'SELECT count(*) count FROM (',
    'SELECT input_id,count(*) n FROM (',
    'SELECT input_id FROM event_members UNION ALL SELECT input_id FROM context_items',
    ') GROUP BY input_id HAVING n<>1',
    ')',
  ].join(' '));
  const rawOrphans = scalar([
    'SELECT count(*) count FROM raw_rows r LEFT JOIN input_turns i ON i.input_id=r.input_id',
    'WHERE i.input_id IS NULL',
  ].join(' '));
  const crossSession = scalar([
    'SELECT count(*) count FROM events e JOIN event_members em ON em.event_id=e.event_id',
    'JOIN input_turns i ON i.input_id=em.input_id WHERE i.session_id<>e.session_id',
  ].join(' '));
  const events = artifact.prepare(
    'SELECT event_id eventId,semantic_full semanticFull,summary20,outcome,category_path categoryPath FROM events'
  ).all();
  const invalid = [];
  const leaves = new Map();
  for (const event of events) {
    const categoryPath = normalizedCategoryPath(safeJson(event.categoryPath, null));
    if (charLength(event.semanticFull) < 4 || charLength(event.semanticFull) > 2000 ||
        String(event.semanticFull).includes('[中段省略]')) invalid.push(event.eventId + ':semantic');
    if (charLength(event.summary20) < 2 || charLength(event.summary20) > 20) {
      invalid.push(event.eventId + ':summary');
    }
    if (!OUTCOMES.includes(String(event.outcome))) invalid.push(event.eventId + ':outcome');
    if (!categoryPath) invalid.push(event.eventId + ':category');
    else leaves.set(categoryKey(categoryPath), (leaves.get(categoryKey(categoryPath)) || 0) + 1);
  }
  const overloaded = [...leaves].filter(([, count]) => count > leafLimit);
  if (logicalInputs !== covered || duplicateCoverage || rawOrphans || crossSession ||
      invalid.length || overloaded.length) {
    throw new Error('净化产物审计失败: ' + JSON.stringify({
      logicalInputs, covered, duplicateCoverage, rawOrphans, crossSession,
      invalid: invalid.slice(0, 10), overloaded: overloaded.slice(0, 10),
    }));
  }
  return { logicalInputs, sourceRows, events: events.length, leaves: leaves.size };
}

function resetCanonical(db) {
  for (const table of [
    'memory_events_fts', 'event_categories', 'categories', 'memory_event_turns',
    'memory_event_inputs', 'memory_context_turns', 'memory_contexts', 'memory_inbox',
    'memory_raw_fallbacks', 'memory_events', 'memory_meta',
  ]) db.prepare('DELETE FROM ' + table).run();
}

function setMeta(db, key, value) {
  db.prepare([
    'INSERT INTO memory_meta(key,value) VALUES(?,?)',
    'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ].join(' ')).run(String(key), String(value));
}

export function importPurifiedArtifact(db, artifactFile, options = {}) {
  ensureCanonicalSchema(db);
  const leafLimit = Math.max(1, Number(options.leafLimit) || 50);
  const artifact = new DatabaseSync(path.resolve(artifactFile), { readOnly: true });
  let audit;
  try {
    audit = validatePurifiedArtifact(artifact, leafLimit);
    const events = artifact.prepare([
      'SELECT e.event_id eventId,e.session_id sessionId,e.semantic_full semanticFull,',
      'e.summary20,e.outcome,e.category_path categoryPath,min(i.timestamp) firstAt,max(i.timestamp) lastAt',
      'FROM events e JOIN event_members em ON em.event_id=e.event_id',
      'JOIN input_turns i ON i.input_id=em.input_id GROUP BY e.event_id ORDER BY e.event_id',
    ].join(' ')).all();
    const members = artifact.prepare([
      'SELECT em.input_id inputId,em.event_id eventId,i.session_id sessionId,i.turn_id turnId,',
      'i.selected_raw_turn_key selectedTurnKey,i.session_ordinal ordinal',
      'FROM event_members em JOIN input_turns i ON i.input_id=em.input_id',
      'ORDER BY em.event_id,i.session_ordinal,i.input_id',
    ].join(' ')).all();
    const eventTurns = artifact.prepare([
      'SELECT r.raw_turn_key turnKey,r.source_key sourceKey,r.input_id inputId,em.event_id eventId,',
      'CASE WHEN r.raw_turn_key=i.selected_raw_turn_key THEN 1 ELSE 0 END selected',
      'FROM raw_rows r JOIN event_members em ON em.input_id=r.input_id',
      'JOIN input_turns i ON i.input_id=r.input_id ORDER BY r.raw_turn_key',
    ].join(' ')).all();
    const contexts = artifact.prepare([
      'SELECT c.input_id inputId,i.session_id sessionId,c.kind,c.reason,',
      'i.selected_raw_turn_key selectedTurnKey',
      'FROM context_items c JOIN input_turns i ON i.input_id=c.input_id ORDER BY c.input_id',
    ].join(' ')).all();
    const contextTurns = artifact.prepare([
      'SELECT r.raw_turn_key turnKey,r.source_key sourceKey,r.input_id inputId,',
      'CASE WHEN r.raw_turn_key=i.selected_raw_turn_key THEN 1 ELSE 0 END selected',
      'FROM raw_rows r JOIN context_items c ON c.input_id=r.input_id',
      'JOIN input_turns i ON i.input_id=r.input_id ORDER BY r.raw_turn_key',
    ].join(' ')).all();
    const rawSelections = artifact.prepare([
      'SELECT i.selected_raw_turn_key turnKey,i.input_id inputId,r.source_key sourceKey,',
      'i.session_id sessionId,i.kind,i.turn_id turnId,i.timestamp,i.prompt,i.answer',
      'FROM input_turns i JOIN raw_rows r ON r.input_id=i.input_id',
      'AND r.raw_turn_key=i.selected_raw_turn_key ORDER BY i.input_id',
    ].join(' ')).all();
    const importedAt = nowIso();
    begin(db);
    try {
      resetCanonical(db);
      const saveEvent = db.prepare([
        'INSERT INTO memory_events(event_id,session_id,semantic_full,summary20,outcome,first_at,last_at,',
        'source,needs_category,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?,?)',
      ].join(' '));
      const saveCategoryEvent = db.prepare([
        'INSERT INTO event_categories(event_id,category_id,is_primary,assigned_at) VALUES(?,?,1,?)',
      ].join(' '));
      const prefixCounts = new Map();
      const leafCounts = new Map();
      for (const event of events) {
        const categoryPath = normalizedCategoryPath(safeJson(event.categoryPath, null));
        saveEvent.run(
          event.eventId, event.sessionId, event.semanticFull, event.summary20, event.outcome,
          event.firstAt, event.lastAt, 'offline-purifier-v2', importedAt, importedAt
        );
        const leafId = ensureCategory(db, categoryPath, leafLimit);
        saveCategoryEvent.run(event.eventId, leafId, importedAt);
        leafCounts.set(leafId, (leafCounts.get(leafId) || 0) + 1);
        for (let level = 1; level <= categoryPath.length; level += 1) {
          const id = categoryId(categoryPath.slice(0, level));
          prefixCounts.set(id, (prefixCounts.get(id) || 0) + 1);
        }
      }
      const saveInput = db.prepare([
        'INSERT INTO memory_event_inputs(input_id,event_id,session_id,turn_id,selected_turn_key,ordinal)',
        'VALUES(?,?,?,?,?,?)',
      ].join(' '));
      for (const row of members) {
        saveInput.run(row.inputId, row.eventId, row.sessionId, row.turnId, row.selectedTurnKey, row.ordinal);
      }
      const saveTurn = db.prepare([
        'INSERT INTO memory_event_turns(turn_key,event_id,input_id,source_key,selected) VALUES(?,?,?,?,?)',
      ].join(' '));
      for (const row of eventTurns) {
        saveTurn.run(row.turnKey, row.eventId, row.inputId, row.sourceKey, row.selected);
      }
      const saveContext = db.prepare([
        'INSERT INTO memory_contexts(input_id,session_id,kind,reason,selected_turn_key,created_at)',
        'VALUES(?,?,?,?,?,?)',
      ].join(' '));
      for (const row of contexts) {
        saveContext.run(row.inputId, row.sessionId, row.kind, row.reason, row.selectedTurnKey, importedAt);
      }
      const saveContextTurn = db.prepare([
        'INSERT INTO memory_context_turns(turn_key,input_id,source_key,selected) VALUES(?,?,?,?)',
      ].join(' '));
      for (const row of contextTurns) {
        saveContextTurn.run(row.turnKey, row.inputId, row.sourceKey, row.selected);
      }
      const rawExists = hasTable(db, 'turns')
        ? db.prepare('SELECT 1 found FROM turns WHERE turn_key=?')
        : null;
      const saveFallback = db.prepare([
        'INSERT INTO memory_raw_fallbacks(',
        'turn_key,input_id,source_key,session_id,kind,turn_id,timestamp,prompt,answer',
        ') VALUES(?,?,?,?,?,?,?,?,?)',
      ].join(' '));
      for (const row of rawSelections) {
        if (rawExists?.get(row.turnKey)) continue;
        saveFallback.run(
          row.turnKey, row.inputId, row.sourceKey, row.sessionId, row.kind,
          row.turnId, row.timestamp, row.prompt, row.answer
        );
      }
      for (const [id, count] of prefixCounts) {
        db.prepare('UPDATE categories SET event_count=?,updated_at=? WHERE category_id=?')
          .run(count, importedAt, id);
      }
      for (const [id, count] of leafCounts) {
        db.prepare('UPDATE categories SET split_needed=? WHERE category_id=?')
          .run(count > leafLimit ? 1 : 0, id);
      }
      setMeta(db, 'canonical_schema', CANONICAL_SCHEMA_VERSION);
      setMeta(db, 'artifact_path', path.resolve(artifactFile));
      setMeta(db, 'artifact_source_sha256',
        artifact.prepare("SELECT value FROM meta WHERE key='source_sha256'").get()?.value || '');
      setMeta(db, 'imported_at', importedAt);
      rebuildFts(db);
      commit(db);
    } catch (error) {
      rollback(db);
      throw error;
    }
  } finally {
    artifact.close();
  }
  const inbox = syncCanonicalInbox(db);
  return { ...audit, ...canonicalStats(db), inbox };
}

function outcomeWeight(outcome) {
  return ({
    '已纠正': 4.0,
    '已采纳': 3.4,
    '已确认': 2.6,
    '已完成': 2.4,
    '待处理': 1.0,
    '不支持': 0.7,
    '仅讨论': 0.5,
  })[outcome] || 0;
}

function recencyWeight(timestamp) {
  const ageDays = Math.max(0, (Date.now() - Date.parse(timestamp || 0)) / 86400000);
  if (!Number.isFinite(ageDays)) return 0;
  return Math.exp(-ageDays / 730) * 2;
}

function semanticTokenWeight(token) {
  return /^[a-z0-9]/i.test(token)
    ? Math.max(3, token.length)
    : Math.max(1, charLength(token) - 1);
}

function rankCandidates(db, rows, wantedText, options = {}) {
  const wanted = new Set(semanticTokens(wantedText, 128));
  const wantedWeight = [...wanted].reduce((sum, token) => sum + semanticTokenWeight(token), 0);
  return rows.map((row) => {
    const categoryPaths = eventCategoryPaths(db, row.event_id);
    const available = new Set(semanticTokens(
      row.summary20 + '\n' + row.semantic_full + '\n' +
      (options.includeCategoryTerms === false
        ? ''
        : categoryPaths.map((item) => item.join(' ')).join('\n')),
      4096
    ));
    let overlap = 0;
    for (const token of wanted) {
      if (!available.has(token)) continue;
      overlap += semanticTokenWeight(token);
    }
    const rank = Number(row.rank);
    const bm25 = Number.isFinite(rank) ? -rank : 0;
    const score = overlap * 5 + bm25 * 2 + outcomeWeight(row.outcome) + recencyWeight(row.last_at);
    return {
      eventId: row.event_id,
      sessionId: row.session_id,
      semanticFull: row.semantic_full,
      summary20: row.summary20,
      outcome: row.outcome,
      firstAt: row.first_at,
      lastAt: row.last_at,
      needsCategory: Boolean(row.needs_category),
      categoryPaths,
      overlap,
      wantedWeight,
      coverage: wantedWeight ? overlap / wantedWeight : 1,
      bm25,
      score,
    };
  }).sort((left, right) =>
    right.score - left.score || String(right.lastAt).localeCompare(String(left.lastAt)) ||
    left.eventId.localeCompare(right.eventId)
  );
}

function queryCanonicalEventsSingle(db, prompt, options = {}) {
  const limit = Math.max(1, Math.min(500, Number(options.limit) || 150));
  const sessionId = String(options.sessionId || '');
  const semanticOnly = options.semanticOnly === true;
  const match = ftsExpression(prompt, semanticOnly ? ['summary_terms', 'semantic_terms'] : []);
  let rows;
  if (match) {
    rows = db.prepare([
      'SELECT e.*,bm25(memory_events_fts,0.0,8.0,3.0,' +
        (semanticOnly ? '0.0' : '6.0') + ') rank',
      'FROM memory_events_fts JOIN memory_events e ON e.event_id=memory_events_fts.event_id',
      "WHERE memory_events_fts MATCH ? AND (?='' OR e.session_id<>?)",
      'ORDER BY rank,e.last_at DESC LIMIT ?',
    ].join(' ')).all(match, sessionId, sessionId, limit);
  } else {
    rows = db.prepare([
      'SELECT e.*,0 rank FROM memory_events e',
      "WHERE (?='' OR e.session_id<>?) ORDER BY e.last_at DESC LIMIT ?",
    ].join(' ')).all(sessionId, sessionId, limit);
  }
  return rankCandidates(db, rows, prompt, { includeCategoryTerms: !semanticOnly });
}

export function queryCanonicalEvents(db, prompt, options = {}) {
  assertCanonicalReadable(db);
  const current = queryCanonicalEventsSingle(db, prompt, options);
  const contextPrompts = (Array.isArray(options.contextPrompts) ? options.contextPrompts : [])
    .map(normalizeSpace)
    .filter((item) => item && item !== normalizeSpace(prompt))
    .slice(-3);
  if (!contextPrompts.length || options.semanticOnly === true) return current;

  // 追问上下文只负责重排当前问题已经命中的候选，不能把一个与当前问题零交集的旧话题
  // 硬塞进来。这样“算了，统计全库”能继承同一 turn 的 Mongo 实体，而真正换话题时
  // 仍以当前提示为准。
  const contextual = queryCanonicalEventsSingle(
    db,
    [prompt, ...contextPrompts].join('\n'),
    options
  );
  const currentById = new Map(current.map((row) => [row.eventId, row]));
  const reranked = [];
  const seen = new Set();
  for (const row of contextual) {
    const base = currentById.get(row.eventId);
    if (!base || base.overlap <= 0) continue;
    reranked.push({
      ...base,
      score: row.score,
      contextualScore: row.score,
      contextUsed: true,
    });
    seen.add(row.eventId);
  }
  for (const row of current) {
    if (seen.has(row.eventId)) continue;
    reranked.push({ ...row, contextualScore: null, contextUsed: false });
  }
  return reranked.sort((left, right) =>
    right.score - left.score || String(right.lastAt).localeCompare(String(left.lastAt)) ||
    left.eventId.localeCompare(right.eventId)
  );
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

export function buildTaskRouteContext(options = {}) {
  const maxBytes = Math.max(1024, Math.min(4096, Number(options.maxBytes) || 2048));
  const profile = normalizeSpace(options.profile || '');
  const sessionId = normalizeSpace(options.sessionId || '') || '<sessionId>';
  const recallCliPath = String(options.recallCliPath || 'lop-memory.mjs');
  const rulesPath = String(options.rulesPath || 'decision-replay-engine/data/rules.jsonl');
  const recallRun = JSON.stringify({
    allow_mutation: true,
    job: {
      op: 'proc.exec',
      file: 'node',
      args: [recallCliPath, 'recall', sessionId, '<associationFrame JSON>'],
    },
  });
  const semanticJob = JSON.stringify({
    op: 'proc.exec',
    file: 'node',
    args: [recallCliPath, 'semantic', '<selected event_id>'],
  });
  const lines = [
    '<lop-task-route priority="high">',
    '用户请求：以本轮用户原话及可观察结果为唯一目标，不向用户复述本卡。',
    '个性关联：' + profile,
    '路径：用户请求→个性关联归类→associationFrame→recall读取summary20事件卡→按展开判据选择event_id并semantic展开→按需Rule/Skill→自主执行与真实验证→Stop对抗审查→写semanticFull与summary20≤20字。',
    '展开判据：候选摘要只要可能影响本轮判断/执行/结论，或仅凭summary20无法判定相关性，就必须先semantic(event_id)完整阅读semanticFull；只有明确无关或无候选才不展开。',
    'associationFrame：{"query":"本轮问题的语义联想","keys":["每项≤64字"],"categoryPaths":[["一级","二级","三级"]],"confidence":0.9,"topK":4}；topK默认4，只有前4摘要无法覆盖明确分叉实体才提高。',
    '首个工具调用（只返回摘要卡；在functions.exec内直达，recall前禁止ALL_TOOLS/winnative_ops/status）：tools.mcp__winnative__winnative_run(' + recallRun + ')',
    '第二按需只读动作：semantic job=' + semanticJob + '；多个event_id去重后单次WinNative ops batch，只有整包>8KiB才预分块。',
    '按需Rule真值：' + rulesPath + '；筛完历史摘要、按需展开相关事件后，只检索/读取相关Rule，Skill只加载原生目录元数据命中的最小集合；MCP只在实际执行需要时调用。',
    '禁止：自动预读历史或规则全库；本地任务/动作/规则ID路由；计划锁、等待闸门、工作流状态。',
    '收尾：<!-- lop-memory-event {"semanticFull":"完整净化语义","summary20":"≤20字","outcome":"已完成","categoryPaths":[["一","二","三"]]} -->',
    '</lop-task-route>',
  ];
  const rendered = lines.join('\n');
  if (utf8Bytes(rendered) <= maxBytes) return rendered;
  const compact = [
    '<lop-task-route priority="high">',
    '个性关联：' + profile,
    '路径：用户请求→个性关联归类→associationFrame→recall读取summary20事件卡→按展开判据选择event_id并semantic展开→按需Rule/Skill→自主执行→Stop对抗审查→写semanticFull+summary20≤20字。',
    '展开判据：候选摘要只要可能影响本轮判断/执行/结论，或仅凭summary20无法判定相关性，就必须先semantic(event_id)完整阅读semanticFull；只有明确无关或无候选才不展开。',
    'associationFrame confidence为0..1，topK默认4；只有前4摘要无法覆盖明确分叉实体才提高。',
    '首个工具调用：tools.mcp__winnative__winnative_run(' + recallRun + ')；recall前禁止ALL_TOOLS/winnative_ops/status。',
    'semantic job：' + semanticJob + '；event_id去重后单次WinNative ops batch，只有整包>8KiB才预分块。',
    'Rule：' + rulesPath,
    '禁止本地任务/动作/规则ID路由、计划锁、等待闸门或工作流状态；不得复述本卡。',
    '</lop-task-route>',
  ].join('\n');
  if (utf8Bytes(compact) > maxBytes) throw new Error('task route exceeds configured context budget');
  return compact;
}

export function normalizeAssociationFrame(frame) {
  const input = typeof frame === 'string' ? safeJson(frame, {}) : (frame || {});
  const query = String(input.query || '').trim().slice(0, 2000);
  const keys = Array.isArray(input.keys)
    ? input.keys.map(normalizeSpace).filter((item) => item && charLength(item) <= 64).slice(0, 16)
    : [];
  const rawPaths = Array.isArray(input.categoryPaths)
    ? input.categoryPaths
    : (Array.isArray(input.categoryPath) ? [input.categoryPath] : []);
  const categoryPaths = rawPaths.map(normalizedCategoryPath).filter(Boolean).slice(0, 8);
  const aliases = { high: 0.9, medium: 0.7, low: 0.4, '高': 0.9, '中': 0.7, '低': 0.4 };
  const confidenceText = normalizeSpace(input.confidence).toLowerCase();
  const confidenceValue = Object.hasOwn(aliases, confidenceText)
    ? aliases[confidenceText]
    : Number(input.confidence);
  const confidence = Math.max(0, Math.min(1, Number.isFinite(confidenceValue) ? confidenceValue : 0));
  const topK = Math.max(1, Math.min(50, Number(input.topK) || 4));
  return { query, keys, categoryPaths, confidence, topK };
}

function pathStartsWith(categoryPath, prefix) {
  return prefix.length <= categoryPath.length &&
    prefix.every((label, index) => label === categoryPath[index]);
}

export function recallAssociation(db, sessionId, frame, options = {}) {
  assertCanonicalReadable(db);
  const normalized = normalizeAssociationFrame(frame);
  const candidateLimit = Math.max(20, Math.min(500, Number(options.candidateLimit) || 150));
  const topK = Math.min(normalized.topK, Math.max(1, Number(options.topK) || normalized.topK));
  const queryText = [normalized.query, ...normalized.keys].filter(Boolean).join(' ');
  const candidates = queryCanonicalEvents(db, queryText, {
    sessionId, limit: candidateLimit, semanticOnly: Boolean(queryText),
  });
  const wantedWeight = semanticTokens(queryText, 128)
    .reduce((sum, token) => sum + semanticTokenWeight(token), 0);
  const strongThreshold = wantedWeight
    ? Math.min(12, Math.max(3, Math.ceil(wantedWeight * 0.15)))
    : 0;
  const bestSemanticScore = Number(candidates[0]?.score || 0);
  const strongScoreThreshold = queryText && candidates.length
    ? (bestSemanticScore > 0
      ? bestSemanticScore * STRONG_RELATIVE_SCORE_RATIO
      : bestSemanticScore)
    : Number.NEGATIVE_INFINITY;
  const startLevel = normalized.confidence >= 0.85 ? 3 : normalized.confidence >= 0.6 ? 2 : 1;
  const selected = [];
  const seen = new Set();
  const stages = [];
  const add = (rows, stage) => {
    let added = 0;
    for (const row of rows) {
      if (seen.has(row.eventId) || (queryText &&
          (row.overlap < strongThreshold || row.score < strongScoreThreshold))) continue;
      seen.add(row.eventId);
      selected.push(row);
      added += 1;
      if (selected.length >= topK) break;
    }
    stages.push({ stage, added, total: selected.length });
  };
  if (normalized.categoryPaths.length) {
    for (let level = startLevel; level >= 1 && selected.length < topK; level -= 1) {
      const prefixes = normalized.categoryPaths
        .filter((item) => item.length >= level)
        .map((item) => item.slice(0, level));
      if (!prefixes.length) continue;
      add(candidates.filter((row) => row.categoryPaths.some((categoryPath) =>
        prefixes.some((prefix) => pathStartsWith(categoryPath, prefix))
      )), 'category-l' + level);
    }
  }
  if (selected.length < topK) add(candidates, 'global-fts');
  const rankedSelected = [...selected].sort((left, right) =>
    right.score - left.score || String(right.lastAt).localeCompare(String(left.lastAt)) ||
    left.eventId.localeCompare(right.eventId)
  );
  const maxChars = Math.max(2000, Math.min(100000, Number(options.maxChars) || 20000));
  const summaryCards = rankedSelected.map((row) => ({
    eventId: row.eventId,
    summary20: row.summary20,
    outcome: row.outcome,
    categoryPaths: row.categoryPaths,
    lastAt: row.lastAt,
  }));
  const lines = [
    '<lop-memory-recall>',
    'associationFrame：' + JSON.stringify(normalized),
    '召回事件卡（summary20仅作一级索引；只对选中的event_id按需semantic展开）：',
  ];
  for (const row of summaryCards) {
    const category = row.categoryPaths.map((item) => item.join('/')).join('；') || '未分类';
    const block = [
      '- [' + row.eventId + '] ' + row.summary20 + '｜' + row.outcome + '｜' + category + '｜' + row.lastAt,
    ];
    if (charLength([...lines, ...block, '</lop-memory-recall>'].join('\n')) > maxChars) break;
    lines.push(...block);
  }
  if (!rankedSelected.length) lines.push('- 无强相关事件。');
  lines.push('展开判据：候选摘要只要可能影响本轮判断/执行/结论，或仅凭summary20无法判定相关性，就必须先semantic(event_id)完整阅读semanticFull；只有明确无关或无候选才不展开。', '</lop-memory-recall>');
  const state = {
    updatedAt: nowIso(),
    sessionId: String(sessionId || ''),
    frame: normalized,
    strongThreshold,
    strongScoreRatio: STRONG_RELATIVE_SCORE_RATIO,
    strongScoreThreshold: Number.isFinite(strongScoreThreshold) ? strongScoreThreshold : null,
    selectedEventIds: rankedSelected.map((row) => row.eventId),
    stages,
  };
  return { text: lines.join('\n'), events: summaryCards, state, statePath: '' };
}

export function parseMemoryMarker(value) {
  const text = String(value || '');
  const pattern = /<!--\s*lop-memory-event\s+(\{[\s\S]*?\})\s*-->/gu;
  let match;
  let parsed = null;
  while ((match = pattern.exec(text))) {
    const candidate = safeJson(match[1], null);
    if (candidate) parsed = candidate;
  }
  if (!parsed) return { ok: false, reason: 'no-memory-marker' };
  const semanticFull = normalizeSpace(parsed.semanticFull);
  const summary20 = normalizeSpace(parsed.summary20);
  const outcome = normalizeSpace(parsed.outcome);
  const categoryPaths = (Array.isArray(parsed.categoryPaths) ? parsed.categoryPaths : [])
    .map(normalizedCategoryPath).filter(Boolean).slice(0, 8);
  if (charLength(semanticFull) < 4 || charLength(semanticFull) > 2000 ||
      semanticFull.includes('[中段省略]')) return { ok: false, reason: 'invalid-semantic-full' };
  if (charLength(summary20) < 2 || charLength(summary20) > 20) {
    return { ok: false, reason: 'invalid-summary20' };
  }
  if (!OUTCOMES.includes(outcome)) return { ok: false, reason: 'invalid-outcome' };
  if (!categoryPaths.length) return { ok: false, reason: 'invalid-category-paths' };
  return { ok: true, semanticFull, summary20, outcome, categoryPaths };
}

function inputContentHash(prompt, answer) {
  return sha256(String(prompt || '') + '\u0000' + String(answer || ''));
}

function turnIdentityKey(sessionId, timestamp, prompt) {
  const exactTimestamp = String(timestamp || '').trim();
  const exactPrompt = String(prompt || '');
  if (!exactTimestamp || !exactPrompt.trim()) return '';
  return String(sessionId || '') + '\u0000' + exactTimestamp + '\u0000' + sha256(exactPrompt);
}

function rememberMappedTurnIdentity(mappedByTurnIdentity, key, candidate) {
  if (!key) return;
  const current = mappedByTurnIdentity.get(key);
  if (current === false) return;
  if (!current) {
    mappedByTurnIdentity.set(key, candidate);
    return;
  }
  if (current.kind !== candidate.kind) {
    mappedByTurnIdentity.set(key, false);
    return;
  }
  if (candidate.kind === 'event') {
    if (current.eventId !== candidate.eventId) {
      mappedByTurnIdentity.set(key, false);
    } else if (candidate.inputId < current.inputId) {
      mappedByTurnIdentity.set(key, candidate);
    }
    return;
  }
  if (current.inputId !== candidate.inputId) mappedByTurnIdentity.set(key, false);
}

function saveInbox(db, input, reason) {
  const at = nowIso();
  db.prepare([
    'INSERT INTO memory_inbox(input_id,session_id,turn_id,selected_turn_key,content_hash,reason,created_at,updated_at)',
    'VALUES(?,?,?,?,?,?,?,?)',
    'ON CONFLICT(input_id) DO UPDATE SET selected_turn_key=excluded.selected_turn_key,',
    'content_hash=excluded.content_hash,reason=excluded.reason,updated_at=excluded.updated_at',
  ].join(' ')).run(
    input.inputId, input.sessionId, input.turnId, input.selectedTurnKey,
    inputContentHash(input.prompt, input.answer),
    String(reason || 'awaiting-semantic-marker'), at, at
  );
}

export function recordCanonicalTurn(db, input, options = {}) {
  ensureCanonicalSchema(db);
  const leafLimit = Math.max(1, Number(options.leafLimit) || 50);
  const normalizedInput = {
    sessionId: String(input.sessionId || 'unknown'),
    turnId: String(input.turnId || sha256(input.prompt || '').slice(0, 24)),
    selectedTurnKey: String(input.turnKey || input.selectedTurnKey || ''),
    sourceKey: String(input.sourceKey || ''),
    timestamp: String(input.timestamp || nowIso()),
    prompt: String(input.prompt || ''),
    answer: String(input.answer || ''),
  };
  normalizedInput.inputId = logicalInputId(normalizedInput.sessionId, normalizedInput.turnId);
  const relatedTurns = (Array.isArray(input.relatedTurns) ? input.relatedTurns : []).map((row) => ({
    turnKey: String(row?.turnKey || ''),
    sourceKey: String(row?.sourceKey || normalizedInput.sourceKey),
    turnId: String(row?.turnId || ''),
    timestamp: String(row?.timestamp || normalizedInput.timestamp),
    prompt: String(row?.prompt || ''),
    answer: String(row?.answer || ''),
  })).filter((row) => row.turnKey && row.prompt);
  const marker = parseMemoryMarker(input.lastAssistantMessage || input.answer);
  if (!marker.ok) {
    saveInbox(db, normalizedInput, marker.reason);
    return { saved: false, inbox: true, reason: marker.reason, inputId: normalizedInput.inputId };
  }
  const existing = db.prepare(
    'SELECT event_id eventId FROM memory_event_inputs WHERE input_id=?'
  ).get(normalizedInput.inputId);
  const eventId = existing?.eventId || canonicalEventId(normalizedInput.sessionId, normalizedInput.turnId);
  const acceptedCategories = [];
  begin(db);
  try {
    const at = nowIso();
    db.prepare([
      'INSERT INTO memory_events(event_id,session_id,semantic_full,summary20,outcome,first_at,last_at,',
      'source,needs_category,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?,?)',
      'ON CONFLICT(event_id) DO UPDATE SET semantic_full=excluded.semantic_full,summary20=excluded.summary20,',
      'outcome=excluded.outcome,last_at=excluded.last_at,source=excluded.source,updated_at=excluded.updated_at',
    ].join(' ')).run(
      eventId, normalizedInput.sessionId, marker.semanticFull, marker.summary20, marker.outcome,
      normalizedInput.timestamp, normalizedInput.timestamp, 'stop-marker', at, at
    );
    db.prepare([
      'INSERT INTO memory_event_inputs(input_id,event_id,session_id,turn_id,selected_turn_key,ordinal)',
      'VALUES(?,?,?,?,?,1)',
      'ON CONFLICT(input_id) DO UPDATE SET event_id=excluded.event_id,session_id=excluded.session_id,',
      'turn_id=excluded.turn_id,selected_turn_key=excluded.selected_turn_key',
    ].join(' ')).run(
      normalizedInput.inputId, eventId, normalizedInput.sessionId,
      normalizedInput.turnId, normalizedInput.selectedTurnKey
    );
    if (normalizedInput.selectedTurnKey) {
      db.prepare([
        'INSERT INTO memory_event_turns(turn_key,event_id,input_id,source_key,selected) VALUES(?,?,?,?,1)',
        'ON CONFLICT(turn_key) DO UPDATE SET event_id=excluded.event_id,input_id=excluded.input_id,',
        'source_key=excluded.source_key,selected=1',
      ].join(' ')).run(
        normalizedInput.selectedTurnKey, eventId, normalizedInput.inputId, normalizedInput.sourceKey
      );
      const rawExists = hasTable(db, 'turns') && Boolean(db.prepare(
        'SELECT 1 found FROM turns WHERE turn_key=?'
      ).get(normalizedInput.selectedTurnKey));
      if (!rawExists) {
        db.prepare([
          'INSERT INTO memory_raw_fallbacks(',
          'turn_key,input_id,source_key,session_id,kind,turn_id,timestamp,prompt,answer',
          ') VALUES(?,?,?,?,?,?,?,?,?)',
          'ON CONFLICT(turn_key) DO UPDATE SET input_id=excluded.input_id,source_key=excluded.source_key,',
          'session_id=excluded.session_id,turn_id=excluded.turn_id,timestamp=excluded.timestamp,',
          'prompt=excluded.prompt,answer=excluded.answer',
        ].join(' ')).run(
          normalizedInput.selectedTurnKey, normalizedInput.inputId, normalizedInput.sourceKey,
          normalizedInput.sessionId, 'live', normalizedInput.turnId, normalizedInput.timestamp,
          normalizedInput.prompt, normalizedInput.answer
        );
      }
    }
    const saveRelatedTurn = db.prepare([
      'INSERT INTO memory_event_turns(turn_key,event_id,input_id,source_key,selected) VALUES(?,?,?,?,0)',
      'ON CONFLICT(turn_key) DO UPDATE SET event_id=excluded.event_id,input_id=excluded.input_id,',
      'source_key=excluded.source_key,selected=0',
    ].join(' '));
    const saveRelatedFallback = db.prepare([
      'INSERT INTO memory_raw_fallbacks(',
      'turn_key,input_id,source_key,session_id,kind,turn_id,timestamp,prompt,answer',
      ') VALUES(?,?,?,?,?,?,?,?,?)',
      'ON CONFLICT(turn_key) DO UPDATE SET input_id=excluded.input_id,source_key=excluded.source_key,',
      'session_id=excluded.session_id,turn_id=excluded.turn_id,timestamp=excluded.timestamp,',
      'prompt=excluded.prompt,answer=excluded.answer',
    ].join(' '));
    const rawTurnExists = hasTable(db, 'turns')
      ? db.prepare('SELECT 1 found FROM turns WHERE turn_key=?')
      : null;
    for (const row of relatedTurns) {
      saveRelatedTurn.run(row.turnKey, eventId, normalizedInput.inputId, row.sourceKey);
      if (!rawTurnExists?.get(row.turnKey)) {
        saveRelatedFallback.run(
          row.turnKey, normalizedInput.inputId, row.sourceKey, normalizedInput.sessionId,
          'live', row.turnId, row.timestamp, row.prompt, row.answer
        );
      }
      if (row.turnId) {
        db.prepare('DELETE FROM memory_inbox WHERE input_id=?')
          .run(logicalInputId(normalizedInput.sessionId, row.turnId));
      }
    }

    // Codex rollout 与 hook 影子记录同一条用户 steering 时，时间戳会有几秒偏差且
    // parser turn_id 可能不同。只在同会话、提示完全相同、30 秒窗口内补物理映射；
    // 已映射到其他事件的 turn 永不抢占。
    if (hasTable(db, 'turns') && relatedTurns.length) {
      const findAliases = db.prepare([
        'SELECT turn_key turnKey,source_key sourceKey,turn_id turnId,timestamp',
        'FROM turns WHERE session_id=? AND prompt=?',
      ].join(' '));
      const mapped = db.prepare('SELECT event_id eventId FROM memory_event_turns WHERE turn_key=?');
      for (const related of relatedTurns) {
        const wantedAt = Date.parse(related.timestamp);
        for (const alias of findAliases.all(normalizedInput.sessionId, related.prompt)) {
          const aliasAt = Date.parse(alias.timestamp);
          if (Number.isFinite(wantedAt) && Number.isFinite(aliasAt) &&
              Math.abs(aliasAt - wantedAt) > 30000) continue;
          const existingAlias = mapped.get(alias.turnKey);
          if (existingAlias && existingAlias.eventId !== eventId) continue;
          saveRelatedTurn.run(alias.turnKey, eventId, normalizedInput.inputId, alias.sourceKey);
          db.prepare('DELETE FROM memory_inbox WHERE input_id=?')
            .run(logicalInputId(normalizedInput.sessionId, alias.turnId));
        }
      }
    }
    for (const categoryPath of marker.categoryPaths) {
      const id = ensureCategory(db, categoryPath, leafLimit);
      const count = Number(db.prepare([
        'SELECT count(DISTINCT event_id) count FROM event_categories',
        'WHERE category_id=? AND event_id<>?',
      ].join(' ')).get(id, eventId)?.count || 0);
      if (count >= leafLimit) {
        db.prepare('UPDATE categories SET split_needed=1,updated_at=? WHERE category_id=?').run(at, id);
        continue;
      }
      acceptedCategories.push({ id, categoryPath });
      if (acceptedCategories.length >= 3) break;
    }
    if (acceptedCategories.length) {
      db.prepare('DELETE FROM event_categories WHERE event_id=?').run(eventId);
      const save = db.prepare([
        'INSERT INTO event_categories(event_id,category_id,is_primary,assigned_at) VALUES(?,?,?,?)',
      ].join(' '));
      acceptedCategories.forEach((item, index) => save.run(eventId, item.id, index === 0 ? 1 : 0, at));
      db.prepare('UPDATE memory_events SET needs_category=0 WHERE event_id=?').run(eventId);
    } else {
      db.prepare('UPDATE memory_events SET needs_category=1 WHERE event_id=?').run(eventId);
      saveInbox(db, normalizedInput, 'category-capacity-full');
    }
    db.prepare('DELETE FROM memory_inbox WHERE input_id=? AND ?=1')
      .run(normalizedInput.inputId, acceptedCategories.length ? 1 : 0);
    indexEvent(db, eventId);
    commit(db);
  } catch (error) {
    rollback(db);
    throw error;
  }
  return {
    saved: true,
    inbox: acceptedCategories.length === 0,
    eventId,
    inputId: normalizedInput.inputId,
    summary20: marker.summary20,
    categories: acceptedCategories.map((item) => item.categoryPath),
  };
}

function richerTurn(left, right) {
  const weight = (row) =>
    charLength(row.prompt) + charLength(row.answer) * 2 + (row.answer ? 1000000 : 0);
  const leftWeight = weight(left);
  const rightWeight = weight(right);
  if (leftWeight !== rightWeight) return leftWeight > rightWeight ? left : right;
  return String(left.turn_key) < String(right.turn_key) ? left : right;
}

export function syncCanonicalInbox(db, options = {}) {
  ensureCanonicalSchema(db);
  if (!hasTable(db, 'turns')) return { added: 0, total: 0, mappedTurns: 0 };
  const sessionId = String(options.sessionId || '');
  const rows = db.prepare([
    'SELECT turn_key,source_key,session_id,turn_id,prompt,answer,timestamp FROM turns',
    "WHERE (?='' OR session_id=?)",
    'ORDER BY session_id,turn_id,turn_key',
  ].join(' ')).all(sessionId, sessionId);
  const groups = new Map();
  for (const row of rows) {
    const key = row.session_id + '\u0000' + row.turn_id;
    const current = groups.get(key);
    groups.set(key, current ? richerTurn(current.winner, row) === current.winner
      ? { winner: current.winner, rows: [...current.rows, row] }
      : { winner: row, rows: [...current.rows, row] }
      : { winner: row, rows: [row] });
  }
  const eventInputs = db.prepare([
    'SELECT input_id inputId,event_id eventId FROM memory_event_inputs',
    "WHERE (?='' OR session_id=?)",
  ].join(' ')).all(sessionId, sessionId);
  const eventByInput = new Map(eventInputs.map((row) => [row.inputId, row.eventId]));
  const canonicalByContent = new Map();
  for (const row of db.prepare([
    'SELECT mei.input_id inputId,mei.event_id eventId,mei.session_id sessionId,',
    "COALESCE(t.prompt,rf.prompt,'') prompt,COALESCE(t.answer,rf.answer,'') answer",
    'FROM memory_event_inputs mei',
    'LEFT JOIN turns t ON t.turn_key=mei.selected_turn_key',
    'LEFT JOIN memory_raw_fallbacks rf ON rf.turn_key=mei.selected_turn_key',
    "WHERE (?='' OR mei.session_id=?) AND (t.turn_key IS NOT NULL OR rf.turn_key IS NOT NULL)",
  ].join(' ')).all(sessionId, sessionId)) {
    const key = row.sessionId + '\u0000' + inputContentHash(row.prompt, row.answer);
    const current = canonicalByContent.get(key);
    if (current === false) continue;
    if (!current) {
      canonicalByContent.set(key, { inputId: row.inputId, eventId: row.eventId });
    } else if (current.eventId !== row.eventId) {
      canonicalByContent.set(key, false);
    } else if (row.inputId < current.inputId) {
      canonicalByContent.set(key, { inputId: row.inputId, eventId: row.eventId });
    }
  }
  const contextInputs = new Set(db.prepare([
    'SELECT input_id inputId FROM memory_contexts',
    "WHERE (?='' OR session_id=?)",
  ].join(' ')).all(sessionId, sessionId).map((row) => row.inputId));
  const mappedByTurnIdentity = new Map();
  for (const row of db.prepare([
    'SELECT met.input_id inputId,met.event_id eventId,t.session_id sessionId,',
    't.timestamp timestamp,t.prompt prompt',
    'FROM memory_event_turns met JOIN turns t ON t.turn_key=met.turn_key',
    "WHERE (?='' OR t.session_id=?)",
  ].join(' ')).all(sessionId, sessionId)) {
    rememberMappedTurnIdentity(
      mappedByTurnIdentity,
      turnIdentityKey(row.sessionId, row.timestamp, row.prompt),
      { kind: 'event', inputId: row.inputId, eventId: row.eventId }
    );
  }
  for (const row of db.prepare([
    'SELECT mct.input_id inputId,t.session_id sessionId,t.timestamp timestamp,t.prompt prompt',
    'FROM memory_context_turns mct JOIN turns t ON t.turn_key=mct.turn_key',
    "WHERE (?='' OR t.session_id=?)",
  ].join(' ')).all(sessionId, sessionId)) {
    rememberMappedTurnIdentity(
      mappedByTurnIdentity,
      turnIdentityKey(row.sessionId, row.timestamp, row.prompt),
      { kind: 'context', inputId: row.inputId }
    );
  }
  let added = 0;
  let mappedTurns = 0;
  let aliasedTurns = 0;
  begin(db);
  try {
    const saveEventTurn = db.prepare([
      'INSERT INTO memory_event_turns(turn_key,event_id,input_id,source_key,selected) VALUES(?,?,?,?,?)',
      'ON CONFLICT(turn_key) DO UPDATE SET event_id=excluded.event_id,input_id=excluded.input_id,',
      'source_key=excluded.source_key,selected=excluded.selected',
    ].join(' '));
    const saveContextTurn = db.prepare([
      'INSERT INTO memory_context_turns(turn_key,input_id,source_key,selected) VALUES(?,?,?,?)',
      'ON CONFLICT(turn_key) DO UPDATE SET input_id=excluded.input_id,source_key=excluded.source_key,',
      'selected=excluded.selected',
    ].join(' '));
    for (const group of groups.values()) {
      const inputId = logicalInputId(group.winner.session_id, group.winner.turn_id);
      const exactEventId = eventByInput.get(inputId);
      if (exactEventId) {
        db.prepare('DELETE FROM memory_inbox WHERE input_id=?').run(inputId);
        for (const row of group.rows) {
          saveEventTurn.run(
            row.turn_key, exactEventId, inputId, row.source_key,
            row.turn_key === group.winner.turn_key ? 1 : 0
          );
          mappedTurns += 1;
        }
        continue;
      }
      if (contextInputs.has(inputId)) {
        db.prepare('DELETE FROM memory_inbox WHERE input_id=?').run(inputId);
        for (const row of group.rows) {
          saveContextTurn.run(
            row.turn_key, inputId, row.source_key,
            row.turn_key === group.winner.turn_key ? 1 : 0
          );
          mappedTurns += 1;
        }
        continue;
      }
      const identityAlias = mappedByTurnIdentity.get(turnIdentityKey(
        group.winner.session_id,
        group.winner.timestamp,
        group.winner.prompt
      ));
      if (identityAlias) {
        db.prepare('DELETE FROM memory_inbox WHERE input_id=?').run(inputId);
        for (const row of group.rows) {
          if (identityAlias.kind === 'event') {
            saveEventTurn.run(
              row.turn_key, identityAlias.eventId, identityAlias.inputId, row.source_key, 0
            );
          } else {
            saveContextTurn.run(row.turn_key, identityAlias.inputId, row.source_key, 0);
          }
          mappedTurns += 1;
          aliasedTurns += 1;
        }
        continue;
      }
      const contentAlias = canonicalByContent.get(
        group.winner.session_id + '\u0000' +
        inputContentHash(group.winner.prompt, group.winner.answer)
      );
      if (contentAlias) {
        db.prepare('DELETE FROM memory_inbox WHERE input_id=?').run(inputId);
        for (const row of group.rows) {
          saveEventTurn.run(
            row.turn_key, contentAlias.eventId, contentAlias.inputId, row.source_key, 0
          );
          mappedTurns += 1;
          aliasedTurns += 1;
        }
        continue;
      }
      const existed = Boolean(db.prepare('SELECT 1 FROM memory_inbox WHERE input_id=?').get(inputId));
      saveInbox(db, {
        inputId,
        sessionId: group.winner.session_id,
        turnId: group.winner.turn_id,
        selectedTurnKey: group.winner.turn_key,
        prompt: group.winner.prompt,
        answer: group.winner.answer,
      }, 'awaiting-semantic-marker');
      if (!existed) added += 1;
    }
    commit(db);
  } catch (error) {
    rollback(db);
    throw error;
  }
  return {
    added,
    total: Number(db.prepare([
      'SELECT count(*) count FROM memory_inbox',
      "WHERE (?='' OR session_id=?)",
    ].join(' ')).get(sessionId, sessionId).count),
    mappedTurns,
    aliasedTurns,
  };
}

function recountCategories(db, leafLimit) {
  const counts = new Map();
  const leafCounts = new Map();
  for (const row of db.prepare([
    'SELECT ec.event_id eventId,c.category_id categoryId,c.path_json pathJson',
    'FROM event_categories ec JOIN categories c ON c.category_id=ec.category_id',
  ].join(' ')).all()) {
    const categoryPath = normalizedCategoryPath(safeJson(row.pathJson, null));
    if (!categoryPath) continue;
    leafCounts.set(row.categoryId, (leafCounts.get(row.categoryId) || 0) + 1);
    for (let level = 1; level <= categoryPath.length; level += 1) {
      const id = categoryId(categoryPath.slice(0, level));
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  db.prepare('UPDATE categories SET event_count=0,split_needed=0').run();
  for (const [id, count] of counts) {
    db.prepare('UPDATE categories SET event_count=?,updated_at=? WHERE category_id=?')
      .run(count, nowIso(), id);
  }
  for (const [id, count] of leafCounts) {
    db.prepare('UPDATE categories SET split_needed=? WHERE category_id=?')
      .run(count > leafLimit ? 1 : 0, id);
  }
}

export function weeklyCanonical(db, options = {}) {
  ensureCanonicalSchema(db);
  const leafLimit = Math.max(1, Number(options.leafLimit) || 50);
  const inbox = syncCanonicalInbox(db);
  const rows = db.prepare([
    'SELECT e.*,(',
    'SELECT category_id FROM event_categories ec WHERE ec.event_id=e.event_id',
    'ORDER BY is_primary DESC,category_id LIMIT 1',
    ') primaryCategory FROM memory_events e ORDER BY first_at,event_id',
  ].join(' ')).all();
  const groups = new Map();
  for (const row of rows) {
    const key = [
      row.session_id, row.semantic_full, row.outcome, row.primaryCategory || '',
    ].join('\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  let merged = 0;
  begin(db);
  try {
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const keeper = group[0];
      for (const duplicate of group.slice(1)) {
        db.prepare([
          'INSERT OR IGNORE INTO event_categories(event_id,category_id,is_primary,assigned_at)',
          'SELECT ?,category_id,0,assigned_at FROM event_categories WHERE event_id=?',
        ].join(' ')).run(keeper.event_id, duplicate.event_id);
        db.prepare('UPDATE memory_event_inputs SET event_id=? WHERE event_id=?')
          .run(keeper.event_id, duplicate.event_id);
        db.prepare('UPDATE memory_event_turns SET event_id=? WHERE event_id=?')
          .run(keeper.event_id, duplicate.event_id);
        db.prepare('DELETE FROM event_categories WHERE event_id=?').run(duplicate.event_id);
        db.prepare('DELETE FROM memory_events_fts WHERE event_id=?').run(duplicate.event_id);
        db.prepare('DELETE FROM memory_events WHERE event_id=?').run(duplicate.event_id);
        merged += 1;
      }
      const times = group.flatMap((row) => [row.first_at, row.last_at]).sort();
      db.prepare('UPDATE memory_events SET first_at=?,last_at=?,updated_at=? WHERE event_id=?')
        .run(times[0], times.at(-1), nowIso(), keeper.event_id);
    }
    recountCategories(db, leafLimit);
    rebuildFts(db);
    setMeta(db, 'weekly_at', nowIso());
    commit(db);
  } catch (error) {
    rollback(db);
    throw error;
  }
  return { merged, inbox, ...canonicalStats(db) };
}

function stripMemoryMarker(value) {
  return String(value || '').replace(/<!--\s*lop-memory-event\s+\{[\s\S]*?\}\s*-->/gu, '').trim();
}

export function readCanonicalSemantic(db, eventId) {
  assertCanonicalReadable(db);
  const event = db.prepare([
    'SELECT event_id eventId,session_id sessionId,semantic_full semanticFull,summary20,outcome,',
    'first_at firstAt,last_at lastAt,source,needs_category needsCategory',
    'FROM memory_events WHERE event_id=?',
  ].join(' ')).get(String(eventId || ''));
  if (!event) return null;
  return {
    ...event,
    needsCategory: Boolean(event.needsCategory),
    categoryPaths: eventCategoryPaths(db, event.eventId),
  };
}

export function expandCanonicalEvent(db, eventId) {
  assertCanonicalReadable(db);
  const event = db.prepare('SELECT * FROM memory_events WHERE event_id=?').get(String(eventId || ''));
  if (!event) return null;
  const inputs = db.prepare([
    'SELECT * FROM memory_event_inputs WHERE event_id=? ORDER BY ordinal,input_id',
  ].join(' ')).all(event.event_id);
  const turns = db.prepare([
    'SELECT mt.turn_key turnKey,mt.input_id inputId,mt.selected,',
    'coalesce(t.source_key,rf.source_key) sourceKey,',
    'coalesce(t.timestamp,rf.timestamp) timestamp,coalesce(t.prompt,rf.prompt) prompt,',
    'coalesce(t.answer,rf.answer) answer,s.path sourcePath',
    'FROM memory_event_turns mt LEFT JOIN turns t ON t.turn_key=mt.turn_key',
    'LEFT JOIN memory_raw_fallbacks rf ON rf.turn_key=mt.turn_key',
    'LEFT JOIN sources s ON s.source_key=coalesce(t.source_key,rf.source_key)',
    'WHERE mt.event_id=? ORDER BY mt.input_id,mt.selected DESC,',
    'coalesce(t.timestamp,rf.timestamp),mt.turn_key',
  ].join(' ')).all(event.event_id).map((row) => ({
    ...row,
    answer: stripMemoryMarker(row.answer),
  }));
  return {
    eventId: event.event_id,
    sessionId: event.session_id,
    semanticFull: event.semantic_full,
    summary20: event.summary20,
    outcome: event.outcome,
    firstAt: event.first_at,
    lastAt: event.last_at,
    source: event.source,
    needsCategory: Boolean(event.needs_category),
    categoryPaths: eventCategoryPaths(db, event.event_id),
    inputs,
    turns,
  };
}

export function canonicalStats(db) {
  assertCanonicalReadable(db);
  const count = (table) => Number(db.prepare('SELECT count(*) count FROM ' + table).get().count);
  const leafMax = Number(db.prepare([
    'SELECT coalesce(max(n),0) value FROM (',
    'SELECT category_id,count(*) n FROM event_categories GROUP BY category_id',
    ')',
  ].join(' ')).get().value);
  return {
    events: count('memory_events'),
    eventInputs: count('memory_event_inputs'),
    eventTurns: count('memory_event_turns'),
    contexts: count('memory_contexts'),
    contextTurns: count('memory_context_turns'),
    rawFallbacks: count('memory_raw_fallbacks'),
    inbox: count('memory_inbox'),
    categories: count('categories'),
    leafMax,
    needsCategory: Number(db.prepare(
      'SELECT count(*) count FROM memory_events WHERE needs_category<>0'
    ).get().count),
    importedAt: db.prepare("SELECT value FROM memory_meta WHERE key='imported_at'").get()?.value || '',
  };
}
