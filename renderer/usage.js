// 用量统计面板渲染脚本。
// 职责：拉取用量数据 → ECharts 渲染日级堆叠图（按模型/类型/API Key）、各模型占比饼图、
//       累计趋势、热力图 + 分时下钻（按类型/模型/API Key）；处理范围选择、同步进度/取消。
(function () {
  'use strict'
  var api = window.whaleAPI

  var PALETTE = ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc']
  var modelColors = {}
  function modelColor(name) {
    if (!modelColors[name]) modelColors[name] = PALETTE[Object.keys(modelColors).length % PALETTE.length]
    return modelColors[name]
  }
  function modelLabel(m) {
    if (!m) return '(未命名)'
    var map = {
      'deepseek-chat & deepseek-reasoner': 'Chat / Reasoner',
      'deepseek-v4-flash': 'V4 Flash',
      'deepseek-v4-flash-vision-exp': 'V4 Flash Vision',
      'deepseek-v4-pro': 'V4 Pro',
      'deepseek-chat': 'Chat',
      'deepseek-reasoner': 'Reasoner',
    }
    return map[m] || m
  }

  var state = {
    dailyView: 'model',
    dailyMetric: 'tokens',
    modelsMetric: 'tokens',
    cumulativeMetric: 'tokens',
    heatmapMetric: 'tokens',
    hourlyView: 'type',
    hourlyDate: null,
    daily: null,
    heatmapData: null,
    range: { start: null, end: null },
    feeVisible: true,
  }
  var charts = {}
  function detectDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  function buildTheme(dark) {
    return {
      ink: dark ? '#e6edf3' : '#1f2328',
      muted: dark ? '#8b949e' : '#6b7280',
      border: dark ? '#2d333b' : '#e5e7eb',
      panel: dark ? '#1b2026' : '#ffffff',
      heatColors: dark ? ['#151b23', '#0e4429', '#006d32', '#26a641', '#39d353'] : ['#eff2f5', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
    }
  }
  var T = buildTheme(detectDark())
  function tooltipCfg(o) {
    o.backgroundColor = T.panel
    o.borderColor = T.border
    o.textStyle = { color: T.ink }
    return o
  }

  function gmt8Date(offsetDays) {
    return new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10)
  }
  function heatmapRange() {
    var d = new Date(Date.now() + 8 * 3600 * 1000)
    var dow = d.getUTCDay() || 7 // 1=周一 … 7=周日
    var back = (dow - 1) + 51 * 7 // 回到 52 周前（含本周）的周一
    return { start: gmt8Date(-back), end: gmt8Date(0) }
  }
  function fmtTokens(n) {
    n = Number(n) || 0
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
    return String(n)
  }
  function fmtTokensFull(n) {
    return (Number(n) || 0).toLocaleString('en-US')
  }
  function fmtMoney(n, cur) {
    n = Number(n) || 0
    return (cur === 'CNY' ? '¥' : cur + ' ') + n.toFixed(4)
  }
  function fmtMoneyShort(n) {
    n = Number(n) || 0
    if (n >= 1e6) return '¥' + (n / 1e6).toFixed(2) + 'M'
    if (n >= 1e3) return '¥' + (n / 1e3).toFixed(2) + 'K'
    return '¥' + n.toFixed(2)
  }
  function fmtCost(n) {
    return '¥' + (Math.round((Number(n) || 0) * 1e4) / 1e4)
  }
  function genDateRange(start, end) {
    var out = []
    var cur = new Date(start + 'T00:00:00')
    var endD = new Date(end + 'T00:00:00')
    while (cur <= endD) {
      out.push(cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0'))
      cur.setDate(cur.getDate() + 1)
    }
    return out
  }
  function initChart(id) {
    if (!charts[id]) charts[id] = echarts.init(document.getElementById(id))
    return charts[id]
  }
  function emptyOption(text) {
    return { title: { text: text, left: 'center', top: 'middle', textStyle: { color: T.muted, fontSize: 13, fontWeight: 'normal' } } }
  }

  function renderSummary(s, balance) {
    var cards = [
      ['总 Tokens', fmtTokens(s.tokens)],
      ['缓存命中', fmtTokens(s.cache_hit)],
      ['缓存未命中', fmtTokens(s.cache_miss)],
      ['输出', fmtTokens(s.output)],
      ['请求次数', String(s.requests || 0)],
    ]
    if (s.cost && s.cost.length) {
      cards.push(['累计费用', s.cost.map(function (c) { return fmtMoney(c.cost, c.currency) }).join(' / ')])
    }
    if (balance && balance.normal) {
      cards.push(['充值余额', fmtMoney(balance.normal.balance, balance.normal.currency)])
    }
    document.getElementById('summary').innerHTML = cards.map(function (c) {
      return '<div class="card"><div class="card-label">' + c[0] + '</div><div class="card-value">' + c[1] + '</div></div>'
    }).join('')
  }

  function renderDaily() {
    var d = state.daily
    var chart = initChart('dailyChart')
    if (!d || !state.range.start) return
    var dates = genDateRange(state.range.start, state.range.end)
    var view = state.dailyView
    var isCost = state.dailyMetric === 'cost'
    var series

    if (view === 'type') {
      if (isCost) {
        // 计费类型下费用无法按类型拆分，退化为一条「当日费用」折线。
        var costByDate = {}
        ;(d.costTotals || []).forEach(function (r) { costByDate[r.utc_date] = Math.round(((costByDate[r.utc_date] || 0) + (Number(r.cost) || 0)) * 1e4) / 1e4 })
        series = [{ name: '费用', type: 'line', data: dates.map(function (dt) { return costByDate[dt] || 0 }) }]
      } else {
        var byDate = {}
        ;(d.totals || []).forEach(function (r) { byDate[r.utc_date] = r })
        var mk = function (name, key) {
          return { name: name, type: 'bar', stack: 'total', barMaxWidth: 20, data: dates.map(function (dt) { var r = byDate[dt]; return r ? (r[key] || 0) : 0 }) }
        }
        series = [mk('缓存命中', 'cache_hit'), mk('缓存未命中', 'cache_miss'), mk('输出', 'output')]
      }
    } else {
      var isModel = view === 'model'
      var nameOf = isModel
        ? function (r) { return modelLabel(r.model) }
        : function (r) { return r.api_key_name || '(未命名)' }
      var rows = isCost
        ? (isModel ? (d.costByModel || []) : (d.costByKey || []))
        : (isModel ? (d.byModel || []) : (d.byKey || []))
      var toValue = isCost
        ? function (r) { return Math.round((Number(r.cost) || 0) * 1e4) / 1e4 }
        : function (r) { return (r.cache_hit || 0) + (r.cache_miss || 0) + (r.output || 0) }
      var names = []
      var seen = {}
      rows.forEach(function (r) {
        var n = nameOf(r)
        if (!seen[n]) { seen[n] = true; names.push(n) }
      })
      var byDateName = {}
      rows.forEach(function (r) {
        var n = nameOf(r)
        byDateName[r.utc_date + '|' + n] = (byDateName[r.utc_date + '|' + n] || 0) + toValue(r)
      })
      series = names.map(function (n) {
        return { name: n, type: 'bar', stack: 'total', barMaxWidth: 20, itemStyle: { color: modelColor(n) }, data: dates.map(function (dt) { return byDateName[dt + '|' + n] || 0 }) }
      })
    }

    var tooltip = tooltipCfg({ trigger: 'axis', confine: true, axisPointer: { type: 'shadow' } })
    if (isCost) tooltip.valueFormatter = fmtCost
    chart.setOption({
      tooltip: tooltip,
      legend: { type: view === 'type' ? 'plain' : 'scroll', top: 0, textStyle: { color: T.muted } },
      grid: { left: 8, right: 12, top: 32, bottom: 32, containLabel: true },
      xAxis: { type: 'category', data: dates, axisLabel: { color: T.muted }, axisLine: { lineStyle: { color: T.border } }, axisTick: { lineStyle: { color: T.border } } },
      yAxis: { type: 'value', name: isCost ? '费用(¥)' : 'tokens', nameTextStyle: { color: T.muted }, axisLabel: { color: T.muted, formatter: isCost ? function (v) { return '¥' + v } : fmtTokens }, splitLine: { lineStyle: { color: T.border } } },
      series: series,
    }, true)
    chart.off('click')
    chart.on('click', function (p) {
      var dt = dates[p.dataIndex]
      if (dt) {
        setHourlyView(state.dailyView)
        loadHourly(dt)
      }
    })
  }

  function renderModels() {
    var d = state.daily
    var chart = initChart('modelsChart')
    if (!d) return
    var isCost = state.modelsMetric === 'cost'
    var items = (d.modelTotals || []).map(function (r) {
      var cost = 0
      if (r.cost) {
        if (r.cost.CNY !== undefined) cost = r.cost.CNY
        else { var ks = Object.keys(r.cost); if (ks.length) cost = r.cost[ks[0]] }
      }
      return { name: modelLabel(r.model), value: isCost ? cost : r.tokens }
    }).filter(function (x) { return x.value > 0 }).sort(function (a, b) { return b.value - a.value })
    if (!items.length) { chart.setOption(emptyOption('暂无数据'), true); return }
    var total = items.reduce(function (s, x) { return s + x.value }, 0)
    chart.setOption({
      title: { text: isCost ? fmtMoneyShort(total) : fmtTokens(total), left: 'center', top: 'middle', textStyle: { color: T.ink, fontSize: 14, fontWeight: 600 } },
      tooltip: tooltipCfg({ trigger: 'item', confine: true, formatter: function (p) { return p.marker + ' ' + p.name + '<br/>' + (isCost ? fmtCost(p.value) : fmtTokensFull(p.value) + ' tokens') + ' (' + p.percent + '%)' } }),
      legend: { type: 'plain', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: T.muted, fontSize: 11 } },
      series: [{
        type: 'pie', radius: ['40%', '72%'], center: ['50%', '50%'],
        label: { show: false },
        emphasis: { scaleSize: 6 },
        data: items.map(function (x) { return { name: x.name, value: x.value, itemStyle: { color: modelColor(x.name) } } }),
      }],
    }, true)
  }

  function renderCumulative() {
    var d = state.daily
    var chart = initChart('cumulativeChart')
    if (!d || !state.range.start) return
    var isCost = state.cumulativeMetric === 'cost'
    var dates = genDateRange(state.range.start, state.range.end)
    var byDate = {}
    if (isCost) {
      ;(d.costTotals || []).forEach(function (r) { byDate[r.utc_date] = (byDate[r.utc_date] || 0) + (Number(r.cost) || 0) })
    } else {
      ;(d.totals || []).forEach(function (r) { byDate[r.utc_date] = (r.cache_hit || 0) + (r.cache_miss || 0) + (r.output || 0) })
    }
    var last = 0
    var data = dates.map(function (dt) { if (byDate[dt] !== undefined) last += byDate[dt]; return last })
    chart.setOption({
      tooltip: tooltipCfg({ trigger: 'axis', confine: true, valueFormatter: isCost ? fmtCost : undefined }),
      grid: { left: 8, right: 12, top: 28, bottom: 30, containLabel: true },
      xAxis: { type: 'category', data: dates, boundaryGap: false, axisLabel: { color: T.muted }, axisLine: { lineStyle: { color: T.border } }, axisTick: { lineStyle: { color: T.border } } },
      yAxis: { type: 'value', axisLabel: { color: T.muted, formatter: function (v) { return isCost ? '¥' + v : fmtTokens(v) } }, splitLine: { lineStyle: { color: T.border } } },
      series: [{
        name: isCost ? '累计花费' : '累计 Tokens',
        type: 'line', smooth: false, showSymbol: false,
        lineStyle: { width: 2 }, areaStyle: { opacity: 0.12 },
        data: data,
      }],
    }, true)
  }

  function renderHeatmap() {
    var d = state.heatmapData
    var chart = initChart('heatmapChart')
    if (!d) return
    var isCost = state.heatmapMetric === 'cost'
    var r = heatmapRange()
    var byDate = {}
    if (isCost) {
      ;(d.costTotals || []).forEach(function (r) { byDate[r.utc_date] = (byDate[r.utc_date] || 0) + (Number(r.cost) || 0) })
    } else {
      ;(d.totals || []).forEach(function (r) { byDate[r.utc_date] = (r.cache_hit || 0) + (r.cache_miss || 0) + (r.output || 0) })
    }
    var hasData = Object.keys(byDate).length > 0
    if (!hasData) { chart.setOption(emptyOption('暂无数据'), true); return }
    var max = Math.max.apply(null, Object.keys(byDate).map(function (dt) { return byDate[dt] }))
    var data = genDateRange(r.start, r.end).map(function (dt) { return [dt, byDate[dt] || 0] })
    var gapColor = T.panel
    chart.setOption({
      tooltip: tooltipCfg({ position: 'top', confine: true, formatter: function (p) { return p.value[0] + '<br/>' + (isCost ? fmtCost(p.value[1]) : fmtTokensFull(p.value[1]) + ' tokens') } }),
      visualMap: { min: 0, max: max, show: false, inRange: { color: T.heatColors } },
      calendar: { range: [r.start, r.end], cellSize: 16, left: 'center', top: 'middle', itemStyle: { borderWidth: 0, color: T.panel }, yearLabel: { show: false }, dayLabel: { color: T.muted, firstDay: 1 }, monthLabel: { color: T.muted, nameMap: 'ZH' }, splitLine: { show: false } },
      series: [{ type: 'heatmap', coordinateSystem: 'calendar', itemStyle: { borderWidth: 2, borderColor: gapColor, borderRadius: 3 }, data: data }],
    }, true)
  }

  async function loadHeatmap() {
    var r = heatmapRange()
    state.heatmapData = await api.getUsageDaily(r.start, r.end)
    renderHeatmap()
  }

  function renderHourly(detail) {
    var chart = initChart('hourlyChart')
    if (!detail || !detail.series || !detail.series.length) {
      chart.setOption(emptyOption('无保存的分时数据'), true)
      document.getElementById('hourlyTitle').textContent = '分时明细'
      return
    }
    document.getElementById('hourlyTitle').textContent = '分时明细 · ' + detail.date
    var hours = []
    for (var h = 0; h < 24; h++) hours.push(String(h).padStart(2, '0') + ':00')
    var series = detail.series.map(function (s) {
      return { name: s.name, type: 'bar', stack: 't', data: s.data }
    })
    series.push({ name: '费用', type: 'line', yAxisIndex: 1, data: (detail.cost || []).map(function (c) { return Math.round((c || 0) * 1e4) / 1e4 }) })
    chart.setOption({
      tooltip: tooltipCfg({
        trigger: 'axis',
        formatter: function (params) {
          var rows = [params[0].axisValue]
          params.forEach(function (p) {
            rows.push(p.marker + ' ' + p.seriesName + ': ' + (p.seriesName === '费用' ? fmtCost(p.value) : p.value))
          })
          return rows.join('<br/>')
        },
      }),
      legend: { type: 'scroll', top: 0, textStyle: { color: T.muted }, selected: { '费用': state.feeVisible } },
      grid: { left: 8, right: 8, top: 32, bottom: 32, containLabel: true },
      xAxis: { type: 'category', data: hours, axisLabel: { color: T.muted }, axisLine: { lineStyle: { color: T.border } }, axisTick: { lineStyle: { color: T.border } } },
      yAxis: [
        { type: 'value', name: 'tokens', nameTextStyle: { color: T.muted }, axisLabel: { color: T.muted, formatter: fmtTokens }, splitLine: { lineStyle: { color: T.border } } },
        { type: 'value', name: '费用(¥)', nameTextStyle: { color: T.muted }, axisLabel: { color: T.muted }, splitLine: { show: false }, show: state.feeVisible },
      ],
      series: series,
    }, true)
    chart.off('legendselectchanged')
    chart.on('legendselectchanged', function (params) {
      state.feeVisible = !params.selected || params.selected['费用'] !== false
      chart.setOption({ yAxis: [{ show: true }, { show: state.feeVisible }] })
    })
  }

  async function loadSummary() {
    var r = await api.getUsageSummary()
    renderSummary(r.summary || {}, r.balance)
    displaySyncTime(r.lastSyncAt)
    highlightPreset(7)
    setRange(gmt8Date(-6), gmt8Date(0))
    loadHeatmap().catch(function (e) { console.error(e) })
  }

  function displaySyncTime(iso) {
    var el = document.getElementById('syncTime')
    if (!iso) { el.textContent = '—'; return }
    try { el.textContent = new Date(iso).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) + ' (GMT+8)' } catch (e) { el.textContent = iso }
  }

  async function loadDailyRange(start, end) {
    state.range.start = start
    state.range.end = end
    var d = await api.getUsageDaily(start, end)
    state.daily = d
    renderDaily()
    renderModels()
    renderCumulative()
    // 等首帧布局稳定后再补一次 resize，避免 CSS Grid 列宽尚未算完时图表拿到偏小尺寸
    requestAnimationFrame(function () { resizeAllCharts() })
  }

  function setHourlyView(value) {
    state.hourlyView = value
    var box = document.getElementById('hourlyViewSeg')
    if (!box) return
    Array.prototype.slice.call(box.querySelectorAll('button')).forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === value)
    })
  }

  async function loadHourly(day) {
    state.hourlyDate = day
    showHourlyModal() // 先显示弹窗，确保容器可见，避免 ECharts 在隐藏容器上初始化出 0 尺寸
    var detail = await api.getUsageHourly(day, state.hourlyView)
    state.hourlyDetail = detail
    renderHourly(detail)
  }

  function showHourlyModal() {
    document.getElementById('hourlyModal').classList.remove('hidden')
    if (charts.hourlyChart) charts.hourlyChart.resize()
  }
  function hideHourlyModal() {
    document.getElementById('hourlyModal').classList.add('hidden')
  }
  function showTokenModal() {
    document.getElementById('tokenModal').classList.remove('hidden')
  }
  function hideTokenModal() {
    document.getElementById('tokenModal').classList.add('hidden')
  }

  async function doSync() {
    var btn = document.getElementById('syncBtn')
    var cancelBtn = document.getElementById('cancelSyncBtn')
    btn.disabled = true
    btn.textContent = '同步中…'
    if (cancelBtn) { cancelBtn.style.display = ''; cancelBtn.disabled = false; cancelBtn.textContent = '取消同步' }
    try {
      var r = await api.syncUsage()
      btn.textContent = r.ok ? '已同步' : '同步失败'
      if (r.ok) await loadSummary()
    } catch (e) {
      btn.textContent = '同步失败'
    } finally {
      if (cancelBtn) cancelBtn.style.display = 'none'
      setTimeout(function () { btn.disabled = false; btn.textContent = '立即同步' }, 2000)
    }
  }

  async function doLogin() {
    var btn = document.getElementById('loginBtn')
    btn.disabled = true
    btn.textContent = '请在登录窗口完成登录…'
    try {
      var r = await api.platformLogin()
      if (r.ok) { btn.textContent = '已获取令牌'; await doSync() } else { btn.textContent = '未获取到令牌' }
    } catch (e) {
      btn.textContent = '登录失败'
    } finally {
      setTimeout(function () { btn.disabled = false; btn.textContent = '登录平台获取令牌' }, 2000)
    }
  }

  async function doSaveToken() {
    var input = document.getElementById('tokenInput')
    var btn = document.getElementById('tokenSave')
    var token = input.value.trim()
    if (!token) return
    btn.disabled = true
    btn.textContent = '保存中…'
    try {
      await api.setConfig({ platformToken: token })
      btn.textContent = '已保存'
      input.value = ''
      hideTokenModal()
    } catch (e) {
      btn.textContent = '保存失败'
    } finally {
      setTimeout(function () { btn.disabled = false; btn.textContent = '保存' }, 2000)
    }
  }

  function bindSeg(id, onSelect) {
    var box = document.getElementById(id)
    if (!box) return
    Array.prototype.slice.call(box.querySelectorAll('button')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        box.querySelectorAll('button').forEach(function (b) { b.classList.remove('active') })
        btn.classList.add('active')
        onSelect(btn)
      })
    })
  }

  document.getElementById('syncBtn').addEventListener('click', doSync)
  document.getElementById('loginBtn').addEventListener('click', doLogin)
  document.getElementById('tokenSave').addEventListener('click', doSaveToken)
  var cancelSyncBtn = document.getElementById('cancelSyncBtn')
  if (cancelSyncBtn) {
    cancelSyncBtn.addEventListener('click', function () {
      api.cancelSync()
      cancelSyncBtn.disabled = true
      cancelSyncBtn.textContent = '正在取消…'
    })
  }
  api.onSyncProgress(function (p) {
    var btn = document.getElementById('syncBtn')
    if (p && p.startDate) btn.textContent = '同步中… 回填到 ' + p.startDate
  })

  bindSeg('dailyViewSeg', function (btn) { state.dailyView = btn.dataset.view; renderDaily() })
  bindSeg('dailyMetricSeg', function (btn) { state.dailyMetric = btn.dataset.metric; renderDaily() })
  bindSeg('modelsMetricSeg', function (btn) { state.modelsMetric = btn.dataset.metric; renderModels() })
  bindSeg('cumulativeMetricSeg', function (btn) { state.cumulativeMetric = btn.dataset.metric; renderCumulative() })
  bindSeg('heatmapMetricSeg', function (btn) { state.heatmapMetric = btn.dataset.metric; renderHeatmap() })
  bindSeg('hourlyViewSeg', function (btn) { state.hourlyView = btn.dataset.view; if (state.hourlyDate) loadHourly(state.hourlyDate) })

  document.getElementById('hourlyClose').addEventListener('click', hideHourlyModal)
  document.getElementById('hourlyModal').addEventListener('click', function (e) {
    if (e.target === e.currentTarget) hideHourlyModal()
  })
  document.getElementById('manualTokenBtn').addEventListener('click', showTokenModal)
  document.getElementById('tokenClose').addEventListener('click', hideTokenModal)
  document.getElementById('tokenModal').addEventListener('click', function (e) {
    if (e.target === e.currentTarget) hideTokenModal()
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { hideHourlyModal(); hideTokenModal() }
  })

  var presetBtns = Array.prototype.slice.call(document.querySelectorAll('.preset-btn'))
  var rangeStart = document.getElementById('rangeStart')
  var rangeEnd = document.getElementById('rangeEnd')
  function highlightPreset(days) {
    presetBtns.forEach(function (btn) { btn.classList.toggle('active', Number(btn.dataset.days) === days) })
  }
  function setRange(start, end) {
    rangeStart.value = start
    rangeEnd.value = end
    loadDailyRange(start, end).catch(function (e) { console.error(e) })
  }
  presetBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var days = Number(btn.dataset.days) || 7
      highlightPreset(days)
      setRange(gmt8Date(-(days - 1)), gmt8Date(0))
    })
  })
  function onDateChange() {
    var s = rangeStart.value
    var e = rangeEnd.value
    if (s && e) {
      highlightPreset(-1)
      loadDailyRange(s, e).catch(function (err) { console.error(err) })
    }
  }
  rangeStart.addEventListener('change', onDateChange)
  rangeEnd.addEventListener('change', onDateChange)
  var chartContainerIds = ['dailyChart', 'modelsChart', 'cumulativeChart', 'heatmapChart', 'hourlyChart']
  function resizeAllCharts() {
    Object.keys(charts).forEach(function (id) { if (charts[id]) charts[id].resize() })
  }
  window.addEventListener('resize', resizeAllCharts)
  if (window.ResizeObserver) {
    var resizeObserver = new ResizeObserver(function () { resizeAllCharts() })
    chartContainerIds.forEach(function (id) {
      var el = document.getElementById(id)
      if (el) resizeObserver.observe(el)
    })
  }
  function renderAll() {
    if (state.daily) {
      renderDaily()
      renderModels()
      renderCumulative()
    }
    if (state.heatmapData) renderHeatmap()
    if (state.hourlyDetail) renderHourly(state.hourlyDetail)
  }
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      T = buildTheme(detectDark())
      renderAll()
    })
  }
  loadSummary().catch(function (e) { console.error(e) })
})()
