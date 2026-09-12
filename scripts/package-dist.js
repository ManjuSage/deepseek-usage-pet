'use strict'
// 打包后整理产物：
//   - 安装包（含 blockmap）→ dist/installer/
//   - 便携版单文件 exe + win-unpacked → dist/portable/
//   - 并把单文件便携版压成 Release 使用的 zip
const fs = require('fs')
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
  const dst = path.join(dstDir, path.basename(src))
  fs.rmSync(dst, { recursive: true, force: true })
  fs.renameSync(src, dst)
}

function zipFile(srcFile, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true })
  fs.rmSync(zipPath, { force: true })
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -LiteralPath "${srcFile}" -DestinationPath "${zipPath}" -CompressionLevel Optimal`], { stdio: 'inherit' })
  } else {
    execFileSync('zip', ['-j', zipPath, srcFile], { stdio: 'inherit' })
  }
}

const installerDir = path.join(DIST, 'installer')
const portableDir = path.join(DIST, 'portable')

moveIfExists(path.join(DIST, `${productName}-Setup-${version}-x64.exe`), installerDir)
moveIfExists(path.join(DIST, `${productName}-Setup-${version}-x64.exe.blockmap`), installerDir)
const portableExeName = `${productName}-${version}-x64.exe`
moveIfExists(path.join(DIST, portableExeName), portableDir)
moveIfExists(path.join(DIST, 'win-unpacked'), portableDir)

const portableExe = path.join(portableDir, portableExeName)
if (fs.existsSync(portableExe)) {
  zipFile(portableExe, path.join(portableDir, `${productName}-${version}-portable.zip`))
}

console.log('打包产物已整理：dist/installer/ 与 dist/portable/')
