// dsh-console-sentinel — auto-hide idle AI/script console windows on Windows.
//
// Problem: long-running harness workflows (Fluent jobs, detached scripts,
// WMI-launched processes) leave PowerShell/Python console windows stacked in
// the taskbar. The user cannot tell which are still working and does not want
// to kill them by hand.
//
// Approach: scan every N seconds with a zero-dependency PowerShell probe
// (user32 + ntdll). Classify each console window by its process parent chain
// (WmiPrvSE = WMI-detached AI job, "DSH Desktop" = harness-host job). Track
// CPU usage per scan; when a window stays under the CPU floor for the idle
// threshold, perform the configured action (hide by default — the process
// keeps running, nothing is lost; restore on demand).
//
// Contract notes: every registration goes through ctx.effect / ctx.tools
// (disposers, HMR-safe). Config is a Schemastery schema; tunables are never
// hardcoded. Windows-only: inert everywhere else (patch-level `disabled` plus
// a runtime guard in apply()). The ledger/idle algorithm is a pure module
// (lib/logic.js) so it can be regression-tested without a live host.

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runProbe, runWindowAction, probeVisibility, supportedActions } from './probe.js'
import { createRequire } from 'node:module'

// 顶层 node:fs / node:path 绑定：隐藏台账需要落盘（见 hiddenFile/hiddenList/hiddenSave）。
// 注意不要用 `fs`/`path` 这两个名字 —— ensureClientGraph 的 fallback 分支里
// 局部声明过同名常量，容易看混。
const sentinelReq = createRequire(import.meta.url)
const nodeFs = sentinelReq('node:fs')
const nodePath = sentinelReq('node:path')
const PLUGIN_VERSION = (() => {
  try { return createRequire(import.meta.url)('dsh-console-sentinel/package.json').version }
  catch (_) { return '0.0.0' }
})()
import { runDesktopCleanup, runDesktopProbe, forceCloseElevated, runElevatedClose, DEFAULT_PROTECTED_PROCESSES } from './desktop.js'
import { collectAiStatus, releaseLocalAi, releasePid } from './ai.js'
import {
  createLedger,
  eligibleForAuto,
  eligibleForSweep,
  isEmptyConsole,
  isExplorerFolderWindow,
  isDesktopShellClass,
  EXPLORER_FOLDER_CLASSES,
  SOURCES,
} from './logic.js'
import {
  loadWhitelist,
  saveWhitelist,
  mergeWhitelists,
  addWhitelistItems,
  removeWhitelistItems,
  emptyWhitelist,
  DEFAULT_WHITELIST_PATH,
} from './whitelist.js'

export const name = 'dsh-console-sentinel'
export const inject = ['tools']

// ---------------------------------------------------------------------------
// Host-process guard — the SAFETY BACKSTOP for any bulk close/hide action.
//
// 🛑 2026-11-08 事故：点「关闭空壳窗口」把 DSH 客户端也关了。原因是从 ledger 里
// 取"空壳"时只按 isEmpty 过滤，没排除宿主自己的进程家族 —— 宿主（Electron /
// 其下 pwsh、node、conhost）里有些控制台窗口恰好"没有业务子进程"，被当成空壳
// 一并 WM_CLOSE，连带把宿主进程树杀掉。
//
// 现在任何批量关闭/隐藏都必须先算出一个"宿主保护集"：宿主进程自身 + 全部祖先
// + 全部后代 + 所有镜像名像 dsh/deepseek/electron 的进程。命中集合的窗口一律跳过。
// ---------------------------------------------------------------------------
let __hostGuardCache = { at: 0, set: null }
function hostProcessGuard(ttlMs = 8000) {
  const now = Date.now()
  if (__hostGuardCache.set && now - __hostGuardCache.at < ttlMs) return __hostGuardCache.set
  const guard = new Set()
  const self = process.pid
  guard.add(self)
  try {
    const req = createRequire(import.meta.url)
    const { execFileSync } = req('node:child_process')
    // One shot: pid|ppid|name for every process.
    const raw = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId,$_.ParentProcessId,$_.Name }"],
      { encoding: 'utf8', timeout: 15000, windowsHide: true })
    const map = new Map() // pid -> { ppid, name }
    for (const line of String(raw).split(/\r?\n/)) {
      const parts = line.trim().split('|')
      if (parts.length < 3) continue
      const pid = Number(parts[0])
      if (!pid) continue
      map.set(pid, { ppid: Number(parts[1]) || 0, name: String(parts[2] || '') })
    }
    const childrenOf = new Map()
    for (const [pid, info] of map) {
      if (!childrenOf.has(info.ppid)) childrenOf.set(info.ppid, [])
      childrenOf.get(info.ppid).push(pid)
    }
    const seed = new Set([self])
    // 1) ancestors of self
    let cur = self
    const upSeen = new Set()
    while (cur && map.has(cur) && !upSeen.has(cur)) {
      upSeen.add(cur); seed.add(cur); cur = map.get(cur).ppid
    }
    // 2) every process whose image looks like DSH / Electron / DeepSeek harness
    for (const [pid, info] of map) {
      const n = String(info.name).toLowerCase()
      if (n.indexOf('dsh') === 0 || n.indexOf('deepseek') >= 0 || n === 'electron.exe' || n === 'electron') {
        seed.add(pid)
      }
    }
    // 3) expand to ALL descendants of every seed (whole DSH tree, wherever we sit)
    const stack = [...seed]
    const seen = new Set(seed)
    for (const p of seed) guard.add(p)
    while (stack.length) {
      const p = stack.pop()
      for (const c of (childrenOf.get(p) || [])) {
        if (!seen.has(c)) { seen.add(c); guard.add(c); stack.push(c) }
      }
    }
  } catch (_) {
    // Could not enumerate: keep at least self. Callers additionally skip
    // source==='dshHost' rows, so a total enumeration failure is still safe.
  }
  __hostGuardCache = { at: now, set: guard }
  return guard
}

// 只有"裸解释器"才允许被批量关闭：cmd / powershell / pwsh / python。
// 显式排除 mpiexec（Fluent MPI）、fluent/ansys/cx* 求解器、node（可能托管服务/中继）、
// launcher 等——这些一旦被关，会杀掉正在计算的 Fluent 或后台服务。
const SAFE_SHELL_NAMES = new Set([
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'python', 'python.exe', 'pythonw', 'pythonw.exe',
])
function isSafeClosableShell(row) {
  const raw = String((row && (row.processName || row.process)) || '').toLowerCase()
  if (!SAFE_SHELL_NAMES.has(raw)) return false
  if (/mpi|fluent|ansys|cx\d|solver|launcher|cae/.test(raw)) return false
  return true
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description(
    'Master switch. When off, no scans run and no actions are taken.',
  ),
  panelOnly: Schema.boolean().default(true).description(
    'Only run while the settings panel is open (2026-11-26 user requirement): ' +
    'no probe on plugin mount, no periodic PowerShell, no background scanning. ' +
    'The panel posts a heartbeat while it is visible; that heartbeat is the ONLY ' +
    'thing that triggers a scan (and therefore the empty-console auto-hide).',
  ),
  scanIntervalSec: Schema.number().default(10).min(5).max(120).step(1).description(
    'Legacy cadence for a background sweep; only used when panelOnly is false.',
  ),
  idleThresholdSec: Schema.number().default(60).min(15).max(3600).step(5).description(
    'Seconds of sustained low CPU before a window is considered finished.',
  ),
  cpuThresholdPct: Schema.number().default(1).min(0).max(50).step(0.5).description(
    'Average CPU percentage below which a window counts as idle.',
  ),
  autoAction: Schema.union([
    Schema.const('none').description('never act automatically; report only'),
    Schema.const('hide').description('hide idle windows (process keeps running)'),
    Schema.const('close').description('send WM_CLOSE to idle windows (releases resources)'),
  ]).default('hide').description(
    'Action taken automatically when an in-scope window goes idle.',
  ),
  probeTimeoutMs: Schema.number().default(20000).min(5000).max(60000).description(
    'Hard timeout for one probe invocation.',
  ),
  spikeTolerance: Schema.number().default(2).min(1).max(5).description(
    'How many consecutive busy samples are needed to reset the idle clock. 2 ' +
    'tolerates single-sample background jitter (a host process such as ' +
    'WindowsTerminal can spike briefly even when all its sessions are idle).',
  ),
  guardForeground: Schema.boolean().default(true).description(
    'Never auto-manage the window the user is currently focused on.',
  ),
  scope: Schema.object({
    wmiDetached: Schema.boolean().default(true).description(
      'Consoles whose parent is WmiPrvSE.exe — WMI-launched detached jobs (unattended Fluent runs).',
    ),
    dshHost: Schema.boolean().default(true).description(
      'Consoles spawned by the DSH Desktop host process.',
    ),
    orphaned: Schema.boolean().default(false).description(
      'Consoles whose parent process has already exited (detached scripts).',
    ),
    emptyConsole: Schema.boolean().default(true).description(
      'Treat an interpreter console (PowerShell/Python/cmd) that has NO workload ' +
      'child process as an empty shell and manage it regardless of its parent ' +
      'chain. This is the safe way to clean up leftover empty PowerShell windows ' +
      'without enabling the whole orphaned scope (which would also match ' +
      'mpiexec / fl2610 / live compute processes).',
    ),
    scriptConsole: Schema.boolean().default(true).description(
      'Consoles whose title is a script executable path (python.exe / powershell.exe / ' +
      'fluent.exe …), e.g. Windows Terminal windows hosting a scripted session. ' +
      'A hand-opened interactive console keeps a prompt-style title and stays unmanaged.',
    ),
    excludeTitles: Schema.array(Schema.string()).default([]).description(
      'Substring blocklist applied to window titles; matched windows are never auto-managed.',
    ),
  }).description('Which console windows are eligible for automatic management.'),
  cleanup: Schema.object({
    protectedProcesses: Schema.array(Schema.string()).default(DEFAULT_PROTECTED_PROCESSES).description(
      'Desktop cleanup never selects windows of these processes (lowercase, without .exe). ' +
      'PowerShell/Python console sessions host long-running jobs (Fluent runs, detached ' +
      'scripts) and are only ever managed through the lossless console path — never closed ' +
      'by a bulk desktop cleanup.',
    ),
    keepTitles: Schema.array(Schema.string()).default([]).description(
      'Extra title substrings the desktop cleanup keeps on top of the protected processes.',
    ),
  }).description('Desktop-wide cleanup (merged from the 一键关闭其他窗口 shortcut).'),
  emptyConsoleAction: Schema.union([
    Schema.const('none').description('leave empty console windows alone'),
    Schema.const('hide').description('hide empty console windows (process keeps running)'),
    Schema.const('close').description('send WM_CLOSE to empty console windows'),
  ]).default('hide').description(
    'Action for empty interpreter consoles (a shell with no workload child), ' +
    'independent of autoAction so leftover empty PowerShell windows can be ' +
    'cleaned up even when other auto-actions are off.',
  ),
  whitelist: Schema.object({
    processes: Schema.array(Schema.string()).default([]).description(
      'Process image names (e.g. "code.exe") that are never auto-managed or ' +
      'bulk-closed. Extendable at runtime via the sentinel_whitelist tool.',
    ),
    titles: Schema.array(Schema.string()).default([]).description(
      'Window-title substrings that are never auto-managed or bulk-closed.',
    ),
    unprotect: Schema.array(Schema.string()).default([]).description(
      'Process image names whose built-in desktop-cleanup protection is lifted, ' +
      'so they CAN be closed by 一键关闭其他窗口. Managed at runtime from the ' +
      'settings panel (taskbar list → 取消保护). Never applies to the DSH host.',
    ),
  }).description('Static exemption list; merged with the runtime-managed whitelist file.'),
})

