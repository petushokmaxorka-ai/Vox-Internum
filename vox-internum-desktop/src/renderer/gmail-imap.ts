// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Gmail IMAP Native Panel
// ═══════════════════════════════════════════════════════════
// Renderer-side logic for the Gmail IMAP panel. Shown when 'gmail'
// is the active service (the main process hides all WebContentsViews
// so this HTML is visible). Three sub-views: setup form / inbox
// list / reading pane.

import type { ImapMailSummary, ImapMailFull } from '../shared/types'

const api = window.electronAPI.vox

let currentInbox: ImapMailSummary[] = []
let currentPage = 1
let totalPages = 1

/** Show the Gmail panel (called when user switches to 'gmail'). */
export async function showGmailPanel(): Promise<void> {
  const panel = document.getElementById('gmail-panel')
  panel?.classList.remove('hidden')
  const configured = await api.gmailConfigured()
  if (configured) {
    currentPage = 1
    await showInbox()
  } else {
    showSetup()
  }
}

/** Hide the Gmail panel (called when user switches away). */
export function hideGmailPanel(): void {
  document.getElementById('gmail-panel')?.classList.add('hidden')
}

function showSetup(): void {
  document.getElementById('gmail-setup')?.classList.remove('hidden')
  document.getElementById('gmail-inbox')?.classList.add('hidden')
  document.getElementById('gmail-read')?.classList.add('hidden')
}

async function showInbox(): Promise<void> {
  document.getElementById('gmail-setup')?.classList.add('hidden')
  document.getElementById('gmail-read')?.classList.add('hidden')
  document.getElementById('gmail-inbox')?.classList.remove('hidden')
  await refreshInbox()
}

async function refreshInbox(): Promise<void> {
  const listEl = document.getElementById('gmail-list')
  if (listEl) listEl.innerHTML = '<div class="gmail-row" style="color:var(--dm-muted)">◆ FETCHING…</div>'
  updatePager()
  const res = await api.gmailFetchInbox(currentPage)
  if (!listEl) return
  if (!res.ok || !res.list) {
    listEl.innerHTML = `<div class="gmail-row" style="color:var(--dm-red-text)">✗ ${res.error || 'FETCH FAILED'}</div>`
    return
  }
  currentInbox = res.list
  totalPages = res.totalPages || 1
  updatePager()
  if (res.list.length === 0) {
    listEl.innerHTML = '<div class="gmail-row" style="color:var(--dm-muted)">◆ INBOX EMPTY</div>'
    return
  }
  listEl.innerHTML = res.list
    .map(
      (m) => `<div class="gmail-row ${m.recent ? 'recent' : ''}" data-seq="${m.seq}">
        <span class="from">${escapeHtml(m.from || '?')}</span>
        <span class="subject">${escapeHtml(m.subject || '(no subject)')}</span>
        <span class="date">${escapeHtml(formatDate(m.date))}</span>
      </div>`
    )
    .join('')
  listEl.querySelectorAll('.gmail-row[data-seq]').forEach((row) => {
    row.addEventListener('click', () => {
      const seq = parseInt((row as HTMLElement).dataset.seq || '0', 10)
      if (seq) void openMessage(seq)
    })
  })
}

function updatePager(): void {
  const pager = document.getElementById('gmail-pager')
  if (!pager) return
  pager.textContent = `PAGE ${currentPage} / ${Math.max(1, totalPages)}`
  const prev = document.getElementById('gmail-prev')
  const next = document.getElementById('gmail-next')
  if (prev) prev.classList.toggle('disabled', currentPage <= 1)
  if (next) next.classList.toggle('disabled', currentPage >= totalPages)
}

