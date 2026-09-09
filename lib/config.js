'use strict'
// ---------------------------------------------------------------------------
// 配置管理：~/.config/whale-pet/config.json
// - 默认值 + 读时消毒（sanitize），保证任何字段都不会把渲染进程搞挂
// - 原子写入（tmp + rename），目录 0700 / 文件 0600（含 API Key，必须收紧权限）
// - 环境变量优先：DEEPSEEK_API_KEY / DEEPSEEK_PLATFORM_TOKEN 存在时覆盖文件值
// ---------------------------------------------------------------------------
const fs = require('fs')
const os = require('os')
const path = require('path')
const log = require('./log')

// 平台自适应配置目录：Windows 用 %APPDATA%/whale-pet，macOS 用
// ~/Library/Application Support/whale-pet，其余 ~/.config/whale-pet；
// 可用 WHALE_PET_HOME 重定向（开发/CI 用）。
function defaultConfigDir() {
  if (process.env.WHALE_PET_HOME) return process.env.WHALE_PET_HOME
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'whale-pet')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'whale-pet')
  }
  return path.join(os.homedir(), '.config', 'whale-pet')
}
const CONFIG_DIR = defaultConfigDir()
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const USAGE_FILE = path.join(CONFIG_DIR, 'usage.json')
// 应用根目录（lib/config.js → 上一级），用于校验内置素材（如预警图）是否存在
const APP_ROOT = path.resolve(__dirname, '..')

const DEFAULTS = {
  apiKey: '',
  platformToken: '',
  scale: 1.0,               // 0.6 - 2.5（默认 1.0）
  soundSet: 'duck',         // duck（音效1）| fx1（音效2）
  volume: 1.0,              // 0 - 1（默认 100%）
  usageMode: 'ledger',      // ledger | token
  peakMode: 'default',      // default | liangwen | qiangqiang
  peakText: true,           // 气泡里显示峰谷时段提示
  bubbleOn: true,
  bubbleInterval: 900,      // 每隔 N 秒自动弹出一次随机台词气泡（0 = 关闭，默认 15 分钟）
  idleFade: true,           // 闲置半透明（开关）
  idleOpacity: 0.6,         // 闲置时的不透明度（0.2 - 1.0，可拖动调节）
  refreshInterval: 60,      // 秒
  lowBalanceThreshold: 5,   // 元（默认 5）
  mainImgPath: 'assets/DSniang1.png',   // 主图（默认显示图，可上传替换）
  theme: 'system',          // system | light | dark（设置面板深色模式）
  bubbleTextOk: 'DeepSeek 余额', // 余额充足时气泡第一行文字（限 20 字符）
  bubbleTextLow: '余额预警',   // 预警状态气泡第一行文字（限 20 字符）
  textColorOk: '',          // 余额充足文案颜色（'' = 默认 #536ba9；否则 #rrggbb）
  textColorLow: '',         // 预警文案颜色
  bubbleColor: '#203170',   // 气泡描边颜色（色相滑条）
  peakTextOff: '',          // 自定义空闲时段文案（'' = 用内置/峰谷模式，限 12 字符）
  peakTextOn: '',           // 自定义高峰时段文案
  pressSound: '',           // 自定义按压音效路径（'' = 用当前音效集）
  releaseSound: '',         // 自定义松手音效路径
  autostart: false,
  autoSync: true,           // 启动及运行期间自动同步近两天用量（分时）
  passthrough: false,       // 鼠标穿透：整窗不接收鼠标事件（配合闲置半透明）
  mirror: true,             // 镜像翻转：拖到屏幕左半侧时鲸鱼左右镜像
  // 表情状态机（阶段 A：眨眼 / 失望 / 生气；阶段 B：害羞 / 低余额疲惫）
  expressions: {
    images: {
      press: 'assets/expressions/press.png',
      angry: 'assets/expressions/angry.png',
      disappointed: 'assets/expressions/disappointed.png',
      shy: 'assets/expressions/shy.png',
      exhausted: 'assets/expressions/exhausted.png',
      blinkHalf: 'assets/expressions/blink_half.png',
      blinkClosed: 'assets/expressions/blink_closed.png',
      blinkHalfOpen: 'assets/expressions/blink_half_open.png',
    },
    enabled: { blink: true, angry: true, disappointed: true, shy: true, exhausted: true },
    masterEnabled: true,   // 表情总开关：false 时只显示默认脸（按压/摸头不受影响）
    lines: {
      angryWarn: ['你再摸人家就生气了喵 (╬ Ò﹏Ó)'],
      disappointedEntry: ['鲸鲸没人要了喵 (╥﹏╥)'],
      lonely: [
        '主人不理我，好寂寞…',
        '喵…都不看本鲸一眼…',
        '等了你好久好久…',
        '尾巴都垂下来了…',
        '罐头不香了吗…',
        '你忘了本鲸在这里了吗…',
        '太阳落山了，你还没来…',
        '连呼噜都没力气…',
        '本鲸趴门口等了好久…',
        '你鼠标路过也不摸我…',
        '喵…本鲸心里空空的…',
        '窗台好冷，主人不在…',
        '我给空气翻肚皮…',
        '本鲸叫了三声，没人应…',
        '你的影子都走了…',
        '本鲸的人生突然好灰暗…',
        '你连本鲸尾巴尖都没碰过…',
        '主人…本鲸还在等你回家呢。',
      ],
      shy: ['主人摸本鲸头了喵 (≧◡≦)♡'],
      exhausted: [
        '额度快见底了，省着点花喵…',
        '本鲸已经有点转不动了…',
        '余额薄得像尾巴尖了…',
        '再这样下去要喝西北风啦…',
        '我闻到贫穷的海风了喵。',
        '今天先克制一点点，好吗？',
      ],
    },
    blinkMinSec: 4,
    blinkMaxSec: 6,
    idleToDisappointedSec: 180,
    hoverToShyMs: 1500,
    shyDurationMs: 10000,
    angryDurationMs: 5000,
    exhaustedPromptSec: 300,
  },
  posX: null,               // 上次窗口位置（屏幕坐标）
  posY: null,
  posH: 'right',            // left | right | null（已弃用，兼容旧配置保留）
  posV: 'bottom',           // top | bottom | null（已弃用，兼容旧配置保留）
}

