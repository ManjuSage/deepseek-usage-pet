'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

test('usage panel labels known Flash model ids without swallowing future Vision variants', () => {
  let usage
  assert.doesNotThrow(() => {
    usage = require('../renderer/usage')
  })
  assert.strictEqual(typeof usage.modelLabel, 'function')
  assert.strictEqual(usage.modelLabel('deepseek-v4-flash'), 'V4 Flash')
  assert.strictEqual(usage.modelLabel('deepseek-flash'), 'V4 Flash')
  assert.strictEqual(usage.modelLabel('deepseek-v4-flash-vision-exp'), 'V4 Flash Vision')
  assert.strictEqual(usage.modelLabel('deepseek-v4.1-flash'), 'V4.1 Flash')
  assert.strictEqual(usage.modelLabel('deepseek-v4.1-flash-expires-on-0910'), 'V4.1 Flash')
  assert.strictEqual(usage.modelLabel('deepseek-v4.1-flash-preview'), 'deepseek-v4.1-flash-preview')
  assert.strictEqual(usage.modelLabel('deepseek-v4.1-flash-vision-exp'), 'deepseek-v4.1-flash-vision-exp')
})
