// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Per-view Context Menu
// ═══════════════════════════════════════════════════════════
// Right-click in any messenger view shows this menu. Provides the
// "default browser" affordances (copy/cut/paste/select-all) that
// Electron turns off by default, plus app-specific actions:
//   - Back / Forward / Reload (navigation within the SPA)
//   - Sign out: clears the service's session partition and reloads
//     the login page. Useful when selling the machine or switching
//     accounts.

import { Menu, dialog, type BrowserWindow, type WebContentsView } from 'electron'

interface MenuDeps {
  /** Resolve the currently-active service id. */
  getActiveService: () => string
  /** Resolve the currently-visible WebContentsView. */
  getActiveView: () => WebContentsView | null
  /** Clear the session partition for a service + reload to login. */
  signOut: (serviceId: string) => Promise<void>
}

/**
 * Attach a context-menu handler to a WebContentsView. Call this for
 * every view that ViewManager creates. The handler resolves the
 * active view through deps.getActiveView() so the menu always acts
 * on what's currently visible.
 */
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
  const hasSelection = params.selectionText && params.selectionText.length > 0

  const template: Electron.MenuItemConstructorOptions[] = []

  // Editing actions (only when an input/textarea/contenteditable is focused)
  if (editable) {
    if (hasSelection) {
      template.push({ label: '✂ Cut', role: 'cut' })
    }
    template.push({ label: '◆ Copy', role: 'copy' })
    template.push({
      label: '➜ Paste',
      role: 'paste',
      enabled: params.editFlags.canPaste !== false
    })
    template.push({ label: '⚙ Select All', role: 'selectAll' })
    template.push({ type: 'separator' })
  } else if (hasSelection) {
    template.push({ label: '◆ Copy', role: 'copy' })
    template.push({ type: 'separator' })
  }

  // Navigation. In Electron 30, go-back/go-forward live on webContents
  // itself (navigationHistory exposes only getActiveIndex/length).
  const activeWc = deps.getActiveView()?.webContents
  template.push({
    label: '◄ Back',
    enabled: activeWc ? activeWc.canGoBack() : false,
    click: () => {
      const wc = deps.getActiveView()?.webContents
      if (wc?.canGoBack()) wc.goBack()
    }
  })
  template.push({
    label: '► Forward',
    enabled: activeWc ? activeWc.canGoForward() : false,
    click: () => {
      const wc = deps.getActiveView()?.webContents
      if (wc?.canGoForward()) wc.goForward()
    }
  })
  template.push({
    label: '↻ Reload',
    click: () => {
      deps.getActiveView()?.webContents.reload()
    }
  })

  // Sign out — only meaningful if we know which service this view is.
  if (activeService) {
    template.push({ type: 'separator' })
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