async function openMessage(seq: number): Promise<void> {
  replyToSeq = seq
  document.getElementById('gmail-inbox')?.classList.add('hidden')
  document.getElementById('gmail-read')?.classList.remove('hidden')
  const bodyEl = document.getElementById('gmail-read-body')
  const subjEl = document.getElementById('gmail-read-subject')
  if (bodyEl) bodyEl.textContent = '◆ LOADING…'
  const env = currentInbox.find((m) => m.seq === seq)
  if (subjEl) subjEl.textContent = env?.subject || ''
  const res = await api.gmailFetchMessage(seq)
  if (!bodyEl) return
  if (!res.ok || !res.msg) {
    bodyEl.textContent = '✗ ' + (res.error || 'FETCH FAILED')
    return
  }
  // Prefer plain text; fall back to de-tagged HTML.
  const m: ImapMailFull = res.msg
  bodyEl.textContent = m.text || stripHtml(m.html) || '(empty body)'
  if (m.attachments.length > 0) {
    const atts = m.attachments.map((a) => `${a.filename} (${a.type}, ${formatBytes(a.size)})`).join('\n')
    bodyEl.textContent += `\n\n── ATTACHMENTS ──\n${atts}`
  }
}

// ─── Wiring ─────────────────────────────────────────────────

export function wireGmailPanel(): void {
  document.getElementById('gmail-connect')?.addEventListener('click', onConnect)
  document.getElementById('gmail-refresh')?.addEventListener('click', () => {
    currentPage = 1
    void refreshInbox()
  })
  document.getElementById('gmail-signout')?.addEventListener('click', onSignOut)
  document.getElementById('gmail-back')?.addEventListener('click', () => {
    document.getElementById('gmail-read')?.classList.add('hidden')
    document.getElementById('gmail-inbox')?.classList.remove('hidden')
  })
  document.getElementById('gmail-prev')?.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--
      void refreshInbox()
    }
  })
  document.getElementById('gmail-next')?.addEventListener('click', () => {
    if (currentPage < totalPages) {
      currentPage++
      void refreshInbox()
    }
  })
  // Compose / Reply / Send
  document.getElementById('gmail-compose-new')?.addEventListener('click', () => openCompose())
  document.getElementById('gmail-reply')?.addEventListener('click', () => openReply())
  document.getElementById('gmail-compose-back')?.addEventListener('click', () => {
    document.getElementById('gmail-compose')?.classList.add('hidden')
    document.getElementById('gmail-inbox')?.classList.remove('hidden')
  })
  document.getElementById('gmail-send')?.addEventListener('click', onSend)
  // External links → system browser
  document.getElementById('gmail-link-2fa')?.addEventListener('click', (e) => {
    e.preventDefault()
    void window.electronAPI.vox.openExternalLink('https://myaccount.google.com/security')
  })
  document.getElementById('gmail-link-apppass')?.addEventListener('click', (e) => {
    e.preventDefault()
    void window.electronAPI.vox.openExternalLink('https://myaccount.google.com/apppasswords')
  })
  // Right-click context menu for the Gmail panel — copy/cut/paste/
  // select-all. Electron doesn't show one on native HTML by default.
  const panel = document.getElementById('gmail-panel')
  panel?.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    showPanelContextMenu(e)
  })
}

/** Minimal in-page context menu for the Gmail panel. */
function showPanelContextMenu(e: MouseEvent): void {
  // Remove any existing menu first.
  document.getElementById('vox-context-menu')?.remove()
  const sel = window.getSelection?.() ?? null
  const hasSelection = !!sel && sel.toString().length > 0
  const target = e.target as HTMLElement
  const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'

  const items: Array<{ label: string; action: () => void; disabled?: boolean }> = []
  if (inInput && hasSelection) items.push({ label: '✂ Cut', action: () => document.execCommand('cut') })
  if (hasSelection) items.push({ label: '◆ Copy', action: () => document.execCommand('copy') })
  if (inInput) items.push({ label: '➜ Paste', action: () => document.execCommand('paste') })
  items.push({ label: '⚙ Select All', action: () => document.execCommand('selectAll') })

  const menu = document.createElement('div')
  menu.id = 'vox-context-menu'
  menu.className = 'vox-context-menu'
  for (const it of items) {
    const btn = document.createElement('div')
    btn.className = 'vox-context-item'
    btn.textContent = it.label
    if (it.disabled) btn.classList.add('disabled')
    btn.addEventListener('click', () => {
      it.action()
      menu.remove()
    })
    menu.appendChild(btn)
  }
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 160)}px`
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - 140)}px`
  document.body.appendChild(menu)
  // Close on any click elsewhere / escape / scroll.
  const close = (): void => menu.remove()
  setTimeout(() => {
    window.addEventListener('mousedown', close, { once: true })
    window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close() }, { once: true })
    window.addEventListener('blur', close, { once: true })
  }, 0)
}

