'use strict'
// ---------------------------------------------------------------------------
// DeepSeek 平台私有用量接口 → SQLite 落库
// 端点（platform.deepseek.com，需 userToken，即平台会话令牌）：
//   /api/v0/usage/by_api_key/amount  （tokens）
//   /api/v0/usage/by_api_key/cost    （费用）
// 分时 = 同端点 + bucket=3600（平台仅保留今天+昨天）
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('./config')
const store = require('./store')

const PLATFORM_BASE = 'https://platform.deepseek.com'
const AMOUNT_URL = PLATFORM_BASE + '/api/v0/usage/by_api_key/amount'
const COST_URL = PLATFORM_BASE + '/api/v0/usage/by_api_key/cost'
const USER_SUMMARY_URL = PLATFORM_BASE + '/api/v0/users/get_user_summary'
const TZ_OFFSET_SEC = 8 * 3600 // 平台默认 GMT+8

let RAW_DIR = path.join(config.CONFIG_DIR, 'raw')
const RAW_MAX_FILES = 100 // 原始响应存档上限：只保留最近 100 份，防止无限增长

function setRawDir(dir) {
  RAW_DIR = dir
}

const TYPE_MAP = {
  PROMPT_CACHE_HIT_TOKEN: 'input_cache_hit_tokens',
  PROMPT_CACHE_MISS_TOKEN: 'input_cache_miss_tokens',
  RESPONSE_TOKEN: 'output_tokens',
  REQUEST: 'request_count',
}

function stripBearer(v) {
  return String(v || '').replace(/^Bearer\s+/i, '')
}

async function getBizData(url, token) {
  let res
  try {
    res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + stripBearer(token), Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    })
  } catch (err) {
    throw new Error('网络请求失败: ' + ((err && err.message) || err))
  }
  let text = ''
  try {
    text = await res.text()
  } catch (err) { /* 忽略读取失败 */ }
  archiveRaw(url, text)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error('响应不是合法 JSON')
  }
  const code = data && data.code
  if (code !== undefined && code !== 0 && String(code) !== '0' && String(code) !== '200') {
    const err = new Error('平台错误 code=' + code + ' ' + (data.msg || data.message || ''))
    err.expired = String(code) === '40002' || String(code) === '40003'
    throw err
  }
  const inner = data && data.data
  if (inner && inner.biz_code !== undefined && String(inner.biz_code) !== '0') {
    throw new Error('平台 biz_code=' + inner.biz_code + ' ' + (inner.biz_msg || ''))
  }
  return (inner && inner.biz_data) || {}
}

// 原始响应存档：用于私有接口结构变动时排查。
function archiveRaw(url, text) {
  try {
    fs.mkdirSync(RAW_DIR, { recursive: true, mode: 0o700 })
    const name = (url.split('?')[0].split('/').pop() || 'resp').replace(/[^a-zA-Z0-9_-]/g, '_')
    const stamp = new Date().toISOString().replace(/[:.]/g, '')
    fs.writeFileSync(path.join(RAW_DIR, name + '_' + stamp + '.json'), url + '\n' + text, { encoding: 'utf8', mode: 0o600 })
    // 清理旧档案：按文件名（含时间戳）排序，只保留最近 RAW_MAX_FILES 个
    const files = fs.readdirSync(RAW_DIR).filter((f) => f.endsWith('.json')).sort()
    while (files.length > RAW_MAX_FILES) {
      const oldest = files.shift()
      try { fs.unlinkSync(path.join(RAW_DIR, oldest)) } catch (e) {}
    }
  } catch (e) { /* 存档失败不影响主流程 */ }
}

function tsToDate(ts) {
  return new Date((Number(ts) + TZ_OFFSET_SEC) * 1000).toISOString().slice(0, 10)
}

function tsToHour(ts) {
  const d = new Date((Number(ts) + TZ_OFFSET_SEC) * 1000)
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() }
}

function normalizeAmount(biz, hourly) {
  const rows = []
  const series = Array.isArray(biz && biz.series) ? biz.series : []
  for (const s of series) {
    const keyName = (s.api_key && s.api_key.name) || ''
    const model = s.model || 'unknown'
    for (const b of (s.buckets || [])) {
      const usage = b.usage || {}
      for (const [type, amount] of Object.entries(usage)) {
        const mapped = TYPE_MAP[type]
        if (!mapped) continue
        const n = Number(amount) || 0
        if (n === 0) continue
        if (hourly) {
          const { date, hour } = tsToHour(b.time)
          rows.push({ utc_date: date, hour, model, api_key_name: keyName, type: mapped, amount: n })
        } else {
          rows.push({ utc_date: tsToDate(b.time), model, api_key_name: keyName, type: mapped, amount: n })
        }
      }
    }
  }
  return rows
}

