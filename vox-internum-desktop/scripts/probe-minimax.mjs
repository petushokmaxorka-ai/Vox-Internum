import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const electronPath = require('electron')
import { spawn } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const runner = join(tmpdir(), `vox-probe-mm-${process.pid}.cjs`)
writeFileSync(
  runner,
  `
const { app, BrowserWindow, session } = require('electron');
app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:vox-test-minimax');
  await ses.setProxy({ proxyRules: 'direct://' });
  ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, offscreen: true } });
  const fails = [];
  const reqs = [];
  ses.webRequest.onCompleted((d) => {
    if (d.statusCode >= 400 || d.url.includes('minimax') || d.url.includes('google')) {
      reqs.push({ status: d.statusCode, url: d.url.slice(0, 120) });
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => fails.push({ code, desc, url: (url || '').slice(0, 120) }));
  const t0 = Date.now();
  try { await win.loadURL('https://agent.minimax.io/'); } catch (e) { fails.push({ err: String(e) }); }
  await new Promise((r) => setTimeout(r, 10000));
  let body = 0, title = '', url = '';
  try {
    url = win.webContents.getURL();
    title = win.webContents.getTitle();
    body = await win.webContents.executeJavaScript('(document.body && document.body.innerText || "").length');
  } catch (e) { fails.push({ eval: String(e) }); }
  console.log(JSON.stringify({ ms: Date.now() - t0, url, title, body, fails, reqs: reqs.slice(0, 40) }, null, 2));
  app.exit(0);
});
`
)

const child = spawn(electronPath, [runner], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    ALL_PROXY: '',
    HTTPS_PROXY: '',
    HTTP_PROXY: '',
    all_proxy: '',
    https_proxy: '',
    http_proxy: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
delete child.env
let out = ''
child.stdout.on('data', (d) => { out += d; process.stdout.write(d) })
child.stderr.on('data', (d) => { process.stderr.write(d) })
child.on('exit', (code) => {
  try { unlinkSync(runner) } catch {}
  process.exit(code || 0)
})
