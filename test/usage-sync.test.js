'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const store = require('../lib/store')
const usage = require('../lib/usage-sync')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-usage-'))
const DB = path.join(tmpDir, 'test.db')
const DB3 = path.join(tmpDir, 'test3.db')
const DB4 = path.join(tmpDir, 'test4.db')
const DB5 = path.join(tmpDir, 'test5.db')

test('usage-sync: normalizeAmount 类型映射 + 跳过全零', () => {
  const biz = {
    series: [{
      api_key: { name: 'codex' },
      model: 'deepseek-v4-pro',
      buckets: [{
        time: 1787770800,
        usage: { RESPONSE_TOKEN: 4966, REQUEST: 7, PROMPT_CACHE_HIT_TOKEN: 610432, PROMPT_CACHE_MISS_TOKEN: 9139 },
      }],
    }],
  }
  const rows = usage.normalizeAmount(biz, false)
  assert.strictEqual(rows.length, 4)
  const types = rows.map((r) => r.type).sort()
  assert.deepStrictEqual(types, ['input_cache_hit_tokens', 'input_cache_miss_tokens', 'output_tokens', 'request_count'].sort())

  const zero = { series: [{ api_key: {}, model: 'm', buckets: [{ time: 1, usage: { RESPONSE_TOKEN: 0, REQUEST: 0, PROMPT_CACHE_HIT_TOKEN: 0, PROMPT_CACHE_MISS_TOKEN: 0 } }] }] }
  assert.strictEqual(usage.normalizeAmount(zero, false).length, 0)
})

test('usage-sync: syncDay 拉取 amount/cost 落库（mock fetch）', async () => {
  await store.init(DB)
  usage.setRawDir(path.join(tmpDir, 'raw'))
  const ts = usage.dayStartUnix(usage.gmt8Today()) + 3600

  globalThis.fetch = async (url) => {
    if (url.includes('/cost')) {
      return { ok: true, text: async () => JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { data: [{ currency: 'CNY', series: [{ api_key: { name: 'codex' }, model: 'deepseek-v4-pro', buckets: [{ time: ts, cost: '3.14' }] }] }] } } }) }
    }
    return { ok: true, text: async () => JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { series: [{ api_key: { tracking_id: 'tid-1', name: 'codex' }, model: 'deepseek-v4-pro', buckets: [{ time: ts, usage: { RESPONSE_TOKEN: 4966, REQUEST: 7, PROMPT_CACHE_HIT_TOKEN: 610432, PROMPT_CACHE_MISS_TOKEN: 9139 } }] }] } } }) }
  }

  const r = await usage.syncDay('tok', usage.gmt8Today())
  assert.strictEqual(r.amount, 4)
  assert.strictEqual(r.cost, 1)

  const amountRows = store.queryAll("SELECT type, amount FROM amount_daily WHERE model='deepseek-v4-pro'")
  assert.strictEqual(amountRows.length, 4)
  const out = amountRows.find((x) => x.type === 'output_tokens')
  assert.strictEqual(out.amount, 4966)

  const costRows = store.queryAll('SELECT cost, currency FROM cost_daily')
  assert.strictEqual(costRows.length, 1)
  assert.strictEqual(costRows[0].cost, 3.14)
  assert.strictEqual(costRows[0].currency, 'CNY')
  assert.ok(store.getMeta('account_fingerprint'))
  store.close()
})

test('usage-sync: 账号指纹不一致 → 中止同步', async () => {
  await store.init(DB3)
  usage.setRawDir(path.join(tmpDir, 'raw3'))
  store.setMeta('account_keys', JSON.stringify(['tid-a|key-a']))

  globalThis.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { series: [{ api_key: { tracking_id: 'tid-b', name: 'key-b' }, model: 'm', buckets: [] }] } } }),
  })

  await assert.rejects(
    () => usage.syncDay('tok', usage.gmt8Today()),
    (err) => err.accountChanged === true
  )
  store.close()
})

test('usage-sync: syncBackfill 历史回溯 + 遇连续空段停止', async () => {
  await store.init(DB4)
  usage.setRawDir(path.join(tmpDir, 'raw4'))

  let amountCalls = 0
  globalThis.fetch = async (url) => {
    if (url.includes('/cost')) {
      return { ok: true, text: async () => JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { data: [] } } }) }
    }
    amountCalls++
    if (amountCalls === 1) {
      return { ok: true, text: async () => JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { series: [{ api_key: { tracking_id: 'tid-1', name: 'codex' }, model: 'deepseek-v4-pro', buckets: [{ time: 1787770800, usage: { RESPONSE_TOKEN: 100, REQUEST: 1, PROMPT_CACHE_HIT_TOKEN: 200, PROMPT_CACHE_MISS_TOKEN: 300 } }] }] } } }) }
    }
    return { ok: true, text: async () => JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { series: [] } } }) }
  }

  const r = await usage.syncBackfill('tok')
  assert.strictEqual(r.amount, 4)
  assert.strictEqual(r.cost, 0)
  assert.strictEqual(amountCalls, 3) // 1 段有数据 + 2 段连续空 → 停止
  assert.ok(store.getMeta('account_fingerprint'))
  store.close()
})

test('usage-sync: syncBalance 拉取余额并落库', async () => {
  await store.init(DB5)
  usage.setRawDir(path.join(tmpDir, 'raw5'))
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { normal_wallets: [{ currency: 'CNY', balance: '48.51', token_estimation: '0' }], bonus_wallets: [{ currency: 'CNY', balance: '0', token_estimation: '0' }], total_costs: [{ currency: 'CNY', amount: '131.48' }] } } }),
  })
  const r = await usage.syncBalance('tok')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.wallets.normal.balance, 48.51)
  const stored = JSON.parse(store.getMeta('balance_wallets'))
  assert.strictEqual(stored.normal.balance, 48.51)
  store.close()
})
