// Independent cross-check: does the plugin's report match Windows' ground truth?
// Uses raw user32 IsWindowVisible directly (no plugin code in the measurement),
// then compares against what the plugin's own ledger/probe claims.
// This is the check that caught the original lie, kept as a permanent tool.
import { probeVisibility } from '../lib/probe.js'
import { execFileSync } from 'node:child_process'

// Ground truth straight from user32, via a throwaway PowerShell that shares no
// code with the plugin.
const TRUTH_PS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if (-not ('X.W' -as [type])) {
  Add-Type -Name W -Namespace X -MemberDefinition @"
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
"@
}
$c = Get-Content -Raw -Path $env:XLIST
$o = @{}
foreach ($h in ($c -split ',')) {
  if (-not $h.Trim()) { continue }
  $p = [IntPtr]([int64]$h.Trim())
  if (-not [X.W]::IsWindow($p)) { $o[$h.Trim()] = 'gone' }
  elseif ([X.W]::IsWindowVisible($p)) { $o[$h.Trim()] = 'visible' }
  else { $o[$h.Trim()] = 'hidden' }
}
ConvertTo-Json -InputObject $o -Compress
`

const HWNDS = (process.argv[2] || '5714870,28210540,630864').split(',').map((s) => s.trim()).filter(Boolean)

const listFile = process.env.TEMP + '\\xlist.txt'
const fs = await import('node:fs')
fs.writeFileSync(listFile, HWNDS.join(','))

const rawTruth = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TRUTH_PS], {
  env: { ...process.env, XLIST: listFile },
  encoding: 'utf8',
  windowsHide: true,
})
const truth = JSON.parse(rawTruth.trim())

// The plugin's own answer (its new probeVisibility path).
const pluginView = await probeVisibility(HWNDS.map(Number))

let mismatches = 0
let checked = 0
console.log('hwnd          独立实测(user32)   插件报告         一致?')
console.log('-'.repeat(66))
for (const h of HWNDS) {
  const t = truth[h] ?? 'gone'
  const pv = pluginView ? pluginView[Number(h)] : undefined
  const pluginSays = pv === undefined ? 'gone' : (pv ? 'visible' : 'hidden')
  const same = t === pluginSays
  if (!same) mismatches += 1
  checked += 1
  console.log(String(h).padEnd(13) + '  ' + t.padEnd(18) + '  ' + pluginSays.padEnd(15) + '  ' + (same ? 'OK' : 'MISMATCH'))
}
console.log('-'.repeat(66))
console.log('checked=' + checked + '  mismatches=' + mismatches)
console.log(mismatches === 0
  ? 'RESULT: the plugin report matches Windows ground truth (no lie).'
  : 'RESULT: the plugin is still misreporting — investigate.')
process.exit(mismatches === 0 ? 0 : 1)
