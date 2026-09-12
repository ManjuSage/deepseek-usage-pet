'use strict'

;(function (root, factory) {
  var runtime = factory()
  if (typeof module === 'object' && module.exports) module.exports = runtime
  if (root) root.whaleRuntime = runtime
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createIntervalController(callback, timerApi) {
    var timer = null
    var intervalMs = null

    function stop() {
      if (timer === null) return
      timerApi.clearInterval(timer)
      timer = null
      intervalMs = null
    }

    function start(nextIntervalMs) {
      if (timer !== null && intervalMs === nextIntervalMs) return
      stop()
      intervalMs = nextIntervalMs
      timer = timerApi.setInterval(callback, nextIntervalMs)
    }

    return { start: start, stop: stop }
  }

  function createLazyAudioPair(AudioCtor) {
    var pressSrc = ''
    var releaseSrc = ''
    var volume = 1
    var pressAudio = null
    var releaseAudio = null

    function configure(nextPressSrc, nextReleaseSrc, nextVolume) {
      if (pressSrc !== nextPressSrc) { pressSrc = nextPressSrc; pressAudio = null }
      if (releaseSrc !== nextReleaseSrc) { releaseSrc = nextReleaseSrc; releaseAudio = null }
      volume = nextVolume
      if (pressAudio) pressAudio.volume = volume
      if (releaseAudio) releaseAudio.volume = volume
    }

    function create(src) {
      var audio = new AudioCtor(src)
      audio.preload = 'auto'
      audio.volume = volume
      return audio
    }

    return {
      configure: configure,
      getPress: function () { return pressAudio || (pressAudio = create(pressSrc)) },
      getRelease: function () { return releaseAudio || (releaseAudio = create(releaseSrc)) },
    }
  }

  return {
    createIntervalController: createIntervalController,
    createLazyAudioPair: createLazyAudioPair,
  }
})
