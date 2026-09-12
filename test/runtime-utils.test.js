'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const runtime = require('../renderer/runtime-utils')

test('refresh interval keeps exactly one active timer when its period changes', () => {
  let nextId = 1
  const active = new Map()
  const timerApi = {
    setInterval(fn, ms) {
      const id = nextId++
      active.set(id, { fn, ms })
      return id
    },
    clearInterval(id) {
      active.delete(id)
    },
  }
  let refreshes = 0
  const interval = runtime.createIntervalController(() => { refreshes++ }, timerApi)

  interval.start(60000)
  interval.start(30000)

  assert.strictEqual(active.size, 1)
  assert.strictEqual([...active.values()][0].ms, 30000)
  for (const timer of active.values()) timer.fn()
  assert.strictEqual(refreshes, 1)
})

test('audio pair does not construct audio until the requested sound is used', () => {
  const created = []
  function FakeAudio(src) {
    this.src = src
    this.volume = 1
    created.push(this)
  }
  const audio = runtime.createLazyAudioPair(FakeAudio)

  audio.configure('press.mp3', 'release.mp3', 0.4)
  assert.strictEqual(created.length, 0)

  const press = audio.getPress()
  assert.strictEqual(created.length, 1)
  assert.strictEqual(press.src, 'press.mp3')
  assert.strictEqual(press.volume, 0.4)
  assert.strictEqual(audio.getPress(), press)

  audio.configure('press.mp3', 'release.mp3', 0.7)
  assert.strictEqual(created.length, 1)
  assert.strictEqual(press.volume, 0.7)
})