function normalizeCost(biz, hourly) {
  const rows = []
  const data = Array.isArray(biz && biz.data) ? biz.data : []
  for (const entry of data) {
    const currency = entry.currency || 'CNY'
    for (const s of (entry.series || [])) {
      const keyName = (s.api_key && s.api_key.name) || ''
      const model = s.model || 'unknown'
      for (const b of (s.buckets || [])) {
        const cost = Number(b.cost) || 0
        if (cost === 0) continue
        if (hourly) {
          const { date, hour } = tsToHour(b.time)
          rows.push({ utc_date: date, hour, model, api_key_name: keyName, cost, currency })
        } else {
          rows.push({ utc_date: tsToDate(b.time), model, api_key_name: keyName, cost, currency })
        }
      }
    }
  }
  return rows
}

function gmt8Today() {
  return new Date(Date.now() + TZ_OFFSET_SEC * 1000).toISOString().slice(0, 10)
}

function gmt8Yesterday() {
  return new Date(Date.now() + TZ_OFFSET_SEC * 1000 - 86400 * 1000).toISOString().slice(0, 10)
}

function dayStartUnix(gmt8DateStr) {
  const [y, m, d] = gmt8DateStr.split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / 1000) - TZ_OFFSET_SEC
}

function gmt8AddDays(gmt8DateStr, n) {
  const [y, m, d] = String(gmt8DateStr).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d) + n * 86400 * 1000).toISOString().slice(0, 10)
}

function amountUrl(start, end, bucket) {
  let u = AMOUNT_URL + '?start=' + start + '&end=' + end + '&tz=' + TZ_OFFSET_SEC
  if (bucket) u += '&bucket=' + bucket
  return u
}

function costUrl(start, end, bucket) {
  let u = COST_URL + '?start=' + start + '&end=' + end + '&tz=' + TZ_OFFSET_SEC
  if (bucket) u += '&bucket=' + bucket
  return u
}

// ---------- 账号指纹（防污染） ----------
function extractAccountKeys(biz) {
  const keys = new Set()
  const series = Array.isArray(biz && biz.series) ? biz.series : []
  for (const s of series) {
    const ak = s.api_key || {}
    const tid = String(ak.tracking_id || '')
    const name = String(ak.name || '')
    if (tid || name) keys.add(tid + '|' + name)
  }
  return keys
}

function accountFingerprint(keys) {
  return crypto.createHash('sha256').update([...keys].sort().join(';')).digest('hex').slice(0, 16)
}

