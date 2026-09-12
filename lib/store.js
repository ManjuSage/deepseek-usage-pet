'use strict'
// ---------------------------------------------------------------------------
// SQLite 存储层：Node.js 内置 node:sqlite
// - 直接读写数据库文件，无需加载 WASM 或整库 export
// - schema 与 33March7/deepseek-api-usage-statistics 对齐
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const log = require('./log')

let _db = null

// 日级接口只有日期桶，因此切换日按新口径归类；分时接口使用同步时观测到的切换点。
const FLASH_CUTOVER_DATE = '2026-09-10'
const V41_FLASH_SQL = "(model = 'deepseek-v4.1-flash' OR model GLOB 'deepseek-v4.1-flash-expires-on-[0-9][0-9][0-9][0-9]')"
const LEGACY_FLASH_SQL = "model IN ('deepseek-v4-flash', 'deepseek-v4-flash-vision-exp')"
const MODEL_GROUP_DAILY_SQL = `CASE
  WHEN model = 'deepseek-flash' OR ${V41_FLASH_SQL} THEN 'deepseek-v4.1-flash'
  WHEN ${LEGACY_FLASH_SQL} AND utc_date >= '${FLASH_CUTOVER_DATE}' THEN 'deepseek-v4.1-flash'
  WHEN model = 'deepseek-v4-flash' THEN 'deepseek-v4-flash-legacy'
  WHEN model = 'deepseek-v4-flash-vision-exp' THEN 'deepseek-v4-flash-vision-exp-legacy'
  ELSE model
END`
function observedFlashCutover() {
  const raw = getMeta('flash_cutover_observed_at')
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date) || !Number.isInteger(value.hour) || value.hour < 0 || value.hour > 23) return null
    return value
  } catch (e) {
    return null
  }
}

function modelGroupHourlySql() {
  const marker = observedFlashCutover()
  const legacyAfter = marker
    ? `(${LEGACY_FLASH_SQL} AND (utc_date > '${marker.date}' OR (utc_date = '${marker.date}' AND hour >= ${marker.hour})))`
    : '0'
  return `CASE
    WHEN model = 'deepseek-flash' OR ${V41_FLASH_SQL} OR ${legacyAfter} THEN 'deepseek-v4.1-flash'
    WHEN model = 'deepseek-v4-flash' THEN 'deepseek-v4-flash-legacy'
    WHEN model = 'deepseek-v4-flash-vision-exp' THEN 'deepseek-v4-flash-vision-exp-legacy'
    ELSE model
  END`
}

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

// 初始化：打开/创建数据库文件，返回 db 句柄。
async function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  try {
    _db = new DatabaseSync(dbPath)
    _db.exec(SCHEMA)
  } catch (err) {
    try { if (_db) _db.close() } catch (_) {}
    _db = null
    if (!fs.existsSync(dbPath) || ![11, 26].includes(err && err.errcode)) throw err

    let backupPath = dbPath + '.corrupt-' + Date.now()
    while (fs.existsSync(backupPath)) backupPath += '-1'
    fs.renameSync(dbPath, backupPath)
    log.warn('[store] 数据库损坏，已备份并重建: ' + backupPath)
    _db = new DatabaseSync(dbPath)
    _db.exec(SCHEMA)
  }
  log.info('[store] 数据库初始化成功: ' + dbPath)
  return _db
}

// node:sqlite 直接写入文件；保留接口以兼容现有调用方。
function persist() {
  return
}

// node:sqlite 每次事务直接落盘；保留批量接口以兼容现有同步流程。
function beginBatch() {
  return
}

function flush() {
  return
}

// 获取已初始化的 db 句柄（未初始化则抛错，保证调用时序正确）。
function db() {
  if (!_db) throw new Error('store 未初始化：请先 await init(dbPath)')
  return _db
}

// 关闭并释放内存中的 db（下次使用前需重新 init）。
function close() {
  if (_db) { _db.close(); _db = null }
}

// 通用批量 upsert：事务包裹 + 每行执行 + 落盘。
function upsertMany(sql, rows, mapper) {
  if (!rows || rows.length === 0) return 0
  const d = db()
  d.exec('BEGIN')
  let n = 0
  try {
    const stmt = d.prepare(sql)
    for (const r of rows) { stmt.run(...mapper(r)); n++ }
    d.exec('COMMIT')
  } catch (e) {
    try { d.exec('ROLLBACK') } catch (_) {}
    throw e
  }
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
  db().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run(key, v)
}

