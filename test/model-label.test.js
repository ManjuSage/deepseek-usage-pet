'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

test('usage panel labels V4.1 Flash model ids consistently', () => {
  let usage
  assert.doesNotThrow(() => {
    usage = require('../renderer/usage')
  })
  assert.strictEqual(typeof usage.modelLabel, 'function')
  assert.strictEqual(usage.modelLabel('deepseek-v4.1-flash'), 'V4.1 Flash')
  assert.strictEqual(usage.modelLabel('deepseek-v4.1-flash-expires-on-0910'), 'V4.1 Flash')
})
