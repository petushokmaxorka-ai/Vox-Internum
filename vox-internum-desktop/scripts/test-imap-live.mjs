// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — IMAP Live Test
// ═══════════════════════════════════════════════════════════
// One-shot live test against imap.gmail.com:993. Reads email +
// App Password from stdin (NOT saved anywhere), connects, lists
// the 5 most recent envelopes, then disconnects.
//
// Run:  node scripts/test-imap-live.mjs
//   (then type your email and App Password when prompted)

import * as tls from 'node:tls'
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise((r) => rl.question(q, r))

const email = (await ask('Gmail email: ')).trim()
const pass = (await ask('App Password (16 chars): ')).trim()
rl.close()

if (!email || !pass) {
  console.error('email and password required')
  process.exit(1)
}

console.log(`\n▶ connecting to imap.gmail.com:993 as ${email}...`)

const sock = tls.connect({ host: 'imap.gmail.com', port: 993 })
let buf = ''
let tagCounter = 0
const pending = new Map()
const untagged = [] // collected for the most recent pending

function send(cmd) {
  const tag = `T${++tagCounter}`
  return new Promise((resolve, reject) => {
    pending.set(tag, { resolve, reject, untagged: [] })
    sock.write(`${tag} ${cmd}\r\n`)
  })
}

sock.on('data', (chunk) => {
  buf += chunk.toString('latin1')
  // Naive line split — fine for the test (no big literals expected
  // for LOGIN/CAPABILITY/SELECT/FETCH ENVELOPE).
  let i
  while ((i = buf.indexOf('\r\n')) !== -1) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 2)
    handleLine(line)
  }
})

function handleLine(line) {
  if (line.startsWith('* ')) {
    const entry = { text: line.slice(2) }
    untagged.push(entry)
    // route to most recent pending too
    for (const [, p] of pending) p.untagged.push(entry)
    return
  }
  if (line.startsWith('+ ')) return // continuation (we don't AUTHENTICATE)
  const sp = line.indexOf(' ')
  const tag = line.slice(0, sp)
  const text = line.slice(sp + 1)
  const p = pending.get(tag)
  if (!p) return
  pending.delete(tag)
  if (text.startsWith('OK')) p.resolve(text)
  else p.reject(new Error(`IMAP error: ${text}`))
}

await new Promise((r, j) => {
  sock.once('secureConnect', r)
  sock.once('error', j)
  setTimeout(() => j(new Error('connect timeout')), 15000)
})

// Wait for greeting
await new Promise((r) => setTimeout(r, 500))

try {
  const loginRes = await send(`LOGIN "${email.replace(/"/g, '\\"')}" "${pass.replace(/"/g, '\\"')}"`)
  console.log(`✓ LOGIN ok: ${loginRes.slice(0, 60)}`)

  const selRes = await send('SELECT INBOX')
  const exists = untagged.findLast?.((u) => /\d+ EXISTS/.test(u.text))
  console.log(`✓ SELECT ok: ${selRes.slice(0, 40)}... ${exists?.text || ''}`)
  untagged.length = 0

  // Fetch last 5 envelopes
  const m = exists?.text.match(/(\d+)/)
  const n = m ? parseInt(m[1], 10) : 0
  if (n > 0) {
    const start = Math.max(1, n - 4)
    const fetchRes = await send(`FETCH ${start}:${n} ENVELOPE`)
    console.log(`✓ FETCH ok: ${fetchRes.slice(0, 40)}...`)
    console.log('\n▼ 5 most recent envelopes:')
    for (const u of untagged) {
      const seqM = u.text.match(/^(\d+)\s+FETCH/)
      const subM = u.text.match(/ENVELOPE\s+\("[^"]*"\s+"([^"]*)"/)
      const fromM = u.text.match(/"\<([^"]+?)\@"|\(("?[^"]*"?)"\s*NIL\s*"([^"]+)"\s*"([^"]+)"/)
      const seq = seqM ? seqM[1] : '?'
      const subject = subM ? subM[1] : '(no subject)'
      console.log(`  #${seq}: ${subject.slice(0, 70)}`)
    }
  } else {
    console.log('(INBOX is empty)')
  }

  await send('LOGOUT')
  console.log('\n✓ DONE — IMAP работает! Можно строить UI.')
} catch (e) {
  console.error('\n✗ FAILED:', e.message)
  console.error('\nЭто значит:')
  console.error('  - Email/App Password incorrect — перепроверь (пробелы можно вставлять как есть)')
  console.error('  - 2FA не включён → App Password не создать')
  console.error('  - IMAP отключён в Gmail settings → myaccount.google.com → Security → IMAP access')
  process.exit(1)
} finally {
  sock.destroy()
  process.exit(0)
}
