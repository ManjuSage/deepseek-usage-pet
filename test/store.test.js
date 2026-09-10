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
const DB3 = path.join(tmpDir, 'test3.db')
const DB4 = path.join(tmpDir, 'test4.db')

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
  assert.ok(Math.abs(totals[0].cache_hit_rate - 83.33333333333333) < 1e-9)
  assert.strictEqual(totals[0].requests, 3)

  const byModel = store.getDailyByModel('2026-08-28', '2026-08-28')
  assert.strictEqual(byModel.length, 1)
  assert.strictEqual(byModel[0].output, 50)
  assert.ok(Math.abs(byModel[0].cache_hit_rate - 83.33333333333333) < 1e-9)

  const byKey = store.getDailyByKey('2026-08-28', '2026-08-28')
  assert.strictEqual(byKey.length, 1)
  assert.strictEqual(byKey[0].api_key_name, 'codex')
  assert.strictEqual(byKey[0].output, 50)
  assert.ok(Math.abs(byKey[0].cache_hit_rate - 83.33333333333333) < 1e-9)

  const modelTotals = store.getModelTotals('2026-08-28', '2026-08-28')
  assert.strictEqual(modelTotals.length, 1)
  assert.strictEqual(modelTotals[0].model, 'deepseek-v4-pro')
  assert.strictEqual(modelTotals[0].tokens, 1250)
  assert.strictEqual(modelTotals[0].cost.CNY, 1.5)

  const costByModel = store.getDailyCostByModel('2026-08-28', '2026-08-28')
  assert.strictEqual(costByModel.length, 1)
  assert.strictEqual(costByModel[0].model, 'deepseek-v4-pro')
  assert.strictEqual(costByModel[0].cost, 1.5)

  const costByKey = store.getDailyCostByKey('2026-08-28', '2026-08-28')
  assert.strictEqual(costByKey.length, 1)
  assert.strictEqual(costByKey[0].api_key_name, 'codex')
  assert.strictEqual(costByKey[0].cost, 1.5)

  const hourly = store.getHourlyDetail('2026-08-28')
  assert.strictEqual(hourly.dim, 'type')
  assert.strictEqual(hourly.series.length, 3)
  assert.strictEqual(hourly.cost.length, 24)
  assert.strictEqual(hourly.series[2].data[10], 40)
  assert.strictEqual(hourly.cost[10], 0.5)

  const hourlyByModel = store.getHourlyDetail('2026-08-28', 'model')
  assert.strictEqual(hourlyByModel.dim, 'model')
  assert.strictEqual(hourlyByModel.series.length, 1)
  assert.strictEqual(hourlyByModel.series[0].name, 'deepseek-v4-pro')
  assert.strictEqual(hourlyByModel.series[0].data[10], 40)

  const hourlyByKey = store.getHourlyDetail('2026-08-28', 'key')
  assert.strictEqual(hourlyByKey.dim, 'key')
  assert.strictEqual(hourlyByKey.series.length, 1)
  assert.strictEqual(hourlyByKey.series[0].name, 'codex')
  assert.strictEqual(hourlyByKey.series[0].data[10], 40)

  const summary = store.getSummary()
  assert.strictEqual(summary.tokens, 1250)
  assert.strictEqual(summary.requests, 3)
  assert.ok(Math.abs(summary.cache_hit_rate - 83.33333333333333) < 1e-9)
  assert.strictEqual(summary.cost[0].cost, 1.5)

  const range = store.getDateRange()
  assert.strictEqual(range.min, '2026-08-28')
  assert.strictEqual(range.max, '2026-08-28')
  store.close()
})

test('store: 无输入 token 时缓存命中率为空', async () => {
  await store.init(DB3)
  store.upsertAmounts([
    { utc_date: '2026-08-29', model: 'deepseek-v4-pro', api_key_name: 'codex', type: 'output_tokens', amount: 50 },
  ])

  const totals = store.getDailyTotals('2026-08-29', '2026-08-29')
  assert.strictEqual(totals.length, 1)
  assert.strictEqual(totals[0].cache_hit_rate, null)
  assert.strictEqual(store.getSummary().cache_hit_rate, null)
  store.close()
})

