# ◆ VOX INTERNUM

> Dark Mechanicus messenger aggregator. One Electron shell, one isolated
> session per service. Telegram, VK, MAX, OK — in a single WH40k-themed window.

## ⚒ What it is

A standalone desktop client that embeds the **web versions** of several
messengers, each in its own persistent Chromium session partition
(`persist:vox-internum-<id>`). Cookies, cache and localStorage are fully
separated between services — Telegram cannot see VK, VK cannot see OK.

This is the foundation layer. Everything privacy-related that comes later
(per-service Smart Proxy, telemetry firewall, anti-fingerprinting,
ecosystem-isolation, Identity Forge) builds on top of these isolated
partitions without changing the architecture.

| Service | URL | Tier |
|---------|-----|------|
| Telegram | `https://web.telegram.org/k/` | free |
| VK       | `https://vk.com/im`           | free |
| MAX      | `https://web.max.ru/`         | free |
| OK       | `https://ok.ru/messages`      | free |
| Gmail    | `https://mail.google.com/mail/u/0/` | free |
| Yandex Mail | `https://mail.yandex.ru/`    | free |
| Mail.ru | `https://e.mail.ru/inbox/`    | free |

## ⚙ Stack

- Electron 43+ — `WebContentsView` (not the deprecated `<webview>`/`BrowserView`)
- electron-vite + TypeScript
- electron-store — persistence (`lastActiveService`)
- electron-updater — auto-update from GitHub Releases
- electron-builder — AppImage / NSIS / DMG
- Vanilla TS renderer (no React at this scale), Dark Mechanicus theme

## ➜ Auto-update

Two tiers, picked automatically at runtime:

1. **Full auto-update** (AppImage on Linux, NSIS install on Windows):
   the app polls GitHub Releases, downloads the new version in the
   background, then shows a `RESTART & UPDATE` banner. The update also
   installs on quit, so ignoring the banner is safe.
2. **Banner fallback** (tar.gz, portable exe / zip, unsigned macOS, dev):
   a banner with a `DOWNLOAD` button that opens the release page in the
   system browser.

