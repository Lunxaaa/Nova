import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import initSqlJs from 'sql.js';
import { config } from './config.js';
import { createEmbedding, summarizeConversation } from './openai.js';

const ensureDir = async (filePath) => {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
};

const shortTermToText = (entries) =>
  entries.map((msg) => `${msg.role === 'user' ? 'User' : 'Bot'}: ${msg.content}`).join('\n');

const cosineSimilarity = (a, b) => {
  if (!a?.length || !b?.length) return 0;
  const dot = a.reduce((sum, value, idx) => sum + value * (b[idx] || 0), 0);
  const magA = Math.hypot(...a);
  const magB = Math.hypot(...b);
  if (!magA || !magB) return 0;
  return dot / (magA * magB);
};

const keywords = ['remember', 'promise', 'plan', 'goal', 'project', 'birthday'];
const estimateImportance = (text) => {
  const keywordBoost = keywords.reduce((score, word) => (text.toLowerCase().includes(word) ? score + 0.2 : score), 0);
  const lengthScore = Math.min(text.length / 400, 0.5);
  const emojiBoost = /:[a-z_]+:|😊|😂|❤️/i.test(text) ? 0.1 : 0;
  return Math.min(1, 0.2 + keywordBoost + lengthScore + emojiBoost);
};

const parseEmbedding = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn('[memory] Failed to parse embedding payload:', error);
    return [];
  }
};

const memoryUsageMap = new Map();

const getMemoryUsageMapForUser = (userId) => {
  if (!memoryUsageMap.has(userId)) {
    memoryUsageMap.set(userId, new Map());
  }
  return memoryUsageMap.get(userId);
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmDir = path.resolve(__dirname, '../node_modules/sql.js/dist');

let initPromise = null;
let persistTimer = null;
let pendingSnapshot = null;
let pendingPromise = null;
let pendingResolve = null;
let pendingReject = null;

const locateFile = (fileName) => path.join(wasmDir, fileName);

const scheduleWrite = (snapshot) => {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  if (!pendingPromise) {
    pendingPromise = new Promise((resolve, reject) => {
      pendingResolve = resolve;
      pendingReject = reject;
    });
  }
  pendingSnapshot = snapshot;
  persistTimer = setTimeout(async () => {
    try {
      await ensureDir(config.memoryDbFile);
      await fs.writeFile(config.memoryDbFile, pendingSnapshot);
      pendingResolve && pendingResolve();
    } catch (err) {
      pendingReject && pendingReject(err);
    } finally {
      pendingPromise = null;
      pendingResolve = null;
      pendingReject = null;
      pendingSnapshot = null;
      persistTimer = null;
    }
  }, 300);
  return pendingPromise;
};

const persistDb = (db) => scheduleWrite(Buffer.from(db.export()));

const run = (db, sql, params = []) => {
  db.run(sql, params);
};

const get = (db, sql, params = []) => {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    if (stmt.step()) {
      return stmt.getAsObject();
    }
    return null;
  } finally {
    stmt.free();
  }
};

const all = (db, sql, params = []) => {
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
};

