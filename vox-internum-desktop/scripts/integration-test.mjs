// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Integration Test Harness
// ═══════════════════════════════════════════════════════════
// Spawns the built electron app, then drives it like a real client:
//   1. Calls MCP tools/list to verify the LLM bridge.
//   2. Calls MCP tools/call list_services to verify tool execution.
//   3. Polls vox:diagnostic-snapshot to confirm all 6 views loaded.
//
// Uses the test driver pattern: a special renderer path is loaded by
// setting an env var that flips the app into "test mode" — but we
// avoid that complexity here. Instead we hit the MCP endpoint (real
// HTTP) and trust the snapshot IPC to expose internal state.
//
// Because vox:diagnostic-snapshot is a renderer IPC, we cannot call
// it from outside the app. We use the MCP list_services tool as the
// proxy signal: if MCP responds with 6 services, view-manager init
// completed. For per-view load status, we launch with a test hook
// that writes a JSON report to disk before quitting.

import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'

const REPORT = '/tmp/vox-integration-report.json'
if (existsSync(REPORT)) unlinkSync(REPORT)

const ELECTRON = './node_modules/.bin/electron'
const APP = 'out/main/index.js'

console.log('▶ launching electron…')
const app = spawn(ELECTRON, [APP], {
  env: {
    ...process.env,
    VOX_TEST_MODE: '1',
    VOX_TEST_REPORT: REPORT
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

const logs = []
app.stdout.on('data', (d) => {
  const s = d.toString()
  logs.push(s)
  process.stdout.write('[app] ' + s)
})
app.stderr.on('data', (d) => {
  const s = d.toString()
  logs.push(s)
  process.stderr.write('[app!] ' + s)
})

// ── wait for MCP to come up ─────────────────────────────────
async function waitForMcp(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch('http://127.0.0.1:9751/health', { method: 'GET' })
      // /health doesn't exist on the MCP server (that's the license worker);
      // we detect readiness by initialize succeeding instead.
      if (r.status < 500) return true
    } catch {
      // not up yet
    }
    await sleep(500)
  }
  return false
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// ── real MCP client calls ───────────────────────────────────
async function mcpInitialize() {
  const r = await fetch('http://127.0.0.1:9751/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'integration-test', version: '0' }
      }
    })
  })
  const sid = r.headers.get('mcp-session-id')
  const text = await r.text()
  return { sid, text }
}

async function mcpCall(sid, method, params) {
  const r = await fetch('http://127.0.0.1:9751/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sid
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params })
  })
  return r.text()
}

function parseSseData(s) {
  // SSE blocks look like "event: message\ndata: {...}\n\n"
  const m = s.match(/data: (\{.*\})/s)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}

// ── test runner ─────────────────────────────────────────────
const results = { pass: [], fail: [], steps: [] }

function check(name, cond, detail = '') {
  if (cond) {
    results.pass.push(name)
    console.log(`  ✓ ${name}`)
  } else {
    results.fail.push(name)
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`)
  }
  results.steps.push({ name, pass: cond, detail })
}

try {
  console.log('\n▼ Phase A: app launch')
  // Give it 5s to spin up window + start init
  await sleep(5000)

  console.log('\n▼ Phase B: MCP bridge (real HTTP JSON-RPC)')
  const init = await mcpInitialize()
  check('MCP initialize returned session id', Boolean(init.sid), `got: ${init.sid}`)
  const initJson = parseSseData(init.text)
  check(
    'MCP serverInfo correct',
    initJson?.result?.serverInfo?.name === 'vox-internum',
    JSON.stringify(initJson?.result?.serverInfo)
  )

  // tools/list
  await sleep(500)
  const notif = await mcpCall(init.sid, 'notifications/initialized', {})
  const listRaw = await mcpCall(init.sid, 'tools/list', {})
  const listJson = parseSseData(listRaw)
  const toolNames = (listJson?.result?.tools || []).map((t) => t.name).sort()
  check(
    'MCP exposes 3 tools',
    JSON.stringify(toolNames) === JSON.stringify(['get_unread', 'list_services', 'send_message']),
    JSON.stringify(toolNames)
  )

  // tools/call list_services
  const callRaw = await mcpCall(init.sid, 'tools/call', {
    name: 'list_services',
    arguments: {}
  })
  const callJson = parseSseData(callRaw)
  let servicesCount = 0
  try {
    const inner = JSON.parse(callJson.result.content[0].text)
    servicesCount = inner.services.length
  } catch {}
  check('list_services returns 6 services', servicesCount === 6, `got ${servicesCount}`)

  console.log('\n▼ Phase C: wait for all views to settle')
  // Views need ~10s to fetch telegram.org, vk.com, etc. on a cold
  // start. App fires SNAPSHOT 12s after its own init completes.
  console.log('  (letting views load for 15s…)')
  await sleep(15000)

  console.log('\n▼ Phase D: error scan')
  const errPattern = /TypeError|ReferenceError|FATAL:gpu_data|view-manager init FAILED/i
  const crashes = logs.filter((l) => errPattern.test(l))
  check('no JS exceptions in stdout', crashes.length === 0, `${crashes.length} lines matched`)
  if (crashes.length) {
    for (const c of crashes.slice(0, 5)) console.log('    > ' + c.trim().slice(0, 200))
  }

  console.log('\n▼ Phase E: MCP still healthy after 20s')
  const init2 = await mcpInitialize()
  check('MCP server still accepts new sessions after 20s', Boolean(init2.sid))

  console.log('\n▼ Phase F: per-view load snapshot (parsed from test-mode stdout)')
  // The app prints "[vox-internum:test] SNAPSHOT [...]" at 20s.
  let snapshot = null
  const snapStart = Date.now()
  while (Date.now() - snapStart < 25000) {
    for (const l of logs) {
      const m = l.match(/SNAPSHOT (\[.*\])/)
      if (m) {
        try { snapshot = JSON.parse(m[1]); break } catch {}
      }
    }
    if (snapshot) break
    await sleep(500)
  }
  if (!snapshot) {
    check('view snapshot received', false, 'no SNAPSHOT line in 15s')
  } else {
    check('snapshot covers all 6 services', snapshot.length === 6, `got ${snapshot.length}`)
    const expected = ['telegram', 'vk', 'max', 'gmail', 'yandex', 'mailru']
    for (const id of expected) {
      const v = snapshot.find((s) => s.id === id)
      if (!v) {
        check(`${id} present in snapshot`, false)
        continue
      }
      check(`${id} loaded`, v.loaded === true, `loaded=${v.loaded}`)
      // bodySize > 100 means the page actually rendered DOM content.
      check(`${id} rendered content (bodySize>100)`, v.bodySize > 100, `bodySize=${v.bodySize}, url=${v.url}`)
    }
  }
} catch (e) {
  results.fail.push('uncaught: ' + e.message)
  console.log('  ✗ uncaught: ' + e.message)
} finally {
  console.log('\n■ tearing down…')
  app.kill('SIGTERM')
  await new Promise((r) => app.once('exit', r))

  // Final report
  console.log('\n════════════════════════════════════════')
  console.log(`  PASS: ${results.pass.length}    FAIL: ${results.fail.length}`)
  console.log('════════════════════════════════════════')
  if (results.fail.length) {
    console.log('Failed:')
    for (const f of results.fail) console.log('  - ' + f)
  }
  writeFileSync(REPORT, JSON.stringify(results, null, 2))
  process.exit(results.fail.length ? 1 : 0)
}
