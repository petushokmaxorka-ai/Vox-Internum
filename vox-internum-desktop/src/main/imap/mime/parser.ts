// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — MIME Parser (RFC 2045/2046)
// ═══════════════════════════════════════════════════════════
// Recursive descent parser for RFC 2822/MIME messages. Produces a
// tree of MimePart nodes. Each part carries its headers + decoded
// text content (or, for binaries, latin1-safe string + a flag).
//
// Tree shape (example):
//   multipart/mixed
//   ├── multipart/alternative
//   │   ├── text/plain     ← alternate plain rendering
//   │   └── text/html      ← alternate html rendering
//   ├── image/png          ← attachment
//   └── application/pdf    ← attachment
//
// Callers walk the tree to pick the best representation (prefer
// text/plain for chat-style UI, fall back to text/html).

import {
  decodeBody,
  decodeHeader,
  parseContentType
} from './decoder'

export interface MimePart {
  /** Lowercased MIME type: text/plain, multipart/mixed, etc. */
  type: string
  /** Charset for text/* parts (lowercased). */
  charset: string
  /** Boundary for multipart/* parts. */
  boundary?: string
  /** Decoded Content-Transfer-Encoding: base64 / quoted-printable / 7bit. */
  encoding: string
  /** Raw headers (lowercased name → value). */
  headers: Record<string, string>
  /**
   * Decoded text body for leaf text/* parts.
   * Empty for multipart/* (use children) and for non-text binaries.
   */
  text: string
  /**
   * True for binary parts (image, application, audio, video).
   * Consumers treat these as attachments.
   */
  isAttachment: boolean
  /** Filename from Content-Disposition (decoded). */
  filename?: string
  /** Children for multipart/* parts. */
  children: MimePart[]
}

const CRLF = '\r\n'

/**
 * Parse a full RFC 2822 message into a MimePart tree. The input is
 * the complete message body (headers + blank line + body), as you'd
 * get from IMAP FETCH BODY[].
 */
export function parseMessage(raw: string): MimePart {
  const { headers, body } = splitHeadAndBody(raw)
  return parsePart(headers, body)
}

function parsePart(
  headers: Record<string, string>,
  body: string
): MimePart {
  const ct = parseContentType(headers['content-type'] || '')
  const encoding = (headers['content-transfer-encoding'] || '').toLowerCase().trim()
  const disposition = headers['content-disposition'] || ''
  const isAttachment = /^(attachment|inline)/i.test(disposition) ||
    /^(image|audio|video|application)\//i.test(ct.type)
  // Filename from Content-Disposition or Content-Type name=
  let filename: string | undefined
  const dispParams = parseDispositionParams(disposition)
  if (dispParams.filename) {
    filename = decodeHeader(dispParams.filename)
  } else if (ct.params['name']) {
    filename = decodeHeader(ct.params['name'])
  }

  const part: MimePart = {
    type: ct.type,
    charset: ct.params['charset']?.toLowerCase() || 'utf-8',
    boundary: ct.params['boundary'],
    encoding,
    headers,
    text: '',
    isAttachment,
    filename,
    children: []
  }

  if (ct.type.startsWith('multipart/') && part.boundary) {
    // Split on --boundary
    const segments = splitMultipart(body, part.boundary)
    part.children = segments.map((seg) => {
      const { headers: ch, body: cb } = splitHeadAndBody(seg)
      return parsePart(ch, cb)
    })
  } else if (ct.type.startsWith('text/') || ct.type === 'application/xml') {
    const isText = true
    part.text = decodeBody(body, encoding, isText)
  } else {
    // Binary leaf — decode to a latin1-safe string (UI uses this
    // only for size/preview; download uses a separate raw fetch).
    part.text = decodeBody(body, encoding, false)
  }
  return part
}

/**
 * Split "Header: value\r\nHeader2: value\r\n\r\nbody..." into
 * { headers, body }. Headers lowercased. Folds multi-line headers.
 */
