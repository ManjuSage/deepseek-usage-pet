// 用量统计面板渲染脚本。
// 职责：拉取用量数据 → ECharts 渲染日级堆叠图 + 分时下钻；处理范围选择（预设/自定义日期）、
//       充值余额卡片、上次同步时间显示。
(function () {
  'use strict'
  var api = window.whaleAPI
  var dailyChart = null
  var hourlyChart = null
  var feeVisible = true // 分时图「费用」是否显示（跨日期保持用户选择）

  // GMT+8 日期字符串（offsetDays 相对今天偏移），与后端 usage-sync 的日分桶口径一致。
  function gmt8Date(offsetDays) {
    return new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10)
  }
  // token 数量缩写（K/M/B）。
  function fmtTokens(n) {
    n = Number(n) || 0
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
    return String(n)
  }

  // 金额显示（CNY 用 ¥）。
  function fmtMoney(n, cur) {
    n = Number(n) || 0
    return (cur === 'CNY' ? '¥' : cur + ' ') + n.toFixed(4)
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

  function renderDaily(d) {
    var dates = (d.totals || []).map(function (r) { return r.utc_date })
    var series = [
      { name: '缓存命中', key: 'cache_hit' },
      { name: '缓存未命中', key: 'cache_miss' },
      { name: '输出', key: 'output' },
    ]
    var option = {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { data: series.map(function (s) { return s.name }) },
      grid: { left: 8, right: 8, top: 40, bottom: 40, containLabel: true },
      xAxis: { type: 'category', data: dates },
      yAxis: { type: 'value', name: 'tokens' },
      series: series.map(function (s) {
        return {
          name: s.name,
          type: 'bar',
          stack: 'total',
          data: (d.totals || []).map(function (r) { return r[s.key] || 0 }),
        }
      }),
    }
    if (!dailyChart) dailyChart = echarts.init(document.getElementById('dailyChart'))
    dailyChart.setOption(option)
    dailyChart.off('click')
    dailyChart.on('click', function (p) {
      var date = dates[p.dataIndex]
      if (date) loadHourly(date)
    })
  }

  function renderHourly(detail) {
    document.getElementById('hourlyTitle').textContent = '分时明细 · ' + detail.date
    var hours = detail.hours.map(function (h) { return String(h.hour).padStart(2, '0') + ':00' })
    var option = {
      tooltip: { trigger: 'axis' },
      legend: { data: ['缓存命中', '缓存未命中', '输出', '费用'], selected: { '费用': feeVisible } },
      grid: { left: 8, right: 8, top: 40, bottom: 40, containLabel: true },
      xAxis: { type: 'category', data: hours },
      yAxis: [
        { type: 'value', name: 'tokens' },
        { type: 'value', name: '费用(¥)', show: feeVisible },
      ],
      series: [
        { name: '缓存命中', type: 'bar', stack: 't', data: detail.hours.map(function (h) { return h.cache_hit }) },
        { name: '缓存未命中', type: 'bar', stack: 't', data: detail.hours.map(function (h) { return h.cache_miss }) },
        { name: '输出', type: 'bar', stack: 't', data: detail.hours.map(function (h) { return h.output }) },
        { name: '费用', type: 'line', yAxisIndex: 1, data: detail.hours.map(function (h) { return Math.round((h.cost || 0) * 1e4) / 1e4 }) },
      ],
    }
    if (!hourlyChart) {
      hourlyChart = echarts.init(document.getElementById('hourlyChart'))
      // 点击图例隐藏/显示「费用」时，同步隐藏/显示右侧「费用(¥)」坐标轴，避免残留文字并向右溢出
      hourlyChart.on('legendselectchanged', function (params) {
        feeVisible = !params.selected || params.selected['费用'] !== false
        hourlyChart.setOption({ yAxis: [{ show: true }, { show: feeVisible }] })
      })
    }
    hourlyChart.setOption(option)
  }

  async function loadSummary() {
    var r = await api.getUsageSummary()
    renderSummary(r.summary || {}, r.balance)
    displaySyncTime(r.lastSyncAt)
    highlightPreset(7)
    setRange(gmt8Date(-6), gmt8Date(0))
  }

  function displaySyncTime(iso) {
    var el = document.getElementById('syncTime')
    if (!iso) { el.textContent = '—'; return }
    try {
      el.textContent = new Date(iso).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) + ' (GMT+8)'
    } catch (e) { el.textContent = iso }
  }

  async function loadDailyRange(start, end) {
    var d = await api.getUsageDaily(start, end)
    renderDaily(d)
    var totals = d.totals || []
    if (totals.length) await loadHourly(totals[totals.length - 1].utc_date)
  }

  function hourlyHasData(detail) {
    var hours = detail && detail.hours
    if (!Array.isArray(hours)) return false
    return hours.some(function (h) {
      return (h.cache_hit || 0) + (h.cache_miss || 0) + (h.output || 0) + (h.requests || 0) + (h.cost || 0) > 0
    })
  }

  async function loadHourly(day) {
    var detail = await api.getUsageHourly(day)
    if (!hourlyHasData(detail)) {
      document.getElementById('hourlyTitle').textContent = '分时明细 · ' + day + '（无保存的分时数据：需在该日当天或次日同步过）'
      if (hourlyChart) hourlyChart.clear()
      return
    }
    renderHourly(detail)
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
      if (r.ok) {
        btn.textContent = '已获取令牌'
        await doSync()
      } else {
        btn.textContent = '未获取到令牌'
      }
    } catch (e) {
      btn.textContent = '登录失败'
    } finally {
      setTimeout(function () { btn.disabled = false; btn.textContent = '登录平台获取令牌' }, 2000)
    }
  }

  async function doSaveToken() {
    const input = document.getElementById('tokenInput')
    const btn = document.getElementById('tokenSave')
    const token = input.value.trim()
    if (!token) return
    btn.disabled = true
    btn.textContent = '保存中…'
    try {
      await api.setConfig({ platformToken: token })
      btn.textContent = '已保存'
      input.value = ''
    } catch (e) {
      btn.textContent = '保存失败'
    } finally {
      setTimeout(function () { btn.disabled = false; btn.textContent = '保存' }, 2000)
    }
  }

  document.getElementById('syncBtn').addEventListener('click', doSync)
  document.getElementById('loginBtn').addEventListener('click', doLogin)
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
  document.getElementById('tokenSave').addEventListener('click', doSaveToken)
  var presetBtns = Array.prototype.slice.call(document.querySelectorAll('.preset-btn'))
  var rangeStart = document.getElementById('rangeStart')
  var rangeEnd = document.getElementById('rangeEnd')
  function highlightPreset(days) {
    presetBtns.forEach(function (btn) {
      btn.classList.toggle('active', Number(btn.dataset.days) === days)
    })
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
  window.addEventListener('resize', function () {
    if (dailyChart) dailyChart.resize()
    if (hourlyChart) hourlyChart.resize()
  })
  loadSummary().catch(function (e) { console.error(e) })
})()
