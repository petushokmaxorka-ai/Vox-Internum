// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Shared Types & IPC Channels
// ═══════════════════════════════════════════════════════════
// Single source of truth for IPC channel names + data shapes.
// Mirrors the void-shield-desktop pattern: no inline channel strings.

/** IPC channel names — never inline strings. */
export const IPC_CHANNELS = {
  // Service registry / state
  VOX_GET_SERVICES: 'vox:get-services',
  VOX_GET_ACTIVE: 'vox:get-active',
  VOX_SWITCH: 'vox:switch',
  // Main asks the renderer to switch (tray menu, restored last service)
  // so the sidebar / native panels stay in sync (main -> renderer push)
  VOX_SWITCH_REQUEST: 'vox:switch-request',
  // Unread badge (main -> renderer push)
  VOX_UNREAD_UPDATE: 'vox:unread-update',
  // Loading state (main -> renderer push)
  VOX_LOADING_UPDATE: 'vox:loading-update',
  // Smart Proxy (per-service routing)
  VOX_GET_PROXIES: 'vox:get-proxies',
  VOX_SET_PROXY: 'vox:set-proxy',
  VOX_APPLY_AND_RELOAD: 'vox:apply-and-reload',
  // View visibility (so HTML overlays can be shown above the view)
  VOX_HIDE_ACTIVE_VIEW: 'vox:hide-active-view',
  VOX_SHOW_ACTIVE_VIEW: 'vox:show-active-view',
  // MCP HITL: server asks user to approve an outbound action
  VOX_MCP_APPROVE_REQUEST: 'vox:mcp-approve-request',
  // MCP HITL: user responds (renderer -> main)
  VOX_MCP_APPROVE_RESPONSE: 'vox:mcp-approve-response',
  // Licensing
  VOX_LICENSE_GET_STATE: 'vox:license-get-state',
  VOX_LICENSE_ACTIVATE: 'vox:license-activate',
  VOX_LICENSE_FORGET: 'vox:license-forget',
  // Gmail IMAP
  VOX_GMAIL_CONFIGURED: 'vox:gmail-configured',
  VOX_GMAIL_SETUP: 'vox:gmail-setup',
  VOX_GMAIL_SIGNOUT: 'vox:gmail-signout',
  VOX_GMAIL_FETCH_INBOX: 'vox:gmail-fetch-inbox',
  VOX_GMAIL_FETCH_MESSAGE: 'vox:gmail-fetch-message',
  VOX_GMAIL_SEND: 'vox:gmail-send',
  // Universal Google cookie import (bypasses Google OAuth block)
  VOX_IMPORT_GOOGLE_COOKIES: 'vox:import-google-cookies',
  // Open an http(s) link in the system browser (renderer -> main;
  // `shell` is not available in the sandboxed preload)
  VOX_OPEN_EXTERNAL: 'vox:open-external',
  // Chrome / appearance
  VOX_GET_THEME: 'vox:get-theme',
  VOX_SET_THEME: 'vox:set-theme',
  // Update check (GitHub Releases)
  VOX_CHECK_UPDATE: 'vox:check-update',
  VOX_DISMISS_UPDATE: 'vox:dismiss-update',
  VOX_OPEN_UPDATE: 'vox:open-update',
  VOX_INSTALL_UPDATE: 'vox:install-update',
  VOX_UPDATE_AVAILABLE: 'vox:update-available'
} as const

export type UiTheme = 'dark' | 'light'

export interface UpdateInfo {
  available: boolean
  /**
   * True when electron-updater has already downloaded the new version
   * and the banner's action button should RESTART & INSTALL instead of
   * opening the release page (Tier 1 auto-update).
   */
  readyToInstall?: boolean
  currentVersion: string
  latestVersion: string
  releaseUrl: string
  releaseName: string
  body: string
}

// ─── Service registry ────────────────────────────────────────

export interface ServiceConfig {
  /** Stable id, used in partition name: persist:vox-internum-<id> */
  id: string
  /** Short label for sidebar icon (TG / VK / MX) */
  label: string
  /** Full display name */
  name: string
  /** Web URL loaded into the WebContentsView (empty for native services) */
  url: string
  /** Sidebar grouping: messengers vs mail relays. */
  category: 'messenger' | 'mail' | 'ai'
  /**
   * 'web' (default) renders the URL in a WebContentsView. 'native'
   * means the renderer owns the UI (e.g. Gmail IMAP). 'external'
   * opens the URL in the system browser (escape hatch only).
   */
  kind?: 'web' | 'native' | 'external'
}

// ─── Runtime shapes ──────────────────────────────────────────

export interface UnreadUpdate {
  service: string
  /** Parsed unread count, or 0 if none */
  count: number
}

export interface LoadingUpdate {
  service: string
  loading: boolean
}

// ─── Smart Proxy (per-service routing) ──────────────────────

/**
 * A proxy configuration for one service.
 * Empty `url` means DIRECT (no proxy) — used by default for VK/MAX.
 * Format for `url`: `socks5://[user:pass@]host:port` or `http://...`.
 */
export interface ProxyConfig {
  /** Service id this proxy applies to (telegram / vk / max / ...). */
  service: string
  /** Raw proxy URL, or '' for direct connection. */
  url: string
}

/** Map of serviceId -> ProxyConfig, returned to renderer. */
export type ProxyMap = Record<string, ProxyConfig>

export interface SetProxyResult {
  ok: boolean
  /** Parsed/normalized proxy URL actually applied, or '' for direct. */
  applied: string
  error?: string
}

// ─── MCP HITL (Human-in-the-Loop) ───────────────────────────
// When an LLM client invokes a write tool (e.g. send_message), the
// MCP server does not act autonomously: it asks the human to approve
// via the renderer. The request carries a unique id; the response
// references the same id.

export interface McpApproveRequest {
  /** Unique id; the renderer's response must echo it. */
  id: string
  /** Short verb describing the action: "SEND_MESSAGE". */
  action: string
  /** Target service id ("telegram"). */
  service: string
  /** Human-readable summary of the payload. */
  summary: string
}

export interface McpApproveResponse {
  id: string
  approved: boolean
}

// ─── Licensing ──────────────────────────────────────────────

export type LicenseTier = 'trial' | 'licensed' | 'expired' | 'revoked' | 'unlicensed'

export interface LicenseState {
  tier: LicenseTier
  /** Epoch ms when current validity ends (trial or license). 0 if none. */
  expiresAt: number
  /** Last 4 chars of the key, for UI display. Empty for trial. */
  keyTail: string
  /** Human-readable status line for the badge. */
  statusText: string
}

export interface ActivateResult {
  ok: boolean
  state?: LicenseState
  error?: string
}

// ─── Gmail IMAP ─────────────────────────────────────────────

/** Lightweight envelope for the inbox list. */
export interface ImapMailSummary {
  seq: number
  date: string
  subject: string
  from: string
  to: string
  recent: boolean
}

/** Inbox fetch result with paging metadata. */
export interface ImapInboxPage {
  ok: boolean
  list: ImapMailSummary[]
  page: number
  total: number
  totalPages: number
  error?: string
}

/** Full parsed message for the reading pane. */
export interface ImapMailFull {
  seq: number
  text: string
  html: string
  attachments: Array<{ filename: string; type: string; size: number }>
}

export interface GmailSetupResult {
  ok: boolean
  error?: string
}

export interface GmailSendInput {
  to: string
  subject: string
  text: string
  inReplyTo?: string
}

export interface GmailSendResult {
  ok: boolean
  message?: string
}
