'use strict'
// ---------------------------------------------------------------------------
// 余额 / 用量核心：与原版 DSH 插件 lib/index.js 宿主侧逻辑 1:1 移植
// - 余额拉取：GET https://api.deepseek.com/user/balance
//   · balance_infos 选取规则（优先级）：CNY 且 >0 → 任意非零 → CNY → 第一项
//   · 重试：网络错误/超时/5xx 重试 1 次（间隔 500ms）；4xx 不重试
//   · 缓存：25 秒内存 TTL + 进行中请求去重（in-flight 复用）
//   · 瞬时失败（非 4xx）时回退缓存中的最近余额（stale 标记）
// - 今日已用双模式：
//   · ledger：小鲸鱼记账（余额差值，见 lib/ledger.js）
//   · token：平台费用接口返回的实际账单费用
// ---------------------------------------------------------------------------
const ledger = require('./ledger')
const log = require('./log')

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const USAGE_COST_URL = 'https://platform.deepseek.com/api/v0/usage/by_api_key/cost'
const BALANCE_TTL_MS = 25000
const FETCH_TIMEOUT_MS = 20000

// 峰谷时段：每日 9:00–12:00 与 14:00–18:00（北京时间 UTC+8）
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]
// bucket time 是 Unix 秒；换算北京时间判断峰谷。
// 周末（周六、周日）全天按谷价，但带生效分界：北京时间 2026-08-23 00:00 起
// 才生效，之前的周末历史用量仍按旧峰谷规则计价。
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000) // = 北京时间 2026-08-23 00:00
function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const d = new Date(n * 1000 + 8 * 3600 * 1000)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const day = d.getUTCDay() // 0=周日, 6=周六
    if (day === 0 || day === 6) return false // 生效后的周末全天低谷
  }
  const hour = d.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

function pickBalanceInfo(infos) {
  if (!Array.isArray(infos) || infos.length === 0) return null
  const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
  return (
    infos.find((x) => x && x.currency === 'CNY' && num(x) > 0) ||
    infos.find((x) => num(x) > 0) ||
    infos.find((x) => x && x.currency === 'CNY') ||
    infos[0]
  )
}

