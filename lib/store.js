'use strict'
// ---------------------------------------------------------------------------
// SQLite 存储层：sql.js（WASM SQLite）
// - 内存库 + 原子 export 落盘（tmp + rename）
// - schema 与 33March7/deepseek-api-usage-statistics 对齐
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')

let _SQL = null
let _db = null
let _dbPath = null
let _deferPersist = false // 批量写入时暂缓落盘，结束后统一 persist 一次

const SCHEMA = `
CREATE TABLE IF NOT EXISTS amount_daily (
  utc_date     TEXT    NOT NULL,
  model        TEXT    NOT NULL,
  api_key_name TEXT    NOT NULL DEFAULT '',
  type         TEXT    NOT NULL,
  amount       INTEGER NOT NULL,
  price        REAL,
  PRIMARY KEY (utc_date, model, api_key_name, type)
);
CREATE TABLE IF NOT EXISTS cost_daily (
  utc_date     TEXT    NOT NULL,
  model        TEXT    NOT NULL,
  api_key_name TEXT    NOT NULL DEFAULT '',
  wallet_type  TEXT    NOT NULL DEFAULT 'default',
  cost         REAL    NOT NULL,
  currency     TEXT    NOT NULL,
  PRIMARY KEY (utc_date, model, api_key_name, currency)
);
CREATE TABLE IF NOT EXISTS hourly_usage (
  utc_date     TEXT    NOT NULL,
  hour         INTEGER NOT NULL,
  model        TEXT    NOT NULL DEFAULT '',
  api_key_name TEXT    NOT NULL DEFAULT '',
  type         TEXT    NOT NULL,
  amount       INTEGER NOT NULL,
  PRIMARY KEY (utc_date, hour, model, api_key_name, type)
);
CREATE TABLE IF NOT EXISTS hourly_cost (
  utc_date     TEXT    NOT NULL,
  hour         INTEGER NOT NULL,
  model        TEXT    NOT NULL DEFAULT '',
  api_key_name TEXT    NOT NULL DEFAULT '',
  cost         REAL    NOT NULL,
  currency     TEXT    NOT NULL,
  PRIMARY KEY (utc_date, hour, model, api_key_name, currency)
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_amount_date ON amount_daily(utc_date);
CREATE INDEX IF NOT EXISTS idx_cost_date   ON cost_daily(utc_date);
`

// 初始化：加载 WASM + 打开/创建数据库文件，返回 db 句柄。
async function init(dbPath) {
  const initSqlJs = require('sql.js')
  const wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm')
  const wasmBinary = fs.readFileSync(wasmPath)
  _SQL = await initSqlJs({ wasmBinary })
  _dbPath = dbPath
  if (fs.existsSync(dbPath)) {
    try {
      _db = new _SQL.Database(fs.readFileSync(dbPath))
    } catch (e) {
      _db = new _SQL.Database()
    }
  } else {
    _db = new _SQL.Database()
  }
  _db.run(SCHEMA)
  persist()
  return _db
}

// 把内存库整体导出并原子写回文件。
function persist() {
  if (!_db || !_dbPath) return
  const data = _db.export()
  fs.mkdirSync(path.dirname(_dbPath), { recursive: true })
  const tmp = _dbPath + '.tmp'
  fs.writeFileSync(tmp, Buffer.from(data))
  fs.renameSync(tmp, _dbPath)
}

// 开始批量写入：期间 upsert/setMeta 不落盘，调用 flush() 时统一持久化一次。
function beginBatch() {
  _deferPersist = true
}

// 结束批量写入并立即落盘（无论之前是否在批量模式，都强制写一次）。
function flush() {
  _deferPersist = false
  persist()
}

// 获取已初始化的 db 句柄（未初始化则抛错，保证调用时序正确）。
function db() {
  if (!_db) throw new Error('store 未初始化：请先 await init(dbPath)')
  return _db
}

// 关闭并释放内存中的 db（下次使用前需重新 init）。
function close() {
  if (_db) { _db.close(); _db = null }
  _SQL = null
  _dbPath = null
}