test('store: 合并 V4 Flash 新旧 ID，但保持 V4.1 Flash 和 Vision 独立', async () => {
  await store.init(DB4)
  store.upsertAmounts([
    { utc_date: '2026-09-10', model: 'deepseek-v4-flash', api_key_name: 'codex', type: 'input_cache_hit_tokens', amount: 100 },
    { utc_date: '2026-09-10', model: 'deepseek-v4-flash', api_key_name: 'codex', type: 'input_cache_miss_tokens', amount: 100 },
    { utc_date: '2026-09-10', model: 'deepseek-v4-flash', api_key_name: 'codex', type: 'output_tokens', amount: 10 },
    { utc_date: '2026-09-10', model: 'deepseek-flash', api_key_name: 'codex', type: 'input_cache_hit_tokens', amount: 300 },
    { utc_date: '2026-09-10', model: 'deepseek-flash', api_key_name: 'codex', type: 'input_cache_miss_tokens', amount: 100 },
    { utc_date: '2026-09-10', model: 'deepseek-flash', api_key_name: 'codex', type: 'output_tokens', amount: 20 },
    { utc_date: '2026-09-10', model: 'deepseek-v4.1-flash', api_key_name: 'codex', type: 'output_tokens', amount: 40 },
    { utc_date: '2026-09-10', model: 'deepseek-v4-flash-vision-exp', api_key_name: 'codex', type: 'output_tokens', amount: 50 },
    { utc_date: '2026-09-10', model: 'deepseek-v4-pro', api_key_name: 'codex', type: 'output_tokens', amount: 60 },
  ])
  store.upsertCosts([
    { utc_date: '2026-09-10', model: 'deepseek-v4-flash', api_key_name: 'codex', cost: 0.2, currency: 'CNY' },
    { utc_date: '2026-09-10', model: 'deepseek-flash', api_key_name: 'codex', cost: 0.3, currency: 'CNY' },
    { utc_date: '2026-09-10', model: 'deepseek-v4.1-flash', api_key_name: 'codex', cost: 0.7, currency: 'CNY' },
    { utc_date: '2026-09-10', model: 'deepseek-v4-flash-vision-exp', api_key_name: 'codex', cost: 0.8, currency: 'CNY' },
    { utc_date: '2026-09-10', model: 'deepseek-v4-pro', api_key_name: 'codex', cost: 0.9, currency: 'CNY' },
  ])
  store.upsertHourlyAmounts([
    { utc_date: '2026-09-10', hour: 8, model: 'deepseek-v4-flash', api_key_name: 'codex', type: 'output_tokens', amount: 7 },
    { utc_date: '2026-09-10', hour: 8, model: 'deepseek-flash', api_key_name: 'codex', type: 'output_tokens', amount: 11 },
    { utc_date: '2026-09-10', hour: 8, model: 'deepseek-v4.1-flash', api_key_name: 'codex', type: 'output_tokens', amount: 13 },
    { utc_date: '2026-09-10', hour: 8, model: 'deepseek-v4-flash-vision-exp', api_key_name: 'codex', type: 'output_tokens', amount: 17 },
    { utc_date: '2026-09-10', hour: 8, model: 'deepseek-v4-pro', api_key_name: 'codex', type: 'output_tokens', amount: 19 },
  ])

  const rawModels = [
    'deepseek-flash',
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp',
    'deepseek-v4-pro',
    'deepseek-v4.1-flash',
  ]
  for (const table of ['amount_daily', 'cost_daily', 'hourly_usage']) {
    assert.deepStrictEqual(
      store.queryAll(`SELECT DISTINCT model FROM ${table} ORDER BY model`).map((r) => r.model),
      rawModels
    )
  }

  const byModel = store.getDailyByModel('2026-09-10', '2026-09-10')
  assert.strictEqual(byModel.length, 4)
  const flash = byModel.find((r) => r.model === 'deepseek-v4-flash')
  assert.deepStrictEqual(
    { cache_hit: flash.cache_hit, cache_miss: flash.cache_miss, output: flash.output },
    { cache_hit: 400, cache_miss: 200, output: 30 }
  )
  assert.ok(Math.abs(flash.cache_hit_rate - (400 / 600 * 100)) < 1e-9)
  assert.ok(byModel.some((r) => r.model === 'deepseek-v4.1-flash'))
  assert.ok(byModel.some((r) => r.model === 'deepseek-v4-flash-vision-exp'))
  assert.ok(byModel.some((r) => r.model === 'deepseek-v4-pro'))

  const costByModel = store.getDailyCostByModel('2026-09-10', '2026-09-10')
  assert.strictEqual(costByModel.length, 4)
  assert.strictEqual(costByModel.find((r) => r.model === 'deepseek-v4-flash').cost, 0.5)

  const modelTotals = store.getModelTotals('2026-09-10', '2026-09-10')
  assert.strictEqual(modelTotals.length, 4)
  const flashTotal = modelTotals.find((r) => r.model === 'deepseek-v4-flash')
  assert.strictEqual(flashTotal.tokens, 630)
  assert.strictEqual(flashTotal.cost.CNY, 0.5)

  const hourly = store.getHourlyDetail('2026-09-10', 'model')
  assert.strictEqual(hourly.series.length, 4)
  assert.strictEqual(hourly.series.find((s) => s.name === 'deepseek-v4-flash').data[8], 18)
  assert.ok(hourly.series.some((s) => s.name === 'deepseek-v4.1-flash'))
  assert.ok(hourly.series.some((s) => s.name === 'deepseek-v4-flash-vision-exp'))
  assert.ok(hourly.series.some((s) => s.name === 'deepseek-v4-pro'))
  store.close()
})
