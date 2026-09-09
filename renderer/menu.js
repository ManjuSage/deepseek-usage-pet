/* ============================================================================
 * 设置窗口（menu.html，系统原生窗口 + Tab 标签页）—— 渲染进程逻辑
 * 所有控件修改都通过 whaleAPI.setConfig() 持久化；
 * 主进程把 config:changed 广播给鲸鱼窗口（实时应用）。
 * 主题：跟随系统（matchMedia 监听）/ 浅色 / 深色（与 nativeTheme 联动）。
 * ========================================================================== */
(function () {
  'use strict'
  var api = window.whaleAPI
  if (!api) return

  var $ = function (id) { return document.getElementById(id) }

  var els = {
    done: $('wm-done'),
    theme: $('wm-theme'),
    apiKey: $('wm-apikey'), apiKeyEye: $('wm-apikey-eye'), apiKeyNote: $('wm-apikey-note'),
    token: $('wm-token'), tokenEye: $('wm-token-eye'), tokenLogin: $('wm-token-login'),
    usage: $('wm-usage'), refresh: $('wm-refresh'), threshold: $('wm-threshold'), autostart: $('wm-autostart'), autosync: $('wm-autosync'),
    bubble: $('wm-bubble'), bubbleInterval: $('wm-bubble-interval'), idleFade: $('wm-idlefade'), mirror: $('wm-mirror'),
    idleOpacity: $('wm-idle-opacity'), idleOpacityV: $('wm-idle-opacity-v'),
    scale: $('wm-scale'), scaleV: $('wm-scale-v'),
    bubbleColor: $('wm-bubble-color'), bubbleColorReset: $('wm-bubble-color-reset'),
    peak: $('wm-peak'), peakText: $('wm-peaktext'), peakOff: $('wm-peak-off'), peakOn: $('wm-peak-on'),
    textOk: $('wm-text-ok'), textLow: $('wm-text-low'),
    colorOk: $('wm-color-ok'), colorLow: $('wm-color-low'),
    colorOkReset: $('wm-color-ok-reset'), colorLowReset: $('wm-color-low-reset'),
    sound: $('wm-sound'), vol: $('wm-vol'), volV: $('wm-vol-v'),
    pressPick: $('wm-press-pick'), pressReset: $('wm-press-reset'),
    releasePick: $('wm-release-pick'), releaseReset: $('wm-release-reset'),
    soundNote: $('wm-sound-note'),
    mainPick: $('wm-main-pick'), mainReset: $('wm-main-reset'), mainNote: $('wm-main-note'),
    configOpen: $('wm-config-open'),
    updateCheck: $('wm-update-check'), updateNote: $('wm-update-note'),
    usageOpen: $('wm-usage-open'),
    logOpen: $('wm-log-open'),
    soundsOpen: $('wm-sounds-open'),
    imagesOpen: $('wm-images-open'),
    refreshNow: $('wm-refresh-now'),
    exprMaster: $('wm-expr-master'),
    exprBlink: $('wm-expr-blink'), exprAngry: $('wm-expr-angry'), exprDisappointed: $('wm-expr-disappointed'), exprShy: $('wm-expr-shy'), exprExhausted: $('wm-expr-exhausted'),
    exprPressPick: $('wm-expr-press-pick'), exprPressReset: $('wm-expr-press-reset'),
    exprAngryPick: $('wm-expr-angry-pick'), exprAngryReset: $('wm-expr-angry-reset'),
    exprDisappointedPick: $('wm-expr-disappointed-pick'), exprDisappointedReset: $('wm-expr-disappointed-reset'),
    exprShyPick: $('wm-expr-shy-pick'), exprShyReset: $('wm-expr-shy-reset'),
    exprExhaustedPick: $('wm-expr-exhausted-pick'), exprExhaustedReset: $('wm-expr-exhausted-reset'),
    exprBlinkHalfPick: $('wm-expr-blinkhalf-pick'), exprBlinkHalfReset: $('wm-expr-blinkhalf-reset'),
    exprBlinkClosedPick: $('wm-expr-blinkclosed-pick'), exprBlinkClosedReset: $('wm-expr-blinkclosed-reset'),
    exprBlinkHalfOpenPick: $('wm-expr-blinkhalfopen-pick'), exprBlinkHalfOpenReset: $('wm-expr-blinkhalfopen-reset'),
    exprBlinkMin: $('wm-expr-blinkmin'), exprBlinkMax: $('wm-expr-blinkmax'), exprIdleDis: $('wm-expr-idledis'), exprHoverShy: $('wm-expr-hovershy'), exprShyDur: $('wm-expr-shydur'), exprAngryDur: $('wm-expr-angrydur'), exprExhPrompt: $('wm-expr-exhprompt'),
  }

  // ---------- Tab 切换 ----------
  var tabs = document.querySelectorAll('.wm-tab')
  function switchTab(page) {
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-page') === page
      tabs[i].classList.toggle('wm-tab-on', on)
      var el = $('page-' + page)
      for (var j = 0; j < tabs.length; j++) {
        $('page-' + tabs[j].getAttribute('data-page')).hidden = true
      }
      if (el) el.hidden = false
    }
  }
  for (var i = 0; i < tabs.length; i++) {
    (function (tab) {
      tab.addEventListener('click', function () { switchTab(tab.getAttribute('data-page')) })
    })(tabs[i])
  }
  switchTab('account')

  var saveTimer = null
  function debounceSave(patch, ms) {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(function () { api.setConfig(patch) }, ms || 150)
  }

  // ---------- 主题（跟随系统） ----------
  var currentCfg = null
  var systemDark = window.matchMedia('(prefers-color-scheme: dark)')
  function applyTheme(cfg) {
    var dark = cfg && (cfg.theme === 'dark' || (cfg.theme !== 'light' && systemDark.matches))
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }
  function onSystemThemeChange() {
    if (currentCfg && (currentCfg.theme === 'system' || !currentCfg.theme)) applyTheme(currentCfg)
  }
  if (systemDark.addEventListener) systemDark.addEventListener('change', onSystemThemeChange)
  else if (systemDark.addListener) systemDark.addListener(onSystemThemeChange)

  function imgPathNote(path) {
    if (!path) return '未提供（可上传）'
    if (path.indexOf('assets/') === 0) return path + '（内置素材）'
    return path.split('/').pop() + '（已复制到配置目录）'
  }

  function fill(cfg) {
    currentCfg = cfg
    applyTheme(cfg)
    els.theme.value = cfg.theme || 'system'
    els.apiKey.value = cfg.apiKey || ''
    els.token.value = cfg.platformToken || ''
    els.usage.value = cfg.usageMode || 'ledger'
    els.refresh.value = String(cfg.refreshInterval || 60)
    els.threshold.value = String(cfg.lowBalanceThreshold != null ? cfg.lowBalanceThreshold : 10)
    els.autostart.checked = !!cfg.autostart
    els.autosync.checked = cfg.autoSync !== false
    els.bubble.checked = cfg.bubbleOn !== false
    els.bubbleInterval.value = String(cfg.bubbleInterval != null ? cfg.bubbleInterval : 900)
  els.idleFade.checked = cfg.idleFade !== false
  els.mirror.checked = cfg.mirror !== false
    els.idleOpacity.value = String(cfg.idleOpacity != null ? cfg.idleOpacity : 0.6)
    els.idleOpacityV.textContent = Math.round((cfg.idleOpacity != null ? cfg.idleOpacity : 0.6) * 100) + '%'
    els.scale.value = String(cfg.scale || 1)
    els.scaleV.textContent = (cfg.scale || 1).toFixed(1)
    els.bubbleColor.value = /^#[0-9a-fA-F]{6}$/.test(cfg.bubbleColor || '') ? cfg.bubbleColor : '#203170'
    els.peak.value = cfg.peakMode || 'default'
    els.peakText.checked = cfg.peakText !== false
    els.peakOff.value = cfg.peakTextOff || ''
    els.peakOn.value = cfg.peakTextOn || ''
    els.textOk.value = cfg.bubbleTextOk || 'DeepSeek 余额'
    els.textLow.value = cfg.bubbleTextLow || '余额预警'
    els.colorOk.value = /^#[0-9a-fA-F]{6}$/.test(cfg.textColorOk || '') ? cfg.textColorOk : '#536ba9'
    els.colorLow.value = /^#[0-9a-fA-F]{6}$/.test(cfg.textColorLow || '') ? cfg.textColorLow : '#e0433f'
    els.sound.value = cfg.soundSet || 'duck'
    els.vol.value = String(cfg.volume != null ? cfg.volume : 0.8)
    els.volV.textContent = Math.round((cfg.volume != null ? cfg.volume : 0.8) * 100) + '%'
    els.mainNote.textContent = '主图：' + imgPathNote(cfg.mainImgPath || 'assets/DSniang1.png')
    if (cfg.apiKeySource === 'env') {
      els.apiKeyNote.textContent = '当前使用环境变量 DEEPSEEK_API_KEY（此处可覆盖文件配置）'
      els.apiKeyNote.className = 'wm-note wm-note-ok'
      els.apiKey.disabled = true
    } else if (cfg.apiKey) {
      els.apiKeyNote.textContent = '已配置（保存在 %APPDATA%\\whale-pet\\config.json）'
      els.apiKeyNote.className = 'wm-note wm-note-ok'
      els.apiKey.disabled = false
    } else {
      els.apiKeyNote.textContent = '未配置：点击鲸鱼将提示获取失败'
      els.apiKeyNote.className = 'wm-note wm-note-warn'
      els.apiKey.disabled = false
    }
    fillExpressions(cfg)
  }

  function fillExpressions(cfg) {
    var ex = (cfg && cfg.expressions) || {}
    var en = ex.enabled || {}
    els.exprMaster.checked = ex.masterEnabled !== false
    updateExprMasterUI(els.exprMaster.checked)
    els.exprBlink.checked = en.blink !== false
    els.exprAngry.checked = en.angry !== false
    els.exprDisappointed.checked = en.disappointed !== false
    els.exprShy.checked = en.shy !== false
    els.exprExhausted.checked = en.exhausted !== false
    renderAllExprLines()
    els.exprBlinkMin.value = ex.blinkMinSec != null ? ex.blinkMinSec : 4
    els.exprBlinkMax.value = ex.blinkMaxSec != null ? ex.blinkMaxSec : 6
    els.exprIdleDis.value = ex.idleToDisappointedSec != null ? ex.idleToDisappointedSec : 180
    els.exprHoverShy.value = (ex.hoverToShyMs != null ? ex.hoverToShyMs : 1500) / 1000
    els.exprShyDur.value = (ex.shyDurationMs != null ? ex.shyDurationMs : 10000) / 1000
    els.exprAngryDur.value = (ex.angryDurationMs != null ? ex.angryDurationMs : 5000) / 1000
    els.exprExhPrompt.value = ex.exhaustedPromptSec != null ? ex.exhaustedPromptSec : 300
  }

  async function reload() {
    fill(await api.getConfig())
  }

  // 任意输入框聚焦期间，跳过 config:changed 的字段回填（避免打断输入）
  function anyFocused() {
    try {
      var a = document.activeElement
      return !!(a && a.tagName && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA'))
    } catch (err) { return false }
  }

  api.onConfigChanged(function (cfg) {
    if (!anyFocused()) fill(cfg)
  })

  // ---------- 关闭 ----------
  function closeWin() { api.closeMenu() }
  els.done.addEventListener('click', closeWin)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeWin()
  })

  // ---------- API Key / 平台令牌 ----------
  function bindSecret(input, eye, patchKey) {
    eye.addEventListener('click', function () {
      input.type = input.type === 'password' ? 'text' : 'password'
      eye.textContent = input.type === 'password' ? '显示' : '隐藏'
    })
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') input.blur()
    })
    input.addEventListener('change', function () {
      var patch = {}
      patch[patchKey] = input.value.trim()
      api.setConfig(patch).then(function () { reload() })
    })
  }
  bindSecret(els.apiKey, els.apiKeyEye, 'apiKey')
  bindSecret(els.token, els.tokenEye, 'platformToken')

  // ---------- 平台令牌自动登录 ----------
  if (els.tokenLogin) {
    els.tokenLogin.addEventListener('click', async function () {
      els.tokenLogin.disabled = true
      els.tokenLogin.textContent = '请登录…'
      try {
        const r = await api.platformLogin()
        if (r && r.ok) {
          els.tokenLogin.textContent = '已获取'
          await reload()
        } else {
          els.tokenLogin.textContent = '未获取'
        }
      } catch (e) {
        els.tokenLogin.textContent = '失败'
      } finally {
        setTimeout(function () { els.tokenLogin.disabled = false; els.tokenLogin.textContent = '登录平台' }, 2000)
      }
    })
  }

  // ---------- 选择/开关 ----------
  els.theme.addEventListener('change', function () {
    api.setConfig({ theme: els.theme.value }).then(function (cfg) { applyTheme(cfg || { theme: els.theme.value }) })
  })
  els.usage.addEventListener('change', function () { api.setConfig({ usageMode: els.usage.value }) })
  els.sound.addEventListener('change', function () { api.setConfig({ soundSet: els.sound.value }) })
  els.peak.addEventListener('change', function () { api.setConfig({ peakMode: els.peak.value }) })
  els.peakText.addEventListener('change', function () { api.setConfig({ peakText: els.peakText.checked }) })
  els.bubble.addEventListener('change', function () { api.setConfig({ bubbleOn: els.bubble.checked }) })
  els.idleFade.addEventListener('change', function () { api.setConfig({ idleFade: els.idleFade.checked }) })
  els.mirror.addEventListener('change', function () { api.setConfig({ mirror: els.mirror.checked }) })
  els.autostart.addEventListener('change', function () { api.setConfig({ autostart: els.autostart.checked }) })
  els.autosync.addEventListener('change', function () { api.setConfig({ autoSync: els.autosync.checked }) })
  // ---------- 滑块（实时预览 + 防抖保存） ----------
  els.scale.addEventListener('input', function () {
    els.scaleV.textContent = Number(els.scale.value).toFixed(1)
    debounceSave({ scale: Number(els.scale.value) }, 200)
  })
  els.vol.addEventListener('input', function () {
    els.volV.textContent = Math.round(Number(els.vol.value) * 100) + '%'
    debounceSave({ volume: Number(els.vol.value) }, 200)
  })
  els.idleOpacity.addEventListener('input', function () {
    els.idleOpacityV.textContent = Math.round(Number(els.idleOpacity.value) * 100) + '%'
    debounceSave({ idleOpacity: Number(els.idleOpacity.value) }, 200)
  })
  els.bubbleColor.addEventListener('input', function () {
    debounceSave({ bubbleColor: els.bubbleColor.value }, 200)
  })
  els.bubbleColorReset.addEventListener('click', function () {
    api.setConfig({ bubbleColor: '#203170' }).then(function () { reload() })
  })

  // ---------- 数字输入 ----------
  els.refresh.addEventListener('change', function () {
    var v = Math.round(Number(els.refresh.value) || 60)
    els.refresh.value = String(v)
    api.setConfig({ refreshInterval: v })
  })
  els.bubbleInterval.addEventListener('change', function () {
    var v = Math.round(Number(els.bubbleInterval.value) || 0)
    els.bubbleInterval.value = String(v)
    api.setConfig({ bubbleInterval: v })
  })
  els.threshold.addEventListener('change', function () {
    var v = Number(els.threshold.value)
    if (!isFinite(v) || v < 0) v = 10
    els.threshold.value = String(v)
    api.setConfig({ lowBalanceThreshold: v })
  })

  // ---------- 峰谷自定义文案（留空 = 用内置/峰谷模式） ----------
  els.peakOff.addEventListener('change', function () {
    els.peakOff.value = els.peakOff.value.slice(0, 12)
    api.setConfig({ peakTextOff: els.peakOff.value.trim() })
  })
  els.peakOn.addEventListener('change', function () {
    els.peakOn.value = els.peakOn.value.slice(0, 12)
    api.setConfig({ peakTextOn: els.peakOn.value.trim() })
  })

  // ---------- 气泡文案 + 颜色 ----------
  els.textOk.addEventListener('change', function () {
    els.textOk.value = els.textOk.value.slice(0, 20)
    api.setConfig({ bubbleTextOk: els.textOk.value.trim() })
  })
  els.textLow.addEventListener('change', function () {
    els.textLow.value = els.textLow.value.slice(0, 20)
    api.setConfig({ bubbleTextLow: els.textLow.value.trim() })
  })
  els.colorOk.addEventListener('input', function () {
    debounceSave({ textColorOk: els.colorOk.value }, 200)
  })
  els.colorLow.addEventListener('input', function () {
    debounceSave({ textColorLow: els.colorLow.value }, 200)
  })
  els.colorOkReset.addEventListener('click', function () {
    api.setConfig({ textColorOk: '' }).then(function () { reload() })
  })
  els.colorLowReset.addEventListener('click', function () {
    api.setConfig({ textColorLow: '' }).then(function () { reload() })
  })

  // ---------- 主图 上传 ----------
  function bindImagePicker(pickBtn, resetBtn, kind, noteEl) {
    pickBtn.addEventListener('click', async function () {
      pickBtn.disabled = true
      try {
        var r = await api.pickImage(kind)
        if (r && r.ok) {
          noteEl.textContent = '已设置：' + r.path
          noteEl.className = 'wm-note wm-note-ok'
        } else if (r && !r.canceled) {
          noteEl.textContent = '选择失败：' + ((r && r.error) || '未知错误')
          noteEl.className = 'wm-note wm-note-warn'
        }
      } catch (err) {
        noteEl.textContent = '选择失败：' + String((err && err.message) || err)
        noteEl.className = 'wm-note wm-note-warn'
      } finally {
        pickBtn.disabled = false
      }
    })
    resetBtn.addEventListener('click', async function () {
      resetBtn.disabled = true
      try { await api.resetImage(kind); await reload() } finally { resetBtn.disabled = false }
    })
  }
  bindImagePicker(els.mainPick, els.mainReset, 'main', els.mainNote)

  // ---------- 表情：开关 / 图片 / 台词 ----------
  function patchExpressions(mutator) {
    var ex = (currentCfg && currentCfg.expressions) ? JSON.parse(JSON.stringify(currentCfg.expressions)) : { enabled: {}, lines: {} }
    mutator(ex)
    api.setConfig({ expressions: ex }).catch(function () {})
  }

  function bindExprToggle(el, key) {
    el.addEventListener('change', function () {
      patchExpressions(function (ex) {
        ex.enabled = ex.enabled || {}
        ex.enabled[key] = el.checked
      })
    })
  }
  function updateExprMasterUI(on) {
    var folds = document.querySelectorAll('#page-expression details')
    for (var i = 0; i < folds.length; i++) {
      folds[i].classList.toggle('wm-disabled', !on)
    }
  }
  els.exprMaster.addEventListener('change', function () {
    var on = els.exprMaster.checked
    patchExpressions(function (ex) { ex.masterEnabled = on })
    updateExprMasterUI(on)
  })
  bindExprToggle(els.exprBlink, 'blink')
  bindExprToggle(els.exprAngry, 'angry')
  bindExprToggle(els.exprDisappointed, 'disappointed')
  bindExprToggle(els.exprShy, 'shy')
  bindExprToggle(els.exprExhausted, 'exhausted')

  function bindExprImagePicker(pickBtn, resetBtn, kind) {
    pickBtn.addEventListener('click', async function () {
      pickBtn.disabled = true
      try { await api.pickImage(kind); await reload() } finally { pickBtn.disabled = false }
    })
    resetBtn.addEventListener('click', async function () {
      resetBtn.disabled = true
      try { await api.resetImage(kind); await reload() } finally { resetBtn.disabled = false }
    })
  }
  bindExprImagePicker(els.exprPressPick, els.exprPressReset, 'press')
  bindExprImagePicker(els.exprAngryPick, els.exprAngryReset, 'angry')
  bindExprImagePicker(els.exprDisappointedPick, els.exprDisappointedReset, 'disappointed')
  bindExprImagePicker(els.exprShyPick, els.exprShyReset, 'shy')
  bindExprImagePicker(els.exprExhaustedPick, els.exprExhaustedReset, 'exhausted')
  bindExprImagePicker(els.exprBlinkHalfPick, els.exprBlinkHalfReset, 'blinkHalf')
  bindExprImagePicker(els.exprBlinkClosedPick, els.exprBlinkClosedReset, 'blinkClosed')
  bindExprImagePicker(els.exprBlinkHalfOpenPick, els.exprBlinkHalfOpenReset, 'blinkHalfOpen')

  function getExprLines(key) {
    var lines = (currentCfg && currentCfg.expressions && currentCfg.expressions.lines) || {}
    return Array.isArray(lines[key]) ? lines[key].slice() : []
  }
  function saveExprLines(key, arr) {
    if (currentCfg && currentCfg.expressions) {
      currentCfg.expressions.lines = currentCfg.expressions.lines || {}
      currentCfg.expressions.lines[key] = arr
    }
    patchExpressions(function (ex) {
      ex.lines = ex.lines || {}
      ex.lines[key] = arr
    })
  }
  function renderExprLines(key) {
    var container = document.querySelector('.wm-lines[data-key="' + key + '"]')
    if (!container) return
    var chipsEl = container.querySelector('.wm-chips')
    var countEl = container.querySelector('.wm-chip-count')
    var arr = getExprLines(key)
    chipsEl.innerHTML = ''
    arr.forEach(function (text, idx) {
      var chip = document.createElement('span')
      chip.className = 'wm-chip'
      var t = document.createElement('span')
      t.className = 'wm-chip-text'
      t.textContent = text
      t.title = text
      var x = document.createElement('button')
      x.type = 'button'
      x.className = 'wm-chip-x'
      x.textContent = '×'
      x.title = '删除'
      x.addEventListener('click', function () { removeExprLine(key, idx) })
      chip.appendChild(t)
      chip.appendChild(x)
      chipsEl.appendChild(chip)
    })
    countEl.textContent = arr.length + ' 条'
  }
  function addExprLine(key, text) {
    var t = String(text || '').trim()
    if (!t) return
    var arr = getExprLines(key)
    if (arr.indexOf(t) !== -1) return
    arr.push(t)
    saveExprLines(key, arr)
    renderExprLines(key)
  }
  function removeExprLine(key, idx) {
    var arr = getExprLines(key)
    if (idx < 0 || idx >= arr.length) return
    arr.splice(idx, 1)
    saveExprLines(key, arr)
    renderExprLines(key)
  }
  function resetExprLines(key) {
    saveExprLines(key, []) // 空数组 → 配置消毒回退到默认台词
  }
  function renderAllExprLines() {
    renderExprLines('angryWarn')
    renderExprLines('disappointedEntry')
    renderExprLines('lonely')
    renderExprLines('shy')
    renderExprLines('exhausted')
  }
  function initExprLineEditor(key) {
    var container = document.querySelector('.wm-lines[data-key="' + key + '"]')
    if (!container) return
    var input = container.querySelector('.wm-chip-add input')
    var btn = container.querySelector('.wm-chip-add button')
    var resetBtn = container.querySelector('.wm-chip-reset')
    function add() {
      addExprLine(key, input.value)
      input.value = ''
      input.focus()
    }
    btn.addEventListener('click', add)
    resetBtn.addEventListener('click', function () { resetExprLines(key) })
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); add() }
    })
  }
  initExprLineEditor('angryWarn')
  initExprLineEditor('disappointedEntry')
  initExprLineEditor('lonely')
  initExprLineEditor('shy')
  initExprLineEditor('exhausted')

  function bindExprNumber(el, key, factor) {
    el.addEventListener('change', function () {
      var v = parseFloat(el.value)
      if (!isFinite(v)) return
      patchExpressions(function (ex) {
        ex[key] = Math.round(v * (factor || 1))
      })
    })
  }
  bindExprNumber(els.exprBlinkMin, 'blinkMinSec', 1)
  bindExprNumber(els.exprBlinkMax, 'blinkMaxSec', 1)
  bindExprNumber(els.exprIdleDis, 'idleToDisappointedSec', 1)
  bindExprNumber(els.exprHoverShy, 'hoverToShyMs', 1000)
  bindExprNumber(els.exprShyDur, 'shyDurationMs', 1000)
  bindExprNumber(els.exprAngryDur, 'angryDurationMs', 1000)
  bindExprNumber(els.exprExhPrompt, 'exhaustedPromptSec', 1)

  // ---------- 自定义音效（按压/松手） ----------
  function bindSoundPicker(pickBtn, resetBtn, which) {
    pickBtn.addEventListener('click', async function () {
      pickBtn.disabled = true
      try {
        var r = await api.pickSound(which)
        if (r && r.ok) {
          els.soundNote.textContent = (which === 'release' ? '松手' : '按压') + '音效已设置：' + r.path
          els.soundNote.className = 'wm-note wm-note-ok'
        } else if (r && !r.canceled) {
          els.soundNote.textContent = '选择失败：' + ((r && r.error) || '未知错误')
          els.soundNote.className = 'wm-note wm-note-warn'
        }
      } catch (err) {
        els.soundNote.textContent = '选择失败：' + String((err && err.message) || err)
        els.soundNote.className = 'wm-note wm-note-warn'
      } finally {
        pickBtn.disabled = false
      }
    })
    resetBtn.addEventListener('click', async function () {
      resetBtn.disabled = true
      try { await api.resetSound(which); await reload() } finally { resetBtn.disabled = false }
    })
  }
  bindSoundPicker(els.pressPick, els.pressReset, 'press')
  bindSoundPicker(els.releasePick, els.releaseReset, 'release')

  // ---------- 随机台词池（lines.json → 词条标签编辑器） ----------
  var customPool = { gif: '', specialGroups: [], textGroups: [] }

  function loadCustomPoolFromData(d) {
    customPool.gif = (d && typeof d.gif === 'string') ? d.gif : ''
    customPool.specialGroups = []
    customPool.textGroups = []
    var groups = (d && Array.isArray(d.groups)) ? d.groups : []
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i]
      if (g && (g.type === 'balance' || g.type === 'gif')) customPool.specialGroups.push(g)
      else if (g && typeof g.text === 'string' && g.text) customPool.textGroups.push(g)
    }
    renderCustomChips()
  }

  async function loadCustomChips() {
    try { loadCustomPoolFromData(await api.getCustom()) } catch (err) {}
  }

  function renderCustomChips() {
    var container = document.getElementById('wm-custom-lines')
    if (!container) return
    var chipsEl = container.querySelector('.wm-chips')
    var countEl = container.querySelector('.wm-chip-count')
    chipsEl.innerHTML = ''
    customPool.textGroups.forEach(function (g, idx) {
      var chip = document.createElement('span')
      chip.className = 'wm-chip'
      var t = document.createElement('span')
      t.className = 'wm-chip-text'
      t.textContent = g.text
      t.title = g.text
      var x = document.createElement('button')
      x.type = 'button'
      x.className = 'wm-chip-x'
      x.textContent = '×'
      x.title = '删除'
      x.addEventListener('click', function () { removeCustomLine(idx) })
      chip.appendChild(t)
      chip.appendChild(x)
      chipsEl.appendChild(chip)
    })
    countEl.textContent = customPool.textGroups.length + ' 条'
  }

  function saveCustomPool() {
    var groups = customPool.specialGroups.concat(customPool.textGroups)
    api.saveCustom({ gif: customPool.gif, groups: groups }).catch(function () {})
  }

  function addCustomLine(text) {
    var t = String(text || '').trim().slice(0, 40)
    if (!t) return
    for (var i = 0; i < customPool.textGroups.length; i++) {
      if (customPool.textGroups[i].text === t) return
    }
    customPool.textGroups.push({ weight: 1, text: t, style: 'A', wrap: true, color: '' })
    saveCustomPool()
    renderCustomChips()
  }

  function removeCustomLine(idx) {
    if (idx < 0 || idx >= customPool.textGroups.length) return
    customPool.textGroups.splice(idx, 1)
    saveCustomPool()
    renderCustomChips()
  }

  function resetCustomLines() {
    api.saveCustom({ gif: '', groups: [] }).then(function () {
      return api.getCustom()
    }).then(function (d) {
      loadCustomPoolFromData(d)
    }).catch(function () {})
  }

  function initCustomLineEditor() {
    var container = document.getElementById('wm-custom-lines')
    if (!container) return
    var input = container.querySelector('.wm-chip-add input')
    var btn = container.querySelector('.wm-chip-add button')
    var resetBtn = container.querySelector('.wm-chip-reset')
    function add() {
      addCustomLine(input.value)
      input.value = ''
      input.focus()
    }
    btn.addEventListener('click', add)
    resetBtn.addEventListener('click', resetCustomLines)
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); add() }
    })
  }

  initCustomLineEditor()
  loadCustomChips()

  // ---------- 打开文件/目录（用系统默认程序；引用配置内路径） ----------
  function bindOpen(btn, getPath) {
    if (!btn) return
    btn.addEventListener('click', async function () {
      btn.disabled = true
      try { await api.openPath(getPath()) } finally { btn.disabled = false }
    })
  }
  bindOpen(els.configOpen, function () { return (currentCfg && currentCfg.paths && currentCfg.paths.config) || '' })
  bindOpen(els.usageOpen, function () { return (currentCfg && currentCfg.paths && currentCfg.paths.usage) || '' })
  bindOpen(els.soundsOpen, function () { return (currentCfg && currentCfg.paths && currentCfg.paths.sounds) || '' })
  bindOpen(els.imagesOpen, function () { return (currentCfg && currentCfg.paths && currentCfg.paths.images) || '' })

  // ---------- 打开运行日志 ----------
  if (els.logOpen) {
    els.logOpen.addEventListener('click', async function () {
      els.logOpen.disabled = true
      try { await api.openLog() } finally { els.logOpen.disabled = false }
    })
  }

  // ---------- 立即刷新 ----------
  els.refreshNow.addEventListener('click', async function () {
    els.refreshNow.textContent = '刷新中...'
    els.refreshNow.disabled = true
    try {
      var r = await api.refreshPet()
      els.refreshNow.textContent = r && r.ok ? '已刷新' : '失败（检查 API Key）'
    } catch (err) {
      els.refreshNow.textContent = '失败'
    }
    setTimeout(function () { els.refreshNow.textContent = '立即刷新余额'; els.refreshNow.disabled = false }, 1200)
  })

  // ---------- 检查更新 ----------
  var updateUrl = ''
  els.updateNote.addEventListener('click', function () {
    if (updateUrl) api.openExternal(updateUrl)
  })
  els.updateCheck.addEventListener('click', async function () {
    els.updateCheck.disabled = true
    els.updateNote.textContent = '正在检查更新…'
    els.updateNote.className = 'wm-note'
    updateUrl = ''
    try {
      var r = await api.checkUpdate()
      if (!r || !r.ok) {
        els.updateNote.textContent = '检查更新失败：' + ((r && r.error) || '网络错误')
        els.updateNote.className = 'wm-note wm-note-warn'
      } else if (r.hasUpdate) {
        els.updateNote.textContent = '发现新版本 v' + r.latest + '（当前 v' + r.current + '），点击打开下载页'
        els.updateNote.className = 'wm-note wm-note-ok'
        updateUrl = r.url || ''
      } else {
        els.updateNote.textContent = '已是最新版本（v' + r.current + '）'
        els.updateNote.className = 'wm-note wm-note-ok'
      }
    } catch (err) {
      els.updateNote.textContent = '检查更新失败：' + String((err && err.message) || err)
      els.updateNote.className = 'wm-note wm-note-warn'
    } finally {
      els.updateCheck.disabled = false
    }
    els.updateNote.style.cursor = updateUrl ? 'pointer' : ''
  })

  reload().catch(function (err) { console.error('[menu] load failed', err) })
})()
