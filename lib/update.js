'use strict'
// ---------------------------------------------------------------------------
// 检查更新：从 GitHub Releases 拉取最新版本，与当前版本做语义化比较。
// 仓库：ManjuSage/deepseek-usage-pet（package.json 的 repository）
// ---------------------------------------------------------------------------
const REPO = 'ManjuSage/deepseek-usage-pet'
const LATEST_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest'
const TIMEOUT_MS = 10000

// 解析 x.y.z（可带 v 前缀），返回 [major, minor, patch]；非法返回 null
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

// a > b → 1；a < b → -1；相等/无法比较 → 0
function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

async function checkForUpdate(currentVersion) {
  try {
    const res = await fetch(LATEST_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'deepseek-usage-pet',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status }
    const data = await res.json()
    const tag = String((data && data.tag_name) || '').trim()
    const latest = tag.replace(/^v/, '')
    const url = String((data && data.html_url) || '')
    const hasUpdate = compareVersions(latest, currentVersion) > 0
    return { ok: true, current: currentVersion, latest, hasUpdate, url }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

module.exports = { checkForUpdate, parseVersion, compareVersions }
