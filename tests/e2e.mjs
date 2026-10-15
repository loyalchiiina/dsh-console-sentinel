// End-to-end smoke: real probe (live Windows) -> ledger -> eligibility,
// plus one reversible hide/show on a genuinely idle wmi-detached console.
import { runProbe, runWindowAction } from '../lib/probe.js'
import { createLedger, eligibleForAuto } from '../lib/logic.js'

const CONFIG = {
  idleThresholdSec: 60,
  cpuThresholdPct: 1,
  guardForeground: true,
  scope: { wmiDetached: true, dshHost: true, orphaned: false, scriptConsole: true, excludeTitles: [] },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('=== round 1 (seed) ===')
const p1 = await runProbe()
if (!p1.ok) { console.log('PROBE FAILED', p1.reason, p1.stderr); process.exit(1) }
console.log('windows:', p1.windows.length, '| procs:', Object.keys(p1.procs).length, '| fgHwnd:', p1.fgHwnd)

const ledger = createLedger()
const t0 = Date.now()
ledger.update({ ...p1, cpuThresholdPct: CONFIG.cpuThresholdPct, spikeTolerance: 2 }, t0)
console.log('seeded:', ledger.records.size)

console.log('waiting 6s (round 2) ...')
await sleep(6000)
const p2 = await runProbe()
if (!p2.ok) { console.log('PROBE 2 FAILED', p2.reason); process.exit(1) }
const t1 = Date.now()
ledger.update({ ...p2, cpuThresholdPct: CONFIG.cpuThresholdPct, spikeTolerance: 2 }, t1)
// first idle sample sets idleSince=now, so idleSec is still 0 here; one more
// round is needed for the idle clock to actually read > 0.
console.log('waiting 6s (round 3) ...')
await sleep(6000)
const p3 = await runProbe()
if (!p3.ok) { console.log('PROBE 3 FAILED', p3.reason); process.exit(1) }
const t2 = Date.now()
ledger.update({ ...p3, cpuThresholdPct: CONFIG.cpuThresholdPct, spikeTolerance: 2 }, t2)

const fgHwnd = p3.fgHwnd
const rows = [...ledger.records.values()]
console.log('\nhwnd        class                          pid     source         cpuPct  idleSec  eligible')
for (const r of rows) {
  const el = eligibleForAuto(r, fgHwnd, CONFIG)
  console.log(String(r.hwnd).padEnd(11) + ' ' + r.class.slice(0, 30).padEnd(31) + ' ' +
    String(r.pid).padEnd(7) + ' ' + r.source.padEnd(14) + ' ' +
    r.cpuPct.toFixed(1).padStart(6) + '% ' + Math.round(r.idleSec).toString().padStart(7) + 's  ' +
    (el ? 'YES' : ''))
}

// pick a genuinely idle, in-scope, non-foreground window for a reversible test
const target = rows.find((r) =>
  r.class !== 'PseudoConsoleWindow' &&
  (r.source === 'wmi-detached' || r.source === 'dsh-host' || r.source === 'script-console') &&
  r.idleSec >= 1 && r.visible && r.hwnd !== fgHwnd)

if (!target) {
  console.log('\nno idle in-scope window available for the action test (none qualified) — skipping hide/show')
  process.exit(0)
}

console.log('\n=== reversible hide -> show on target ===')
console.log('target: hwnd=' + target.hwnd + ' pid=' + target.pid + ' source=' + target.source +
  ' idle=' + Math.round(target.idleSec) + 's title=' + target.title.slice(0, 60))
const h = await runWindowAction(target.hwnd, 'hide')
console.log('hide  ->', JSON.stringify(h))
await sleep(800)
const s = await runWindowAction(target.hwnd, 'show')
console.log('show  ->', JSON.stringify(s))
console.log(h.ok && s.ok ? 'REVERSIBLE OK' : 'ACTION TEST FAILED')