// 通用批量 upsert：事务包裹 + 每行执行 + 落盘。
function upsertMany(sql, rows, mapper) {
  if (!rows || rows.length === 0) return 0
  const d = db()
  d.run('BEGIN')
  let n = 0
  try {
    const stmt = d.prepare(sql)
    for (const r of rows) { stmt.run(mapper(r)); n++ }
    stmt.free()
    d.run('COMMIT')
  } catch (e) {
    try { d.run('ROLLBACK') } catch (_) {}
    throw e
  }
  if (!_deferPersist) persist()
  return n
}

// ---------- 写入（日级/分时的用量与费用）：按主键 INSERT OR REPLACE 去重 ----------
function upsertAmounts(rows) {
  return upsertMany(
    'INSERT OR REPLACE INTO amount_daily (utc_date, model, api_key_name, type, amount, price) VALUES (?,?,?,?,?,?)',
    rows,
    (r) => [r.utc_date, r.model, r.api_key_name || '', r.type, r.amount, r.price == null ? null : r.price]
  )
}

function upsertCosts(rows) {
  return upsertMany(
    'INSERT OR REPLACE INTO cost_daily (utc_date, model, api_key_name, wallet_type, cost, currency) VALUES (?,?,?,?,?,?)',
    rows,
    (r) => [r.utc_date, r.model, r.api_key_name || '', r.wallet_type || 'default', r.cost, r.currency]
  )
}

function upsertHourlyAmounts(rows) {
  return upsertMany(
    'INSERT OR REPLACE INTO hourly_usage (utc_date, hour, model, api_key_name, type, amount) VALUES (?,?,?,?,?,?)',
    rows,
    (r) => [r.utc_date, r.hour, r.model, r.api_key_name || '', r.type, r.amount]
  )
}

function upsertHourlyCosts(rows) {
  return upsertMany(
    'INSERT OR REPLACE INTO hourly_cost (utc_date, hour, model, api_key_name, cost, currency) VALUES (?,?,?,?,?,?)',
    rows,
    (r) => [r.utc_date, r.hour, r.model, r.api_key_name || '', r.cost, r.currency]
  )
}

// meta 键值读写：非字符串值自动 JSON 序列化。
function getMeta(key, def) {
  const rows = queryAll('SELECT value FROM meta WHERE key = ?', [key])
  return rows.length ? rows[0].value : (def === undefined ? null : def)
}

function setMeta(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value)
  db().run('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)', [key, v])
  if (!_deferPersist) persist()
}

// 参数化查询 → 行对象数组。
function queryAll(sql, params) {
  const d = db()
  const stmt = d.prepare(sql)
  try {
    if (params && params.length) stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    return rows
  } finally {
    stmt.free()
  }
}

// ---------- 用量面板查询 ----------
// 数据最早/最晚日期（已无此用途，保留供参考）。
function getDateRange() {
  const min = queryAll('SELECT MIN(utc_date) AS d FROM amount_daily')[0]
  const max = queryAll('SELECT MAX(utc_date) AS d FROM amount_daily')[0]
  return { min: min && min.d ? min.d : null, max: max && max.d ? max.d : null }
}

// 按模型分组的日级 token 用量（供按模型拆分视图）。
function getDailyByModel(start, end) {
  return queryAll(
    `SELECT utc_date, model,
       SUM(CASE WHEN type='input_cache_hit_tokens' THEN amount ELSE 0 END) AS cache_hit,
       SUM(CASE WHEN type='input_cache_miss_tokens' THEN amount ELSE 0 END) AS cache_miss,
       SUM(CASE WHEN type='output_tokens' THEN amount ELSE 0 END) AS output,
       SUM(CASE WHEN type='request_count' THEN amount ELSE 0 END) AS requests
     FROM amount_daily WHERE utc_date BETWEEN ? AND ? AND type != 'request_count'
     GROUP BY utc_date, model ORDER BY utc_date, model`,
    [start, end]
  )
}

