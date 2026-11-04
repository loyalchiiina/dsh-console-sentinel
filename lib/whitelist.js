// dsh-console-sentinel — persistent user-managed exemption whitelist.
//
// Two kinds of exemptions the user can maintain without editing the cordis
// config (which is static in cordis.patch.yml):
//   processes: process image names, e.g. "code.exe", "notepad.exe"
//   titles:    window-title substrings
// A window matching either is NEVER auto-hidden/closed by the console path and
// NEVER selected by desktop_windows_cleanup. Persisted as JSON so the list
// survives restarts.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_WHITELIST_PATH = path.join(
  os.homedir(), '.dsh', 'console-sentinel', 'whitelist.json',
)

function normItems(arr) {
  const out = []
  for (const v of Array.isArray(arr) ? arr : []) {
    if (typeof v !== 'string') continue
    const s = v.trim()
    if (!s) continue
    if (!out.includes(s)) out.push(s)
  }
  return out
}

export function emptyWhitelist() {
  return { processes: [], titles: [] }
}

export function sanitizeWhitelist(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return { processes: normItems(r.processes), titles: normItems(r.titles) }
}

export function mergeWhitelists(...lists) {
  const processes = []
  const titles = []
  for (const l of lists) {
    const c = sanitizeWhitelist(l)
    for (const p of c.processes) if (!processes.includes(p)) processes.push(p)
    for (const t of c.titles) if (!titles.includes(t)) titles.push(t)
  }
  return { processes, titles }
}

export function loadWhitelist(file = DEFAULT_WHITELIST_PATH) {
  try {
    return sanitizeWhitelist(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    // Missing or unreadable file is a normal first-run state, not an error.
    return emptyWhitelist()
  }
}

export function saveWhitelist(data, file = DEFAULT_WHITELIST_PATH) {
  const clean = sanitizeWhitelist(data)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n', 'utf8')
  return clean
}

// kind is the canonical plural key: 'processes' | 'titles'.
export function addWhitelistItems(data, kind, items) {
  const base = sanitizeWhitelist(data)
  return mergeWhitelists(base, { [kind]: items })
}

export function removeWhitelistItems(data, kind, items) {
  const base = sanitizeWhitelist(data)
  const key = kind === 'titles' ? 'titles' : 'processes'
  const drop = new Set(normItems(items).map((s) => s.toLowerCase()))
  const out = { processes: base.processes, titles: base.titles }
  out[key] = base[key].filter((v) => !drop.has(v.toLowerCase()))
  return out
}