// 参数化查询 → 行对象数组。
function queryAll(sql, params) {
  const stmt = db().prepare(sql)
  return params && params.length ? stmt.all(...params) : stmt.all()
}

// ---------- 用量面板查询 ----------
function cacheHitRate(hit, miss) {
  const input = (Number(hit) || 0) + (Number(miss) || 0)
  return input > 0 ? ((Number(hit) || 0) / input) * 100 : null
}

function withCacheHitRate(rows) {
  return rows.map((r) => ({ ...r, cache_hit_rate: cacheHitRate(r.cache_hit, r.cache_miss) }))
}

// 数据最早/最晚日期（覆盖 amount_daily 与 cost_daily，供「总体」范围使用）。
function getDateRange() {
  const r = queryAll(`
    SELECT MIN(d) AS mn, MAX(d) AS mx FROM (
      SELECT utc_date AS d FROM amount_daily
      UNION ALL
      SELECT utc_date AS d FROM cost_daily
    )
  `)[0]
  return { min: (r && r.mn) || null, max: (r && r.mx) || null }
}

// 按模型分组的日级 token 用量（供按模型拆分视图）。
function getDailyByModel(start, end) {
  return withCacheHitRate(queryAll(
    `SELECT utc_date, ${MODEL_GROUP_DAILY_SQL} AS model,
       SUM(CASE WHEN type='input_cache_hit_tokens' THEN amount ELSE 0 END) AS cache_hit,
       SUM(CASE WHEN type='input_cache_miss_tokens' THEN amount ELSE 0 END) AS cache_miss,
       SUM(CASE WHEN type='output_tokens' THEN amount ELSE 0 END) AS output,
       SUM(CASE WHEN type='request_count' THEN amount ELSE 0 END) AS requests
     FROM amount_daily WHERE utc_date BETWEEN ? AND ? AND type != 'request_count'
     GROUP BY utc_date, ${MODEL_GROUP_DAILY_SQL} ORDER BY utc_date, model`,
    [start, end]
  ))
}

// 按 API Key 分组的日级 token 用量（供「按 API Key」拆分视图）。
function getDailyByKey(start, end) {
  return withCacheHitRate(queryAll(
    `SELECT utc_date, api_key_name,
       SUM(CASE WHEN type='input_cache_hit_tokens' THEN amount ELSE 0 END) AS cache_hit,
       SUM(CASE WHEN type='input_cache_miss_tokens' THEN amount ELSE 0 END) AS cache_miss,
       SUM(CASE WHEN type='output_tokens' THEN amount ELSE 0 END) AS output,
       SUM(CASE WHEN type='request_count' THEN amount ELSE 0 END) AS requests
     FROM amount_daily WHERE utc_date BETWEEN ? AND ? AND type != 'request_count'
     GROUP BY utc_date, api_key_name ORDER BY utc_date, api_key_name`,
    [start, end]
  ))
}

// 按模型汇总的 token 总量 + 费用（各模型占比饼图 / 累计趋势用）。
function getModelTotals(start, end) {
  const tokens = queryAll(
    `SELECT ${MODEL_GROUP_DAILY_SQL} AS model,
       SUM(CASE WHEN type='input_cache_hit_tokens' THEN amount ELSE 0 END
         + CASE WHEN type='input_cache_miss_tokens' THEN amount ELSE 0 END
         + CASE WHEN type='output_tokens' THEN amount ELSE 0 END) AS tokens
     FROM amount_daily WHERE utc_date BETWEEN ? AND ? AND type != 'request_count'
     GROUP BY ${MODEL_GROUP_DAILY_SQL} ORDER BY model`,
    [start, end]
  )
  const costs = queryAll(
    `SELECT ${MODEL_GROUP_DAILY_SQL} AS model, currency, SUM(cost) AS cost
     FROM cost_daily WHERE utc_date BETWEEN ? AND ?
     GROUP BY ${MODEL_GROUP_DAILY_SQL}, currency ORDER BY model`,
    [start, end]
  )
  const map = new Map()
  for (const r of tokens) map.set(r.model, { model: r.model, tokens: Number(r.tokens) || 0, cost: {} })
  for (const r of costs) {
    if (!map.has(r.model)) map.set(r.model, { model: r.model, tokens: 0, cost: {} })
    map.get(r.model).cost[r.currency] = Number(r.cost) || 0
  }
  return [...map.values()]
}