function num(v, lo, hi, def) {
  const n = Number(v)
  if (!isFinite(n)) return def
  return Math.min(hi, Math.max(lo, n))
}

function sanitizeExpressions(raw) {
  const d = raw && typeof raw === 'object' ? raw : {}
  const imgs = d.images && typeof d.images === 'object' ? d.images : {}
  const en = d.enabled && typeof d.enabled === 'object' ? d.enabled : {}
  const ln = d.lines && typeof d.lines === 'object' ? d.lines : {}
  const images = {}
  for (const k of Object.keys(DEFAULTS.expressions.images)) {
    images[k] = (typeof imgs[k] === 'string' && imgs[k].trim()) ? imgs[k].trim() : DEFAULTS.expressions.images[k]
  }
  const enabled = {}
  for (const k of Object.keys(DEFAULTS.expressions.enabled)) {
    enabled[k] = (typeof en[k] === 'boolean') ? en[k] : DEFAULTS.expressions.enabled[k]
  }
  const lines = {}
  for (const k of ['angryWarn', 'disappointedEntry', 'lonely', 'shy', 'exhausted']) {
    const arr = Array.isArray(ln[k])
      ? ln[k].filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
      : []
    lines[k] = arr.length ? arr : DEFAULTS.expressions.lines[k]
  }
  return {
    images,
    enabled,
    lines,
    masterEnabled: (typeof d.masterEnabled === 'boolean') ? d.masterEnabled : DEFAULTS.expressions.masterEnabled,
    blinkMinSec: Math.round(num(d.blinkMinSec, 1, 3600, DEFAULTS.expressions.blinkMinSec)),
    blinkMaxSec: Math.round(num(d.blinkMaxSec, 1, 3600, DEFAULTS.expressions.blinkMaxSec)),
    idleToDisappointedSec: Math.round(num(d.idleToDisappointedSec, 5, 86400, DEFAULTS.expressions.idleToDisappointedSec)),
    hoverToShyMs: Math.round(num(d.hoverToShyMs, 500, 60000, DEFAULTS.expressions.hoverToShyMs)),
    shyDurationMs: Math.round(num(d.shyDurationMs, 1000, 120000, DEFAULTS.expressions.shyDurationMs)),
    angryDurationMs: Math.round(num(d.angryDurationMs, 1000, 60000, DEFAULTS.expressions.angryDurationMs)),
    exhaustedPromptSec: Math.round(num(d.exhaustedPromptSec !== undefined ? d.exhaustedPromptSec : (d.exhaustedPromptMin !== undefined ? d.exhaustedPromptMin * 60 : undefined), 60, 86400, DEFAULTS.expressions.exhaustedPromptSec)),
  }
}