// 每日 token 总量（日级堆叠图用）。
function getDailyTotals(start, end) {
  return queryAll(
    `SELECT utc_date,
       SUM(CASE WHEN type='input_cache_hit_tokens' THEN amount ELSE 0 END) AS cache_hit,
       SUM(CASE WHEN type='input_cache_miss_tokens' THEN amount ELSE 0 END) AS cache_miss,
       SUM(CASE WHEN type='output_tokens' THEN amount ELSE 0 END) AS output,
       SUM(CASE WHEN type='request_count' THEN amount ELSE 0 END) AS requests
     FROM amount_daily WHERE utc_date BETWEEN ? AND ?
     GROUP BY utc_date ORDER BY utc_date`,
    [start, end]
  )
}

// 每日费用（按币种）。
function getDailyCostTotals(start, end) {
  return queryAll(
    'SELECT utc_date, currency, SUM(cost) AS cost FROM cost_daily WHERE utc_date BETWEEN ? AND ? GROUP BY utc_date, currency ORDER BY utc_date',
    [start, end]
  )
}

// 某一天的 24 小时分时明细（点柱子下钻用）。
function getHourlyDetail(day) {
  const usage = queryAll(
    'SELECT hour, type, SUM(amount) AS amount FROM hourly_usage WHERE utc_date = ? GROUP BY hour, type',
    [day]
  )
  const cost = queryAll(
    'SELECT hour, currency, SUM(cost) AS cost FROM hourly_cost WHERE utc_date = ? GROUP BY hour, currency',
    [day]
  )
  const hours = []
  for (let h = 0; h < 24; h++) hours.push({ hour: h, cache_hit: 0, cache_miss: 0, output: 0, requests: 0, cost: 0 })
  for (const r of usage) {
    const h = hours[r.hour]
    if (!h) continue
    if (r.type === 'input_cache_hit_tokens') h.cache_hit += Number(r.amount) || 0
    else if (r.type === 'input_cache_miss_tokens') h.cache_miss += Number(r.amount) || 0
    else if (r.type === 'output_tokens') h.output += Number(r.amount) || 0
    else if (r.type === 'request_count') h.requests += Number(r.amount) || 0
  }
  for (const r of cost) {
    const h = hours[r.hour]
    if (h) h.cost += Number(r.cost) || 0
  }
  return { date: day, hours }
}

// 汇总卡片数据：总 token / 缓存命中 / 未命中 / 输出 / 请求次数 / 累计费用。
function getSummary() {
  const t = queryAll(
    `SELECT
       SUM(CASE WHEN type='input_cache_hit_tokens' THEN amount ELSE 0 END) AS cache_hit,
       SUM(CASE WHEN type='input_cache_miss_tokens' THEN amount ELSE 0 END) AS cache_miss,
       SUM(CASE WHEN type='output_tokens' THEN amount ELSE 0 END) AS output,
       SUM(CASE WHEN type='request_count' THEN amount ELSE 0 END) AS requests
     FROM amount_daily`
  )[0] || {}
  const cost = queryAll('SELECT currency, SUM(cost) AS cost FROM cost_daily GROUP BY currency')
  const cacheHit = Number(t.cache_hit) || 0
  const cacheMiss = Number(t.cache_miss) || 0
  const output = Number(t.output) || 0
  return {
    cache_hit: cacheHit,
    cache_miss: cacheMiss,
    output: output,
    requests: Number(t.requests) || 0,
    tokens: cacheHit + cacheMiss + output,
    cost,
  }
}

module.exports = {
  SCHEMA,
  init,
  persist,
  beginBatch,
  flush,
  close,
  db,
  queryAll,
  upsertAmounts,
  upsertCosts,
  upsertHourlyAmounts,
  upsertHourlyCosts,
  getMeta,
  setMeta,
  getDateRange,
  getDailyByModel,
  getDailyTotals,
  getDailyCostTotals,
  getHourlyDetail,
  getSummary,
}
