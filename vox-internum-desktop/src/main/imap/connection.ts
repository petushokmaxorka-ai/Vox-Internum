// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — IMAP Connection (Raw TLS)
// ═══════════════════════════════════════════════════════════
// Owns the TLS socket to an IMAP server and the IMAP state machine.
// All bytes flow through ImapParser; every command we send is tagged
// with a monotonic A<n> prefix so we can match its response. We
// resolve per-tag promises when the matching tagged response arrives.
//
// State machine (RFC 9051 §3.1):
//   NOT-CONNECTED ──connect()──► NOT-AUTHENTICATED ──login()──► AUTHENTICATED
//   AUTHENTICATED ──select()──► SELECTED ──close()──► AUTHENTICATED
//   Any ──logout()──► LOGOUT
//
// All commands are async. We never block on the socket directly;
// we register a promise per tag and resolve it when the parser
// emits the matching tagged response.

import { connect as tlsConnect, type TLSSocket } from 'tls'
import { ImapParser, type ImapResponse, classifyTagged, parseGreetingCapabilities } from './protocol'

export type ImapState =
  | 'NOT-CONNECTED'
  | 'NOT-AUTHENTICATED'
  | 'AUTHENTICATED'
  | 'SELECTED'
  | 'LOGOUT'

export interface ImapConnectOptions {
  host: string
  port: number
  /** Optional servername override for SNI (defaults to host). */
  servername?: string
  /** Connect timeout ms (default 15s). */
  timeout?: number
}

interface PendingCommand {
  resolve: (text: string) => void
  reject: (e: Error) => void
  /** Untagged responses collected while waiting for this tag. */
  untagged: Array<{ text: string }>
}

/**
 * A raw IMAP4rev1 connection. One instance = one TCP/TLS session.
 * NOT safe to reuse after logout(); create a new one.
 */
export class ImapConnection {
  state: ImapState = 'NOT-CONNECTED'
  /** Capabilities advertised by the server (lowercased). */
  capabilities: string[] = []

  private sock: TLSSocket | null = null
  private parser = new ImapParser()
  private tagCounter = 0
  private pending = new Map<string, PendingCommand>()
  /** Resolves once the server greeting arrives (initial * OK). */
  private greetingPromise: Promise<void>
  private greetingResolve!: () => void
  private greetingReject!: (e: Error) => void

  constructor() {
    this.greetingPromise = new Promise((resolve, reject) => {
      this.greetingResolve = resolve
      this.greetingReject = reject
    })
  }

  /** Establish the TLS connection and wait for the server greeting. */
  async connect(opts: ImapConnectOptions): Promise<void> {
    if (this.state !== 'NOT-CONNECTED') {
      throw new Error(`connect() called in state ${this.state}`)
    }
    return new Promise((resolve, reject) => {
      const onTimeout = (): void => reject(new Error('IMAP connect timeout'))
      const sock = tlsConnect({
        host: opts.host,
        port: opts.port,
        servername: opts.servername ?? opts.host,
        // Gmail and others require TLS 1.2+; Node defaults are fine.
      })
      const greetingTimeoutMs = opts.timeout ?? 15000
      sock.setTimeout(greetingTimeoutMs)

      sock.once('secureConnect', () => {
        sock.setTimeout(0)
        this.sock = sock
        this.state = 'NOT-AUTHENTICATED'
        // Wait for the greeting before resolving. The greeting's
        // capabilities are parsed in handleResponse. If no greeting
        // arrives within the timeout, fail.
        const t = setTimeout(() => {
          this.greetingReject(new Error('IMAP greeting timeout'))
        }, greetingTimeoutMs)
        this.greetingPromise.then(
          () => { clearTimeout(t); resolve() },
          (e) => { clearTimeout(t); reject(e) }
        )
      })
      sock.once('timeout', onTimeout)
      sock.once('error', (e) => {
        reject(new Error(`IMAP TLS error: ${e.message}`))
      })
      sock.on('data', (chunk: Buffer) => {
        const responses = this.parser.feed(chunk)
        for (const r of responses) this.handleResponse(r)
      })
      sock.on('close', () => {
        this.state = 'NOT-CONNECTED'
        // Reject any in-flight commands.
        for (const [, p] of this.pending) {
          p.reject(new Error('IMAP connection closed'))
        }
        this.pending.clear()
      })
    })
  }