function loadAccountKeys() {
  const v = store.getMeta('account_keys')
  if (!v) return new Set()
  try {
    const arr = JSON.parse(v)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch (e) {
    return new Set()
  }
}

function accountsConflict(stored, current) {
  if (!stored.size || !current.size) return false
  for (const k of stored) if (current.has(k)) return false
  return true
}

function checkAccount(biz) {
  const currentKeys = extractAccountKeys(biz)
  if (accountsConflict(loadAccountKeys(), currentKeys)) {
    const err = new Error('检测到登录账号与本地数据不一致（API Key 集合不同），已中止同步，本地历史保留未动')
    err.accountChanged = true
    throw err
  }
  if (currentKeys.size) {
    store.setMeta('account_keys', JSON.stringify([...currentKeys].sort()))
    store.setMeta('account_fingerprint', accountFingerprint(currentKeys))
  }
}

// 同步某个 GMT+8 日（日级 amount/cost）。
async function syncDay(token, gmt8DateStr) {
  const start = dayStartUnix(gmt8DateStr)
  const end = start + 86400
  const amountBiz = await getBizData(amountUrl(start, end), token)
  checkAccount(amountBiz)
  const amountRows = normalizeAmount(amountBiz, false)
  store.upsertAmounts(amountRows)
  const costRows = normalizeCost(await getBizData(costUrl(start, end), token), false)
  store.upsertCosts(costRows)
  return { amount: amountRows.length, cost: costRows.length }
}

// 同步今天 + 昨天的分时（小时级 amount/cost）。
async function syncHourly(token) {
  let nA = 0
  let nC = 0
  for (const d of [gmt8Today(), gmt8Yesterday()]) {
    const start = dayStartUnix(d)
    const end = start + 86400
    const amountRows = normalizeAmount(await getBizData(amountUrl(start, end, 3600), token), true)
    store.upsertHourlyAmounts(amountRows)
    nA += amountRows.length
    const costRows = normalizeCost(await getBizData(costUrl(start, end, 3600), token), true)
    store.upsertHourlyCosts(costRows)
    nC += costRows.length
  }
  return { amount: nA, cost: nC }
}

// 历史日级回填：以 30 天为一段，从今天往回回溯，连续两段全空即停（最多约 60 个月）。
async function syncBackfill(token) {
  let zeroStreak = 0
  let amountTotal = 0
  let costTotal = 0
  let endDate = gmt8AddDays(gmt8Today(), 1) // 结束边界（不含今日）→ 实际含今日
  let first = true
  for (let i = 0; i < 120; i++) {
    const startDate = gmt8AddDays(endDate, -30)
    const start = dayStartUnix(startDate)
    const end = dayStartUnix(endDate)
    const amountBiz = await getBizData(amountUrl(start, end), token)
    if (first) { first = false; checkAccount(amountBiz) }
    const amountRows = normalizeAmount(amountBiz, false)
    store.upsertAmounts(amountRows)
    amountTotal += amountRows.length
    const costRows = normalizeCost(await getBizData(costUrl(start, end), token), false)
    store.upsertCosts(costRows)
    costTotal += costRows.length
    if (amountRows.length === 0 && costRows.length === 0) {
      zeroStreak++
      if (zeroStreak >= 2) break
    } else {
      zeroStreak = 0
    }
    endDate = startDate
    if (startDate <= '2020-01-01') break
  }
  return { amount: amountTotal, cost: costTotal }
}

// 拉取账户余额（充值/赠金），落库到 meta 供面板展示。
async function syncBalance(token) {
  try {
    const biz = await getBizData(USER_SUMMARY_URL, token)
    const normal = Array.isArray(biz.normal_wallets) ? biz.normal_wallets[0] : null
    const bonus = Array.isArray(biz.bonus_wallets) ? biz.bonus_wallets[0] : null
    const wallets = {}
    if (normal) wallets.normal = { currency: String(normal.currency || 'CNY'), balance: Number(normal.balance) || 0 }
    if (bonus) wallets.bonus = { currency: String(bonus.currency || 'CNY'), balance: Number(bonus.balance) || 0 }
    if (wallets.normal || wallets.bonus) store.setMeta('balance_wallets', wallets)
    return { ok: true, wallets }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

// 完整同步：历史日级回填 + 今昨分时 + 余额。
async function syncAll(token) {
  const backfill = await syncBackfill(token)
  const hourly = await syncHourly(token)
  const balance = await syncBalance(token)
  store.setMeta('last_sync_at', new Date().toISOString())
  return { backfill, hourly, balance }
}

// 轻量同步（自动同步用）：最近两天日级 + 今昨分时 + 余额，不含历史回填。
async function syncRecent(token) {
  const days = [gmt8Today(), gmt8Yesterday()]
  let amount = 0
  let cost = 0
  for (const d of days) {
    const r = await syncDay(token, d)
    amount += r.amount
    cost += r.cost
  }
  const hourly = await syncHourly(token)
  const balance = await syncBalance(token)
  store.setMeta('last_sync_at', new Date().toISOString())
  return { amount, cost, hourly, balance }
}

// 校验平台令牌是否有效（调用 get_user_summary，成功即有效）。
async function validateToken(token) {
  try {
    await getBizData(PLATFORM_BASE + '/api/v0/users/get_user_summary', token)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), expired: !!(err && err.expired) }
  }
}

module.exports = {
  TZ_OFFSET_SEC,
  setRawDir,
  syncAll,
  syncRecent,
  syncDay,
  syncHourly,
  syncBackfill,
  syncBalance,
  validateToken,
  normalizeAmount,
  normalizeCost,
  tsToDate,
  tsToHour,
  gmt8Today,
  gmt8Yesterday,
  dayStartUnix,
  gmt8AddDays,
  extractAccountKeys,
  accountFingerprint,
  accountsConflict,
  checkAccount,
}
