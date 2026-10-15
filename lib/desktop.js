// dsh-console-sentinel — desktop (all taskbar windows) cleanup.
//
// Merged from the desktop "一键关闭其他窗口" shortcut (close-all-windows.ps1):
// enumerate every visible top-level taskbar window, select the ones that may
// be cleaned up, and close them gracefully (WM_CLOSE). The selection rule is
// the single source of truth for both the plugin tool and the desktop
// shortcut, and it HARD-GUARANTEES that PowerShell / Python console windows
// are never selected — those host long-running jobs (Fluent runs, detached
// scripts) and must only ever be managed through the plugin's console path
// (hide/lossless), never through a bulk desktop cleanup.
//
// Probe contract (runDesktopProbe):
//   { windows: [{ hwnd, class, title, pid, process }], fgHwnd }
//
// Selection (selectCleanupTargets — pure, unit-tested):
//   skipped: foreground window, this process, shell/system classes,
//            protected processes (default powershell/pwsh/python/pythonw),
//            explicit keepTitles / keepPids.
//   everything else that is a visible titled app window -> target.

import { spawn } from 'node:child_process'

const JSON_BEGIN = '===SENTINEL-DESKTOP-JSON-BEGIN==='
const JSON_END = '===SENTINEL-DESKTOP-JSON-END==='

// Non-app windows: desktop, taskbar, start menu / action center, IME popups.
export const SHELL_CLASSES = [
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
  'Windows.UI.Core.CoreWindow', 'DV2ControlHost', 'Shell_InputPanel',
  'WindowsInternal.ComposableShell.Experiences.TextInputHintPopup',
]

// Default protected processes (lowercase, without .exe). Windows hosting these
// are console sessions of script interpreters — the plugin's console path
// handles them (lossless hide); bulk desktop cleanup must never touch them.
//
// 2026-09-22 widened (user-approved) beyond the upstream list. Rationale, each
// verified against a live probe:
//   dsh desktop  — the harness host itself; closing it kills the session
//   explorer     — file manager / shell; closing flashes the taskbar and can
//                  take the desktop with it. (Distinct Hwnds share this pid.)
//   taskmgr      — closing Task Manager is a forced-end acting on other apps
//   fluent,      — Fluent Launcher / solver front-ends: long-running CFD work
//   launcher1      must go through the lossless console path, never closed here
export const DEFAULT_PROTECTED_PROCESSES = [
  'powershell', 'pwsh', 'python', 'pythonw',
  'dsh desktop', 'explorer', 'taskmgr',
  'fluent', 'launcher1',
]

// --- embedded PowerShell: enumerate all visible top-level app windows --------

// Comma-joined PS string literals, ready to drop inside @( ... ) at the call
// site. NOTE: must NOT wrap in [ ... ] — `@(['a','b'])` is a PowerShell parse
// error ("Missing type name after '['"), which silently yielded
// no-marker-output and broke every CLI/desktop-cleanup call.
const SHELL_CLASSES_PS = SHELL_CLASSES.map((c) => `'${c}'`).join(',')

const DESKTOP_PROBE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

if (-not ('PInvoke.DesktopW32' -as [type])) {
  Add-Type -Name DesktopW32 -Namespace PInvoke -MemberDefinition @"
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtr")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
"@
}

$excludeClass = @(${SHELL_CLASSES_PS})
$GWL_EXSTYLE = -20
$WS_EX_APPWINDOW = 0x00040000
$WS_EX_TOOLWINDOW = 0x00000080
$GW_OWNER = 4

$allProcs = @{}
foreach ($p in [System.Diagnostics.Process]::GetProcesses()) { $allProcs[[int]$p.Id] = $p.ProcessName }

$wins = New-Object System.Collections.Generic.List[object]
$fg = [PInvoke.DesktopW32]::GetForegroundWindow()

$cb = [PInvoke.DesktopW32+EnumWindowsProc]{
  param($hWnd, $lParam)
  if (-not [PInvoke.DesktopW32]::IsWindowVisible($hWnd)) { return $true }
  $sb = [System.Text.StringBuilder]::new(256); $null = [PInvoke.DesktopW32]::GetClassName($hWnd, $sb, 256)
  $cls = $sb.ToString()
  if ($excludeClass -contains $cls) { return $true }
  $t = [System.Text.StringBuilder]::new(512); $null = [PInvoke.DesktopW32]::GetWindowText($hWnd, $t, 512)
  $title = $t.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  $ex = [PInvoke.DesktopW32]::GetWindowLongPtr($hWnd, $GWL_EXSTYLE).ToInt64()
  $owner = [PInvoke.DesktopW32]::GetWindow($hWnd, $GW_OWNER)
  $isApp = (($ex -band $WS_EX_APPWINDOW) -ne 0) -or ((($ex -band $WS_EX_TOOLWINDOW) -eq 0) -and $owner -eq [IntPtr]::Zero)
  if (-not $isApp) { return $true }
  $procid = 0; $null = [PInvoke.DesktopW32]::GetWindowThreadProcessId($hWnd, [ref]$procid)
  $pname = ''
  if ($allProcs.ContainsKey([int]$procid)) { $pname = $allProcs[[int]$procid] }
  $wins.Add([PSCustomObject]@{ Hwnd = $hWnd.ToInt64(); Class = $cls; Title = $title; Pid = [int]$procid; Process = $pname })
  return $true
}
$null = [PInvoke.DesktopW32]::EnumWindows($cb, [IntPtr]::Zero)
[System.GC]::KeepAlive($cb)

