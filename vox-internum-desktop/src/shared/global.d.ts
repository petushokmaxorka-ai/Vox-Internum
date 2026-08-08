// ═══════════════════════════════════════════════════════════
// VOX INTERNUM — Global type declarations
// ═══════════════════════════════════════════════════════════
// Makes window.electronAPI visible to the renderer's TypeScript.

import type { ElectronAPI } from '../preload/index'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