  /**
   * Authenticate via plain LOGIN. Many servers require STARTTLS first
   * (we do that automatically if the server advertises it and we are
   * not already on TLS). For Gmail, use an App Password as password.
   */
  async login(user: string, pass: string): Promise<void> {
    if (this.state !== 'NOT-AUTHENTICATED') {
      throw new Error(`login() called in state ${this.state}`)
    }
    // Quote both to allow special chars; IMAP atoms can't contain
    // spaces, double-quotes, parens. We escape DQUOTE and backslash.
    const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    // Capabilities from greeting may already include AUTH=PLAIN; if
    // not, the LOGIN response will refresh them.
    await this.run(`LOGIN ${q(user)} ${q(pass)}`)
    this.state = 'AUTHENTICATED'
    // After login, refresh capabilities if the server didn't send them.
    if (this.capabilities.length === 0) {
      try {
        await this.run('CAPABILITY')
      } catch {
        // non-fatal
      }
    }
  }

  /** Send a command, await its tagged response text. */
  async run(command: string): Promise<string> {
    if (!this.sock || this.state === 'NOT-CONNECTED') {
      throw new Error('IMAP not connected')
    }
    const tag = `A${++this.tagCounter}`
    const pending: PendingCommand = {
      resolve: () => undefined,
      reject: () => undefined,
      untagged: []
    }
    const promise = new Promise<string>((resolve, reject) => {
      pending.resolve = resolve
      pending.reject = reject
    })
    this.pending.set(tag, pending)
    // Write: "A1 COMMAND\r\n"
    this.sock.write(`${tag} ${command}\r\n`)
    try {
      const text = await promise
      return text
    } finally {
      this.pending.delete(tag)
    }
  }

  /** Like run(), but returns the collected untagged responses too. */
  async runWithUntagged(
    command: string
  ): Promise<{ tagged: string; untagged: Array<{ text: string }> }> {
    const tag = `A${++this.tagCounter}`
    const pending: PendingCommand = {
      resolve: () => undefined,
      reject: () => undefined,
      untagged: []
    }
    const promise = new Promise<string>((resolve, reject) => {
      pending.resolve = resolve
      pending.reject = reject
    })
    this.pending.set(tag, pending)
    this.sock!.write(`${tag} ${command}\r\n`)
    try {
      const tagged = await promise
      return { tagged, untagged: pending.untagged }
    } finally {
      this.pending.delete(tag)
    }
  }

  /** Send LOGOUT. The server responds and closes the socket. */
  async logout(): Promise<void> {
    if (this.state === 'NOT-CONNECTED') return
    try {
      await this.run('LOGOUT')
    } catch {
      // ignore — server may close abruptly
    }
    this.state = 'LOGOUT'
    this.sock?.destroy()
  }

  // ─── Internal: dispatch parsed responses ──────────────────
  private handleResponse(resp: ImapResponse): void {
    // Greeting: very first untagged "* OK ..." (could be PREAUTH/BYE).
    if (this.state === 'NOT-AUTHENTICATED' && this.capabilities.length === 0 && resp.tag === '*' && resp.text.startsWith('OK')) {
      this.capabilities = parseGreetingCapabilities(resp)
      this.greetingResolve()
      return
    }

    if (resp.tag === '*') {
      // Untagged: route to whichever command is in flight (the most
      // recently issued). IMAP doesn't multiplex commands — only one
      // can be in flight at a time per connection — so this is safe.
      // Also handle capability refresh from "* CAPABILITY".
      if (resp.text.startsWith('CAPABILITY ')) {
        this.capabilities = resp.text
          .slice('CAPABILITY '.length)
          .split(/\s+/)
          .map((s) => s.toLowerCase())
      }
      // Find any pending command and attach the untagged to it.
      for (const [, p] of this.pending) {
        p.untagged.push({ text: resp.text })
      }
      return
    }

    if (resp.tag === '+') {
      // Continuation request (e.g. for AUTHENTICATE challenges).
      // We don't currently use AUTHENTICATE-style SASL, so this is
      // unexpected; treat as error for the in-flight command.
      for (const [t, p] of this.pending) {
        p.reject(new Error(`unexpected continuation: ${resp.text}`))
        this.pending.delete(t)
        break
      }
      return
    }

    // Tagged response — match to the pending command of the same tag.
    const p = this.pending.get(resp.tag)
    if (!p) return
    const status = classifyTagged({ tag: resp.tag, text: resp.text, bytes: 0 })
    if (status === 'OK') {
      p.resolve(resp.text)
    } else {
      // NO = expected failure (e.g. wrong creds), BAD = protocol error.
      p.reject(new Error(`IMAP ${status}: ${resp.text}`))
    }
  }
}