const createSchema = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      summary TEXT DEFAULT '',
      last_updated INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS short_term (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS long_term (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding TEXT NOT NULL,
      importance REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS daily_thoughts (
      date TEXT PRIMARY KEY,
      thought TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
};

const loadDatabase = async () => {
  if (initPromise) {
    return initPromise;
  }
  initPromise = (async () => {
    await ensureDir(config.memoryDbFile);
    const SQL = await initSqlJs({ locateFile });
    let fileBuffer = null;
    try {
      fileBuffer = await fs.readFile(config.memoryDbFile);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    const db = fileBuffer ? new SQL.Database(new Uint8Array(fileBuffer)) : new SQL.Database();
    createSchema(db);
    const migrated = await migrateLegacyStore(db);
    if (!fileBuffer || migrated) {
      await persistDb(db);
    }
    return db;
  })();
  return initPromise;
};

const ensureUser = (db, userId) => {
  run(db, "INSERT OR IGNORE INTO users (id, summary, last_updated) VALUES (?, '', 0)", [userId]);
};

const enforceShortTermCap = (db, userId) => {
  const cap = config.shortTermLimit * 2;
  const row = get(db, 'SELECT COUNT(1) as count FROM short_term WHERE user_id = ?', [userId]);
  const total = row?.count || 0;
  if (total > cap) {
    run(
      db,
      `DELETE FROM short_term
       WHERE id IN (
         SELECT id FROM short_term
         WHERE user_id = ?
         ORDER BY timestamp ASC, id ASC
         LIMIT ?
       )`,
      [userId, total - cap],
    );
    return true;
  }
  return false;
};

const pruneMemories = (db, userId) => {
  const row = get(db, 'SELECT COUNT(1) as count FROM long_term WHERE user_id = ?', [userId]);
  const total = row?.count || 0;
  if (total > config.maxMemories) {
    run(
      db,
      `DELETE FROM long_term
       WHERE id IN (
         SELECT id FROM long_term
         WHERE user_id = ?
         ORDER BY importance ASC, timestamp ASC
         LIMIT ?
       )`,
      [userId, total - config.maxMemories],
    );
    return true;
  }
  return false;
};

const getShortTermHistory = (db, userId, limit) => {
  const rows = all(
    db,
    'SELECT role, content, timestamp FROM short_term WHERE user_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?',
    [userId, limit],
  );
  return rows.reverse();
};

const fullShortTerm = (db, userId) =>
  all(db, 'SELECT id, role, content, timestamp FROM short_term WHERE user_id = ? ORDER BY timestamp ASC, id ASC', [userId]);

const maybeSummarize = async (db, userId) => {
  const shortTermEntries = fullShortTerm(db, userId);
  const charCount = shortTermEntries.reduce((sum, msg) => sum + (msg.content?.length || 0), 0);
  if (
    charCount < config.summaryTriggerChars &&
    shortTermEntries.length < (config.summaryTriggerTurns || config.shortTermLimit)
  ) {
    return false;
  }
  const userRow = get(db, 'SELECT summary FROM users WHERE id = ?', [userId]) || { summary: '' };
  const transcript = shortTermToText(shortTermEntries);
  const updatedSummary = await summarizeConversation(userRow.summary || '', transcript);
  if (updatedSummary) {
    run(db, 'UPDATE users SET summary = ?, last_updated = ? WHERE id = ?', [updatedSummary, Date.now(), userId]);
    const keep = 4;
    const excess = shortTermEntries.length - keep;
    if (excess > 0) {
      run(
        db,
        `DELETE FROM short_term
         WHERE id IN (
           SELECT id FROM short_term
           WHERE user_id = ?
           ORDER BY timestamp ASC, id ASC
           LIMIT ?
         )`,
        [userId, excess],
      );
    }
    return true;
  }
  return false;
};

const migrateLegacyStore = async (db) => {
  if (!config.legacyMemoryFile) return false;
  const existing = get(db, 'SELECT 1 as present FROM users LIMIT 1');
  if (existing) {
    return false;
  }
  let raw;
  try {
    raw = await fs.readFile(config.legacyMemoryFile, 'utf-8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  let store;
  try {
    store = JSON.parse(raw);
  } catch (error) {
    console.warn('[memory] Unable to parse legacy memory.json. Skipping migration.');
    return false;
  }
  if (!store?.users || !Object.keys(store.users).length) {
    return false;
  }
  Object.entries(store.users).forEach(([userId, user]) => {
    ensureUser(db, userId);
    run(db, 'UPDATE users SET summary = ?, last_updated = ? WHERE id = ?', [user.summary || '', user.lastUpdated || 0, userId]);
    (user.shortTerm || []).forEach((entry) => {
      run(db, 'INSERT INTO short_term (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)', [
        userId,
        entry.role || 'user',
        entry.content || '',
        entry.timestamp || Date.now(),
      ]);
    });
    (user.longTerm || []).forEach((entry) => {
      const rowId = entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      run(db, 'INSERT INTO long_term (id, user_id, content, embedding, importance, timestamp) VALUES (?, ?, ?, ?, ?, ?)', [
        rowId,
        userId,
        entry.content || '',
        JSON.stringify(entry.embedding || []),
        entry.importance ?? 0,
        entry.timestamp || Date.now(),
      ]);
    });
  });
  console.log('[memory] Migrated legacy memory.json to SQLite (sql.js).');
  return true;
};

const retrieveRelevantMemories = async (db, userId, query, options = {}) => {
  if (!query?.trim()) {
    return [];
  }
  const limit = config.longTermFetchLimit || 200;
  const { includeAllUsers = false, minScore = Number.NEGATIVE_INFINITY } = options;
  const params = [];
  const whereClause = includeAllUsers ? '' : ' WHERE user_id = ?';
  if (!includeAllUsers) {
    params.push(userId);
  }
  params.push(limit);
  const rows = all(
    db,
    `SELECT id, user_id, content, embedding, importance, timestamp FROM long_term${whereClause} ORDER BY timestamp DESC LIMIT ?`,
    params,
  );
  if (!rows.length) {
    return [];
  }
  const now = Date.now();
  const cooldown = config.memoryCooldownMs || 0;
  const usage = getMemoryUsageMapForUser(userId);
  const eligibleRows =
    cooldown && usage
      ? rows.filter((entry) => now - (usage.get(entry.id) || 0) > cooldown)
      : rows;
  const rowsToScore = eligibleRows.length ? eligibleRows : rows;
  const queryEmbedding = await createEmbedding(query);
  const scored = rowsToScore
    .map((entry) => {
      const embedding = parseEmbedding(entry.embedding);
      return {
        ...entry,
        embedding,
        score: cosineSimilarity(queryEmbedding, embedding) + entry.importance * 0.1,
      };
    })
    .sort((a, b) => b.score - a.score);
  const filtered = scored.filter((entry) => entry.score >= minScore);
  const capped = filtered.slice(0, config.relevantMemoryCount);
  if (capped.length) {
    capped.forEach((entry) => usage.set(entry.id, now));
  }
  return capped;
};

export async function appendShortTerm(userId, role, content) {
  const db = await loadDatabase();
  ensureUser(db, userId);
  run(db, 'INSERT INTO short_term (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)', [
    userId,
    role,
    content,
    Date.now(),
  ]);
  enforceShortTermCap(db, userId);
  if (config.enableShortTermSummary) {
    await maybeSummarize(db, userId);
  }
  await persistDb(db);
}

export async function prepareContext(userId, incomingMessage, options = {}) {
  const db = await loadDatabase();
  ensureUser(db, userId);
  const userRow = get(db, 'SELECT summary FROM users WHERE id = ?', [userId]) || { summary: '' };
  const shortTerm = getShortTermHistory(db, userId, config.shortTermLimit);
  const {
    includeAllUsers = false,
    includeLongTerm = true,
    memorySimilarityThreshold = Number.NEGATIVE_INFINITY,
  } = options;
  const memories =
    includeLongTerm && incomingMessage?.trim()
      ? await retrieveRelevantMemories(db, userId, incomingMessage, {
          includeAllUsers,
          minScore: memorySimilarityThreshold,
        })
      : [];
  return {
    shortTerm,
    summary: userRow.summary || '',
    memories,
  };
}

export async function recordInteraction(userId, userMessage, botReply) {
  const db = await loadDatabase();
  ensureUser(db, userId);
  const combined = `User: ${userMessage}\nBot: ${botReply}`;
  const embedding = await createEmbedding(combined);
  const importance = estimateImportance(combined);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  run(db, 'INSERT INTO long_term (id, user_id, content, embedding, importance, timestamp) VALUES (?, ?, ?, ?, ?, ?)', [
    id,
    userId,
    combined,
    JSON.stringify(embedding),
    importance,
    Date.now(),
  ]);
  pruneMemories(db, userId);
  run(db, 'UPDATE users SET last_updated = ? WHERE id = ?', [Date.now(), userId]);
  await persistDb(db);
}

export async function pruneLowImportanceMemories(userId) {
  const db = await loadDatabase();
  ensureUser(db, userId);
  run(db, 'DELETE FROM long_term WHERE user_id = ? AND importance < ?', [userId, config.memoryPruneThreshold]);
  await persistDb(db);
}

// -----------------------------------------------------------------------------
// Dashboard helpers
// -----------------------------------------------------------------------------

export async function listUsers() {
  const db = await loadDatabase();
  return all(db, 'SELECT id, summary, last_updated FROM users');
}

export async function getAllShortTerm(userId) {
  const db = await loadDatabase();
  return fullShortTerm(db, userId);
}

export async function getLongTermMemories(userId) {
  const db = await loadDatabase();
  return all(
    db,
    'SELECT id, content, importance, timestamp FROM long_term WHERE user_id = ? ORDER BY timestamp DESC',
    [userId],
  );
}

export async function getLongTermMemoriesPage(userId, opts = {}) {
  const { limit = 50, offset = 0 } = opts;
  const db = await loadDatabase();
  const rows = all(
    db,
    'SELECT id, content, importance, timestamp FROM long_term WHERE user_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?',
    [userId, limit, offset],
  );
  const countRow = get(db, 'SELECT COUNT(1) as total FROM long_term WHERE user_id = ?', [userId]);
  return { rows, total: countRow?.total || 0 };
}

export async function getMemoryTimeline(userId, days = 14) {
  const db = await loadDatabase();
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = all(
    db,
    `
      SELECT
        strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch') as day,
        COUNT(1) as count
      FROM long_term
      WHERE user_id = ?
        AND timestamp >= ?
      GROUP BY day
      ORDER BY day DESC
      LIMIT ?
    `,
    [userId, since, days],
  );
  const today = new Date();
  const timeline = [];
  const rowMap = new Map(rows.map((entry) => [entry.day, entry.count]));
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().split('T')[0];
    timeline.push({
      day: key,
      count: rowMap.get(key) || 0,
    });
  }
  return timeline;
}

export async function deleteLongTerm(userId, entryId) {
  const db = await loadDatabase();
  run(db, 'DELETE FROM long_term WHERE user_id = ? AND id = ?', [userId, entryId]);
  await persistDb(db);
}

export async function upsertLongTerm(userId, entry) {
  const db = await loadDatabase();
  ensureUser(db, userId);
  const now = Date.now();
  const importance = typeof entry.importance === 'number' ? entry.importance : 0;
  if (entry.id) {
    run(
      db,
      'UPDATE long_term SET content = ?, importance = ?, timestamp = ? WHERE user_id = ? AND id = ?',
      [entry.content, importance, now, userId, entry.id],
    );
    await persistDb(db);
    return { id: entry.id, timestamp: now, updated: true };
  }
  const newId = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  run(
    db,
    'INSERT INTO long_term (id, user_id, content, embedding, importance, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    [newId, userId, entry.content, JSON.stringify(entry.embedding || []), importance, now],
  );
  await persistDb(db);
  return { id: newId, timestamp: now, created: true };
}

export async function findSimilar(userId, query, options = {}) {
  const db = await loadDatabase();
  return retrieveRelevantMemories(db, userId, query, options);
}

export async function getDailyThoughtFromDb(date) {
  const db = await loadDatabase();
  const row = get(db, 'SELECT thought FROM daily_thoughts WHERE date = ?', [date]);
  return row?.thought || null;
}

export async function saveDailyThought(date, thought) {
  const db = await loadDatabase();
  run(db, 'INSERT OR REPLACE INTO daily_thoughts (date, thought, created_at) VALUES (?, ?, ?)', [
    date,
    thought,
    Date.now(),
  ]);
  await persistDb(db);
}
