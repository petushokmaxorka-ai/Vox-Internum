// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — MCP Server
// ═══════════════════════════════════════════════════════════
// Exposes Vox Internum to an LLM dashboard (e.g. mens-machinae) as
// a Model Context Protocol server over Streamable HTTP.
//
// Transport: StreamableHTTP on 127.0.0.1:9751 (NOT stdio — the
// dashboard client connects over HTTP, no process spawning).
//
// SDK version note: we target @modelcontextprotocol/sdk 1.30.x,
// which uses the per-session StreamableHTTPServerTransport pattern.
// v2 (createMcpHandler factory) is not yet stable for us; the
// stateful Map-of-transports below is the documented v1 approach.
//
// Tools:
//   list_services   — read-only: which messengers are configured
//   get_unread      — read-only: unread badge counts per service
//   send_message    — WRITE: requires Human-in-the-Loop approval.
//                     The MCP server does NOT send autonomously;
//                     it asks the user via the renderer and only
//                     injects the text after explicit approval
//                     (AGENTS.md §3.5 HITL for severity=critical).
//
// SECURITY:
//   - Binds 127.0.0.1 ONLY (AGENTS.md §3.1).
//   - send_message payload is shown to the user verbatim before
//     any DOM injection. No silent LLM writes.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'

/** Port the MCP server listens on. Documented in AGENTS.md service map. */
export const MCP_PORT = 9751

/** Callback shape the MCP server needs from main. */
export interface McpCallbacks {
  /** Return the registered services (id/name/category). */
  listServices: () => Array<{ id: string; name: string; category: string }>
  /** Return the last known unread count per service id. */
  getUnread: () => Record<string, number>
  /**
   * Ask the human to approve an outbound send_message. Must resolve
   * to true only after explicit user approval in the renderer.
   */
  requestApproval: (req: {
    id: string
    action: string
    service: string
    summary: string
  }) => Promise<boolean>
  /**
   * Actually inject the approved text into the service's input field.
   * Returns true if the DOM injection succeeded. Implementation lives
   * in view-manager (DOM selectors differ per service).
   */
  injectMessage: (serviceId: string, text: string) => Promise<boolean>
}

// ─── Stateful session management ────────────────────────────
// One McpServer + one StreamableHTTPServerTransport per session.
// Stored by session id (assigned by sessionIdGenerator on init).
// Stateless requests (no session) get an ephemeral server+transport
// that lives only for the request.
interface Session {
  server: McpServer
  transport: StreamableHTTPServerTransport
}
const sessions = new Map<string, Session>()

let httpServer: Server | null = null
const pendingApprovals = new Map<
  string,
  { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }
>()

/**
 * Build a fresh McpServer with all tools registered. Called once
 * per new session (and once per stateless request).
 */
function buildServer(cb: McpCallbacks): McpServer {
  const mcp = new McpServer({ name: 'vox-internum', version: '0.1.0' })

  // ── Tool: list_services (read-only) ──────────────────────
  mcp.registerTool(
    'list_services',
    {
      description:
        'List the messenger and mail services configured in Vox Internum. Read-only.',
      inputSchema: z.object({})
    },
    async () => {
      const services = cb.listServices()
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ services }, null, 2) }]
      }
    }
  )

  // ── Tool: get_unread (read-only) ─────────────────────────
  mcp.registerTool(
    'get_unread',
    {
      description: 'Return the unread message count per service id. Read-only.',
      inputSchema: z.object({})
    },
    async () => {
      const unread = cb.getUnread()
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ unread }, null, 2) }]
      }
    }
  )

  // ── Tool: send_message (WRITE, requires HITL) ────────────
  mcp.registerTool(
    'send_message',
    {
      description:
        'Send a message into a messenger chat. REQUIRES explicit human approval: the user will see the service + text and must approve before any action is taken.',
      inputSchema: z.object({
        service: z.string().describe('Target service id (e.g. "telegram")'),
        text: z.string().max(4000).describe('Message text to send')
      })
    },
    async ({ service, text }) => {
      const id = randomUUID()
      const approved = await cb.requestApproval({
        id,
        action: 'SEND_MESSAGE',
        service,
        summary: text.length > 200 ? text.slice(0, 200) + '…' : text
      })
      if (!approved) {
        return { content: [{ type: 'text' as const, text: 'DENIED by user' }], isError: true }
      }
      const ok = await cb.injectMessage(service, text)
      return {
        content: [
          { type: 'text' as const, text: ok ? 'Message injected into input field' : 'Injection failed' }
        ],
        isError: !ok
      }
    }
  )

  return mcp
}

/**
 * Resolve a pending HITL approval from the renderer.
 * Called by main when VOX_MCP_APPROVE_RESPONSE arrives.
 */
export function resolveApproval(id: string, approved: boolean): void {
  const p = pendingApprovals.get(id)
  if (!p) return
  clearTimeout(p.timer)
  pendingApprovals.delete(id)
  p.resolve(approved)
}

/**
 * Start the MCP server. Idempotent — calling twice is a no-op.
 */
export function startMcpServer(cb: McpCallbacks): Server {
  if (httpServer) return httpServer

  httpServer = createServer((req, res) => {
    void handleRequest(req, res, cb)
  })

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[vox-internum:mcp] port ${MCP_PORT} already in use — another ` +
          `Vox Internum instance is likely running. MCP bridge disabled.`
      )
    } else {
      console.error(`[vox-internum:mcp] server error:`, err.message)
    }
    // Don't crash the app; MCP is non-essential for the core experience.
    httpServer = null
  })

  httpServer.listen(MCP_PORT, '127.0.0.1', () => {
    console.log(`[vox-internum:mcp] listening on http://127.0.0.1:${MCP_PORT}`)
  })

  return httpServer
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cb: McpCallbacks
): Promise<void> {
  try {
    // Existing session? Reuse its server+transport.
    const sessionId = getSessionId(req)
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!
      await session.transport.handleRequest(req, res)
      return
    }

    // New session (or stateless request): build fresh server+transport.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID()
    })

    const server = buildServer(cb)
    await server.connect(transport)
    await transport.handleRequest(req, res)

    // After handleRequest, the transport may have been assigned a
    // session id (initialize requests get one). Stash it so subsequent
    // requests in the same session reuse this server+transport.
    const assignedId = transport.sessionId
    if (assignedId) {
      sessions.set(assignedId, { server, transport })
    }
    // Stateless requests: no session id, transport is one-shot — let
    // it GC. No explicit cleanup needed.
  } catch (e) {
    if (!res.headersSent) res.statusCode = 500
    res.end(JSON.stringify({ error: (e as Error).message }))
  }
}

function getSessionId(req: IncomingMessage): string | null {
  // MCP clients send a mcp-session-id header after initialize.
  const h = req.headers['mcp-session-id']
  if (typeof h === 'string') return h
  return null
}

/**
 * Create a HITL approval promise. Main uses this to bridge MCP's
 * requestApproval callback to the renderer IPC flow.
 */
export function createApproval(
  req: { id: string; action: string; service: string; summary: string },
  timeoutMs = 60000
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(req.id)
      resolve(false)
    }, timeoutMs)
    pendingApprovals.set(req.id, { resolve, timer })
  })
}