async function fetchBalance(apiKey) {
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    let res
    try {
      res = await fetch(BALANCE_URL, {
        headers: { Authorization: 'Bearer ' + apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      lastErr = err
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
      continue
    }
    if (!res.ok) {
      lastErr = new Error('HTTP ' + res.status)
      if (res.status < 500) break
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
      continue
    }
    let data
    try {
      data = await res.json()
    } catch (err) {
      log.warn('[balance] 余额接口返回不是合法 JSON')
      return { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' }
    }
    const info = pickBalanceInfo(data && data.balance_infos)
    if (!info || info.total_balance === undefined) {
      log.warn('[balance] 余额接口返回结构异常')
      return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
    }
    log.debug('[balance] 余额已刷新 ' + String(info.currency || 'CNY') + '=' + info.total_balance)
    return {
      ok: true,
      totalBalance: Number(info.total_balance),
      currency: String(info.currency || 'CNY'),
      updatedAt: new Date().toISOString(),
    }
  }
  const transient = !(lastErr && /^HTTP 4\d\d/.test(lastErr.message))
  const errMsg = (lastErr && lastErr.message) || '未知错误'
  if (transient) log.debug('[balance] 余额获取失败(临时): ' + errMsg)
  else log.warn('[balance] 余额获取失败: ' + errMsg)
  return {
    ok: false,
    code: 'HTTP',
    transient,
    error: '余额获取失败',
  }
}

function stripBearer(v) {
  return String(v || '').replace(/^Bearer\s+/i, '')
}

async function fetchUsage(platformToken, currency) {
  try {
    const TZ_OFFSET_SEC = 8 * 3600
    const nowSec = Date.now() / 1000
    const start = Math.floor((nowSec + TZ_OFFSET_SEC) / 86400) * 86400 - TZ_OFFSET_SEC
    const end = start + 86400
    const url = USAGE_COST_URL + '?start=' + start + '&end=' + end + '&tz=' + TZ_OFFSET_SEC
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + stripBearer(platformToken) },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return { error: 'http ' + res.status }
    const data = await res.json()
    const u = computeTodayCost(data, currency)
    if (u && isFinite(u.amount)) return u
    return { error: 'no usage' }
  } catch (err) {
    return { error: String((err && err.message) || err) }
  }
}

function computeTodayCost(data, currency) {
  // data.data.biz_data.data[]: [{currency, series:[{model, buckets:[{time, cost}]}]}]
  const code = data && data.code
  if (code !== undefined && code !== 0 && String(code) !== '0' && String(code) !== '200') return null
  const inner = data && data.data
  if (inner && inner.biz_code !== undefined && String(inner.biz_code) !== '0') return null
  let d = data
  if (d && d.data && d.data.biz_data && Array.isArray(d.data.biz_data.data)) d = d.data.biz_data
  else if (d && d.data && Array.isArray(d.data.data)) d = d.data
  const groups = Array.isArray(d && d.data) ? d.data : null
  if (!groups) return null
  const wanted = String(currency || 'CNY').toUpperCase()
  let amount = 0
  for (const group of groups) {
    if (!group || String(group.currency || 'CNY').toUpperCase() !== wanted) continue
    for (const s of (Array.isArray(group.series) ? group.series : [])) {
      for (const b of (Array.isArray(s && s.buckets) ? s.buckets : [])) {
        const cost = Number(b && b.cost)
        if (!isFinite(cost)) continue
        amount += cost
      }
    }
  }
  return { amount }
}

// 余额服务：TTL 缓存 + in-flight 去重 + 记账观测 + 双模式今日已用
class BalanceService {
  constructor() {
    this.cache = null // { at, payload }
    this.inFlight = null
  }

  invalidate() {
    this.cache = null
  }

  getSnapshot(cfg) {
    const now = Date.now()
    if (this.cache && now - this.cache.at < BALANCE_TTL_MS) {
      return Promise.resolve(this.cache.payload)
    }
    if (this.inFlight) return this.inFlight
    this.inFlight = this.compute(cfg)
      .then((payload) => {
        if (payload.ok) {
          this.cache = { at: Date.now(), payload }
        } else if (payload.transient && this.cache) {
          return { ...this.cache.payload, stale: true, error: payload.error }
        }
        return payload
      })
      .catch(() => ({ ok: false, code: 'ERROR', error: '余额服务异常' }))
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  async compute(cfg) {
    if (!cfg.apiKey) {
      return { ok: false, code: 'NO_KEY', error: '未配置 API Key' }
    }
    const payload = await fetchBalance(cfg.apiKey)
    if (!payload.ok) return payload
    // 无论哪种模式，都先把余额观测记入账本（自动累积「小鲸鱼记账」数据）
    const led = ledger.recordBalance(Number(payload.totalBalance), payload.currency)
    const full = { ...payload }
    full.isPeak = isPeakTime(Math.floor(Date.now() / 1000))
    if (cfg.usageMode === 'token') {
      if (cfg.platformToken) {
        const u = await fetchUsage(cfg.platformToken, payload.currency)
        if (u && u.amount !== undefined) {
          full.todayUsage = u.amount
          full.usageMode = 'token'
          return full
        }
      }
      // 无令牌或令牌失败：回落记账模式
      full.todayUsage = led.todayUsage
      full.usageMode = 'ledger'
      return full
    }
    // 记账模式：配置了平台令牌时，每次刷新都与平台今日实际费用对账，取两者较大值，
    // 既补齐「未运行期间的花费」，也兼容「今天已经打开过」的情况（无需等到跨天）。
    if (cfg.platformToken) {
      const u = await fetchUsage(cfg.platformToken, payload.currency)
      if (u && typeof u.amount === 'number' && isFinite(u.amount) && u.amount > 0) {
        const todayUsage = Math.max(led.todayUsage, u.amount)
        if (todayUsage > led.todayUsage) {
          ledger.seedToday(todayUsage)
        }
        full.todayUsage = todayUsage
        full.usageMode = 'ledger'
        return full
      }
    }
    full.todayUsage = led.todayUsage
    full.usageMode = 'ledger'
    return full
  }
}

module.exports = {
  PEAK_HOURS,
  isPeakTime,
  pickBalanceInfo,
  fetchBalance,
  fetchUsage,
  computeTodayCost,
  BalanceService,
  BALANCE_URL,
  BALANCE_TTL_MS,
}
