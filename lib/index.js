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
const PLUGIN_VERSION = (() => {
  try { return createRequire(import.meta.url)('dsh-console-sentinel/package.json').version }
  catch (_) { return '0.0.0' }
})()
import { runDesktopCleanup, DEFAULT_PROTECTED_PROCESSES } from './desktop.js'
import {
  createLedger,
  eligibleForAuto,
  eligibleForSweep,
  isEmptyConsole,
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

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description(
    'Master switch. When off, no scans run and no actions are taken.',
  ),
  scanIntervalSec: Schema.number().default(10).min(5).max(120).step(1).description(
    'How often to enumerate console windows and sample process CPU.',
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

  async function actOn(rec, action, opts = {}) {
    const res = await runWindowAction(rec.hwnd, action)
    if (res.ok) {
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
      if (res.reason === 'hwnd-not-a-window') { rec.destroyed = true; rec.hidden = false; rec.closed = true }
      ctx.emit('console-sentinel/action', {
        hwnd: rec.hwnd, title: rec.title, pid: rec.pid, source: rec.source,
        action, automatic: Boolean(opts.automatic), ok: false, reason: res.reason,
      })
      logger.warn(
        (opts.automatic ? 'auto-' : '') + action + ' failed: ' +
        'hwnd=0x' + rec.hwnd.toString(16) + ' reason=' + (res.reason ?? 'unknown'),
      )
    }
    return res
  }

  async function scan() {
    if (scanning) return
    scanning = true
    scanCount++
    lastScanAt = Date.now()
    try {
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

  // --- scan scheduler (registration = effect) --------------------------------

  const scanIntervalMs = Math.max(1, config.scanIntervalSec) * 1000
  // IMPORTANT: keep this timer owned by the process, NOT tied to ctx.effect.
  // In DSH the effect disposer runs during host-side teardown/reload and calls
  // clearInterval() right after the first sweep (observed: only "scan #1" ran,
  // then silence). A plain setInterval survives, which is the same pattern
  // dsh-qq-digest uses. See dev-log 0.3.0 for the full diagnosis.
  const scanTimer = setInterval(() => {
    scan().catch(() => { /* scan() logs internally */ })
  }, scanIntervalMs)
  if (scanTimer && typeof scanTimer.unref === 'function') scanTimer.unref()
  // first sweep immediately so the ledger is populated without waiting
  scan().catch(() => { /* scan() logs internally */ })
  // self-heal: if the host ever starves/clears the timer, force a sweep
  const supervisorTimer = setInterval(() => {
    const age = Date.now() - lastScanAt
    if (age > scanIntervalMs * 3) {
      logger.warn('scan supervisor: no scan for ' + age + 'ms; forcing one')
      scan().catch(() => { /* scan() logs internally */ })
    }
  }, Math.max(5000, scanIntervalMs * 2))
  if (supervisorTimer && typeof supervisorTimer.unref === 'function') supervisorTimer.unref()
  logger.info('apply: scan scheduler armed (intervalMs=' + scanIntervalMs + ')')

  // --- tools ------------------------------------------------------------------

  try {
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
      config,
      getWhitelist: () => userWhitelist,
      setWhitelist: (value) => { userWhitelist = value },
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
  const { ledger, scan, config, getWhitelist, setWhitelist, logger } = deps
  const PREFIX = '/dsh-console-sentinel'

  const statusPayload = () => {
    const wl = getWhitelist()
    const rows = ledger.snapshot()
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
        total: rows.length,
        empty: empty.length,
        visibleEmpty: empty.filter((row) => row.visible && !row.hidden).length,
        hidden: rows.filter((row) => row.hidden).length,
      },
      windows: rows,
      whitelist: { processes: wl.processes, titles: wl.titles },
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

      register('/status', guard(async (req, res) => {
        wsSendJson(res, 200, statusPayload())
      }))

      register('/scan', guard(async (req, res) => {
        await scan()
        wsSendJson(res, 200, statusPayload())
      }))

      register('/hide-empty', guard(async (req, res) => {
        const targets = ledger.snapshot().filter((row) => row.isEmpty && !row.hidden)
        let hidden = 0
        for (const row of targets) {
          const out = await runWindowAction(row.hwnd, 'hide')
          if (out && out.ok) hidden += 1
        }
        await scan()
        wsSendJson(res, 200, { ok: true, hidden, status: statusPayload() })
      }))

      register('/window', guard(async (req, res) => {
        const body = await wsReadJsonBody(req)
        const hwnd = Number(body.hwnd)
        const action = String(body.action || '')
        if (!hwnd || supportedActions.indexOf(action) < 0) {
          return wsSendJson(res, 400, { ok: false, reason: 'bad-params' })
        }
        const result = await runWindowAction(hwnd, action)
        await scan()
        wsSendJson(res, 200, { ok: Boolean(result && result.ok), hwnd, action, result, status: statusPayload() })
      }))

      register('/desktop-cleanup', guard(async (req, res) => {
        const body = await wsReadJsonBody(req)
        const dryRun = Boolean(body.dryRun)
        const wl = getWhitelist()
        const result = await runDesktopCleanup({
          confirm: !dryRun,
          selfPid: process.pid,
          protectedProcesses: [...(config.cleanup?.protectedProcesses || []), ...wl.processes],
          keepTitles: [...(config.cleanup?.keepTitles || []), ...wl.titles],
        })
        const fmt = (w) => 'hwnd=' + w.hwnd + ' pid=' + w.pid + ' [' + (w.process || '?') + '] ' + (w.title || '').slice(0, 70)
        wsSendJson(res, 200, {
          ok: result.ok,
          dryRun: result.dryRun,
          fgHwnd: result.fgHwnd,
          planned: (result.targets || []).map(fmt),
          plannedCount: (result.targets || []).length,
          kept: (result.kept || []).map((k) => ({ reason: k.keepReason, text: fmt(k) })),
          closedCount: (result.closed || []).length,
          reason: result.reason,
        })
      }))

      register('/whitelist', guard(async (req, res) => {
        if ((req.method || 'GET').toUpperCase() === 'GET') {
          const wl = getWhitelist()
          return wsSendJson(res, 200, { ok: true, processes: wl.processes, titles: wl.titles, path: DEFAULT_WHITELIST_PATH })
        }
        const body = await wsReadJsonBody(req)
        const act = String(body.action || 'list')
        const kind = body.kind === 'title' ? 'titles' : 'processes'
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
        wsSendJson(res, 200, { ok: true, action: act, processes: wl.processes, titles: wl.titles, path: DEFAULT_WHITELIST_PATH })
      }))
    })
  } catch (error) {
    // webServer unavailable (e.g. headless host): the panel degrades gracefully.
  }
}