$out = [PSCustomObject]@{ windows = $wins; fgHwnd = $fg.ToInt64() }
Write-Output '__JSON_BEGIN__'
Write-Output ($out | ConvertTo-Json -Depth 4 -Compress)
Write-Output '__JSON_END__'
`.replace(/__JSON_BEGIN__/g, JSON_BEGIN).replace(/__JSON_END__/g, JSON_END)

function spawnPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (!done) { done = true; child.kill(); resolve({ ok: false, reason: 'timeout' }) }
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => {
      if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, reason: 'spawn-failed: ' + err.message }) }
    })
    child.on('close', () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: true, stdout, stderr })
    })
  })
}

function extractMarkeredJson(stdout) {
  const b = stdout.indexOf(JSON_BEGIN)
  const e = stdout.indexOf(JSON_END)
  if (b === -1 || e === -1 || e <= b) return null
  return stdout.slice(b + JSON_BEGIN.length, e).trim()
}

export async function runDesktopProbe(timeoutMs = 20000) {
  const res = await spawnPowerShell(DESKTOP_PROBE_SCRIPT, timeoutMs)
  if (!res.ok) return { ok: false, reason: res.reason, stderr: res.stderr || '' }
  const json = extractMarkeredJson(res.stdout)
  if (!json) return { ok: false, reason: 'no-marker-output', stderr: res.stderr.slice(-400) }
  try {
    const parsed = JSON.parse(json)
    return { ok: true, windows: parsed.windows || [], fgHwnd: parsed.fgHwnd || 0 }
  } catch (err) {
    return { ok: false, reason: 'json-parse: ' + err.message, stderr: res.stdout.slice(-400) }
  }
}

// --- selection (pure) ---------------------------------------------------------

function titleMatches(title, keepTitles) {
  for (const t of keepTitles || []) {
    if (t && title && title.toLowerCase().includes(String(t).toLowerCase())) return true
  }
  return false
}

/**
 * Select which desktop windows may be cleaned up.
 * windows: probe rows; opts: { fgHwnd, selfPid, protectedProcesses, keepTitles, keepPids, nowHwndSet }
 * Returns { targets, kept } with rows annotated { reason } / { keepReason }.
 */
export function selectCleanupTargets(windows, opts = {}) {
  const fgHwnd = opts.fgHwnd || 0
  const selfPid = opts.selfPid || 0
  const protectedProcesses = (opts.protectedProcesses || DEFAULT_PROTECTED_PROCESSES)
    .map((p) => String(p).toLowerCase().replace(/\.exe$/, ''))
  const keepPids = (opts.keepPids || []).map(Number)
  const keepTitles = opts.keepTitles || []

  const targets = []
  const kept = []
  for (const raw of windows || []) {
    // 🔴 The embedded PowerShell probe emits PascalCase keys
    // (Hwnd/Class/Title/Pid/Process); normalise once so every guard below
    // actually compares real values. Reading w.process/w.hwnd directly made
    // every guard fall through (undefined !== anything), which silently put
    // DSH Desktop / explorer / Taskmgr into the close list.
    const w = {
      hwnd: raw.hwnd ?? raw.Hwnd,
      pid: raw.pid ?? raw.Pid,
      class: raw.class ?? raw.Class ?? '',
      title: raw.title ?? raw.Title ?? '',
      process: raw.process ?? raw.Process ?? '',
    }
    const proc = String(w.process).toLowerCase().replace(/\.exe$/, '')
    if (w.hwnd === fgHwnd) { kept.push({ ...w, keepReason: 'foreground' }); continue }
    if (selfPid && w.pid === selfPid) { kept.push({ ...w, keepReason: 'self' }); continue }
    if (SHELL_CLASSES.includes(w.class)) { kept.push({ ...w, keepReason: 'shell-class' }); continue }
    if (protectedProcesses.includes(proc)) { kept.push({ ...w, keepReason: 'protected-process' }); continue }
    if (keepPids.includes(w.pid)) { kept.push({ ...w, keepReason: 'keep-pid' }); continue }
    if (titleMatches(w.title, keepTitles)) { kept.push({ ...w, keepReason: 'keep-title' }); continue }
    targets.push({ ...w })
  }
  return { targets, kept }
}

// --- close (WM_CLOSE, graceful) ------------------------------------------------
// NOTE: built with string concatenation (not a template literal) so the
// PowerShell ${...} placeholders survive until .replace() fills them in.

const CLOSE_JSON_BEGIN = '===SENTINEL-CLOSE-JSON-BEGIN==='
const CLOSE_JSON_END = '===SENTINEL-CLOSE-JSON-END==='

const CLOSE_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$ErrorActionPreference = 'Stop'",
  "if (-not ('PInvoke.CloseW32' -as [type])) {",
  "  Add-Type -Name CloseW32 -Namespace PInvoke -MemberDefinition @\"",
  "  [DllImport(\"user32.dll\")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);",
  "  [DllImport(\"user32.dll\")] public static extern bool IsWindow(IntPtr hWnd);",
  "\"@",
  "}",
  "$result = @()",
  "foreach ($raw in '${HWND_LIST}'.Split(',')) {",
  "  $h = 0",
  "  if (-not [int64]::TryParse($raw, [ref]$h)) { continue }",
  "  $alive = [PInvoke.CloseW32]::IsWindow([IntPtr]$h)",
  "  $posted = $false",
  "  if ($alive) { $posted = [PInvoke.CloseW32]::PostMessage([IntPtr]$h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }",
  "  $result += [PSCustomObject]@{ Hwnd = $h; WasAlive = [bool]$alive; Posted = [bool]$posted }",
  "}",
  "Write-Output '${CLOSE_JSON_BEGIN}'",
  "Write-Output (($result | ConvertTo-Json -Depth 3 -Compress))",
  "Write-Output '${CLOSE_JSON_END}'",
].join('\n')

export async function closeDesktopWindows(hwnds, timeoutMs = 15000) {
  const list = (hwnds || []).map((h) => Number(h)).filter((h) => Number.isInteger(h) && h > 0)
  if (list.length === 0) return { ok: true, results: [] }
  const script = CLOSE_SCRIPT
    .replace('${HWND_LIST}', list.join(','))
    .replaceAll('${CLOSE_JSON_BEGIN}', CLOSE_JSON_BEGIN)
    .replaceAll('${CLOSE_JSON_END}', CLOSE_JSON_END)
  const res = await spawnPowerShell(script, timeoutMs)
  if (!res.ok) return { ok: false, reason: res.reason, results: [] }
  const b = res.stdout.indexOf(CLOSE_JSON_BEGIN)
  const e = res.stdout.indexOf(CLOSE_JSON_END)
  if (b === -1 || e === -1) return { ok: false, reason: 'no-marker-output', stderr: res.stderr.slice(-400), results: [] }
  try {
    const parsed = JSON.parse(res.stdout.slice(b + CLOSE_JSON_BEGIN.length, e).trim())
    return { ok: true, results: Array.isArray(parsed) ? parsed : [parsed] }
  } catch (err) {
    return { ok: false, reason: 'json-parse: ' + err.message, results: [] }
  }
}

/**
 * Full cleanup run: probe -> select -> (optionally) close.
 * opts: { selfPid, protectedProcesses, keepTitles, keepPids, confirm, probeTimeoutMs }
 * Without confirm this is a dry run: targets are planned but nothing is closed.
 */
export async function runDesktopCleanup(opts = {}) {
  const probe = await runDesktopProbe(opts.probeTimeoutMs)
  if (!probe.ok) return { ok: false, reason: probe.reason, dryRun: !opts.confirm, targets: [], kept: [], closed: [] }
  const { targets, kept } = selectCleanupTargets(probe.windows, opts)
  if (!opts.confirm || targets.length === 0) {
    return { ok: true, dryRun: !opts.confirm, fgHwnd: probe.fgHwnd, targets, kept, closed: [] }
  }
  const close = await closeDesktopWindows(targets.map((t) => t.hwnd))
  const closedHwnds = new Set((close.results || []).filter((r) => r.Posted).map((r) => r.Hwnd))
  return {
    ok: close.ok,
    dryRun: false,
    fgHwnd: probe.fgHwnd,
    targets,
    kept,
    closed: targets.filter((t) => closedHwnds.has(t.hwnd)),
    closeFailed: close.ok ? [] : (close.reason ? [{ reason: close.reason }] : targets),
  }
}