export function apply(ctx, config) {
  try {
    return applyInner(ctx, config)
  } catch (e) {
    try { ctx.logger('dsh-console-sentinel').error('apply threw: ' + ((e && e.stack) || e)) } catch (_) { /* ignore */ }
  }
}

function applyInner(ctx, config) {
  const logger = ctx.logger('dsh-console-sentinel')
  logger.info('host half mounted (v' + PLUGIN_VERSION + ', platform=' + process.platform + ', enabled=' + String(config.enabled) + ')')
  // The client bundle must be present in the host-side client module graph so
  // the shell can inject it into the settings page. This plugin's loader entry
  // can appear after ClientModuleRegistry did its initial scan, and no later
  // rescan picks it up, so register it explicitly (idempotent, safe to retry).
  const ensureClientGraph = () => {
    try {
      let reg
      try { reg = (ctx.get && ctx.get('clientModules')) || ctx.clientModules } catch (e0) { return }
      if (!reg || !reg.table || typeof reg.compose !== 'function') return
      if (reg.table.has('dsh-console-sentinel')) return
      const entry = [...ctx.loader.entries()].find((e) => e && e.options && e.options.name === 'dsh-console-sentinel')
      if (!entry) { logger.warn('client module graph: loader entry not found'); return }
      const loaderName = 'dsh-console-sentinel'
      const baseUrl = entry && entry.parent && entry.parent.tree && entry.parent.tree.ctx && entry.parent.tree.ctx.baseUrl
      // Drop any stale negative cache from an earlier (idle) scan, then resolve again.
      if (reg.pkgMeta && typeof reg.pkgMeta.clear === 'function') reg.pkgMeta.clear()

      let src
      let how = 'resolveSource'
      try { src = reg.resolveSource(entry) } catch (eR) { src = undefined; how = 'resolveSource-threw:' + ((eR && eR.message) || String(eR)) }
      if (!src) {
        // Fallback: build the source record ourselves from this package's manifest.
        how = 'manual'
        const req = createRequire(import.meta.url)
        const fs = req('node:fs')
        const path = req('node:path')
        const pkgPath = req.resolve('dsh-console-sentinel/package.json')
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        const rel = (pkg && pkg.exports && pkg.exports['./client']) || './lib/client.js'
        const clientRel = typeof rel === 'string' ? rel : (rel.default || rel.import || './lib/client.js')
        src = {
          packageName: loaderName,
          loaderName,
          baseUrl,
          sourceKey: (typeof reg.sourceKey === 'function' ? reg.sourceKey(loaderName, baseUrl) : ('manual:' + loaderName + ':' + String(baseUrl || ''))),
          meta: {
            clientPath: path.join(path.dirname(pkgPath), clientRel),
            inject: (pkg && pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || [],
            external: (pkg && pkg.dsh && pkg.dsh.client && pkg.dsh.client.external) || [],
            immediately: Boolean(pkg && pkg.dsh && pkg.dsh.client && pkg.dsh.client.immediately),
          },
        }
      }
      if (reg.sources && typeof reg.sources.set === 'function') reg.sources.set(src.sourceKey, src)
      reg.reconcilePackage(loaderName)
      let composed = null
      try { composed = reg.compose(); reg.composed = composed } catch (eC) { logger.warn('client graph compose failed: ' + ((eC && eC.message) || String(eC))) }
      if (typeof reg.notifyGraphChanged === 'function') reg.notifyGraphChanged()
      let registered = reg.table.has(loaderName)
      if (!registered) {
        // Last resort: let the registry's own scanner do it now that the cache is clean.
        const errs = []
        try { reg.dirty.add(loaderName); reg.flush((e) => errs.push(String((e && e.message) || e))) } catch (eF) { errs.push('THREW ' + String((eF && eF.message) || eF)) }
        registered = reg.table.has(loaderName)
        if (!registered) logger.warn('client module graph: could not register (via=' + how + ') errs=' + JSON.stringify(errs))
      }
      if (registered) logger.info('client module graph: registered (via=' + how + ')')
    } catch (e) {
      logger.warn('client graph ensure failed: ' + ((e && e.stack) || String(e)))
    }
  }
  setTimeout(ensureClientGraph, 1500)
  setTimeout(ensureClientGraph, 6000)
  setTimeout(ensureClientGraph, 12000)

  if (process.platform !== 'win32') {
    logger.warn('Windows-only plugin; staying inert on ' + process.platform)
    return
  }
  if (!config.enabled) {
    logger.info('disabled by config; no scans will run')
    return
  }

  const ledger = createLedger()

  // User-managed exemption list (persisted JSON at DEFAULT_WHITELIST_PATH).
  // Merged with the static config whitelist on every read, so tool edits take
  // effect immediately without editing cordis.patch.yml or restarting.
  let userWhitelist = loadWhitelist()
  const effectiveConfig = () => ({
    ...config,
    whitelist: mergeWhitelists(config.whitelist, userWhitelist),
  })
  let scanning = false
  let scanCount = 0
  let lastScanAt = 0
  // last known foreground hwnd, refreshed by scan(); tools consult it so an
  // explicit action on the focused window needs `force`
  let currentForeground = 0

  // Separate registry of Explorer folder windows (CabinetWClass / ExploreWClass).
  // These are NOT console windows, so the console probe never emits them; they
  // are enumerated via runDesktopProbe (all visible top-level windows) and kept
  // here as a lightweight, closable set. Each is closable at the hwnd level with
  // WM_CLOSE WITHOUT killing explorer.exe (folder windows share explorer's pid).
  let folderWindows = []
  let folderWindowsAt = 0
  async function refreshFolderWindows() {
    // runDesktopProbe spawns a fresh PowerShell (~350 ms); a rapid scan or
    // status-poll must not re-spawn it on every call. 1s min gap.
    if (folderWindowsAt && Date.now() - folderWindowsAt < 1000) return
    try {
      const probe = await runDesktopProbe(config.probeTimeoutMs || 20000)
      if (!probe || !probe.ok) return
      const hostSet = hostProcessGuard()
      const list = []
      for (const raw of probe.windows || []) {
        const w = {
          hwnd: Number(raw.hwnd ?? raw.Hwnd),
          pid: Number(raw.pid ?? raw.Pid),
          class: String(raw.class ?? raw.Class ?? ''),
          title: String(raw.title ?? raw.Title ?? ''),
          process: String(raw.process ?? raw.Process ?? ''),
        }
        if (!w.hwnd) continue
        const rec = { hwnd: w.hwnd, pid: w.pid, class: w.class, title: w.title, processName: w.process }
        if (!isExplorerFolderWindow(rec)) continue              // explorer folder window only; shell classes rejected here
        if (hostSet.has(w.pid)) continue                        // never a DSH/Electron-owned folder
        list.push({
          hwnd: w.hwnd, pid: w.pid, class: w.class, title: w.title,
          processName: w.process, source: 'manual', visible: true,
          hidable: false, closable: true,
        })
      }
      folderWindows = list
      folderWindowsAt = Date.now()
    } catch (e) { /* keep last known list; a transient probe failure is not fatal */ }
  }

  // Hide-failure ledger for log de-noising (v1.3.4). One badge per hwnd: the
  // first failure is the one worth reading in full, later attempts are counted
  // and summarised, so a window that refuses to hide can no longer flood the
  // log with one identical line every scan for an hour (measured 2026-11-13:
  // 208 identical `reason=unknown` lines in exactly one hour).
  const hideFailAgg = new Map()   // hwnd -> { firstAt, count, lastWarnAt }
  const HIDE_AGG_WINDOW_MS = 10 * 60 * 1000
  const HIDE_AGG_COUNT = 60

  async function actOn(rec, action, opts = {}) {
    const res = await runWindowAction(rec.hwnd, action)
    if (res.ok) {
      // A successful action clears the failure ledger: the window is provably
      // hideable again, so it must not stay behind an exponential backoff.
      rec.failCount = 0
      rec.lastFailReason = null
      rec.lastFailAt = 0
      rec.nextEligibleAt = 0
      rec.unhideableUntil = 0
      hideFailAgg.delete(rec.hwnd)
      // Trust the probe's VERIFIED post-state, not our own intent. The action
      // script reports `afterVisible` / `stillWindow` measured after the call,
      // so the ledger can no longer claim "hidden" for a window that is gone,
      // or for one whose handle was re-created between scan and action.
      // (2026-09-23 实证: 台账曾把「窗口已销毁」与「已隐藏」混为一谈，
      //  导致汇报"隐藏 13 个"里混入 4 个已销毁窗口。)
      const stillWindow = res.stillWindow !== false
      const afterVisible = res.afterVisible
      rec.destroyed = !stillWindow
      if (!stillWindow) {
        // The window no longer exists — this is NOT a successful hide.
        rec.hidden = false
        rec.closed = true
      } else {
        if (typeof afterVisible === 'boolean') rec.visible = afterVisible
        if (action === 'hide') rec.hidden = !afterVisible
        if (action === 'close') { rec.closed = true; rec.hidden = !afterVisible }
        if (action === 'show' || action === 'restore') rec.hidden = afterVisible === false
        if (action === 'minimize') rec.hidden = false
        // 落盘台账：插件隐藏过谁，必须记住，否则 DSH 一重启它就永久消失了。
        if (rec.hidden === true) hiddenAdd({ hwnd: rec.hwnd, title: rec.title })
        else hiddenRemove(rec.hwnd)
      }
      ctx.emit('console-sentinel/action', {
        hwnd: rec.hwnd, title: rec.title, pid: rec.pid, source: rec.source,
        action, automatic: Boolean(opts.automatic), ok: true, detail: res,
        destroyed: !stillWindow,
      })
      logger.info(
        (opts.automatic ? 'auto-' : '') + action + ' ok: ' +
        'hwnd=0x' + rec.hwnd.toString(16) + ' pid=' + rec.pid +
        ' source=' + rec.source + ' idle=' + Math.round(rec.idleSec) + 's' +
        ' visibleAfter=' + String(afterVisible) + ' stillWindow=' + String(stillWindow) +
        ' title=' + rec.title.slice(0, 60),
      )
    } else {
      // A failed action must not leave a stale "hidden" claim behind.
      const staleHandle = res.reason === 'hwnd-not-a-window'
      if (staleHandle) { rec.destroyed = true; rec.hidden = false; rec.closed = true }
      ctx.emit('console-sentinel/action', {
        hwnd: rec.hwnd, title: rec.title, pid: rec.pid, source: rec.source,
        action, automatic: Boolean(opts.automatic), ok: false, reason: res.reason,
      })
      const failReason = res.reason ?? 'unknown'
      const nowMs = Date.now()
      // Failure memory + exponential backoff (v1.3.4). Before this, a window
      // that simply refuses SW_HIDE kept `rec.hidden === false`, so every scan
      // selected it again — the same hwnd was retried every 10 s for an hour.
      // A vanished handle is NOT a hide failure: it is already resolved as
      // destroyed, so it must not accrue backoff or cool-down.
      if (!staleHandle) {
        rec.failCount = (rec.failCount || 0) + 1
        rec.lastFailReason = failReason
        rec.lastFailAt = nowMs
        const baseMs = Math.max(1, config.scanIntervalSec) * 1000
        rec.nextEligibleAt = nowMs + Math.min(baseMs * Math.pow(2, rec.failCount - 1), 10 * 60 * 1000)
        if (rec.failCount >= 3) rec.unhideableUntil = nowMs + 30 * 60 * 1000
      }
      const failMsg =
        (opts.automatic ? 'auto-' : '') + action + ' failed: ' +
        'hwnd=0x' + rec.hwnd.toString(16) +
        ' reason=' + failReason +
        ' pid=' + rec.pid +
        ' title=' + String(rec.title || '').slice(0, 60) +
        ' class=' + String(res.class ?? rec.class ?? '') +
        ' failCount=' + (rec.failCount || 0)
      const agg = hideFailAgg.get(rec.hwnd)
      if (!agg) {
        // First failure of this hwnd: the one line that carries full identity.
        logger.warn(failMsg + ' elevated=' + String(res.elevated ?? 'unknown'))
        hideFailAgg.set(rec.hwnd, { firstAt: nowMs, count: 1, lastWarnAt: nowMs })
      } else {
        agg.count += 1
        if (nowMs - agg.lastWarnAt >= HIDE_AGG_WINDOW_MS || agg.count >= HIDE_AGG_COUNT) {
          logger.warn(
            'auto-hide still failing: hwnd=0x' + rec.hwnd.toString(16) +
            ' reason=' + failReason + ' retries=' + agg.count +
            ' since=' + new Date(agg.firstAt).toISOString().slice(11, 19) +
            ' title=' + String(rec.title || '').slice(0, 60),
          )
          agg.count = 0
          agg.lastWarnAt = nowMs
        } else {
          logger.debug(failMsg)
        }
      }
    }
    return res
  }

  // --- hidden-window restore bookkeeping (zero-cost, pure JS) --------------
  // 插件自己隐藏过的窗口必须由插件自己恢复：1.4.x 只在内存里记 hwnd，DSH 一重启，
  // 之前 hide 掉的空壳/文件夹窗口就再也回不来了。这里落盘一份 (hwnd, title)，
  // 每次扫描前（省电模式下由面板心跳触发）比对一次：还在的直接 ShowWindow 还原，
  // 已消失的从台账里删掉，避免"补显"动作反过来把用户又想隐藏的窗口拉出来。
  function hiddenFile() {
    const root = process.env.DSH_HOME || (process.env.USERPROFILE ? process.env.USERPROFILE + '/.dsh-official' : '')
    return nodePath.join(root, 'console-sentinel-hidden.json')
  }
  function hiddenList() {
    try {
      const raw = nodeFs.readFileSync(hiddenFile(), 'utf8')
      const arr = JSON.parse(raw)
      return Array.isArray(arr) ? arr : []
    } catch (_) { return [] }
  }
  function hiddenSave(list) {
    try {
      const file = hiddenFile()
      nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true })
      nodeFs.writeFileSync(file, JSON.stringify(list.slice(-400), null, 0), 'utf8')
    } catch (e) { logger.debug('hidden ledger write failed: ' + ((e && e.message) || e)) }
  }
  function hiddenAdd(row) {
    const hwnd = Number(row && row.hwnd)
    if (!hwnd) return
    const list = hiddenList().filter((r) => Number(r.hwnd) !== hwnd)
    list.push({ hwnd, title: String((row && row.title) || ''), at: Date.now() })
    hiddenSave(list)
  }
  function hiddenRemove(hwnd) {
    const h = Number(hwnd)
    const list = hiddenList()
    const next = list.filter((r) => Number(r.hwnd) !== h)
    if (next.length !== list.length) hiddenSave(next)
  }
  let restoreChecked = false
  async function checkRestore() {
    if (restoreChecked) return
    restoreChecked = true
    const list = hiddenList()
    if (!list.length) return
    let truth = null
    try { truth = await probeVisibility(list.map((r) => Number(r.hwnd))) } catch (_) { truth = null }
    if (!truth) { logger.warn('restore sweep skipped: visibility probe failed'); return }
    const keep = []
    let back = 0
    let gone = 0
    for (const row of list) {
      const hwnd = Number(row.hwnd)
      const state = truth[hwnd]
      if (state === true) {
        // 用户自己把它弄回来了 → 台账清掉即可，不要再动窗口
        continue
      }
      if (state === false) {
        // 仍是「我们隐藏」的状态 → 还原它（这正是 1.4.2 丢掉的补显）
        try { await runWindowAction(hwnd, 'show'); back++ } catch (_) { keep.push(row) }
        continue
      }
      // truth 里没有这个 hwnd：窗口已销毁 → 丢台账
      gone++
    }
    hiddenSave(keep)
    logger.info('restore sweep: restored=' + back + ' kept=' + keep.length + ' gone=' + gone)
  }

  async function scan() {
    if (scanning) return
    scanning = true
    scanCount++
    lastScanAt = Date.now()
    // 补显上次插件隐藏过、但现在还活着的窗口（DSH 重启后 hwnd 会换，这里的
    // probeVisibility 只查台账里那几个，代价远小于整轮探测；失败就跳过）。
    try { await checkRestore() } catch (e) { logger.debug('restore sweep failed: ' + ((e && e.message) || e)) }
    try {
      // 不传 tracePids：这是常态扫描，必须零 WMI（本机 WMI 单条也要 7.3 s）。
      const res = await runProbe(config.probeTimeoutMs)
      if (!res.ok) {
        logger.warn('probe failed: ' + (res.reason ?? 'unknown') + (res.stderr ? ' | ' + res.stderr.slice(-300) : ''))
        return
      }
      const now = Date.now()
      currentForeground = res.fgHwnd || currentForeground

      const { added } = ledger.update({
        ...res,
        cpuThresholdPct: config.cpuThresholdPct,
        spikeTolerance: config.spikeTolerance,
      }, now)
      for (const rec of added) {
        logger.debug('tracked hwnd=0x' + rec.hwnd.toString(16) + ' pid=' + rec.pid +
          ' source=' + rec.source + ' title=' + rec.title.slice(0, 60))
      }

      // Explorer folder windows live outside the console probe; refresh their
      // closable set alongside the ledger so statusPayload() can list them.
      await refreshFolderWindows()

      const eff = effectiveConfig()
      const autoOn = config.autoAction !== 'none'
      const emptyOn = config.scope?.emptyConsole === true &&
        config.emptyConsoleAction && config.emptyConsoleAction !== 'none'
      if (autoOn || emptyOn) {
        for (const rec of [...ledger.records.values()]) {
          if (!eligibleForAuto(rec, res.fgHwnd, eff)) continue
          let action = config.autoAction
          if (isEmptyConsole(rec) && emptyOn) action = config.emptyConsoleAction
          if (!action || action === 'none') continue
          await actOn(rec, action, { automatic: true })
        }
      }

      ctx.emit('console-sentinel/scan', {
        at: now,
        windows: ledger.snapshot(),
        autoAction: config.autoAction,
      })
    } catch (err) {
      logger.warn('scan loop error: ' + (err && err.message ? err.message : String(err)))
    } finally {
      scanning = false
    }
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
        if (data.length > 1 << 20) { reject(new Error('body too large')); req.destroy(); return }
      })
      req.on('end', () => {
        if (!data) { resolve({}); return }
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
      req.on('error', reject)
    })
  }

  // --- scan scheduler (registration = effect) --------------------------------

  // MANUAL-ONLY MODE (2026-11-26).
  // 用户要求「不可自动刷新，只允许手动刷新」：不再挂任何后台扫描定时器。
  // 旧实现每 scanIntervalSec(默认 10s) 起一次 PowerShell 探测（一次枚举全部窗口
  // + 采样 CPU），两个定时器（scanTimer / supervisorTimer）叠加客户端每 3s 的
  // 自动刷新，是客户端变卡的来源。
  // 现在的扫描触发点全部是「有人要数据」时：
  //   ① 面板心跳（POST /panel-beat，只在设置面板可见时发）—— 唯一的常态触发点；
  //   ② 每个 HTTP 路由（/status 每次都给最新、/scan、各类操作后）；
  //   ③ 宿主工具被调用前。
  // 2026-11-26 用户口径细化：「我只在打开设置界面的时候用这个插件，不打开时希望它
  // 完全不运行」。所以连挂载那一次扫描也删掉了 —— 见 panelOnly 配置项。
  // 自动动作（autoAction / emptyConsoleAction）因此也变成「手动操作时顺带执行」，
  // 不会在用户不操作时自己动窗口 —— 与「只允许手动」一致。
  const STALE_MS = 5000
  let scanInFlight = null
  // Idempotent + coalesced: concurrent callers share one probe instead of
  // stacking PowerShell processes. TTL skips a probe when the ledger is fresh.
  const ensureFreshScan = (maxAgeMs, ignoreTtl) => {
    if (!ignoreTtl && maxAgeMs > 0 && lastScanAt && Date.now() - lastScanAt < maxAgeMs) return Promise.resolve()
    if (scanInFlight) return scanInFlight
    scanInFlight = scan()
      .catch(() => { /* scan() logs internally */ })
      .finally(() => { scanInFlight = null })
    return scanInFlight
  }
  // 挂载不再扫描：panelOnly=true 时，插件在面板打开前连一次 PowerShell 都不起。
  if (config.panelOnly === false) {
    ensureFreshScan(0)
    logger.info('apply: panelOnly=false -> first sweep on mount (legacy behaviour)')
  } else {
    logger.info('apply: panelOnly=true -> idle until the settings panel sends its first heartbeat')
  }

  // --- tools ------------------------------------------------------------------

  try {
  // 本地 AI 显存：查 + 释放。默认 dryRun（只报候选），显式传 dryRun:false 才动手。
  // 只结束真正占显存的模型服务 —— 网关不参与（用户明确要求）。
  ctx.tools.register(defineTool({
    name: 'ai_release_local_vram',
    description:
      'Inspect or reclaim local-AI VRAM on this Windows host. Lists local model servers ' +
      '(llama.cpp / Ollama / LM Studio / vLLM / ComfyUI / MOSS / YuE2 / MiniMax H3 / voice ' +
      'cloning ...) that actually hold VRAM, then releases them GRACEFULLY so the next use ' +
      'still works: L1 HTTP unload (ComfyUI POST /free, Ollama keep_alive=0 — the service ' +
      'keeps running), L2 WM_CLOSE, and only as a last resort L3 force kill. ' +
      'Identification is generic — driven by the nvidia-smi compute-apps PID list plus ' +
      'process-name/path rules plus a fallback bucket for unrecognized GPU holders — so a ' +
      'deployment in any directory on any machine is recognized. Local AI gateways ' +
      '(tier_router / Agent2API / magpie ...) are never listed and never stopped: they hold ' +
      'no VRAM. Defaults to a dry run that only reports candidates — pass dryRun:false to ' +
      'actually release. The DSH host, Electron, Node runtimes, Fluent, Ansys, MPI and ' +
      'SpaceClaim are always protected.',
    parameters: {
      dryRun: { type: 'boolean', description: 'report candidates only, kill nothing (default true)' },
      mode: { type: 'string', enum: ['graceful', 'unload', 'stop'], description: 'graceful (default): HTTP unload -> WM_CLOSE -> force; unload: only HTTP unload, service keeps running; stop: skip HTTP unload and close the service' },
      gpuOnly: { type: 'boolean', description: 'only release model processes that appear in the GPU compute list (default true)' },
      protectPids: { type: 'array', items: { type: 'number' }, description: 'pid list to keep alive' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          gpuOnly: { type: 'boolean' },
          mode: { type: 'string' },
          freedMiB: { type: 'number' },
          vramBeforeMiB: { type: 'number' },
          vramAfterMiB: { type: 'number' },
          candidates: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                pid: { type: 'number' }, name: { type: 'string' }, kind: { type: 'string' },
                label: { type: 'string' }, usedMiB: { type: 'number' },
              },
            },
          },
          killed: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                pid: { type: 'number' }, name: { type: 'string' }, label: { type: 'string' },
                method: { type: 'string' }, alive: { type: 'boolean' }, detail: { type: 'string' },
              },
            },
          },
          failed: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                pid: { type: 'number' }, name: { type: 'string' }, label: { type: 'string' },
                method: { type: 'string' }, reason: { type: 'string' },
              },
            },
          },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.dryRun ? '[dry-run] ' : '') +
          'VRAM ' + value.vramBeforeMiB + ' -> ' + value.vramAfterMiB + ' MiB (freed ' + value.freedMiB + ' MiB), ' +
          'candidates ' + value.candidates.length + ', released ' + value.killed.length + ', failed ' + value.failed.length +
          (value.killed.length
            ? '\n' + value.killed.map((k) => '  ' + k.label + ' (pid ' + k.pid + '): ' + k.method +
                (k.alive ? ' — 服务仍在运行，模型已卸载' : ' — 服务已退出') +
                (k.detail ? ' — ' + k.detail : '')).join('\n')
            : '') +
          (value.notes.length ? '\n' + value.notes.join('\n') : ''),
      }],
    },
    async execute(args = {}) {
      const dryRun = args.dryRun === undefined ? true : Boolean(args.dryRun)
      const mode = ['graceful', 'unload', 'stop'].includes(args.mode) ? args.mode : 'graceful'
      const gpuOnly = args.gpuOnly !== false
      const result = await releaseLocalAi({
        dryRun,
        mode,
        gpuOnly,
        protectPids: Array.isArray(args.protectPids) ? args.protectPids : [],
      })
      const beforeUsed = (result.before && result.before.totals && result.before.totals.usedMiB) || 0
      const afterUsed = (result.after && result.after.totals && result.after.totals.usedMiB) || 0
      const notes = []
      for (const p of ((result.before && result.before.processes) || [])) {
        if (p.protected) notes.push('受保护已跳过: ' + p.name + ' (' + p.pid + ')')
      }
      const unknownLeft = ((result.after && result.after.processes) || []).filter((p) => p.kind === 'unknown' && p.onGpu)
      if (unknownLeft.length) {
        notes.push('仍有 ' + unknownLeft.length + ' 个「未识别的本地模型」占着显存 —— 需要逐行手动释放（面板里点「结束」）')
      }
      return {
        ok: Boolean(result.ok),
        dryRun,
        gpuOnly,
        mode,
        freedMiB: Math.round(result.freedMiB || 0),
        vramBeforeMiB: Math.round(beforeUsed),
        vramAfterMiB: Math.round(afterUsed),
        candidates: (result.candidates || []).map((p) => ({ pid: p.pid, name: String(p.name || ''), kind: String(p.kind || 'other'), label: String(p.label || ''), usedMiB: Math.round(p.usedMiB || 0) })),
        killed: (result.killed || []).map((p) => ({ pid: p.pid, name: String(p.name || ''), label: String(p.label || ''), method: String(p.method || ''), alive: Boolean(p.alive), detail: String(p.detail || '') })),
        failed: (result.failed || []).map((p) => ({ pid: p.pid, name: String(p.name || ''), label: String(p.label || ''), method: String(p.method || ''), reason: String(p.reason || '') })),
        notes,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'console_windows_list',
    description:
      'List console windows (PowerShell/Python/cmd/terminal) currently tracked ' +
      'on this Windows host, with idle state and origin classification. Use this ' +
      'to see which black console windows are still busy versus finished before ' +
      'hiding or closing them.',
    parameters: {
      includeHidden: {
        type: 'boolean',
        description: 'include windows this plugin already hid (default true)',
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hwnd: { type: 'number' },
            class: { type: 'string' },
            title: { type: 'string' },
            pid: { type: 'number' },
            processName: { type: 'string' },
            parentName: { type: 'string' },
            source: { type: 'string', enum: SOURCES },
            visible: { type: 'boolean' },
            hidden: { type: 'boolean' },
            destroyed: { type: 'boolean' },
            cpuPct: { type: 'number' },
            idleSec: { type: 'number' },
            childCount: { type: 'number' },
            isEmpty: { type: 'boolean' },
            firstSeen: { type: 'number' },
            trace: {
              type: 'object',
              additionalProperties: true,
              properties: {
                cmd: { type: 'string' },
                created: { type: 'string' },
                parent: { type: 'string' },
                chain: { type: 'array', items: { type: 'string' } },
                script: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.length === 0
          ? 'No console windows tracked.'
          : value.map((w) =>
            (w.destroyed ? '[gone]   ' : w.hidden ? '[hidden] ' : w.isEmpty ? '[empty]  ' : w.idleSec > 0 ? '[idle]   ' : '[busy]   ') +
            'hwnd=' + w.hwnd + ' pid=' + w.pid + ' ' + w.processName +
            ' <- ' + (w.parentName || '?') + ' (' + w.source + ')' +
            ' cpu=' + w.cpuPct + '% idle=' + w.idleSec + 's kids=' + w.childCount +
            ' | ' + w.title.slice(0, 70),
          ).join('\n'),
      }],
    },
    async execute(args) {
      // Ground-truth pass before reporting: ask the probe for each tracked
      // window's CURRENT IsWindowVisible, so "[hidden]" can only ever be printed
      // for a window that is genuinely not visible right now. Without this the
      // list reflects what the plugin once did, not what the user can see
      // (2026-09-23 实证: 台账曾漏报一个仍可见的 Windows Terminal 窗口).
      const includeHidden = args.includeHidden !== false
      const tracked = ledger.snapshot({ includeHidden })
      const truth = await probeVisibility(tracked.map((w) => w.hwnd))
      if (truth) {
        ledger.reconcileVisibility(truth)
        for (const w of tracked) {
          const actual = truth[w.hwnd]
          if (actual === undefined) { w.destroyed = true; w.hidden = false; w.visible = false }
          else { w.visible = Boolean(actual); w.hidden = !actual }
        }
      }
      return tracked
    },
  }))

  ctx.tools.register(defineTool({
    name: 'console_window_action',
    description:
      'Hide, show, minimize, restore, or close one console window. Prefer hide ' +
      '(the process keeps running; nothing is lost). close sends WM_CLOSE and ' +
      'may lose unsaved output. Identify the window with either its hwnd or pid ' +
      '(from console_windows_list).',
    parameters: {
      hwnd: {
        type: 'number',
        description: 'window handle from console_windows_list',
      },
      pid: {
        type: 'number',
        description: 'process id (first matching window is used)',
      },
      action: {
        type: 'string',
        enum: supportedActions,
        required: true,
        description: 'hide | show | minimize | restore | close',
      },
      force: {
        type: 'boolean',
        description: 'bypass the foreground guard (act even if this window is focused)',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          hwnd: { type: 'number' },
          action: { type: 'string' },
          title: { type: 'string' },
          reason: { type: 'string' },
          detail: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? value.action + ' ok on hwnd=' + value.hwnd + ' | ' + value.title.slice(0, 70)
          : value.action + ' failed on hwnd=' + value.hwnd + ': ' + (value.reason ?? 'unknown'),
      }],
    },
    async execute(args) {
      const rec = ledger.findByTarget(args)
      if (!rec) {
        return {
          ok: false,
          hwnd: Number(args.hwnd ?? 0),
          action: args.action,
          title: '',
          reason: 'window-not-found (run console_windows_list first)',
        }
      }
      if (!args.force && config.guardForeground && rec.hwnd === currentForeground) {
        return {
          ok: false,
          hwnd: rec.hwnd,
          action: args.action,
          title: rec.title,
          reason: 'window-is-foreground (pass force to override)',
        }
      }
      const res = await actOn(rec, args.action, { automatic: false })
      // `reason` must be OMITTED on success, never set to undefined: the tool's
      // output schema declares it as a string, so an explicit `undefined` fails
      // validation and the runtime drops the whole result — the caller sees
      // "invalid output / value is not lossless JSON" even though the action
      // succeeded. Build the object conditionally instead (2026-09-23 实证).
      const out = {
        ok: Boolean(res.ok),
        hwnd: rec.hwnd,
        action: args.action,
        title: rec.title,
        detail: res,
      }
      if (!res.ok && res.reason !== undefined) out.reason = String(res.reason)
      return out
    },
  }))

  ctx.tools.register(defineTool({
    name: 'console_windows_sweep',
    description:
      'Act on every idle in-scope console window at once (default action: hide). ' +
      'Use after a batch of Fluent jobs to clear the taskbar in one step.',
    parameters: {
      action: {
        type: 'string',
        enum: supportedActions.filter((a) => a !== 'show' && a !== 'restore' && a !== 'minimize'),
        description: 'hide | close (defaults to the plugin autoAction config)',
      },
      minIdleSec: {
        type: 'number',
        description: 'override the idle threshold for this sweep',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          acted: { type: 'array', items: { type: 'number' } },
          actedCount: { type: 'number' },
          skippedCount: { type: 'number' },
          action: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'sweep ' + value.action + ': acted ' + value.actedCount + ' window(s)' +
          (value.acted.length ? ' [' + value.acted.join(',') + ']' : '') +
          ', skipped ' + value.skippedCount,
      }],
    },
    async execute(args, exec) {
      const action = args.action || config.autoAction
      if (action === 'none' || !action) {
        return { acted: [], actedCount: 0, skippedCount: 0, action: 'none' }
      }
      const threshold = args.minIdleSec && args.minIdleSec > 0
        ? args.minIdleSec
        : config.idleThresholdSec
      const acted = []
      let skipped = 0
      for (const rec of [...ledger.records.values()]) {
        if (exec?.signal?.aborted) break
        if (!eligibleForSweep(rec, threshold, config)) { skipped += 1; continue }
        const res = await actOn(rec, action, { automatic: false })
        if (res.ok) acted.push(rec.hwnd)
        else skipped += 1
      }
      return { acted, actedCount: acted.length, skippedCount: skipped, action }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_windows_cleanup',
    description:
      'Close other desktop application windows in one step (merged from the ' +
      '一键关闭其他窗口 desktop shortcut). PowerShell / Python (and any process in ' +
      'cleanup.protectedProcesses) are NEVER selected — console sessions hosting ' +
      'long-running jobs must go through console_windows_sweep instead. Returns a ' +
      'dry-run plan unless confirm=true.',
    parameters: {
      confirm: {
        type: 'boolean',
        description: 'actually close the planned windows (default: dry run, list only)',
      },
      keepTitle: {
        type: 'array',
        items: { type: 'string' },
        description: 'extra title substrings to keep, on top of protected processes',
      },
      keepPid: {
        type: 'array',
        items: { type: 'number' },
        description: 'extra pids to keep',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          reason: { type: 'string' },
          planned: { type: 'array', items: { type: 'string' } },
          plannedCount: { type: 'number' },
          keptProtected: { type: 'array', items: { type: 'string' } },
          closed: { type: 'array', items: { type: 'string' } },
          closedCount: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? (value.dryRun ? 'DRY RUN ' : 'EXECUTED ') + 'desktop cleanup: ' +
            value.plannedCount + ' window(s) eligible' +
            (value.keptProtected.length ? ', kept (protected): ' + value.keptProtected.join('; ') : '') +
            (!value.dryRun ? ', closed ' + value.closedCount : '') +
            (value.planned.length ? '\n' + value.planned.join('\n') : '')
          : 'desktop cleanup failed: ' + (value.reason ?? 'unknown'),
      }],
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) return { ok: false, dryRun: true, reason: 'aborted', planned: [], plannedCount: 0, keptProtected: [], closed: [], closedCount: 0 }
      const res = await runDesktopCleanup({
        confirm: Boolean(args.confirm),
        selfPid: process.pid,
        protectedProcesses: [
          ...(config.cleanup?.protectedProcesses || []),
          ...userWhitelist.processes,
        ],
        keepTitles: [
          ...(config.cleanup?.keepTitles || []),
          ...userWhitelist.titles,
          ...(args.keepTitle || []),
        ],
        keepPids: args.keepPid || [],
      })
      const fmt = (w) => 'hwnd=' + w.hwnd + ' pid=' + w.pid + ' [' + (w.process || '?') + '] ' + (w.title || '').slice(0, 70)
      const keptProtected = (res.kept || [])
        .filter((k) => k.keepReason === 'protected-process')
        .map(fmt)
      if (res.ok) {
        ctx.emit('console-sentinel/desktop-cleanup', {
          dryRun: res.dryRun, plannedCount: (res.targets || []).length,
          keptProtectedCount: keptProtected.length, closedCount: (res.closed || []).length,
        })
      }
      // Same `undefined`-vs-schema defect as console_window_action (2026-09-23
      // 实证): an explicit `reason: undefined` on the success path fails the
      // declared-string schema and the runtime drops the whole result. This is
      // the tool's NORMAL path (a dry-run plan), so the bug hit every call.
      const out = {
        ok: Boolean(res.ok),
        dryRun: Boolean(res.dryRun),
        planned: (res.targets || []).map(fmt),
        plannedCount: (res.targets || []).length,
        keptProtected,
        closed: (res.closed || []).map(fmt),
        closedCount: (res.closed || []).length,
      }
      if (!res.ok && res.reason !== undefined) out.reason = String(res.reason)
      return out
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sentinel_whitelist',
    description:
      'Manage the persistent exemption whitelist — software that must never be ' +
      'auto-hidden/closed by the console sentinel nor closed by desktop cleanup. ' +
      'kind=process matches process image names (e.g. "code.exe"); kind=title ' +
      'matches window-title substrings. Persisted to ' + DEFAULT_WHITELIST_PATH + '.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'remove', 'reset'],
        description: 'list (default) | add | remove | reset',
      },
      kind: {
        type: 'string',
        enum: ['process', 'title'],
        description: 'process (default) matches image names; title matches title substrings',
      },
      items: {
        type: 'array',
        items: { type: 'string' },
        description: 'entries to add/remove for the chosen kind',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          processes: { type: 'array', items: { type: 'string' } },
          titles: { type: 'array', items: { type: 'string' } },
          count: { type: 'number' },
          path: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? 'whitelist (' + value.count + '): processes=[' + value.processes.join(', ') + ']' +
            ' titles=[' + value.titles.join(', ') + ']  -> ' + value.path
          : 'whitelist ' + value.action + ' failed: ' + (value.reason ?? 'unknown'),
      }],
    },
    async execute(args) {
      const act = args.action || 'list'
      const kind = args.kind === 'title' ? 'titles' : 'processes'
      const items = Array.isArray(args.items) ? args.items : []
      if (act === 'add' && items.length === 0) {
        return {
          ok: false, action: act,
          processes: userWhitelist.processes, titles: userWhitelist.titles,
          count: userWhitelist.processes.length + userWhitelist.titles.length,
          path: DEFAULT_WHITELIST_PATH, reason: 'no-items',
        }
      }
      if (act === 'add') userWhitelist = addWhitelistItems(userWhitelist, kind, items)
      else if (act === 'remove') userWhitelist = removeWhitelistItems(userWhitelist, kind, items)
      else if (act === 'reset') userWhitelist = emptyWhitelist()
      if (act !== 'list') {
        userWhitelist = saveWhitelist(userWhitelist)
        ctx.emit('console-sentinel/whitelist', {
          action: act, kind,
          count: userWhitelist.processes.length + userWhitelist.titles.length,
        })
        logger.info('whitelist ' + act + ' ' + kind + ': processes=' +
          userWhitelist.processes.length + ' titles=' + userWhitelist.titles.length)
      }
      return {
        ok: true, action: act,
        processes: userWhitelist.processes, titles: userWhitelist.titles,
        count: userWhitelist.processes.length + userWhitelist.titles.length,
        path: DEFAULT_WHITELIST_PATH,
      }
    },
  }))

  } catch (e) { logger.error('apply: tool registration failed: ' + (e && e.stack ? e.stack : e)) }

  // --- HTTP routes powering the settings-panel UI (client half) ---------------
  // The client bundle has no Node access; it talks to these exact routes via a
  // root-relative fetch. Never gate these on anything that would stop the core
  // tool feature: if webServer is absent the panel simply shows "unavailable".
  try {
    registerHttpUi(ctx, {
      ledger,
      scan,
      ensureFreshScan,
      config,
      getWhitelist: () => userWhitelist,
      setWhitelist: (value) => { userWhitelist = value },
      getFolderWindows: () => folderWindows,
      logger,
    })
  } catch (error) {
    logger.warn('http ui routes not armed: ' + (error && error.message ? error.message : String(error)))
  }
  logger.info('apply: completed (tools + http armed)')
}

