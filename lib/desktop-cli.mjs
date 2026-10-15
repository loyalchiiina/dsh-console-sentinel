#!/usr/bin/env node
// dsh-console-sentinel desktop cleanup CLI.
//
// Single entry point for the desktop "一键关闭其他窗口" shortcut and any
// scripting needs. The selection rule (incl. the powershell/python
// protected-process guarantee) lives in lib/desktop.js — this CLI only
// translates argv into a probe/select/close run.
//
//   node desktop-cli.mjs list [--json]                  show cleanable + kept windows
//   node desktop-cli.mjs close --hwnd N [--hwnd M] --confirm
//                                                       close specific windows (protected
//                                                       ones are refused)
//   node desktop-cli.mjs cleanup [--confirm] [--json]   dry-run plan, or close all eligible
//       [--keep-title Substring]... [--keep-pid N]...
//
// Without --confirm, close/cleanup only print the plan (dry run).

import { runDesktopCleanup, selectCleanupTargets, runDesktopProbe, closeDesktopWindows, DEFAULT_PROTECTED_PROCESSES } from './desktop.js'

const argv = process.argv.slice(2)
const mode = argv[0] || 'help'
const rest = argv.slice(1)

function flag(name) {
  return rest.includes('--' + name)
}
function values(name) {
  const out = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--' + name) out.push(rest[i + 1])
  }
  return out
}
function numbers(name) {
  return values(name).map(Number).filter((n) => Number.isInteger(n) && n > 0)
}

const keepTitles = values('keep-title')
const keepPids = numbers('keep-pid')
const confirm = flag('confirm')
const asJson = flag('json')

// The embedded PowerShell probe emits PascalCase keys (Hwnd/Class/Title/Pid/
// Process); normalise here so both casings work and missing fields never throw.
const f = (w) => ({
  hwnd: w.hwnd ?? w.Hwnd,
  pid: w.pid ?? w.Pid,
  cls: w.class ?? w.Class ?? '',
  process: w.process ?? w.Process ?? '?',
  title: w.title ?? w.Title ?? '',
})

function printPlan(r) {
  console.log(`foreground kept: hwnd=${r.fgHwnd}`)
  console.log(`targets (${r.targets.length}):`)
  for (const raw of r.targets) {
    const t = f(raw)
    console.log(`  CLOSE hwnd=${t.hwnd} pid=${t.pid} [${t.process}] ${t.title.slice(0, 70)}`)
  }
  const groups = {}
  for (const k of r.kept) (groups[k.keepReason] ||= []).push(k)
  for (const [reason, rows] of Object.entries(groups)) {
    console.log(`kept (${reason}): ${rows.length}`)
    for (const raw of rows) {
      const k = f(raw)
      console.log(`  KEEP hwnd=${k.hwnd} pid=${k.pid} [${k.process}] ${k.title.slice(0, 60)}`)
    }
  }
}

async function main() {
  if (mode === 'list') {
    const probe = await runDesktopProbe()
    if (!probe.ok) { console.error('probe failed: ' + probe.reason); process.exit(1) }
    const { targets, kept } = selectCleanupTargets(probe.windows, {
      fgHwnd: probe.fgHwnd,
      selfPid: process.pid,
      keepTitles, keepPids,
    })
    if (asJson) {
      console.log(JSON.stringify({ ok: true, fgHwnd: probe.fgHwnd, targets, kept }, null, 2))
      return
    }
    printPlan({ fgHwnd: probe.fgHwnd, targets, kept })
    return
  }

  if (mode === 'cleanup') {
    const r = await runDesktopCleanup({ confirm, keepTitles, keepPids, selfPid: process.pid })
    if (!r.ok) { console.error('cleanup failed: ' + r.reason); process.exit(1) }
    if (asJson) { console.log(JSON.stringify(r, null, 2)); return }
    console.log(r.dryRun ? 'DRY RUN (no window was closed; pass --confirm to execute)' : 'EXECUTED')
    printPlan(r)
    if (!r.dryRun) console.log(`closed: ${r.closed.length}/${r.targets.length}`)
    return
  }

  if (mode === 'close') {
    const hwnds = numbers('hwnd')
    if (hwnds.length === 0) { console.error('no --hwnd given'); process.exit(1) }
    if (!confirm) {
      console.log('DRY RUN (no window was closed; pass --confirm to execute)')
      console.log('would close hwnds:', hwnds.join(', '))
      return
    }
    // protection is enforced here too: resolve process names before closing
    const probe = await runDesktopProbe()
    if (!probe.ok) { console.error('probe failed: ' + probe.reason); process.exit(1) }
    const protectedLc = DEFAULT_PROTECTED_PROCESSES
    const rows = new Map(probe.windows.map((w) => [w.hwnd, w]))
    const allowed = []
    const refused = []
    for (const h of hwnds) {
      const w = rows.get(h)
      const proc = String(w?.process || '').toLowerCase().replace(/\.exe$/, '')
      if (w && protectedLc.includes(proc)) refused.push({ hwnd: h, process: w.process, title: w.title })
      else allowed.push(h)
    }
    if (refused.length) {
      for (const r of refused) console.error(`REFUSED (protected process): hwnd=${r.hwnd} [${r.process}] ${r.title.slice(0, 60)}`)
    }
    if (allowed.length) {
      const res = await closeDesktopWindows(allowed)
      for (const r of res.results || []) console.log(`close hwnd=${r.Hwnd} posted=${r.Posted}`)
    }
    return
  }

  console.log(`usage:
  node desktop-cli.mjs list [--json]
  node desktop-cli.mjs cleanup [--confirm] [--json] [--keep-title S]... [--keep-pid N]...
  node desktop-cli.mjs close --hwnd N [--confirm]
protected processes (never selected, never closed): ${DEFAULT_PROTECTED_PROCESSES.join(', ')}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
