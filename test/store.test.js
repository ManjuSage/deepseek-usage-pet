'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const store = require('../lib/store')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-store-'))
const DB = path.join(tmpDir, 'test.db')
const DB2 = path.join(tmpDir, 'test2.db')

test('store: 建库 + upsert 去重 + 持久化重载 + meta', async () => {
  await store.init(DB)

  const n1 = store.upsertAmounts([
    { utc_date: '2026-08-28', model: 'deepseek-v4-pro', api_key_name: 'codex', type: 'output_tokens', amount: 100 },
    { utc_date: '2026-08-28', model: 'deepseek-v4-pro', api_key_name: 'codex', type: 'input_cache_hit_tokens', amount: 200 },
  ])
  assert.strictEqual(n1, 2)

  // 同主键覆盖，不产生重复行
  store.upsertAmounts([
    { utc_date: '2026-08-28', model: 'deepseek-v4-pro', api_key_name: 'codex', type: 'output_tokens', amount: 999 },
  ])
  const rows = store.queryAll("SELECT type, amount FROM amount_daily WHERE model='deepseek-v4-pro' ORDER BY type")
  assert.strictEqual(rows.length, 2)
  assert.strictEqual(rows.find((r) => r.type === 'output_tokens').amount, 999)

  store.upsertCosts([
    { utc_date: '2026-08-28', model: 'deepseek-v4-pro', api_key_name: 'codex', cost: 3.14, currency: 'CNY' },
  ])
  assert.strictEqual(store.queryAll('SELECT COUNT(*) AS c FROM cost_daily')[0].c, 1)

  store.setMeta('account_fingerprint', { h: 'abc' })
  assert.strictEqual(store.getMeta('account_fingerprint'), '{"h":"abc"}')
  assert.strictEqual(store.getMeta('missing'), null)

  store.close()

  // 重新从文件打开 → 数据完整（export/import 持久化验证）
  await store.init(DB)
  assert.strictEqual(store.queryAll('SELECT COUNT(*) AS c FROM amount_daily')[0].c, 2)
  assert.strictEqual(store.queryAll('SELECT COUNT(*) AS c FROM cost_daily')[0].c, 1)
  store.close()
})

test('store: 用量查询方法（daily/hourly/summary/range）', async () => {
  await store.init(DB2)
  store.upsertAmounts([
    { utc_date: '2026-08-28', model: 'deepseek-v4-pro', api_key_name: 'codex', type: 'input_cache_hit_tokens', amount: 1000 },
    { utc_date: '2026-08-28', model: 'deepseek-v4-pro', api_key_name: 'codex', type: 'input_cache_miss_tokens', amount: 200 },
    { utc_date: '2026-08-28', model: 'deepseek-v4-pro', api_key_name: 'codex', type: 'output_tokens', amount: 50 },
    { utc_date: '2026-08-28', model: 'deepseek-v4-pro', api_key_name: 'codex', type: 'request_count', amount: 3 },
  ])
  store.upsertCosts([
    { utc_date: '2026-08-28', model: 'deepseek-v4-pro', api_key_name: 'codex', cost: 1.5, currency: 'CNY' },
  ])
  store.upsertHourlyAmounts([
    { utc_date: '2026-08-28', hour: 10, model: 'deepseek-v4-pro', api_key_name: 'codex', type: 'output_tokens', amount: 40 },
  ])
  store.upsertHourlyCosts([
    { utc_date: '2026-08-28', hour: 10, model: 'deepseek-v4-pro', api_key_name: 'codex', cost: 0.5, currency: 'CNY' },
  ])

  const totals = store.getDailyTotals('2026-08-28', '2026-08-28')
  assert.strictEqual(totals.length, 1)
  assert.strictEqual(totals[0].cache_hit, 1000)
  assert.strictEqual(totals[0].requests, 3)

  const byModel = store.getDailyByModel('2026-08-28', '2026-08-28')
  assert.strictEqual(byModel.length, 1)
  assert.strictEqual(byModel[0].output, 50)

  const hourly = store.getHourlyDetail('2026-08-28')
  assert.strictEqual(hourly.hours.length, 24)
  assert.strictEqual(hourly.hours[10].output, 40)
  assert.strictEqual(hourly.hours[10].cost, 0.5)

  const summary = store.getSummary()
  assert.strictEqual(summary.tokens, 1250)
  assert.strictEqual(summary.requests, 3)
  assert.strictEqual(summary.cost[0].cost, 1.5)

  const range = store.getDateRange()
  assert.strictEqual(range.min, '2026-08-28')
  assert.strictEqual(range.max, '2026-08-28')
  store.close()
})