function sanitize(raw) {
  const d = raw && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULTS }
  if (typeof d.apiKey === 'string') cfg.apiKey = d.apiKey.trim()
  if (typeof d.platformToken === 'string') cfg.platformToken = d.platformToken.trim()
  if (d.scale !== undefined) cfg.scale = Math.round(num(d.scale, 0.6, 2.5, DEFAULTS.scale) * 10) / 10
  if (typeof d.soundSet === 'string') cfg.soundSet = d.soundSet === 'fx1' ? 'fx1' : 'duck'
  if (d.volume !== undefined) cfg.volume = Math.round(num(d.volume, 0, 1, DEFAULTS.volume) * 100) / 100
  if (typeof d.usageMode === 'string') cfg.usageMode = d.usageMode === 'token' ? 'token' : 'ledger'
  if (typeof d.peakMode === 'string') cfg.peakMode = ['liangwen', 'qiangqiang'].includes(d.peakMode) ? d.peakMode : 'default'
  if (typeof d.peakText === 'boolean') cfg.peakText = d.peakText
  if (typeof d.bubbleOn === 'boolean') cfg.bubbleOn = d.bubbleOn
  if (d.bubbleInterval !== undefined) cfg.bubbleInterval = Math.round(num(d.bubbleInterval, 0, 86400, DEFAULTS.bubbleInterval))
  if (typeof d.idleFade === 'boolean') cfg.idleFade = d.idleFade
  if (d.idleOpacity !== undefined) cfg.idleOpacity = Math.round(num(d.idleOpacity, 0.2, 1, DEFAULTS.idleOpacity) * 100) / 100
  if (d.refreshInterval !== undefined) cfg.refreshInterval = Math.round(num(d.refreshInterval, 5, 3600, DEFAULTS.refreshInterval))
  if (d.lowBalanceThreshold !== undefined) cfg.lowBalanceThreshold = Math.round(num(d.lowBalanceThreshold, 0, 1e9, DEFAULTS.lowBalanceThreshold) * 100) / 100
  if (typeof d.mainImgPath === 'string' && d.mainImgPath.trim()) cfg.mainImgPath = d.mainImgPath.trim()
  if (['system', 'light', 'dark'].includes(d.theme)) cfg.theme = d.theme
  if (typeof d.bubbleTextOk === 'string') cfg.bubbleTextOk = d.bubbleTextOk.trim().slice(0, 20) || DEFAULTS.bubbleTextOk
  if (typeof d.bubbleTextLow === 'string') cfg.bubbleTextLow = d.bubbleTextLow.trim().slice(0, 20) || DEFAULTS.bubbleTextLow
  if (typeof d.textColorOk === 'string') cfg.textColorOk = /^#[0-9a-fA-F]{6}$/.test(d.textColorOk.trim()) ? d.textColorOk.trim() : ''
  if (typeof d.textColorLow === 'string') cfg.textColorLow = /^#[0-9a-fA-F]{6}$/.test(d.textColorLow.trim()) ? d.textColorLow.trim() : ''
  if (typeof d.bubbleColor === 'string') cfg.bubbleColor = /^#[0-9a-fA-F]{6}$/.test(d.bubbleColor.trim()) ? d.bubbleColor.trim() : DEFAULTS.bubbleColor
  if (typeof d.peakTextOff === 'string') cfg.peakTextOff = d.peakTextOff.trim().slice(0, 12)
  if (typeof d.peakTextOn === 'string') cfg.peakTextOn = d.peakTextOn.trim().slice(0, 12)
  if (typeof d.pressSound === 'string') cfg.pressSound = d.pressSound.trim()
  if (typeof d.releaseSound === 'string') cfg.releaseSound = d.releaseSound.trim()
  if (typeof d.autostart === 'boolean') cfg.autostart = d.autostart
  if (typeof d.autoSync === 'boolean') cfg.autoSync = d.autoSync
  if (typeof d.passthrough === 'boolean') cfg.passthrough = d.passthrough
  if (typeof d.mirror === 'boolean') cfg.mirror = d.mirror
  // 旧「预警换图」字段迁移：自定义预警图 → 疲惫表情图（旧默认 DSniang03.png 不覆盖新默认）
  const exprPre = (d.expressions && typeof d.expressions === 'object') ? d.expressions : {}
  const exprImgsPre = (exprPre.images && typeof exprPre.images === 'object') ? exprPre.images : {}
  if (typeof d.alertImgPath === 'string' && d.alertImgPath.trim() &&
      d.alertImgPath.trim() !== 'assets/DSniang03.png' &&
      !(typeof exprImgsPre.exhausted === 'string' && exprImgsPre.exhausted.trim())) {
    d.expressions = { ...exprPre, images: { ...exprImgsPre, exhausted: d.alertImgPath.trim() } }
  }
  cfg.expressions = sanitizeExpressions(d.expressions)
  if (d.posX !== null && d.posX !== undefined && isFinite(Number(d.posX))) cfg.posX = Math.round(Number(d.posX))
  if (d.posY !== null && d.posY !== undefined && isFinite(Number(d.posY))) cfg.posY = Math.round(Number(d.posY))
  if (typeof d.posH === 'string') cfg.posH = d.posH === 'left' ? 'left' : (d.posH === 'right' ? 'right' : null)
  if (typeof d.posV === 'string') cfg.posV = d.posV === 'top' ? 'top' : 'bottom'
  return cfg
}

function readFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return sanitize(parsed)
  } catch (err) {
    // 不在此打日志：readFile 由 log.secrets() 间接调用，若这里再 log 会形成递归。
    // 文件不存在（首次运行）属正常；真正损坏时上层会以默认配置继续，错误自会体现在别处。
    return null
  }
}

// 带环境变量覆盖的“有效配置”
function getEffective() {
  const cfg = readFile() || { ...DEFAULTS }
  const envKey = process.env.DEEPSEEK_API_KEY
  const envToken = process.env.DEEPSEEK_PLATFORM_TOKEN
  cfg.apiKeySource = typeof envKey === 'string' && envKey.trim() ? 'env' : (cfg.apiKey ? 'config' : '')
  if (cfg.apiKeySource === 'env') cfg.apiKey = envKey.trim()
  if (typeof envToken === 'string' && envToken.trim()) {
    cfg.platformToken = envToken.trim()
    cfg.platformTokenSource = 'env'
  } else {
    cfg.platformTokenSource = cfg.platformToken ? 'config' : ''
  }
  return cfg
}

function save(patch) {
  const cur = readFile() || { ...DEFAULTS }
  const next = sanitize({ ...cur, ...(patch || {}) })
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
    const tmp = CONFIG_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, CONFIG_FILE)
    return next
  } catch (err) {
    log.error('[config] 保存失败: ' + ((err && err.message) || err))
    return null
  }
}

module.exports = { DEFAULTS, CONFIG_DIR, CONFIG_FILE, USAGE_FILE, sanitize, readFile: readFile, getEffective, save }