Releases live in [petushokmaxorka-ai/vox-internum](https://github.com/petushokmaxorka-ai/vox-internum)
(tags: `v<semver>`) and must ship `latest-linux.yml` / `latest.yml`
next to the artifacts — tier 1 reads them.

## ➜ Build from source

```bash
npm install
npm run dev               # dev mode (hot reload)
npm run build             # typecheck + electron-vite build → out/
npm run build:linux       # → release/Vox.Internum-0.4.0.AppImage
npm run build:win         # → release/Vox.Internum-Setup-0.4.0.exe
npm run build:mac         # → release/Vox Internum-0.4.0.dmg
```

## ◆ User flow

1. Launch the app — sidebar shows TG / VK / MX.
2. Click Telegram — the web client loads. Log in once.
3. Click VK — separate session, separate login. Click MAX — same.
4. Sessions persist across restarts (each service remembers you).
5. Unread counts surface as red badges on the sidebar icons.
6. Click the **⚙ gear** → **Smart Proxy** settings: route Telegram
   through `socks5://user:pass@host:port` while VK/MAX stay direct.
   Save & Apply reloads the view so the new route takes effect.
7. **Inquisition Firewall** runs automatically on every session —
   telemetry (Yandex.Metrica, Google Analytics, Tencent, Mail.ru pixel)
   is cancelled at the network level, and microphone/camera/clipboard/
   notification permissions are denied. Messengers think the device
   is a mic-less kiosk.
8. **Camouflage** runs automatically — the `Electron/X.Y.Z` token is
   stripped from the User-Agent, Client Hints (`Sec-CH-UA`) are rewritten
   to plain Chrome, and a preload script patches `navigator.webdriver`
   and `window.chrome` so bot-detectors see a normal Chrome tab.
   Needed for future Gmail/WhatsApp acceptance; harmless for TG/VK/MAX.
9. **CSS Cleaner** runs on every navigation — for VK it hides the top
   header, left nav rail and right promo column, reclaiming the full
   width for the chat surface; for mail (Gmail/Yandex/Mail.ru) it
   strips the right-side widget/ads pane; for Telegram/MAX it trims
   "use the app" promo banners. Selectors are defensive (ID-first,
   class-fallback) and re-applied on every `dom-ready` since SPAs
   rebuild DOM.
10. **Licensing** — a Cloudflare Worker (`../license-worker`)
    issues and verifies opaque activation tokens with device binding
    (max 3 devices) and revocation. The desktop client shows a
    TRIAL/LICENSED/EXPIRED badge in the sidebar; click it to paste a
    key. Payment is out-of-band (crypto / ЮMoney) — the Worker never
    touches money. Without `VOX_LICENSE_URL` set, the app runs as
    UNLICENSED forever and nothing breaks.

## ◆ MCP Server (LLM bridge)

Vox Internum exposes a **Model Context Protocol** server on
`http://127.0.0.1:9751` so an external LLM dashboard (e.g.
mens-machinae) can query and act on the messengers.

| Tool | Mode | Description |
|------|------|-------------|
| `list_services` | read-only | Returns all configured services `{id, name, category}` |
| `get_unread` | read-only | Returns `{service_id: unread_count}` |
| `send_message` | **WRITE — HITL** | Injects text into the active chat's input field. **Requires explicit human approval**: the user sees service + payload and must click APPROVE/DENY in a modal. Auto-denies after 60s. The message is placed in the input but NOT auto-sent — the user presses Enter. |

**HITL compliance:** no LLM-originated write happens without a human
click. This satisfies AGENTS.md §3.5 (Human-in-the-Loop for
severity=critical actions). The MCP server only binds `127.0.0.1`
(§3.1) — it is unreachable from the network.

Connect from any MCP client (Cursor, mens-machinae, raw JSON-RPC):
```
POST http://127.0.0.1:9751
Content-Type: application/json
Accept: application/json, text/event-stream
mcp-session-id: <assigned on initialize>
```

```
┌──────────────┐  IPC      ┌─────────────────┐
│  Renderer    │ ◄────────►│  Main process   │
│  (sidebar +  │           │  ViewManager    │
│   overlay)   │           │  ┌───────────┐  │
└──────────────┘           │  │ WebCV TG  │  │ ← persist:vox-internum-telegram
                           │  │ WebCV VK  │  │ ← persist:vox-internum-vk
                           │  │ WebCV MAX │  │ ← persist:vox-internum-max
                           │  └───────────┘  │
                           └─────────────────┘
```

| Module | Role |
|--------|------|
| `services.ts` | Registry: `{id, label, name, url}` — single source of truth |
| `view-manager.ts` | One `WebContentsView` per service; visibility switching |
| `session-router.ts` | Smart Proxy: parse + `setProxy` per partition + login-handler auth |
| `inquisition.ts` | Firewall: telemetry `onBeforeRequest` block + permission revocation |
| `blocklist.ts` | Suffix-matched telemetry domains (Yandex/GA/Tencent/Mail.ru/Meta) |
| `camouflage.ts` | Strip Electron from UA/Client Hints + camouflage preload path |
| `preload/camouflage.ts` | In-view preload: patches `navigator.webdriver` / `window.chrome` |
| `cleaner.ts` | Per-service CSS injection to strip web-app chrome (VK/MAX/TG) |
| `mcp/server.ts` | MCP Streamable HTTP server on `127.0.0.1:9751`: tools + HITL |
| `storage.ts` | `electron-store` wrapper: `{lastActiveService, proxies}` |
| `index.ts` (main) | Window, tray, IPC, resize-debounce, MCP wiring, lifecycle |

**Key design choice — visibility switching, not recreation.** All views are
created once at startup and live permanently. `switch(id)` only toggles
`setVisible()`. This keeps login sessions warm and avoids reloading on
every tab change.

**Important constraint — `WebContentsView` paints above HTML.** The sidebar
(56px) is the only renderer region that stays visible; the main area is a
"hole". Any HTML overlay (loading screen, future settings) must temporarily
`hideActiveView()` or it will be covered.

## ✗ Security (AGENTS.md compliance)

- **§3.2** — no subprocess execution anywhere in this app.
- **§3.4** — `electron-store` writes only to `app.getPath('userData')`.
- **§3.7** — `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`.
- Per-service `persist:` partitions isolate cookies/cache/localStorage.
- External links open in the user's real browser, not inside a view.
- CSP meta blocks remote script/style injection.
- **Inquisition Firewall** — telemetry cancelled at network level;
  mic/cam/clipboard/notifications denied via permission handlers.

## 🗺 Roadmap (later phases, NOT in this MVP)

- **Auto-payment + auto-issuance** — currently the principal issues keys
  manually after out-of-band payment (crypto / ЮMoney / Boosty). A
  crypto gateway (Cryptomus) or ЮKassa integration would automate this.

*«Astra perpendicularis. Vox intacta.»*
