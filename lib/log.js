'use strict'
// ---------------------------------------------------------------------------
// 轻量文件日志：追加写入 <CONFIG_DIR>/pet.log，单文件上限 1MB 轮转（保留 pet.log.1）。
// - 级别 debug < info < warn < error，默认 info；WHALE_PET_LOG_LEVEL 可覆盖，
//   WHALE_PET_TRACE=1 也映射为 debug（收编现有 trace 调试）。
// - 所有进日志的字符串先过 redact()：把 apiKey / platformToken 替换成 ***。
// - 同时回显到终端（开发时可见），写文件失败静默忽略，绝不影响主流程。
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')

let _config = null
function cfg() {
  if (!_config) _config = require('./config') // 懒加载，避免与 config 形成循环依赖
  return _config
}

const MAX_BYTES = 1024 * 1024 // 1MB
const LEVEL = { debug: 0, info: 1, warn: 2, error: 3 }
const CONSOLE_FN = { debug: 'log', info: 'log', warn: 'warn', error: 'error' }

// Windows 控制台默认不是 UTF-8（中文系统是 GBK/CP936），直接 console.log 中文会乱码。
// 这里检测控制台代码页，把终端回显按对应编码写字节，避免 mojibake。
let _iconv = null
let _iconvTried = false
function iconv() {
  if (!_iconvTried) {
    _iconvTried = true
    try { _iconv = require('iconv-lite') } catch (e) { _iconv = null }
  }
  return _iconv
}

let _consoleEnc = null
function consoleEnc() {
  if (_consoleEnc) return _consoleEnc
  _consoleEnc = 'utf8'
  if (process.platform === 'win32') {
    try {
      const out = require('child_process').execSync('chcp', { encoding: 'utf8' }).toString()
      const m = out.match(/(\d+)/)
      const cp = m ? Number(m[1]) : 936
      if (cp === 65001) _consoleEnc = 'utf8'
      else if (cp === 936) _consoleEnc = 'gbk'
      else if (cp === 950) _consoleEnc = 'big5'
      else _consoleEnc = 'cp' + cp
    } catch (e) {
      _consoleEnc = 'gbk' // 中文 Windows 默认
    }
  }
  return _consoleEnc
}

const MIN_LEVEL = (() => {
  const lv = String(process.env.WHALE_PET_LOG_LEVEL || '').toLowerCase()
  if (lv === 'debug' || process.env.WHALE_PET_TRACE === '1') return 'debug'
  if (lv === 'warn' || lv === 'error') return lv
  return 'info'
})()

let secretsCache = { at: 0, list: [] }
let resolvingSecrets = false
function secrets() {
  const now = Date.now()
  if (now - secretsCache.at < 60000) return secretsCache.list
  if (resolvingSecrets) return [] // 防止 getEffective→log→secrets 重入递归
  resolvingSecrets = true
  const list = []
  try {
    const c = cfg().getEffective()
    for (const v of [c.apiKey, c.platformToken, process.env.DEEPSEEK_API_KEY, process.env.DEEPSEEK_PLATFORM_TOKEN]) {
      if (typeof v === 'string' && v.trim()) list.push(v.trim())
    }
  } catch (err) { /* 读配置失败则本批不掩码 */ }
  resolvingSecrets = false
  secretsCache = { at: now, list }
  return list
}

function redact(text) {
  let s = String(text == null ? '' : text)
  for (const secret of secrets()) {
    if (secret && s.indexOf(secret) !== -1) s = s.split(secret).join('***')
  }
  return s
}

function write(level, msg) {
  if (LEVEL[level] < LEVEL[MIN_LEVEL]) return
  const line = new Date().toISOString() + ' [' + level + '] ' + redact(msg)
  try {
    const dir = cfg().CONFIG_DIR
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'pet.log')
    const old = path.join(dir, 'pet.log.1')
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        try { fs.unlinkSync(old) } catch (e) { /* 旧备份不存在 */ }
        try { fs.renameSync(file, old) } catch (e) { /* 轮转失败忽略 */ }
      }
    } catch (e) { /* 日志文件尚不存在 */ }
    fs.appendFileSync(file, line + '\n', { encoding: 'utf8' })
  } catch (e) { /* 写日志失败忽略 */ }
  try {
    const enc = consoleEnc()
    const ic = iconv()
    if (process.platform === 'win32' && enc !== 'utf8' && ic) {
      const buf = ic.encode(line + '\n', enc)
      if (level === 'warn' || level === 'error') process.stderr.write(buf)
      else process.stdout.write(buf)
    } else {
      console[CONSOLE_FN[level]](line)
    }
  } catch (e) { /* 终端不可用忽略 */ }
}

module.exports = {
  debug: (msg) => write('debug', msg),
  info: (msg) => write('info', msg),
  warn: (msg) => write('warn', msg),
  error: (msg) => write('error', msg),
}
