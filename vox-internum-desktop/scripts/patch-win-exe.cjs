#!/usr/bin/env node
/**
 * Patch Windows .exe PE version resources without Wine/rcedit.
 * electron-builder's signAndEditExecutable needs Wine on Linux hosts;
 * that path is broken here, so we stamp ProductName / FileDescription
 * with the pure-JS `resedit` library after packaging.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const ResEdit = require('resedit')

const PRODUCT = 'Vox Internum'
const COMPANY = 'Heretic OS'
const COPYRIGHT = `Copyright © ${new Date().getFullYear()} Heretic OS`

function parseVersion(version) {
  const parts = String(version)
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  while (parts.length < 4) parts.push(0)
  return parts.slice(0, 4)
}

function patchExe(exePath, version) {
  const [maj, min, pat, build] = parseVersion(version)
  const data = fs.readFileSync(exePath)
  const exe = ResEdit.NtExecutable.from(data, { ignoreCert: true })
  const res = ResEdit.NtExecutableResource.from(exe)
  const versionInfoList = ResEdit.Resource.VersionInfo.fromEntries(res.entries)

  const vi = versionInfoList[0] || ResEdit.Resource.VersionInfo.createEmpty()
  if (!versionInfoList[0]) {
    vi.lang = 0x0409
  }

  vi.setFileVersion(maj, min, pat, build, vi.lang)
  vi.setProductVersion(maj, min, pat, build, vi.lang)

  const langs = vi.getAvailableLanguages()
  const lang =
    langs.find((l) => l.lang === 0x0409) ||
    langs[0] ||
    { lang: 0x0409, codepage: 1200 }

  vi.setStringValues(lang, {
    FileDescription: PRODUCT,
    ProductName: PRODUCT,
    CompanyName: COMPANY,
    LegalCopyright: COPYRIGHT,
    InternalName: PRODUCT,
    OriginalFilename: path.basename(exePath),
    FileVersion: `${maj}.${min}.${pat}.${build}`,
    ProductVersion: `${maj}.${min}.${pat}.${build}`
  })

  vi.outputToResourceEntries(res.entries)
  res.outputResource(exe)
  fs.writeFileSync(exePath, Buffer.from(exe.generate()))
  console.log(`[patch-win-exe] stamped ${exePath} → ${PRODUCT} ${maj}.${min}.${pat}.${build}`)
}

/** electron-builder afterPack hook */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const pack = context.packager.appInfo
  const version = pack.version || require('../package.json').version
  const exeName = `${pack.productFilename || 'Vox Internum'}.exe`
  const exePath = path.join(context.appOutDir, exeName)
  if (!fs.existsSync(exePath)) {
    console.warn(`[patch-win-exe] missing ${exePath}`)
    return
  }
  patchExe(exePath, version)

  const ico = path.join(context.outDir, '.icon-ico', 'icon.ico')
  if (fs.existsSync(ico)) {
    try {
      const data = fs.readFileSync(exePath)
      const exe = ResEdit.NtExecutable.from(data, { ignoreCert: true })
      const res = ResEdit.NtExecutableResource.from(exe)
      const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ico))
      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
        res.entries,
        1,
        0x0409,
        iconFile.icons.map((item) => item.data)
      )
      res.outputResource(exe)
      fs.writeFileSync(exePath, Buffer.from(exe.generate()))
      console.log(`[patch-win-exe] icon applied from ${ico}`)
    } catch (err) {
      console.warn('[patch-win-exe] icon patch skipped:', err.message)
    }
  }
}

if (require.main === module) {
  const exePath = process.argv[2]
  const version = process.argv[3] || require('../package.json').version
  if (!exePath) {
    console.error('usage: node scripts/patch-win-exe.cjs <path-to-exe> [version]')
    process.exit(1)
  }
  patchExe(exePath, version)
}