// ---------------------------------------------------------------------------
// Settings-panel HTTP API (served at /dsh-console-sentinel/*).
// The Electron renderer carries the browser-access capability header, so a
// root-relative fetch from lib/client.js passes; plain curl would be 403.
// ---------------------------------------------------------------------------

function wsIsLoopback(req) {
  const address = ((req.socket && req.socket.remoteAddress) || '').toLowerCase()
  if (address === '::1') return true
  if (address.startsWith('::ffff:')) return address.slice(7).startsWith('127.')
  return address.startsWith('127.')
}

function wsSendJson(res, code, payload) {
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  } catch (_) {
    try { res.end() } catch (_e) { /* client gone */ }
  }
}

function wsReadJsonBody(req, maxBytes = 1048576) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('body too large'))
        try { req.destroy() } catch (_) { /* ignore */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

function registerHttpUi(ctx, deps) {
  const { ledger, scan, ensureFreshScan, config, getWhitelist, setWhitelist, logger, getFolderWindows } = deps
  const PREFIX = '/dsh-console-sentinel'

  const statusPayload = () => {
    const wl = getWhitelist()
    const rows = ledger.snapshot()
    // Explorer folder windows are closable app windows outside the console
    // ledger; expose them so the client can list & single-close each.
    const allRows = [...rows, ...(getFolderWindows ? getFolderWindows() : [])]
    const empty = rows.filter((row) => row.isEmpty)
    return {
      ok: true,
      platform: process.platform,
      config: {
        enabled: config.enabled,
        autoAction: config.autoAction,
        emptyConsoleAction: config.emptyConsoleAction,
        idleThresholdSec: config.idleThresholdSec,
        scanIntervalSec: config.scanIntervalSec,
        guardForeground: config.guardForeground,
        scope: config.scope,
      },
      counts: {
        total: allRows.length,
        empty: empty.length,
        visibleEmpty: empty.filter((row) => row.visible && !row.hidden).length,
        hidden: rows.filter((row) => row.hidden).length,
      },
      windows: allRows,
      whitelist: { processes: wl.processes, titles: wl.titles, unprotect: wl.unprotect || [] },
      whitelistPath: DEFAULT_WHITELIST_PATH,
      protectedProcesses: [
        ...(config.cleanup?.protectedProcesses || DEFAULT_PROTECTED_PROCESSES),
        ...wl.processes,
      ],
    }
  }

  const guard = (handler) => async (req, res) => {
    try {
      if (!wsIsLoopback(req)) return wsSendJson(res, 403, { ok: false, reason: 'forbidden' })
      await handler(req, res)
    } catch (error) {
      wsSendJson(res, 500, { ok: false, reason: String((error && error.message) || error) })
    }
  }

  try {
    ctx.inject(['webServer'], (webCtx) => {
      try { logger.info('http ui: webServer injection fired') } catch (e) { /* ignore */ }
      const register = (path, handler) => {
        try {
          webCtx.webServer.register({ kind: 'exact', path: PREFIX + path, handler })
        } catch (error) {
          // A single route failing must not take down the others.
        }
      }

      // Fallback delivery path: serve the client bundle ourselves and let the
      // shell's index injection pick it up even when the client module graph
      // skipped this package. The bundle is idempotent (guarded in client.js).
      register('/client.bundle.js', (req, res) => {
        try {
          const req2 = createRequire(import.meta.url)
          const fs2 = req2('node:fs')
          const path2 = req2('node:path')
          const pkgJson = req2.resolve('dsh-console-sentinel/package.json')
          const buf = fs2.readFileSync(path2.join(path2.dirname(pkgJson), 'lib', 'client.js'))
          res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
          res.end(buf)
        } catch (error) {
          try { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end(String((error && error.message) || error)) } catch (_) { /* ignore */ }
        }
      })
      try {
        ctx.on('webserver/index-inject', (table) => {
          try { table.push({ kind: 'script-src', placement: 'head', src: PREFIX + '/client.bundle.js' }) } catch (_) { /* ignore */ }
        })
        logger.info('client fallback: index-inject hook armed')
      } catch (e) {
        logger.warn('client fallback: index-inject hook failed: ' + ((e && e.message) || String(e)))
      }

      register('/panel-beat', guard(async (req, res) => {
        // 设置面板可见时的心跳。这是 panelOnly=true 下「插件活着」的唯一证据：
        // 收到就扫一次（顺带判定并执行空壳 auto-hide），面板一打开看到的就是最新状态；
        // 不再收到心跳 → 插件彻底静默，一个 PowerShell 都不起。
        // 心跳体目前只用于诊断（at/adopt），不参与决策：扫描 + 空壳 auto-hide
        // 全部走下面这次 ensureFreshScan，台账由 actOn 记账、checkRestore 补显。
        try { await readJson(req) } catch (_) { /* heartbeat body is optional */ }
        try { await (ensureFreshScan ? ensureFreshScan(0, true) : scan()) } catch (_) {}
        wsSendJson(res, 200, { ok: true, at: lastScanAt, scans: scanCount, hidden: hiddenList().length })
      }))

      register('/status', guard(async (req, res) => {
        // Manual-only: the ledger is refreshed on demand instead of by a timer.
        // panelOnly=true 时客户端先 POST /panel-beat（心跳会顺带扫一次、并执行
        // 空壳 auto-hide），这里直接取刚扫出来的台账；并发请求共享同一次扫描。
        try { await (ensureFreshScan ? ensureFreshScan(0, true) : scan()) } catch (_) { /* stale payload is still valid */ }
        wsSendJson(res, 200, statusPayload())
      }))

      register('/scan', guard(async (req, res) => {
        await scan()
        wsSendJson(res, 200, statusPayload())
      }))

      register('/hide-empty', guard(async (req, res) => {
        const hostSet = hostProcessGuard()
        const all = ledger.snapshot()
        const targets = all.filter((row) =>
          row.isEmpty && !row.hidden &&
          row.source !== 'dsh-host' && !hostSet.has(Number(row.pid)) &&
          isSafeClosableShell(row))
        let hidden = 0
        for (const row of targets) {
          const out = await runWindowAction(row.hwnd, 'hide')
          if (out && out.ok) hidden += 1
        }
        await scan()
        wsSendJson(res, 200, { ok: true, hidden, status: statusPayload() })
      }))

      // 关闭空壳窗口：对"裸解释器空壳"发 WM_CLOSE（真正结束，不是隐藏）。
      // 三重硬保护：① 宿主全进程树 ② source=dsh-host ③ 只认 cmd/powershell/pwsh/python，
      // 绝不动 mpiexec/fluent/ansys/node —— 否则会误杀正在计算的 Fluent 或宿主。
      register('/close-empty', guard(async (req, res) => {
        const hostSet = hostProcessGuard()
        const all = ledger.snapshot()
        const targets = all.filter((row) =>
          row.isEmpty &&
          row.source !== 'dsh-host' && !hostSet.has(Number(row.pid)) &&
          isSafeClosableShell(row))
        // Explorer folder windows (CabinetWClass / ExploreWClass) are closable at
        // the hwnd level with WM_CLOSE without killing explorer.exe; fold them
        // into the "empty cleanup" candidate set so 点清理 also closes opened
        // folder windows (the user's m00916 complaint). isExplorerFolderWindow
        // already excludes desktop shell classes.
        for (const f of (getFolderWindows ? getFolderWindows() : [])) {
          if (!hostSet.has(Number(f.pid))) targets.push(f)
        }
        const skipped = all.filter((row) => row.isEmpty && !targets.includes(row)).length
        let closed = 0
        for (const row of targets) {
          const out = await runWindowAction(row.hwnd, 'close')
          if (out && out.ok) closed += 1
        }
        await scan()
        wsSendJson(res, 200, { ok: true, closed, skipped, status: statusPayload() })
      }))

      // 一键清理孤儿窗口：父进程已退出、但自身还在的控制台（无业务子进程、非计算类）。
      // 安全模式：只碰 isSafeClosableShell（cmd/powershell/pwsh/python 裸解释器）且 childCount===0；
      // mpiexec/fluent/fl2610/cx2610/ansys/node 等计算类一律跳过，绝不中断正在算的任务。
      // dryRun=true 只返回候选清单（不执行），便于前端确认后再关。
      register('/close-orphans', guard(async (req, res) => {
        const body = await wsReadJsonBody(req)
        const dryRun = Boolean(body && body.dryRun)
        const hostSet = hostProcessGuard()
        const all = ledger.snapshot()
        const orphanRows = all.filter((row) => row.source === 'orphaned' && !hostSet.has(Number(row.pid)))
        const targets = orphanRows.filter((row) => !row.hidden && row.childCount === 0 && isSafeClosableShell(row))
        const skipped = orphanRows.length - targets.length
        if (dryRun) {
          return wsSendJson(res, 200, {
            ok: true,
            dryRun: true,
            candidates: targets.map((r) => ({ hwnd: r.hwnd, pid: r.pid, processName: r.processName || '', title: r.title || '' })),
            skipped
          })
        }
        let closed = 0
        for (const row of targets) {
          const out = await runWindowAction(row.hwnd, 'close')
          if (out && out.ok) closed += 1
        }
        await scan()
        wsSendJson(res, 200, { ok: true, closed, skipped, status: statusPayload() })
      }))

      // 按软件一键关闭：对指定进程名的"全部窗口"发 WM_CLOSE（等于对该软件每个窗口按 Alt+F4），
      // 不需要逐个点。宿主/DSH/Fluent 等硬保护；提权软件走一次 UAC 提权优雅关闭。
      register('/close-process', guard(async (req, res) => {
        const body = await wsReadJsonBody(req)
        const procName = String(body.process || '').trim()
        if (!procName) return wsSendJson(res, 400, { ok: false, reason: 'no-process' })
        const target = procName.toLowerCase().replace(/\.exe$/, '')
        if (/^dsh|electron|deepseek/i.test(target)) {
          return wsSendJson(res, 200, { ok: false, reason: 'host-protected' })
        }
        let probe
        try { probe = await runDesktopProbe(config.probeTimeoutMs || 20000) }
        catch (err) { return wsSendJson(res, 200, { ok: false, reason: String((err && err.message) || err) }) }
        if (!probe || !probe.ok) return wsSendJson(res, 200, { ok: false, reason: (probe && probe.reason) || 'probe-failed' })
        const hostSet = hostProcessGuard()
        const procOf = (w) => String(w.process ?? w.Process ?? '').toLowerCase().replace(/\.exe$/, '')
        const pidOf = (w) => Number(w.pid ?? w.Pid)
        const hwndOf = (w) => Number(w.hwnd ?? w.Hwnd)
        const elevOf = (w) => Boolean(w.elevated ?? w.Elevated)
        const winsRaw = (probe.windows || []).filter((w) => procOf(w) === target && !hostSet.has(pidOf(w)))
        // 🔴 Safety parity with /window: a by-process-name close must never touch a
        // desktop/shell surface. DESKTOP_SHELL_CLASSES is a hard red list enforced
        // per candidate window regardless of the owning process, and 'explorer' may
        // only ever close REAL folder windows (CabinetWClass/ExploreWClass) via
        // hwnd-level WM_CLOSE — never the taskbar/desktop/start-menu surfaces that
        // the same explorer.exe process also owns (2026-11-10: shell red list was
        // previously missing here, so close-process explorer could WM_CLOSE Progman
        // / workerw / shell_traywnd).
        const wins = winsRaw.filter((w) => {
          if (isDesktopShellClass(String(w.class ?? w.Class ?? ''))) return false
          if (target === 'explorer') {
            const rec = { hwnd: hwndOf(w), pid: pidOf(w), class: String(w.class ?? w.Class ?? ''), title: String(w.title ?? w.Title ?? ''), processName: procOf(w) }
            return isExplorerFolderWindow(rec)
          }
          return true
        })
        if (!wins.length) return wsSendJson(res, 200, { ok: true, process: procName, total: 0, closedCount: 0, note: 'no-windows' })
        const normalH = [], elevH = []
        for (const w of wins) (elevOf(w) ? elevH : normalH).push(hwndOf(w))
        let closed = 0
        for (const h of normalH) {
          const r = await runWindowAction(h, 'close')
          if (r && r.ok) closed += 1
        }
        let elevRes = null
        if (elevH.length) {
          elevRes = await runElevatedClose(elevH, 120000)
          closed += (elevRes.closedCount || 0)
        }
        await scan()
        wsSendJson(res, 200, {
          ok: true,
          process: procName,
          total: wins.length,
          closedCount: closed,
          normal: normalH.length,
          elevated: elevH.length,
          uacCancelled: Boolean(elevRes && elevRes.reason === 'uac-denied-or-cancelled'),
          status: statusPayload(),
        })
      }))

      register('/window', guard(async (req, res) => {
        const body = await wsReadJsonBody(req)
        const hwnd = Number(body.hwnd)
        const action = String(body.action || '')
        if (!hwnd || supportedActions.indexOf(action) < 0) {
          return wsSendJson(res, 400, { ok: false, reason: 'bad-params' })
        }
        // 单窗口操作也不能碰宿主 / Fluent / MPI（否则点一下就把 DSH 或正在算的 Fluent 关了）。
        const procHint = String(body.process || '').toLowerCase().replace(/\.exe$/, '')
        const sysLocked = procHint && (/^dsh|electron|deepseek|mpi|fluent|ansys|^cx\d|solver|cae|launcher/i.test(procHint))
        const hostSet = hostProcessGuard()
        // Resolve the target across BOTH the console ledger and the explorer
        // folder-window registry (different sources, same closable surface).
        const rec = ledger.snapshot().find((r) => Number(r.hwnd) === hwnd)
        const folder = (getFolderWindows ? getFolderWindows() : []).find((r) => Number(r.hwnd) === hwnd)
        if (!rec && !folder) {
          return wsSendJson(res, 200, { ok: false, reason: 'unknown-window', hwnd, action, status: statusPayload() })
        }
        const target = folder || rec
        // 🔴 Desktop / shell surfaces are ON A HARD RED LIST: closing them would
        // kill the desktop, taskbar, start menu or IME. Reject regardless of the
        // owning process.
        if (isDesktopShellClass(folder ? folder.class : rec.class)) {
          return wsSendJson(res, 200, { ok: false, reason: 'desktop-shell', hwnd, action, status: statusPayload() })
        }
        // Explorer folder windows: the ONLY explorer case the user may act on,
        // and only with hwnd-level WM_CLOSE (never kill). Everything else owned
        // by explorer (taskbar etc.) is already excluded above or by
        // isExplorerFolderWindow=false.
        if (target.processName && String(target.processName).toLowerCase().replace(/\.exe$/, '') === 'explorer') {
          if (action !== 'close') {
            return wsSendJson(res, 200, { ok: false, reason: 'explorer-close-only', hwnd, action, status: statusPayload() })
          }
          if (isExplorerFolderWindow(target)) {
            const result = await runWindowAction(hwnd, 'close')
            await scan()
            return wsSendJson(res, 200, { ok: Boolean(result && result.ok), hwnd, action, result, status: statusPayload() })
          }
          return wsSendJson(res, 200, { ok: false, reason: 'host-protected', hwnd, action, status: statusPayload() })
        }
        if (sysLocked || (rec && (hostSet.has(Number(rec.pid)) || rec.source === 'dsh-host'))) {
          return wsSendJson(res, 200, { ok: false, reason: 'host-protected', hwnd, action, status: statusPayload() })
        }
        // 管理员窗口：非提权 WM_CLOSE 会被 UIPI 丢弃 → 走一次提权优雅关闭（WM_CLOSE）。
        if (action === 'close' && Boolean(body.elevated)) {
          const er = await runElevatedClose([hwnd], 120000)
          await scan()
          const ok = (er.closedCount || 0) > 0
          return wsSendJson(res, 200, {
            ok,
            hwnd, action, elevated: true,
            reason: ok ? '' : (er.reason || 'not-closed'),
            status: statusPayload(),
          })
        }
        const result = await runWindowAction(hwnd, action)
        await scan()
        wsSendJson(res, 200, { ok: Boolean(result && result.ok), hwnd, action, result, status: statusPayload() })
      }))

      register('/desktop-cleanup', guard(async (req, res) => {
        const body = await wsReadJsonBody(req)
        const dryRun = Boolean(body.dryRun)
        const wl = getWhitelist()
        const norm = (s) => String(s).toLowerCase().replace(/\.exe$/, '')
        // Effective protection = (built-in + config + whitelist) minus the
        // processes the user explicitly lifted via 取消保护. The DSH host is
        // always kept protected regardless of the unprotect list.
        const unprotect = new Set((wl.unprotect || []).map(norm))
        const baseProtected = [
          ...(config.cleanup?.protectedProcesses || DEFAULT_PROTECTED_PROCESSES),
          ...wl.processes,
        ]
        const effectiveProtected = baseProtected.filter((p) => {
          const n = norm(p)
          if (n === 'dsh desktop' || n.startsWith('dsh next') || n === 'dsh') return true // host never closable
          return !unprotect.has(n)
        })
        const result = await runDesktopCleanup({
          confirm: !dryRun,
          selfPid: process.pid,
          protectedProcesses: effectiveProtected,
          keepTitles: [...(config.cleanup?.keepTitles || []), ...wl.titles],
          // Never let 一键清理任务栏窗口 touch the DSH host process family.
          keepPids: [...hostProcessGuard()],
        })
        const fmt = (w) => 'hwnd=' + w.hwnd + ' pid=' + w.pid + ' [' + (w.process || '?') + '] ' + (w.title || '').slice(0, 70)
        const detailed = (w) => ({
          hwnd: w.hwnd,
          pid: w.pid,
          process: w.process || '',
          title: w.title || '',
          icon: w.icon || '',
        })
        wsSendJson(res, 200, {
          ok: result.ok,
          dryRun: result.dryRun,
          fgHwnd: result.fgHwnd,
          planned: (result.targets || []).map(fmt),
          plannedDetailed: (result.targets || []).map(detailed),
          plannedCount: (result.targets || []).length,
          kept: (result.kept || []).map((k) => ({ reason: k.keepReason, text: fmt(k) })),
          closedCount: (result.closed || []).length,
          elevatedCount: result.elevatedCount || 0,
          elevatedUacCancelled: Boolean(result.elevatedUacCancelled),
          reason: result.reason,
        })
      }))

      register('/taskbar-windows', guard(async (req, res) => {
        // Enumerate every visible taskbar window, attach its exe icon (base64
        // PNG data URL) and the current whitelist / protection state so the
        // settings panel can present a checkbox list the user picks exemptions
        // from, and can lift built-in protection per process ("取消保护").
        let probe
        try {
          probe = await runDesktopProbe(config.probeTimeoutMs || 20000)
        } catch (err) {
          return wsSendJson(res, 200, { ok: false, reason: String((err && err.message) || err), windows: [] })
        }
        if (!probe || !probe.ok) {
          return wsSendJson(res, 200, { ok: false, reason: (probe && probe.reason) || 'probe-failed', windows: [] })
        }
        const wl = getWhitelist()
        const norm = (s) => String(s).toLowerCase().replace(/\.exe$/, '')
        const wlProc = new Set((wl.processes || []).map(norm))
        const wlTitle = (wl.titles || []).map((s) => String(s).toLowerCase()).filter(Boolean)
        const hardSet = new Set((config.cleanup?.protectedProcesses || DEFAULT_PROTECTED_PROCESSES).map(norm))
        const unprotectSet = new Set((wl.unprotect || []).map(norm))
        // The DSH host window itself must never be closeable — not even via 取消保护.
        const isHostProc = (p) => p === 'dsh desktop' || p.startsWith('dsh next') || p === 'dsh'
        const seen = new Set()
        const windows = []
        for (const raw of probe.windows || []) {
          const hwnd = raw.hwnd ?? raw.Hwnd
          const pid = raw.pid ?? raw.Pid
          const proc = raw.process ?? raw.Process ?? ''
          const title = raw.title ?? raw.Title ?? ''
          const icon = raw.icon ?? raw.Icon ?? ''
          const cls = raw.class ?? raw.Class ?? ''
          const procLower = norm(proc)
          const titleLower = String(title).toLowerCase()
          const byProcess = wlProc.has(procLower)
          const byTitle = !byProcess && wlTitle.some((t) => t && titleLower.indexOf(t) >= 0)
          const isHard = hardSet.has(procLower) || isHostProc(procLower)
          const isUnprotect = unprotectSet.has(procLower)
          const hostLocked = isHostProc(procLower)
          const elevated = Boolean(raw.elevated ?? raw.Elevated)
          const key = String(hwnd) + '|' + String(proc) + '|' + String(title)
          if (seen.has(key)) continue
          seen.add(key)
          windows.push({
            hwnd,
            pid,
            process: proc,
            title,
            icon,
            class: cls,
            whitelisted: byProcess || byTitle,
            whitelistedBy: byProcess ? 'process' : (byTitle ? 'title' : ''),
            // effective protection == built-in protected AND not lifted by user
            protected: (isHard && !isUnprotect) || hostLocked,
            hardProtected: isHard,
            unprotected: isHard && isUnprotect && !hostLocked,
            hostLocked,
            // Elevated rows cannot be closed by WM_CLOSE (UIPI drops it); the
            // panel offers 强制关闭(管理员) which goes through UAC + taskkill.
            elevated,
          })
        }
        wsSendJson(res, 200, { ok: true, selfElevated: Boolean(probe.selfElevated), windows })
      }))

      // 强制关闭(管理员): UAC-elevated taskkill for windows whose owner runs
      // elevated. An unelevated WM_CLOSE is silently dropped by Windows UIPI,
      // which is why Taskmgr / iTop icons "would not close" (measured
      // 2026-11-07). One UAC prompt per batch; answering No returns
      // uac-denied-or-cancelled and changes nothing.
      register('/force-close', guard(async (req, res) => {
        const body = await wsReadJsonBody(req)
        const pids = Array.isArray(body.pids) ? body.pids : (body.pid ? [body.pid] : [])
        // Only processes the caller actually listed are accepted; forceCloseElevated
        // additionally re-verifies every pid with tasklist and blocks the DSH host.
        const allowedProcesses = Array.isArray(body.allowedProcesses) ? body.allowedProcesses : []
        const result = await forceCloseElevated(pids, {
          selfPid: process.pid,
          allowedProcesses,
          timeoutMs: 120000,
        })
        wsSendJson(res, 200, {
          ok: Boolean(result.ok),
          reason: result.reason || '',
          killedCount: result.killedCount || 0,
          total: result.total || 0,
          results: result.results || [],
          rejected: result.rejected || [],
          stderr: result.stderr || '',
        })
      }))

      register('/whitelist', guard(async (req, res) => {
        if ((req.method || 'GET').toUpperCase() === 'GET') {
          const wl = getWhitelist()
          return wsSendJson(res, 200, { ok: true, processes: wl.processes, titles: wl.titles, unprotect: wl.unprotect || [], path: DEFAULT_WHITELIST_PATH })
        }
        const body = await wsReadJsonBody(req)
        const act = String(body.action || 'list')
        const kind = body.kind === 'title' ? 'titles' : (body.kind === 'unprotect' ? 'unprotect' : 'processes')
        const items = Array.isArray(body.items) ? body.items : []
        let wl = getWhitelist()
        if (act === 'add') {
          if (!items.length) return wsSendJson(res, 400, { ok: false, reason: 'no-items' })
          wl = addWhitelistItems(wl, kind, items)
        } else if (act === 'remove') {
          wl = removeWhitelistItems(wl, kind, items)
        } else if (act === 'reset') {
          wl = emptyWhitelist()
        }
        if (act !== 'list') {
          wl = saveWhitelist(wl)
          setWhitelist(wl)
          ctx.emit('console-sentinel/whitelist', { action: act, kind })
        }
        wsSendJson(res, 200, { ok: true, action: act, processes: wl.processes, titles: wl.titles, unprotect: wl.unprotect || [], path: DEFAULT_WHITELIST_PATH })
      }))

      // --- 本地 AI 显存 ---------------------------------------------------
      // /ai/status 只读（显存读数 + 本地大模型服务清单；网关不列）。
      // /ai/release 是写动作，默认 dryRun=true —— 只有用户在面板上二次确认后才发 dryRun:false。
      // 释放一律「优雅优先」：L1 HTTP 卸载 → L2 WM_CLOSE → L3 强制（不再有 CTRL_BREAK 层，
      // 那层会向整个控制台广播，把同控制台的 tier_router 网关一起打死 —— 见 lib/ai.js 事故注释）。
      register('/ai/status', guard(async (req, res) => {
        const status = await collectAiStatus({ probeBusy: true })
        wsSendJson(res, 200, status)
      }))

      // /ai/release —— 只释放真正占显存的本地大模型服务；网关不列不动。
      register('/ai/release', guard(async (req, res) => {
        const body = await wsReadJsonBody(req)
        const dryRun = body.dryRun === undefined ? true : Boolean(body.dryRun)
        const mode = ['graceful', 'unload', 'stop'].includes(body.mode) ? body.mode : 'graceful'
        const result = await releaseLocalAi({
          dryRun,
          mode,
          gpuOnly: body.gpuOnly !== false,
          protectPids: Array.isArray(body.protectPids) ? body.protectPids : [],
          settleMs: Number(body.settleMs),
        })
        if (!dryRun) {
          const done = (result.killed || []).length
          const failed = (result.failed || []).length
          const forced = (result.killed || []).filter((k) => k.method === 'force').length
          logger.info('ai/release: mode=' + mode + ' released=' + done + ' failed=' + failed +
            ' forced=' + forced + ' freedMiB=' + (result.freedMiB || 0))
          try { ctx.emit('console-sentinel/ai-release', { released: done, forced, freedMiB: result.freedMiB || 0 }) } catch (_) { /* no listeners */ }
        }
        wsSendJson(res, 200, result)
      }))

      // /ai/kill —— 逐行手动释放单个 pid（含「未识别的本地模型」）。
      // 同样是优雅优先；保护名单（DSH 宿主 / Electron / Fluent / Ansys / MPI / node 运行时）在 ai.js 内一律拒绝。
      register('/ai/kill', guard(async (req, res) => {
        const body = await wsReadJsonBody(req)
        const result = await releasePid(body.pid, { mode: body.mode, label: body.label })
        if (result.killed) {
          logger.info('ai/kill: pid=' + result.pid + ' name=' + result.name + ' method=' + result.method)
        }
        wsSendJson(res, 200, result)
      }))
    })
  } catch (error) {
    // webServer unavailable (e.g. headless host): the panel degrades gracefully.
  }
}
