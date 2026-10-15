// Regression test for the ledger idle-detection state machine.
// Uses stub probe data (no live Windows, no PowerShell) — this is exactly the
// class of runtime bug that `node --check` and manual reading cannot catch.
import assert from 'node:assert/strict'
import { createLedger, eligibleForAuto, eligibleForSweep, classifySource, isScriptConsoleTitle } from '../lib/logic.js'

let pass = 0
let fail = 0
function check(name, fn) {
  try { fn(); pass += 1; console.log('  PASS ' + name) }
  catch (e) { fail += 1; console.log('  FAIL ' + name + ' -> ' + e.message) }
}

const CONFIG = {
  idleThresholdSec: 60,
  cpuThresholdPct: 1,
  guardForeground: true,
  scope: { wmiDetached: true, dshHost: true, orphaned: false, scriptConsole: true, excludeTitles: [] },
}

console.log('--- T1: source classification ---')
check('wmi-detached', () => {
  assert.equal(classifySource({ Name: 'powershell.exe', PName: 'WmiPrvSE.exe', PPid: 11620 }), 'wmi-detached')
})
check('dsh-host', () => {
  assert.equal(classifySource({ Name: 'python.exe', PName: 'DSH Desktop.exe', PPid: 628512 }), 'dsh-host')
})
check('orphaned (parent exited, name null)', () => {
  assert.equal(classifySource({ Name: 'powershell.exe', PName: null, PPid: 999999 }), 'orphaned')
})
check('manual (explorer-launched, prompt title)', () => {
  assert.equal(classifySource({ Name: 'powershell.exe', PName: 'explorer.exe', PPid: 1234 }, 'Windows PowerShell'), 'manual')
})
check('script-console: WT window title is a python path', () => {
  // a WT window belongs to WindowsTerminal.exe (parent svchost); only the
  // console title reveals it is hosting a scripted session.
  assert.equal(classifySource({ Name: 'WindowsTerminal.exe', PName: 'svchost.exe', PPid: 4208 }, 'C:\\app\\python.exe'), 'script-console')
})
check('script-console: powershell path title', () => {
  assert.equal(classifySource({ Name: 'WindowsTerminal.exe', PName: 'svchost.exe', PPid: 4208 }, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'script-console')
})
check('script-console excluded when scope says so', () => {
  const rec = { hwnd: 6, class: 'CASCADIA_HOSTING_WINDOW_CLASS', source: 'script-console', hidden: false, closed: false, idleSec: 9999, title: 'python.exe' }
  assert.equal(eligibleForAuto(rec, 0, CONFIG), true)
  const off = { ...CONFIG, scope: { ...CONFIG.scope, scriptConsole: false } }
  assert.equal(eligibleForAuto(rec, 0, off), false)
})
check('unknown (no proc, prompt title)', () => {
  assert.equal(classifySource(null, 'Windows PowerShell'), 'unknown')
})
check('script-console from title alone when proc missing', () => {
  assert.equal(classifySource(null, 'C:\\app\\python.exe'), 'script-console')
})
check('isScriptConsoleTitle rejects prompt titles', () => {
  assert.equal(isScriptConsoleTitle('Windows PowerShell'), false)
  assert.equal(isScriptConsoleTitle('C:\\Users\\someone'), false)
  assert.equal(isScriptConsoleTitle(''), false)
})
check('isScriptConsoleTitle accepts exe-path titles', () => {
  assert.equal(isScriptConsoleTitle('C:\\app\\python.exe'), true)
  assert.equal(isScriptConsoleTitle('python.exe'), true)
  assert.equal(isScriptConsoleTitle('fluent.exe'), true)
})

console.log('--- T2: first sighting seeds the record, no idle judgement yet ---')
check('first scan records but idleSec=0', () => {
  const ledger = createLedger()
  const t0 = 1_700_000_000_000
  const probe = {
    windows: [{ hwnd: 1001, class: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'powershell.exe', pid: 5000, visible: true }],
    procs: { '5000': { Name: 'powershell.exe', CpuMs: 10_000, PName: 'WmiPrvSE.exe', PPid: 11620 } },
    cpuThresholdPct: CONFIG.cpuThresholdPct,
  }
  const { added, removed } = ledger.update(probe, t0)
  assert.equal(added.length, 1)
  assert.equal(removed.length, 0)
  assert.equal(added[0].source, 'wmi-detached')
  assert.equal(added[0].idleTicks, 0)
  assert.equal(added[0].idleSince, 0)
  assert.equal(added[0].idleSec, 0)
  // first sample has no delta to compare against, so cpuPct stays 0
  assert.equal(added[0].cpuPct, 0)
  assert.equal(added[0].lastCpuMs, 10_000)
})

console.log('--- T3: busy window never goes idle ---')
check('high CPU resets idle state', () => {
  const ledger = createLedger()
  const t0 = 1_700_000_000_000
  const mk = (cpuMs) => ({
    windows: [{ hwnd: 1001, class: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'ps', pid: 5000, visible: true }],
    procs: { '5000': { Name: 'powershell.exe', CpuMs: cpuMs, PName: 'WmiPrvSE.exe', PPid: 11620 } },
    cpuThresholdPct: CONFIG.cpuThresholdPct,
  })
  ledger.update(mk(10_000), t0)
  // 10 s later, used 5 s CPU -> 50% busy
  const r2 = ledger.update(mk(15_000), t0 + 10_000)
  const rec = ledger.records.get(1001)
  assert.equal(rec.cpuPct, 50)
  assert.equal(rec.idleTicks, 0)
  assert.equal(rec.idleSince, 0)
  assert.equal(rec.idleSec, 0)
  assert.equal(eligibleForAuto(rec, 0, CONFIG), false, 'busy window must not be eligible')
})

console.log('--- T4: idle window accumulates and crosses the threshold ---')
check('sustained low CPU -> idle, then eligible', () => {
  const ledger = createLedger()
  const t0 = 1_700_000_000_000
  const mk = (cpuMs) => ({
    windows: [{ hwnd: 2002, class: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'python.exe', pid: 6000, visible: true }],
    procs: { '6000': { Name: 'python.exe', CpuMs: cpuMs, PName: 'WmiPrvSE.exe', PPid: 11620 } },
    cpuThresholdPct: CONFIG.cpuThresholdPct,
  })
  ledger.update(mk(20_000), t0)
  // four 15s intervals with 0 CPU growth each (0%)
  let t = t0
  for (let i = 0; i < 4; i++) {
    t += 15_000
    ledger.update(mk(20_000), t)
  }
  const rec = ledger.records.get(2002)
  assert.equal(rec.cpuPct, 0)
  assert.equal(rec.idleTicks, 4)
  assert.equal(rec.idleSince, t0 + 15_000, 'idle clock starts at the FIRST idle sample')
  // idleSec measured from first idle sample to last sample time
  assert.equal(rec.idleSec, 45)
  // below 60s threshold: not yet
  assert.equal(eligibleForAuto(rec, 0, CONFIG), false)
  // one more idle interval -> 60s, crosses
  t += 15_000
  ledger.update(mk(20_000), t)
  const rec2 = ledger.records.get(2002)
  assert.equal(rec2.idleSec, 60)
  assert.equal(eligibleForAuto(rec2, 0, CONFIG), true, '60s idle wmi-detached window IS eligible')
})

console.log('--- T5: a busy blip resets the idle clock ---')
check('one busy sample clears idleSince', () => {
  const ledger = createLedger()
  const t0 = 1_700_000_000_000
  const mk = (cpuMs) => ({
    windows: [{ hwnd: 3003, class: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'ps', pid: 7000, visible: true }],
    procs: { '7000': { Name: 'powershell.exe', CpuMs: cpuMs, PName: 'DSH Desktop.exe', PPid: 628512 } },
    cpuThresholdPct: CONFIG.cpuThresholdPct,
    spikeTolerance: 2,
  })
  ledger.update(mk(0), t0)
  let t = t0
  for (let i = 0; i < 5; i++) { t += 15_000; ledger.update(mk(0), t) } // idle 75s
  let rec = ledger.records.get(3003)
  assert.equal(eligibleForAuto(rec, 0, CONFIG), true)
  // busy blip: 3s of CPU in 15s = 20%
  t += 15_000
  ledger.update(mk(3_000), t)
  rec = ledger.records.get(3003)
  assert.equal(rec.cpuPct, 20)
  assert.equal(rec.busyStreak, 1)
  assert.equal(rec.idleTicks, 5, 'single busy sample must NOT reset idle streak (tolerance=2)')
  assert.equal(rec.idleSince, t0 + 15_000)
  assert.equal(eligibleForAuto(rec, 0, CONFIG), true)
  // a SECOND consecutive busy sample breaks the idle streak
  t += 15_000
  ledger.update(mk(6_000), t)
  rec = ledger.records.get(3003)
  assert.equal(rec.busyStreak, 2)
  assert.equal(rec.idleTicks, 0)
  assert.equal(rec.idleSince, 0)
  assert.equal(eligibleForAuto(rec, 0, CONFIG), false, 'two consecutive busy samples must reset')
})

console.log('--- T6: scope guards ---')
check('manual windows are never auto-managed', () => {
  const rec = { hwnd: 1, class: 'CASCADIA_HOSTING_WINDOW_CLASS', source: 'manual', hidden: false, closed: false, idleSec: 9999, title: 'x' }
  assert.equal(eligibleForAuto(rec, 0, CONFIG), false)
})
check('orphaned excluded by default config', () => {
  const rec = { hwnd: 2, class: 'CASCADIA_HOSTING_WINDOW_CLASS', source: 'orphaned', hidden: false, closed: false, idleSec: 9999, title: 'x' }
  assert.equal(eligibleForAuto(rec, 0, CONFIG), false)
  assert.equal(eligibleForAuto(rec, 0, { ...CONFIG, scope: { ...CONFIG.scope, orphaned: true } }), true)
})
check('foreground window is protected', () => {
  const rec = { hwnd: 42, class: 'CASCADIA_HOSTING_WINDOW_CLASS', source: 'wmi-detached', hidden: false, closed: false, idleSec: 9999, title: 'x' }
  assert.equal(eligibleForAuto(rec, 42, CONFIG), false)
  assert.equal(eligibleForAuto(rec, 999, CONFIG), true)
})
check('hidden windows are not re-processed', () => {
  const rec = { hwnd: 3, class: 'CASCADIA_HOSTING_WINDOW_CLASS', source: 'wmi-detached', hidden: true, closed: false, idleSec: 9999, title: 'x' }
  assert.equal(eligibleForAuto(rec, 0, CONFIG), false)
})
check('PseudoConsoleWindow never auto-managed', () => {
  const rec = { hwnd: 4, class: 'PseudoConsoleWindow', source: 'wmi-detached', hidden: false, closed: false, idleSec: 9999, title: '' }
  assert.equal(eligibleForAuto(rec, 0, CONFIG), false)
  assert.equal(eligibleForSweep(rec, 1, CONFIG), false)
})
check('title blocklist', () => {
  const rec = { hwnd: 5, class: 'CASCADIA_HOSTING_WINDOW_CLASS', source: 'wmi-detached', hidden: false, closed: false, idleSec: 9999, title: 'keep-alive-script' }
  const cfg = { ...CONFIG, scope: { ...CONFIG.scope, excludeTitles: ['keep-alive'] } }
  assert.equal(eligibleForAuto(rec, 0, cfg), false)
  assert.equal(eligibleForSweep(rec, 1, cfg), false)
})

console.log('--- T7: ledger GC removes vanished windows ---')
check('window gone -> removed', () => {
  const ledger = createLedger()
  const t0 = 1_700_000_000_000
  const mk = (hwnd) => ({
    windows: hwnd ? [{ hwnd, class: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'ps', pid: 8000, visible: true }] : [],
    procs: { '8000': { Name: 'powershell.exe', CpuMs: 0, PName: 'WmiPrvSE.exe', PPid: 11620 } },
    cpuThresholdPct: CONFIG.cpuThresholdPct,
  })
  ledger.update(mk(9001), t0)
  assert.equal(ledger.records.size, 1)
  const { removed } = ledger.update(mk(null), t0 + 10_000)
  assert.equal(removed.length, 1)
  assert.equal(removed[0].hwnd, 9001)
  assert.equal(ledger.records.size, 0)
})

console.log('--- T8: findByTarget ---')
check('hwnd lookup and pid fallback', () => {
  const ledger = createLedger()
  const probe = {
    windows: [
      { hwnd: 111, class: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'a', pid: 9000, visible: true },
      { hwnd: 222, class: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'b', pid: 9000, visible: false },
    ],
    procs: { '9000': { Name: 'powershell.exe', CpuMs: 0, PName: 'WmiPrvSE.exe', PPid: 11620 } },
    cpuThresholdPct: CONFIG.cpuThresholdPct,
  }
  ledger.update(probe, 1)
  assert.equal(ledger.findByTarget({ hwnd: 222 }).title, 'b')
  // pid match prefers the visible window
  assert.equal(ledger.findByTarget({ pid: 9000 }).title, 'a')
  assert.equal(ledger.findByTarget({ hwnd: 999 }), null)
  assert.equal(ledger.findByTarget({}), null)
})

console.log('--- T9: snapshot sorting and filtering ---')
check('idle-first order, hidden filter', () => {
  const ledger = createLedger()
  const t0 = 1_700_000_000_000
  const mk = (idleSinceAgo) => {
    const now = t0
    return {
      windows: [
        { hwnd: 10, class: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'busy', pid: 100, visible: true },
        { hwnd: 11, class: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'idle', pid: 101, visible: true },
      ],
      procs: {
        '100': { Name: 'python.exe', CpuMs: 5_000, PName: 'WmiPrvSE.exe', PPid: 1 },
        '101': { Name: 'python.exe', CpuMs: 1_000, PName: 'WmiPrvSE.exe', PPid: 1 },
      },
      cpuThresholdPct: CONFIG.cpuThresholdPct,
    }
  }
  // seed at t0
  ledger.update(mk(0), t0)
  // sample 2 at t0+10s: hwnd10 busy (5000->6000 = 10s CPU over 10s = 100%), hwnd11 idle
  ledger.update({
    windows: [
      { hwnd: 10, class: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'busy', pid: 100, visible: true },
      { hwnd: 11, class: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'idle', pid: 101, visible: true },
    ],
    procs: {
      '100': { Name: 'python.exe', CpuMs: 6_000, PName: 'WmiPrvSE.exe', PPid: 1 },
      '101': { Name: 'python.exe', CpuMs: 1_000, PName: 'WmiPrvSE.exe', PPid: 1 },
    },
    cpuThresholdPct: CONFIG.cpuThresholdPct,
  }, t0 + 10_000)
  // sample 3 at t0+20s: hwnd10 still busy, hwnd11 still idle -> idleSec becomes 10s
  ledger.update({
    windows: [
      { hwnd: 10, class: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'busy', pid: 100, visible: true },
      { hwnd: 11, class: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'idle', pid: 101, visible: true },
    ],
    procs: {
      '100': { Name: 'python.exe', CpuMs: 7_000, PName: 'WmiPrvSE.exe', PPid: 1 },
      '101': { Name: 'python.exe', CpuMs: 1_000, PName: 'WmiPrvSE.exe', PPid: 1 },
    },
    cpuThresholdPct: CONFIG.cpuThresholdPct,
  }, t0 + 20_000)
  const list = ledger.snapshot()
  assert.equal(list.length, 2)
  assert.equal(list[0].title, 'idle', 'most idle sorts first')
  assert.equal(list[0].idleSec, 10)
  assert.equal(list[1].title, 'busy')
  assert.equal(list[1].idleSec, 0)
})

console.log('--- T10: destroyed vs hidden are distinct (2026-09-23 实证) ---')
check('new records start with destroyed=false and hidden=false', () => {
  const ledger = createLedger()
  ledger.update({
    windows: [{ hwnd: 20, class: 'ConsoleWindowClass', title: 'x', pid: 200, visible: true }],
    procs: { '200': { Name: 'powershell.exe', CpuMs: 0, PName: 'WmiPrvSE.exe', PPid: 1 } },
    cpuThresholdPct: 1,
  }, 1000)
  const rec = ledger.records.get(20)
  assert.equal(rec.hidden, false)
  assert.equal(rec.destroyed, false)
})

check('snapshot exposes destroyed so a gone window is never counted as hidden', () => {
  const ledger = createLedger()
  ledger.update({
    windows: [{ hwnd: 21, class: 'ConsoleWindowClass', title: 'gone', pid: 201, visible: true }],
    procs: { '201': { Name: 'powershell.exe', CpuMs: 0, PName: 'WmiPrvSE.exe', PPid: 1 } },
    cpuThresholdPct: 1,
  }, 1000)
  // Simulate what actOn now does when the probe reports stillWindow=false:
  const rec = ledger.records.get(21)
  rec.destroyed = true
  rec.hidden = false          // <- the fix: NOT marked hidden
  rec.closed = true
  const snap = ledger.snapshot()
  assert.equal(snap[0].destroyed, true)
  assert.equal(snap[0].hidden, false, 'a destroyed window must not be reported as hidden')
})

console.log('--- T11: reconcileVisibility (anti-lie ground truth) ---')
check('corrects a stale hidden=true when the window is actually visible', () => {
  const ledger = createLedger()
  ledger.update({
    windows: [{ hwnd: 30, class: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'Windows PowerShell', pid: 300, visible: true }],
    procs: { '300': { Name: 'WindowsTerminal.exe', CpuMs: 0, PName: 'svchost.exe', PPid: 1 } },
    cpuThresholdPct: 1,
  }, 1000)
  const rec = ledger.records.get(30)
  rec.hidden = true            // plugin claims it hid this window...
  const corrected = ledger.reconcileVisibility({ 30: true })   // ...but it is visible
  assert.deepEqual(corrected, [30], 'the discrepancy must be reported')
  assert.equal(rec.hidden, false, 'reality wins: not hidden')
  assert.equal(rec.visible, true)
})

check('leaves a genuinely hidden window alone', () => {
  const ledger = createLedger()
  ledger.update({
    windows: [{ hwnd: 31, class: 'ConsoleWindowClass', title: 'x', pid: 301, visible: true }],
    procs: { '301': { Name: 'powershell.exe', CpuMs: 0, PName: 'WmiPrvSE.exe', PPid: 1 } },
    cpuThresholdPct: 1,
  }, 1000)
  const rec = ledger.records.get(31)
  rec.hidden = true
  const corrected = ledger.reconcileVisibility({ 31: false })
  assert.deepEqual(corrected, [])
  assert.equal(rec.hidden, true)
})

check('ignores hwnds absent from the truth map (no false corrections)', () => {
  const ledger = createLedger()
  ledger.update({
    windows: [{ hwnd: 32, class: 'ConsoleWindowClass', title: 'x', pid: 302, visible: true }],
    procs: { '302': { Name: 'powershell.exe', CpuMs: 0, PName: 'WmiPrvSE.exe', PPid: 1 } },
    cpuThresholdPct: 1,
  }, 1000)
  const corrected = ledger.reconcileVisibility({ 999: false })
  assert.deepEqual(corrected, [])
})

console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===')
if (fail > 0) process.exit(1)
