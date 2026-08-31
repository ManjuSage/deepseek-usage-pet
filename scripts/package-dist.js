'use strict'
// 打包后整理产物：
//   - 安装包（含 blockmap）→ dist/installer/
//   - 便携版单文件 exe + win-unpacked → dist/portable/
//   - 并生成「解压即用」的便携版 zip（顶层为产品名文件夹）
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const productName = pkg.productName || pkg.name
const version = pkg.version

function moveIfExists(src, dstDir) {
  if (!fs.existsSync(src)) return
  fs.mkdirSync(dstDir, { recursive: true })
  fs.renameSync(src, path.join(dstDir, path.basename(src)))
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

function zipDir(srcDir, zipPath, topName) {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-dist-'))
  const staged = path.join(stageRoot, topName)
  copyDir(srcDir, staged)
  fs.mkdirSync(path.dirname(zipPath), { recursive: true })
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path "${staged}" -DestinationPath "${zipPath}" -CompressionLevel Optimal`], { stdio: 'inherit' })
  } else {
    execFileSync('zip', ['-r', zipPath, topName], { cwd: stageRoot, stdio: 'inherit' })
  }
  fs.rmSync(stageRoot, { recursive: true, force: true })
}

const installerDir = path.join(DIST, 'installer')
const portableDir = path.join(DIST, 'portable')

moveIfExists(path.join(DIST, `${productName}-Setup-${version}-x64.exe`), installerDir)
moveIfExists(path.join(DIST, `${productName}-Setup-${version}-x64.exe.blockmap`), installerDir)
moveIfExists(path.join(DIST, `${productName}-${version}-x64.exe`), portableDir)
moveIfExists(path.join(DIST, 'win-unpacked'), portableDir)

const unpacked = path.join(portableDir, 'win-unpacked')
if (fs.existsSync(unpacked)) {
  zipDir(unpacked, path.join(portableDir, `${productName}-${version}-portable.zip`), productName)
}

console.log('打包产物已整理：dist/installer/ 与 dist/portable/')
