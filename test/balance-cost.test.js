'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.env.WHALE_PET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-balance-cost-'))

const balance = require('../lib/balance')

const costResponse = {
  data: {
    biz_data: {
      data: [
        {
          currency: 'CNY',
          series: [
            { model: 'deepseek-v4.1-flash', buckets: [{ time: 1789000200, cost: '1.25' }, { time: 1789003800, cost: '2.50' }] },
            { model: 'deepseek-v4-pro', buckets: [{ time: 1789007400, cost: '1.00' }] },
          ],
        },
        {
          currency: 'USD',
          series: [{ model: 'deepseek-v4.1-flash', buckets: [{ time: 1789000200, cost: '99.00' }] }],
        },
      ],
    },
  },
}

test('computeTodayCost sums platform-billed cost for the requested currency', () => {
  assert.strictEqual(typeof balance.computeTodayCost, 'function')
  assert.deepStrictEqual(balance.computeTodayCost(costResponse, 'CNY'), { amount: 4.75 })
})

test('computeTodayCost treats a valid empty bill as zero cost', () => {
  assert.deepStrictEqual(balance.computeTodayCost({ data: { biz_data: { data: [] } } }, 'CNY'), { amount: 0 })
  assert.deepStrictEqual(balance.computeTodayCost(costResponse, 'EUR'), { amount: 0 })
})

test('computeTodayCost rejects top-level and business error envelopes', () => {
  assert.strictEqual(balance.computeTodayCost({ code: 40003, ...costResponse }, 'CNY'), null)
  assert.strictEqual(balance.computeTodayCost({ data: { biz_code: 40003, biz_data: costResponse.data.biz_data } }, 'CNY'), null)
})

test('fetchUsage reads the platform cost endpoint instead of estimating from tokens', async () => {
  const originalFetch = global.fetch
  let requestedUrl = ''
  try {
    global.fetch = async (url) => {
      requestedUrl = String(url)
      return { ok: true, json: async () => costResponse }
    }

    const result = await balance.fetchUsage('Bearer platform-token', 'CNY')

    assert.match(requestedUrl, /\/api\/v0\/usage\/by_api_key\/cost\?/)
    assert.deepStrictEqual(result, { amount: 4.75 })
  } finally {
    global.fetch = originalFetch
  }
})
