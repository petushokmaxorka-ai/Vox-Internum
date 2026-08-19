// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Per-view Context Menu
// ═══════════════════════════════════════════════════════════
// Right-click: Copy / Paste / Select All (explicit clipboard — role:'copy'
// is unreliable inside WebContentsView), navigation, Google Sign-in,
// Pull cookies from real Chrome (CDP), Sign out.

import { Menu, clipboard, dialog, type BrowserWindow, type WebContentsView } from 'electron'

interface MenuDeps {
  getActiveService: () => string
  getActiveView: () => WebContentsView | null
  signOut: (serviceId: string) => Promise<void>
  openCookieImport?: () => void
  /** Start/pull Google login via real Chrome CDP (no F12 / no keyring). */
  pullChromeGoogle?: () => Promise<void>
}

export function attachContextMenu(wc: Electron.WebContents, win: BrowserWindow, deps: MenuDeps): void {
  wc.on('context-menu', (_event, params) => {
    showMenu(win, params, deps)
  })
}

function showMenu(
  win: BrowserWindow,
  params: Electron.ContextMenuParams,
  deps: MenuDeps
): void {
  const activeService = deps.getActiveService()
  const editable = params.isEditable
  const selection = (params.selectionText || '').trim()
  const hasSelection = selection.length > 0

  const template: Electron.MenuItemConstructorOptions[] = []

  // Always expose Copy when there is a selection (explicit clipboard write).
  template.push({
    label: '◆ Copy',
    accelerator: 'CmdOrCtrl+C',
    enabled: hasSelection,
    click: (): void => {
      if (selection) clipboard.writeText(selection)
    }
  })

  if (editable) {
    template.push({
      label: '✂ Cut',
      enabled: hasSelection,
      click: (): void => {
        if (!selection) return
        clipboard.writeText(selection)
        const view = deps.getActiveView()
        view?.webContents.delete()
      }
    })
    template.push({
      label: '➜ Paste',
      accelerator: 'CmdOrCtrl+V',
      enabled: params.editFlags.canPaste !== false,
      click: (): void => {
        const text = clipboard.readText()
        if (!text) return
        deps.getActiveView()?.webContents.insertText(text)
      }
    })
    template.push({
      label: '⚙ Select All',
      click: (): void => {
        deps.getActiveView()?.webContents.selectAll()
      }
    })
  } else {
    template.push({
      label: '➜ Paste',
      enabled: false
    })
  }

  template.push({ type: 'separator' })

  const activeWc = deps.getActiveView()?.webContents
  template.push({
    label: '◄ Back',
    enabled: activeWc ? activeWc.canGoBack() : false,
    click: () => {
      const w = deps.getActiveView()?.webContents
      if (w?.canGoBack()) w.goBack()
    }
  })
  template.push({
    label: '► Forward',
    enabled: activeWc ? activeWc.canGoForward() : false,
    click: () => {
      const w = deps.getActiveView()?.webContents
      if (w?.canGoForward()) w.goForward()
    }
  })
  template.push({
    label: '↻ Reload',
    click: () => {
      deps.getActiveView()?.webContents.reload()
    }
  })

  if (activeService) {
    template.push({ type: 'separator' })
    if (deps.openCookieImport) {
      template.push({
        label: '◆ Sign-in / cookies…',
        click: (): void => {
          deps.openCookieImport?.()
        }
      })
    }
    if (deps.pullChromeGoogle) {
      template.push({
        label: '⚡ Pull Google from Chrome',
        click: (): void => {
          void deps.pullChromeGoogle?.()
        }
      })
    }
    template.push({
      label: '✗ Sign out (clear session)',
      click: () => {
        const choice = dialog.showMessageBoxSync(win, {
          type: 'warning',
          title: 'Sign out',
          message: `Sign out of ${activeService}?`,
          detail:
            'This clears all cookies, cache and login state for this service in Vox Internum. The web page will reload to its login screen. This cannot be undone.',
          buttons: ['Sign out', 'Cancel'],
          defaultId: 1,
          cancelId: 1
        })
        if (choice === 0) {
          void deps.signOut(activeService)
        }
      }
    })
  }

  const menu = Menu.buildFromTemplate(template)
  menu.popup({ window: win })
}