async function onConnect(): Promise<void> {
  const email = (document.getElementById('gmail-email') as HTMLInputElement)?.value.trim() || ''
  const pass = (document.getElementById('gmail-pass') as HTMLInputElement)?.value.trim() || ''
  const status = document.getElementById('gmail-setup-status')
  if (!email || !pass) {
    if (status) {
      status.className = 'modal-status err'
      status.textContent = '◆ EMAIL AND APP PASSWORD REQUIRED'
    }
    return
  }
  if (status) {
    status.className = 'modal-status'
    status.textContent = '◆ CONNECTING TO imap.gmail.com:993…'
  }
  const res = await api.gmailSetup(email, pass)
  if (!res.ok) {
    if (status) {
      status.className = 'modal-status err'
      status.textContent = '✗ ' + (res.error || 'CONNECTION FAILED')
    }
    return
  }
  if (status) {
    status.className = 'modal-status ok'
    status.textContent = '✓ CONNECTED'
  }
  await showInbox()
}

async function onSignOut(): Promise<void> {
  await api.gmailSignOut()
  showSetup()
}

// ─── Compose / Reply / Send ────────────────────────────────
let replyToSeq: number | null = null

function openCompose(to = '', subject = '', inReplySeq: number | null = null): void {
  replyToSeq = inReplySeq
  document.getElementById('gmail-inbox')?.classList.add('hidden')
  document.getElementById('gmail-read')?.classList.add('hidden')
  document.getElementById('gmail-compose')?.classList.remove('hidden')
  ;(document.getElementById('gmail-compose-to') as HTMLInputElement).value = to
  ;(document.getElementById('gmail-compose-subject') as HTMLInputElement).value = subject
  ;(document.getElementById('gmail-compose-text') as HTMLTextAreaElement).value = ''
  const title = document.getElementById('gmail-compose-title')
  if (title) title.textContent = inReplySeq !== null ? '◆ REPLY' : '◆ COMPOSE'
  const status = document.getElementById('gmail-compose-status')
  if (status) { status.className = 'modal-status'; status.textContent = '' }
}

function openReply(): void {
  const env = currentInbox.find((m) => m.seq === replyToSeq) || currentInbox[0]
  if (!env) return
  const subject = env.subject.startsWith('Re:') ? env.subject : `Re: ${env.subject}`
  openCompose(env.from, subject, env.seq)
}

async function onSend(): Promise<void> {
  const to = (document.getElementById('gmail-compose-to') as HTMLInputElement)?.value.trim() || ''
  const subject = (document.getElementById('gmail-compose-subject') as HTMLInputElement)?.value.trim() || ''
  const text = (document.getElementById('gmail-compose-text') as HTMLTextAreaElement)?.value.trim() || ''
  const status = document.getElementById('gmail-compose-status')
  if (!to || !subject) {
    if (status) { status.className = 'modal-status err'; status.textContent = '◆ TO AND SUBJECT REQUIRED' }
    return
  }
  if (status) { status.className = 'modal-status'; status.textContent = '◆ SENDING…' }
  const sendBtn = document.getElementById('gmail-send') as HTMLButtonElement
  if (sendBtn) sendBtn.disabled = true
  const res = await api.gmailSend({ to, subject, text })
  if (sendBtn) sendBtn.disabled = false
  if (res.ok) {
    if (status) { status.className = 'modal-status ok'; status.textContent = '✓ SENT' }
    setTimeout(() => {
      document.getElementById('gmail-compose')?.classList.add('hidden')
      void showInbox()
    }, 800)
  } else {
    if (status) { status.className = 'modal-status err'; status.textContent = '✗ ' + (res.message || 'SEND FAILED') }
  }
}

// ─── Helpers ────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
}

function formatDate(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const now = new Date()
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
  } catch {
    return iso.slice(0, 16)
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function stripHtml(html: string): string {
  if (!html) return ''
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  return (tmp.textContent || '').trim()
}