function splitHeadAndBody(
  raw: string
): { headers: Record<string, string>; body: string } {
  // Find the first empty line (CRLF CRLF).
  const sep = raw.indexOf(CRLF + CRLF)
  const headRaw = sep === -1 ? raw : raw.slice(0, sep)
  const body = sep === -1 ? '' : raw.slice(sep + 4)
  const headers: Record<string, string> = {}
  // Unfold continuation lines (a line starting with whitespace is a
  // continuation of the previous header).
  const lines = headRaw.split(CRLF)
  let i = 0
  while (i < lines.length) {
    let line = lines[i]
    // Fold continuation
    while (i + 1 < lines.length && /^\s/.test(lines[i + 1])) {
      line += ' ' + lines[i + 1].trim()
      i++
    }
    const c = line.indexOf(':')
    if (c > 0) {
      const name = line.slice(0, c).trim().toLowerCase()
      const value = line.slice(c + 1).trim()
      headers[name] = decodeHeader(value)
    }
    i++
  }
  return { headers, body }
}

/**
 * Split a multipart body on the boundary. Returns the inner parts
 * (delimiters stripped). Per RFC 2046, the boundary in the body is
 * `--<boundary>` and the closing is `--<boundary>--`.
 */
function splitMultipart(body: string, boundary: string): string[] {
  const open = `--${boundary}`
  const close = `--${boundary}--`
  // Find the first open delimiter; everything before is the preamble.
  const firstOpen = body.indexOf(open)
  if (firstOpen === -1) return []
  // Walk through subsequent opens, slicing between them. Stop at close.
  const parts: string[] = []
  let pos = firstOpen + open.length
  while (pos < body.length) {
    // Skip the CRLF after the delimiter (some senders omit it).
    if (body.slice(pos, pos + 2) === CRLF) pos += 2
    // Find the next delimiter occurrence from here.
    const nextOpen = body.indexOf(CRLF + open, pos)
    const nextClose = body.indexOf(CRLF + close, pos)
    const nextDelim =
      nextOpen === -1 ? nextClose : nextClose === -1 ? nextOpen : Math.min(nextOpen, nextClose)
    if (nextDelim === -1) {
      // Trailing junk — stop.
      break
    }
    parts.push(body.slice(pos, nextDelim))
    // Advance past the delimiter we matched.
    if (nextDelim === nextClose) break
    pos = nextDelim + CRLF.length + open.length
  }
  return parts
}

/**
 * Pull params out of a Content-Disposition header.
 *   attachment; filename="file.pdf"  → { disposition: 'attachment', filename: 'file.pdf' }
 */
function parseDispositionParams(
  raw: string
): { disposition: string; filename?: string } {
  if (!raw) return { disposition: '' }
  const parts = raw.split(';').map((s) => s.trim())
  const disposition = parts[0].toLowerCase()
  let filename: string | undefined
  for (let i = 1; i < parts.length; i++) {
    const m = parts[i].match(/^filename\s*=\s*\*?([^;]+)$/i)
    if (m) {
      let f = m[1].trim().replace(/^"|"$/g, '')
      // RFC 5987 extended: filename*=UTF-8''encoded
      if (m[0].includes('*=')) {
        const ext = f.match(/^([^']+)'([^']*)'(.+)$/)
        if (ext) {
          try {
            f = decodeURIComponent(ext[3])
          } catch {
            // leave as-is
          }
        }
      }
      filename = f
    }
  }
  return { disposition, filename }
}

// ─── Convenience walkers ─────────────────────────────────────
// Helpers the UI uses to extract "the text the user should see"
// and "the list of attachments" from a parsed message.

/** Find the first text/plain part in the tree (DFS). */
export function findPlainText(part: MimePart): string {
  if (part.type === 'text/plain') return part.text
  for (const c of part.children) {
    const t = findPlainText(c)
    if (t) return t
  }
  return ''
}

/** Find the first text/html part (DFS). */
export function findHtml(part: MimePart): string {
  if (part.type === 'text/html') return part.text
  for (const c of part.children) {
    const t = findHtml(c)
    if (t) return t
  }
  return ''
}

/** Collect all attachment parts (DFS). */
export function collectAttachments(part: MimePart): MimePart[] {
  const out: MimePart[] = []
  if (part.isAttachment && part.filename) {
    out.push(part)
  }
  for (const c of part.children) out.push(...collectAttachments(c))
  return out
}
