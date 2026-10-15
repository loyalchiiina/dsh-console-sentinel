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
import { runDesktopCleanup, DEFAULT_PROTECTED_PROCESSES } from './desktop.js'
import {
  createLedger,
  eligibleForAuto,
  eligibleForSweep,
  SOURCES,
} from './logic.js'

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
})

export function apply(ctx, config) {
  const logger = ctx.logger('dsh-console-sentinel')

  if (process.platform !== 'win32') {
    logger.warn('Windows-only plugin; staying inert on ' + process.platform)
    return
  }
  if (!config.enabled) {
    logger.info('disabled by config; no scans will run')
    return
  }

  const ledger = createLedger()
  let scanning = false
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

      if (config.autoAction !== 'none') {
        for (const rec of [...ledger.records.values()]) {
          if (!eligibleForAuto(rec, res.fgHwnd, config)) continue
          await actOn(rec, config.autoAction, { automatic: true })
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

  ctx.effect(() => {
    const intervalMs = Math.max(1, config.scanIntervalSec) * 1000
    const timer = setInterval(() => {
      scan().catch(() => { /* scan() logs internally */ })
    }, intervalMs)
    // first sweep immediately so the ledger is populated without waiting
    scan().catch(() => { /* scan() logs internally */ })
    return () => clearInterval(timer)
  }, 'dsh-console-sentinel: scan scheduler')

  // --- tools ------------------------------------------------------------------

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
            firstSeen: { type: 'number' },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.length === 0
          ? 'No console windows tracked.'
          : value.map((w) =>
            (w.destroyed ? '[gone]   ' : w.hidden ? '[hidden] ' : w.idleSec > 0 ? '[idle]   ' : '[busy]   ') +
            'hwnd=' + w.hwnd + ' pid=' + w.pid + ' ' + w.processName +
            ' <- ' + (w.parentName || '?') + ' (' + w.source + ')' +
            ' cpu=' + w.cpuPct + '% idle=' + w.idleSec + 's | ' + w.title.slice(0, 70),
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
        protectedProcesses: config.cleanup?.protectedProcesses,
        keepTitles: [...(config.cleanup?.keepTitles || []), ...(args.keepTitle || [])],
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
}
