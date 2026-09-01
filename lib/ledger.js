'use strict'
// ---------------------------------------------------------------------------
// 小鲸鱼记账（默认模式）：每次观测到余额后，用余额下降的差值累计当天用量。
// 持久化到 ~/.config/whale-pet/usage.json；跨天自动归零并归档历史（保留 30 天）。
// 与原版（DSH 插件 lib/index.js recordLedgerUsage）语义完全一致。
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')
const config = require('./config')
const log = require('./log')

const USAGE_FILE = config.USAGE_FILE

function todayKey(now) {
  const d = now || new Date()
  // 与用量同步统一按 GMT+8 分日（平台用量按 GMT+8 分桶），
  // 避免机器不在东八区时跨天归档与平台日桶不一致。
  const bj = new Date(d.getTime() + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return bj.getUTCFullYear() + '-' + p(bj.getUTCMonth() + 1) + '-' + p(bj.getUTCDate())
}

function readLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && typeof parsed.date === 'string') {
      return {
        date: parsed.date,
        lastBalance: typeof parsed.lastBalance === 'number' ? parsed.lastBalance : null,
        lastCurrency: typeof parsed.lastCurrency === 'string' ? parsed.lastCurrency : '',
        todayUsage: typeof parsed.todayUsage === 'number' ? parsed.todayUsage : 0,
        history: parsed.history && typeof parsed.history === 'object' ? parsed.history : {},
      }
    }
  } catch (err) {}
  return { date: todayKey(), lastBalance: null, lastCurrency: '', todayUsage: 0, history: {} }
}

function writeLedger(led) {
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true, mode: 0o700 })
    const tmp = USAGE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(led, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, USAGE_FILE)
    return true
  } catch (err) {
    log.error('[ledger] 写盘失败: ' + ((err && err.message) || err))
    return false
  }
}

// 观测一次余额 → 返回（可能已更新）的账本。
// 币种感知：观测币种与上次不同时只重置基准、不记差值——数值跳变来自币种
// 切换而非真实消费（避免 CNY/USD 切换时把跳变记成假账）。
function recordBalance(currentBalance, currency, now) {
  const t = todayKey(now)
  let led = readLedger()
  const cur = String(currency || '')
  const currencyChanged =
    typeof led.lastCurrency === 'string' && led.lastCurrency !== '' &&
    cur !== '' && led.lastCurrency !== cur
  const crossed = led.date !== t
  if (crossed) {
    log.debug('[ledger] 跨天归档: ' + led.date + ' → ' + t)
    // 跨天：昨天(或上次记录的日期)的 todayUsage 归档进 history，保留最近 30 天
    if (led.date && typeof led.todayUsage === 'number') {
      led.history = led.history || {}
      led.history[led.date] = led.todayUsage
    }
    led.date = t
    led.lastBalance = currentBalance
    led.lastCurrency = cur
    led.todayUsage = 0
  } else if (currencyChanged) {
    log.debug('[ledger] 币种切换，重置基准: ' + led.lastCurrency + ' → ' + cur)
    // 币种切换：只换基准，不把差值记成消费
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  } else {
    const prev = typeof led.lastBalance === 'number' ? led.lastBalance : currentBalance
    if (typeof prev === 'number' && typeof currentBalance === 'number' && currentBalance < prev) {
      led.todayUsage = (typeof led.todayUsage === 'number' ? led.todayUsage : 0) + (prev - currentBalance)
    }
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  }
  const keys = Object.keys(led.history || {}).sort()
  while (keys.length > 30) {
    delete led.history[keys.shift()]
  }
  writeLedger(led)
  led.crossed = crossed // 仅供调用方判断「是否刚跨天」，不写入文件
  return led
}

// 用平台接口返回的今日用量覆盖账本起点（仅在跨天第一次观测后调用）。
// 覆盖（替换 0），不是叠加，避免与之后的余额差值重复计算。
function seedToday(amount) {
  const led = readLedger()
  if (typeof amount === 'number' && isFinite(amount) && amount > 0) {
    led.todayUsage = amount
  }
  writeLedger(led)
  return led
}

module.exports = { USAGE_FILE, todayKey, readLedger, writeLedger, recordBalance, seedToday }
