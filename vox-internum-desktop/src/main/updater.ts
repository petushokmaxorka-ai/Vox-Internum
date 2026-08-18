// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Auto-Update (electron-updater + GitHub banner)
// ═══════════════════════════════════════════════════════════
// Two-tier update system:
//
//   TIER 1 — electron-updater (auto download + install):
//     AppImage on Linux, NSIS install on Windows. Reads the publish
//     config baked into app-update.yml by electron-builder, checks
//     GitHub Releases for latest.yml / latest-linux.yml, downloads
//     the new version in the background, then shows a RESTART banner.
//     autoInstallOnAppQuit means the update applies even if the user
//     just closes the app.
//
//   TIER 2 — GitHub banner (fallback):
//     Everything electron-updater cannot handle: tar.gz on Linux,
//     portable exe / zip on Windows, unsigned macOS, dev builds.
//     Polls the public GitHub Releases API for tags matching v<semver>
//     in the distribution repo (petushokmaxorka-ai/vox-internum),
//     shows a banner, opens the release page in the system browser.
//     No auth required for public repos.
//
// AGENTS.md §3.1: all fetches go to api.github.com / github.com over
// the user's network (may use system proxy). Failures are silent
// (offline / rate-limit).

import { app, shell, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC_CHANNELS } from '../shared/types'
import type { UpdateInfo } from '../shared/types'
import { getDismissedUpdateVersion, setDismissedUpdateVersion } from './storage'

const GH_REPO = 'petushokmaxorka-ai/vox-internum'
const GH_API = `https://api.github.com/repos/${GH_REPO}/releases?per_page=15`
const TAG_RE = /^v(\d+\.\d+\.\d+)$/i

function parseSemver(v: string): [number, number, number] | null {
  const m = v.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** True if `a` is strictly newer than `b`. */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true
    if (pa[i] < pb[i]) return false
  }
  return false
}

// ─── Tier 1: electron-updater ───────────────────────────────

/**
 * electron-updater only works for targets it can replace on disk:
 *   Linux   → AppImage (APPIMAGE env points at the running file)
 *   Windows → NSIS install (portable exe sets PORTABLE_EXECUTABLE_DIR,
 *             which marks it as NOT auto-updatable)
 *   macOS   → requires signed builds; we ship unsigned, so never
 * Dev builds and unpacked runs are excluded by isPackaged.
 */
export function canAutoUpdate(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'linux') return Boolean(process.env['APPIMAGE'])
  if (process.platform === 'win32') return !process.env['PORTABLE_EXECUTABLE_DIR']
  return false
}

/** Restart the app into a downloaded update (RESTART & UPDATE button). */
export function installUpdate(): void {
  if (!canAutoUpdate()) return
  autoUpdater.quitAndInstall()
}

function wireAutoUpdater(getWindow: () => BrowserWindow | null): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  // Quiet: no electron-log dependency, failures fall through to
  // the Tier-2 banner on the next scheduled check.
  autoUpdater.logger = null

  autoUpdater.on('update-downloaded', (info) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    const payload: UpdateInfo = {
      available: true,
      readyToInstall: true,
      currentVersion: app.getVersion(),
      latestVersion: info.version || app.getVersion(),
      releaseUrl: '',
      releaseName: 'UPDATE DOWNLOADED',
      body: ''
    }
    win.webContents.send(IPC_CHANNELS.VOX_UPDATE_AVAILABLE, payload)
  })
}

// ─── Tier 2: GitHub Releases banner ─────────────────────────

interface GhRelease {
  tag_name?: string
  name?: string
  html_url?: string
  body?: string
  draft?: boolean
  prerelease?: boolean
}

async function fetchLatestVoxRelease(): Promise<{
  version: string
  url: string
  name: string
  body: string
} | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 12000)
  try {
    const res = await fetch(GH_API, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Vox-Internum-Desktop'
      }
    })
    if (!res.ok) return null
    const list = (await res.json()) as GhRelease[]
    if (!Array.isArray(list)) return null
    for (const rel of list) {
      if (rel.draft || rel.prerelease) continue
      const tag = rel.tag_name || ''
      const m = tag.match(TAG_RE)
      if (!m) continue
      return {
        version: m[1],
        url: rel.html_url || `https://github.com/${GH_REPO}/releases/tag/${tag}`,
        name: rel.name || tag,
        body: (rel.body || '').slice(0, 2000)
      }
    }
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
  return null
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const currentVersion = app.getVersion()
  const latest = await fetchLatestVoxRelease()
  if (!latest) {
    return {
      available: false,
      currentVersion,
      latestVersion: currentVersion,
      releaseUrl: '',
      releaseName: '',
      body: ''
    }
  }
  const dismissed = getDismissedUpdateVersion()
  const newer = isNewerVersion(latest.version, currentVersion)
  const notDismissed = dismissed !== latest.version
  return {
    available: newer && notDismissed,
    currentVersion,
    latestVersion: latest.version,
    releaseUrl: latest.url,
    releaseName: latest.name,
    body: latest.body
  }
}

export function dismissUpdate(version: string): void {
  setDismissedUpdateVersion(version)
}

export async function openUpdatePage(url: string): Promise<void> {
  if (!url) return
  await shell.openExternal(url)
}

/** Fire-and-forget: check a few seconds after launch, push to renderer. */
export function scheduleUpdateCheck(getWindow: () => BrowserWindow | null): void {
  const run = async (): Promise<void> => {
    try {
      if (canAutoUpdate()) {
        // Tier 1: check + background download. Banner fires from the
        // 'update-downloaded' handler above.
        await autoUpdater.checkForUpdates()
        return
      }
      // Tier 2: banner with a link to the release page.
      const info = await checkForUpdate()
      if (!info.available) return
      const win = getWindow()
      if (!win || win.isDestroyed()) return
      win.webContents.send(IPC_CHANNELS.VOX_UPDATE_AVAILABLE, info)
    } catch {
      /* offline / rate-limit — ignore */
    }
  }

  if (canAutoUpdate()) {
    wireAutoUpdater(getWindow)
  }
  setTimeout(() => void run(), 8000)
  // Re-check every 12h while running.
  setInterval(() => void run(), 12 * 60 * 60 * 1000)
}
