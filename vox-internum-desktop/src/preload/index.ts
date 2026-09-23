// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Preload (Context Bridge)
// ═══════════════════════════════════════════════════════════
// Exposes the Vox Internum API to the renderer via contextBridge.
// Renderer never gets direct ipcRenderer access — only the methods
// explicitly declared here (AGENTS.md §3.7).

import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import type {
  ServiceConfig,
  UnreadUpdate,
  LoadingUpdate,
  ProxyMap,
  SetProxyResult,
  McpApproveRequest,
  LicenseState,
  ActivateResult,
  ImapMailFull,
  ImapInboxPage,
  GmailSetupResult,
  GmailSendInput,
  GmailSendResult,
  UiTheme,
  UpdateInfo
} from '../shared/types'

const electronAPI = {
  // Raw ipcRenderer for ad-hoc main→renderer signals (e.g. Gmail modal)
  ipcRenderer: {
    on: (channel: string, cb: (...args: unknown[]) => void): void => {
      ipcRenderer.on(channel, (_e, ...args) => cb(...args))
    }
  },
  vox: {
    // Service registry / state
    getServices: (): Promise<ServiceConfig[]> => ipcRenderer.invoke(IPC_CHANNELS.VOX_GET_SERVICES),
    getActive: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.VOX_GET_ACTIVE),
    switch: (id: string): Promise<{ ok: boolean; active: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_SWITCH, id),

    // Push events from main process
    onSwitchRequest: (cb: (id: string) => void): (() => void) => {
      const handler = (_e: unknown, id: string): void => cb(id)
      ipcRenderer.on(IPC_CHANNELS.VOX_SWITCH_REQUEST, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOX_SWITCH_REQUEST, handler)
    },
    onUnread: (cb: (u: UnreadUpdate) => void): (() => void) => {
      const handler = (_e: unknown, u: UnreadUpdate): void => cb(u)
      ipcRenderer.on(IPC_CHANNELS.VOX_UNREAD_UPDATE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOX_UNREAD_UPDATE, handler)
    },
    onLoading: (cb: (l: LoadingUpdate) => void): (() => void) => {
      const handler = (_e: unknown, l: LoadingUpdate): void => cb(l)
      ipcRenderer.on(IPC_CHANNELS.VOX_LOADING_UPDATE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOX_LOADING_UPDATE, handler)
    },

    // Smart Proxy
    getProxies: (): Promise<ProxyMap> => ipcRenderer.invoke(IPC_CHANNELS.VOX_GET_PROXIES),
    setProxy: (serviceId: string, url: string): Promise<SetProxyResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_SET_PROXY, serviceId, url),
    applyAndReload: (serviceId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_APPLY_AND_RELOAD, serviceId),

    // View visibility (for HTML overlays)
    hideActiveView: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.VOX_HIDE_ACTIVE_VIEW),
    showActiveView: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.VOX_SHOW_ACTIVE_VIEW),

    // MCP HITL (Human-in-the-Loop) — approval prompts from the MCP server
    onApproveRequest: (cb: (req: McpApproveRequest) => void): (() => void) => {
      const handler = (_e: unknown, req: McpApproveRequest): void => cb(req)
      ipcRenderer.on(IPC_CHANNELS.VOX_MCP_APPROVE_REQUEST, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOX_MCP_APPROVE_REQUEST, handler)
    },
    approveResponse: (id: string, approved: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_MCP_APPROVE_RESPONSE, { id, approved }),

    // Licensing
    getLicenseState: (): Promise<LicenseState> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_LICENSE_GET_STATE),
    activateLicense: (key: string): Promise<ActivateResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_LICENSE_ACTIVATE, key),
    forgetLicense: (): Promise<LicenseState> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_LICENSE_FORGET),

    // Gmail IMAP
    gmailConfigured: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_GMAIL_CONFIGURED),
    gmailSetup: (email: string, appPassword: string): Promise<GmailSetupResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_GMAIL_SETUP, email, appPassword),
    gmailSignOut: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_GMAIL_SIGNOUT),
    gmailFetchInbox: (page?: number): Promise<ImapInboxPage> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_GMAIL_FETCH_INBOX, page),
    gmailFetchMessage: (seq: number): Promise<{ ok: boolean; msg?: ImapMailFull; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_GMAIL_FETCH_MESSAGE, seq),
    gmailSend: (input: GmailSendInput): Promise<GmailSendResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_GMAIL_SEND, input),

    // Open an external URL in the system browser. Goes through main:
    // `shell` is undefined in a sandboxed preload.
    openExternalLink: (url: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_OPEN_EXTERNAL, url),

    // Google cookie import (universal — any service with Google login)
    importGoogleCookies: (
      pairs: Array<{ name: string; value: string }>
    ): Promise<{ ok: boolean; set?: number; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_IMPORT_GOOGLE_COOKIES, pairs),

    onOpenCookieImport: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('vox:open-cookie-import', handler)
      return () => ipcRenderer.removeListener('vox:open-cookie-import', handler)
    },

    onCookieStatus: (cb: (msg: { ok: boolean; message: string }) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { ok: boolean; message: string }): void =>
        cb(payload)
      ipcRenderer.on('vox:cookie-status', handler)
      return () => ipcRenderer.removeListener('vox:cookie-status', handler)
    },

    // Auto-import: read cookies from user's Chrome directly
    autoImportChromeCookies: (): Promise<{ ok: boolean; set?: number; error?: string }> =>
      ipcRenderer.invoke('vox:auto-import-chrome-cookies'),

    // Normal Google login in a top-level window (same session as active tab)
    openGoogleSignInPopup: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('vox:open-google-signin-popup'),

    // Open real Chrome (temp profile + CDP) for Google login
    openChromeGoogleLogin: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('vox:open-chrome-google-login'),

    // Pull cookies from that Chrome via CDP (no F12, works with v20)
    pullChromeCdpCookies: (): Promise<{ ok: boolean; set?: number; error?: string }> =>
      ipcRenderer.invoke('vox:pull-chrome-cdp-cookies'),

    stopChromeGoogleLogin: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('vox:stop-chrome-google-login'),

    // Theme
    getTheme: (): Promise<UiTheme> => ipcRenderer.invoke(IPC_CHANNELS.VOX_GET_THEME),
    setTheme: (theme: UiTheme): Promise<{ ok: boolean; theme: UiTheme }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_SET_THEME, theme),

    // Updates
    checkUpdate: (): Promise<UpdateInfo> => ipcRenderer.invoke(IPC_CHANNELS.VOX_CHECK_UPDATE),
    dismissUpdate: (version: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_DISMISS_UPDATE, version),
    openUpdate: (url: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_OPEN_UPDATE, url),
    installUpdate: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC_CHANNELS.VOX_INSTALL_UPDATE),
    onUpdateAvailable: (cb: (info: UpdateInfo) => void): (() => void) => {
      const handler = (_e: unknown, info: UpdateInfo): void => cb(info)
      ipcRenderer.on(IPC_CHANNELS.VOX_UPDATE_AVAILABLE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOX_UPDATE_AVAILABLE, handler)
    }
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electronAPI', electronAPI)
} else {
  ;(globalThis as unknown as { electronAPI: typeof electronAPI }).electronAPI = electronAPI
}

export type ElectronAPI = typeof electronAPI