// 每日 token 总量（日级堆叠图用）。
function getDailyTotals(start, end) {
  return withCacheHitRate(queryAll(
    `SELECT utc_date,
       SUM(CASE WHEN type='input_cache_hit_tokens' THEN amount ELSE 0 END) AS cache_hit,
       SUM(CASE WHEN type='input_cache_miss_tokens' THEN amount ELSE 0 END) AS cache_miss,
       SUM(CASE WHEN type='output_tokens' THEN amount ELSE 0 END) AS output,
       SUM(CASE WHEN type='request_count' THEN amount ELSE 0 END) AS requests
     FROM amount_daily WHERE utc_date BETWEEN ? AND ?
     GROUP BY utc_date ORDER BY utc_date`,
    [start, end]
  ))
}

// 每日费用（按币种）。
function getDailyCostTotals(start, end) {
  return queryAll(
    'SELECT utc_date, currency, SUM(cost) AS cost FROM cost_daily WHERE utc_date BETWEEN ? AND ? GROUP BY utc_date, currency ORDER BY utc_date',
    [start, end]
  )
}

// 每日按模型费用（供每日走势「按模型·费用」视图）。
function getDailyCostByModel(start, end) {
  return queryAll(
    `SELECT utc_date, ${MODEL_GROUP_DAILY_SQL} AS model, SUM(cost) AS cost
     FROM cost_daily WHERE utc_date BETWEEN ? AND ?
     GROUP BY utc_date, ${MODEL_GROUP_DAILY_SQL} ORDER BY utc_date, model`,
    [start, end]
  )
}

// 每日按 API Key 费用（供每日走势「按 API Key·费用」视图）。
function getDailyCostByKey(start, end) {
  return queryAll(
    'SELECT utc_date, api_key_name, SUM(cost) AS cost FROM cost_daily WHERE utc_date BETWEEN ? AND ? GROUP BY utc_date, api_key_name ORDER BY utc_date, api_key_name',
    [start, end]
  )
}

// 某一天的 24 小时分时明细（点柱子下钻用）。
// dim: 'type'（计费类型，默认）| 'model'（按模型）| 'key'（按 API Key）。
// 返回统一结构：{ date, dim, series:[{name,data:[24]}], cost:[24] }，series 为堆叠 token，cost 为费用折线。
function getHourlyDetail(day, dim) {
  dim = dim || 'type'
  const costArr = new Array(24).fill(0)
  const costRows = queryAll('SELECT hour, SUM(cost) AS cost FROM hourly_cost WHERE utc_date = ? GROUP BY hour', [day])
  for (const r of costRows) costArr[r.hour] = Number(r.cost) || 0

  if (dim !== 'type') {
    const col = dim === 'model' ? modelGroupHourlySql() : 'api_key_name'
    const usage = queryAll(
      `SELECT hour, ${col} AS name, SUM(amount) AS amount FROM hourly_usage WHERE utc_date = ? AND type != 'request_count' GROUP BY hour, ${col}`,
      [day]
    )
    const names = []
    const idx = {}
    for (const r of usage) {
      const n = r.name || '(未命名)'
      if (!(n in idx)) { idx[n] = names.length; names.push(n) }
    }
    const data = names.map(() => new Array(24).fill(0))
    for (const r of usage) {
      const n = r.name || '(未命名)'
      data[idx[n]][r.hour] = Number(r.amount) || 0
    }
    return { date: day, dim, series: names.map((n, i) => ({ name: n, data: data[i] })), cost: costArr }
  }

  const usage = queryAll(
    'SELECT hour, type, SUM(amount) AS amount FROM hourly_usage WHERE utc_date = ? AND type != \'request_count\' GROUP BY hour, type',
    [day]
  )
  const hit = new Array(24).fill(0)
  const miss = new Array(24).fill(0)
  const out = new Array(24).fill(0)
  for (const r of usage) {
    if (r.type === 'input_cache_hit_tokens') hit[r.hour] = Number(r.amount) || 0
    else if (r.type === 'input_cache_miss_tokens') miss[r.hour] = Number(r.amount) || 0
    else if (r.type === 'output_tokens') out[r.hour] = Number(r.amount) || 0
  }
  return {
    date: day,
    dim,
    series: [
      { name: '缓存命中', data: hit },
      { name: '缓存未命中', data: miss },
      { name: '输出', data: out },
    ],
    cost: costArr,
  }
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
    cache_hit_rate: cacheHitRate(cacheHit, cacheMiss),
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
  getDailyByKey,
  getModelTotals,
  getDailyTotals,
  getDailyCostTotals,
  getDailyCostByModel,
  getDailyCostByKey,
  getHourlyDetail,
  getSummary,
}
