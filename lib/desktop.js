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

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

# Token-elevation probe (separate Add-Type so the block above stays untouched).
if (-not ('PInvoke.ElevK' -as [type])) {
  Add-Type -TypeDefinition @"
  using System; using System.Runtime.InteropServices;
  namespace PInvoke {
    public class ElevK {
      [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, int pid);
      [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
      [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t);
      [DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetTokenInformation(IntPtr t, int c, out int info, int len, out int ret);
      public static int Elev(int pid) {
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) return -1;
        try {
          IntPtr tok;
          if (!OpenProcessToken(h, 0x0008, out tok)) return -2;
          try { int info, ret; if (!GetTokenInformation(tok, 20, out info, 4, out ret)) return -3; return info; }
          finally { CloseHandle(tok); }
        } finally { CloseHandle(h); }
      }
    }
  }
"@
}
$elevCache = @{}
function Get-Elev([int]$procid) {
  if ($elevCache.ContainsKey($procid)) { return $elevCache[$procid] }
  $e = $false
  try { if ([PInvoke.ElevK]::Elev($procid) -eq 1) { $e = $true } } catch {}
  $elevCache[$procid] = $e
  return $e
}

$excludeClass = @(${SHELL_CLASSES_PS})
$GWL_EXSTYLE = -20
$WS_EX_APPWINDOW = 0x00040000
$WS_EX_TOOLWINDOW = 0x00000080
$GW_OWNER = 4

$allProcs = @{}
$pathMap = @{}
foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
  $allProcs[[int]$p.Id] = $p.ProcessName
  try { if ($p.Path) { $pathMap[[int]$p.Id] = $p.Path } } catch {}
}

# Load System.Drawing once for icon extraction
try { Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue } catch {}
$iconCache = @{}
function Get-IconData([string]$exePath) {
  if ([string]::IsNullOrWhiteSpace($exePath)) { return '' }
  if ($iconCache.ContainsKey($exePath)) { return $iconCache[$exePath] }
  $result = ''
  try {
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exePath)
    if ($icon) {
      $bmp = $icon.ToBitmap()
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $bytes = $ms.ToArray()
      $result = 'data:image/png;base64,' + [Convert]::ToBase64String($bytes)
      $bmp.Dispose(); $icon.Dispose(); $ms.Dispose()
    }
  } catch {}
  $iconCache[$exePath] = $result
  return $result
}

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
  $icon = ''
  if ($pathMap.ContainsKey([int]$procid)) { $icon = Get-IconData $pathMap[[int]$procid] }
  $elevated = Get-Elev ([int]$procid)
  $wins.Add([PSCustomObject]@{ Hwnd = $hWnd.ToInt64(); Class = $cls; Title = $title; Pid = [int]$procid; Process = $pname; Icon = $icon; Elevated = [bool]$elevated })
  return $true
}
$null = [PInvoke.DesktopW32]::EnumWindows($cb, [IntPtr]::Zero)
[System.GC]::KeepAlive($cb)

$selfEl = $false
try { $selfEl = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')) } catch {}
$out = [PSCustomObject]@{ windows = $wins; fgHwnd = $fg.ToInt64(); selfElevated = [bool]$selfEl }
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
    return { ok: true, windows: parsed.windows || [], fgHwnd: parsed.fgHwnd || 0, selfElevated: Boolean(parsed.selfElevated) }
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
      icon: raw.icon ?? raw.Icon ?? '',
      elevated: Boolean(raw.elevated ?? raw.Elevated),
    }
    const proc = String(w.process).toLowerCase().replace(/\.exe$/, '')
    // Never select DSH/Electron, Fluent/MPI/ANSYS/solver consoles — bulk-closing
    // those kills the host or an in-progress CFD run. Belt-and-suspenders on top
    // of the protectedProcesses list (mpiexec consoles look like plain apps).
    if (/mpi|fluent|ansys|^cx\d|solver|cae|launcher|^dsh|electron|deepseek/.test(proc)) {
      kept.push({ ...w, keepReason: 'hard-protected' }); continue
    }
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
  // Split: normal → plain WM_CLOSE; elevated → one UAC-elevated graceful close
  // (an unelevated WM_CLOSE to an elevated window is silently dropped by UIPI).
  const normal = targets.filter((t) => !t.elevated)
  const elevated = targets.filter((t) => t.elevated)
  const close = await closeDesktopWindows(normal.map((t) => t.hwnd))
  const closedHwnds = new Set((close.results || []).filter((r) => r.Posted).map((r) => r.Hwnd))
  let elevRes = { results: [], closedCount: 0 }
  if (elevated.length) {
    elevRes = await runElevatedClose(elevated.map((t) => t.hwnd), opts.elevatedTimeoutMs || 120000)
    for (const r of (elevRes.results || [])) if (r.Closed) closedHwnds.add(Number(r.Hwnd))
  }
  return {
    ok: close.ok && (!elevated.length || elevRes.ok !== false || elevRes.closedCount > 0),
    dryRun: false,
    fgHwnd: probe.fgHwnd,
    targets,
    kept,
    closed: targets.filter((t) => closedHwnds.has(Number(t.hwnd))),
    elevatedCount: elevated.length,
    elevatedUacCancelled: elevated.length > 0 && elevRes.reason === 'uac-denied-or-cancelled',
    closeFailed: close.ok ? [] : (close.reason ? [{ reason: close.reason }] : normal),
  }
}

// --- elevated force-kill (UAC path, "强制关闭(管理员)") ------------------------
//
// WHY: a window owned by an elevated (admin) process cannot be closed by an
// unelevated process — Windows UIPI silently DROPS the WM_CLOSE we post, so the
// button appears to "do nothing" (measured 2026-11-07: Taskmgr / iScrCompressor /
// iScrRec all ran elevated while the DSH host did not). The only way to act on
// them is to run taskkill with an elevated token, which requires a UAC prompt.
//
// Contract: runElevatedKill(pids) spawns ONE elevated taskkill /F for all pids.
// The user sees exactly one UAC dialog; answering No yields
// { ok:false, reason:'uac-denied-or-cancelled' }. We never run taskkill
// unelevated as a fallback (it would only fail with "拒绝访问" anyway).
//
// 🛑 SAFETY: `elevated: true` makes Task.Run show the UAC shield and ASK the
// user. Without it PowerShell inherits the caller's (unelevated) token, the
// kill silently fails with access-denied, and the user thinks the button is
// broken again. Never drop this flag.

// Runs INSIDE the elevated child. Writes its verdict as JSON to __OUT_FILE__
// (the caller cannot read an elevated child's stdout reliably).
// Liveness uses tasklist (exact PID match) rather than Get-Process: 2026-11-08
// 实测 Get-Process 在某些会话下对存在进程返回空，导致误判 already-gone。
const ELEVATED_KILL_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$pids = @(__PID_LIST__)
function Test-Alive([int]$procId) {
  $o = & tasklist.exe /FI "PID eq $procId" /FO CSV /NH 2>$null
  if (-not $o) { return $false }
  $s = ($o | Out-String)
  if ($s -match ('"' + $procId + '"')) { return $true }
  return $false
}
$results = @()
foreach ($p in $pids) {
  if (-not (Test-Alive $p)) { $results += [PSCustomObject]@{ Pid = $p; Killed = $true; Reason = 'already-gone' }; continue }
  $out = & taskkill.exe /F /PID $p 2>&1 | Out-String
  Start-Sleep -Milliseconds 250
  $still = Test-Alive $p
  $results += [PSCustomObject]@{ Pid = $p; Killed = (-not $still); Reason = $(if ($still) { 'still-running' } else { 'killed' }); Detail = $out.Trim() }
}
$json = ConvertTo-Json -InputObject @($results) -Depth 4 -Compress
[System.IO.File]::WriteAllText('__OUT_FILE__', $json, (New-Object System.Text.UTF8Encoding($false)))
`

const EK_BEGIN = '===SENTINEL-EK-BEGIN==='
const EK_END = '===SENTINEL-EK-END==='
// (markers kept for backward-compatible logs only; the elevated child now
//  reports via a temp JSON file because its stdout is not readable.)

/**
 * Force-kill processes with an elevated token (one UAC prompt for the batch).
 * @param {number[]} pids target process ids
 * @param {number} timeoutMs overall timeout (the user may take a while on UAC)
 */
export function runElevatedKill(pids, timeoutMs = 120000) {
  const list = (pids || [])
    .map((p) => Number(p))
    .filter((p) => Number.isInteger(p) && p > 0)
  if (list.length === 0) return Promise.resolve({ ok: false, reason: 'no-pids', results: [] })

  // 🔴 Why a temp .ps1 + Start-Process -Verb RunAs instead of spawn(-Command):
  // 2026-11-08 实测 — 多行脚本经 `-Command` 传参时换行被 shell 层吃掉，语句
  // 粘连导致存活检测误判 already-gone，notepad 明明活着却报告"已杀"，且全程
  // 只花 337ms、没有弹 UAC（因为它压根没提权）。现在改为：
  //   ① 把脚本写进临时 .ps1（UTF-8 BOM，中文路径安全）；
  //   ② 结果写到临时 .json（提权子进程的 stdout 拿不到，只能靠文件回传）；
  //   ③ 用 Start-Process -Verb RunAs 真正触发 UAC；
  //   ④ 等子进程退出后读 .json —— 拿不到就明确报 uac-denied-or-cancelled。
  const stamp = Date.now() + '_' + Math.floor(Math.random() * 1e6)
  const outFile = path.join(os.tmpdir(), 'dsh-sentinel-ek-' + stamp + '.json')
  const psFile = path.join(os.tmpdir(), 'dsh-sentinel-ek-' + stamp + '.ps1')

  const body = ELEVATED_KILL_SCRIPT
    .replace('__PID_LIST__', list.join(','))
    .replace('__OUT_FILE__', outFile.replace(/'/g, "''"))

  // Write BOM-marked UTF-8: PS 5.1 without a BOM decodes non-ASCII as GBK and
  // the Chinese reason strings would be mojibake.
  const withBom = '\ufeff' + body
  fs.writeFileSync(psFile, withBom, 'utf8')

  const cleanup = () => {
    try { fs.unlinkSync(psFile) } catch (_) {}
  }

  // Launch elevated. Start-Process is run from a (non-elevated) helper; -Verb
  // RunAs makes Windows show the UAC prompt. -Wait blocks until the elevated
  // child exits so we know when to read the result file.
  const launcher =
    "$ErrorActionPreference='Stop'\n" +
    "try {\n" +
    "  $p = Start-Process -FilePath 'powershell.exe' " +
    "-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','" + psFile.replace(/'/g, "''") + "') " +
    "-Verb RunAs -WindowStyle Hidden -PassThru -Wait\n" +
    "  Write-Output ('EXIT=' + $p.ExitCode)\n" +
    "} catch { Write-Output ('LAUNCH_FAILED=' + $_.Exception.Message) }\n"

  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', launcher]
    let child
    try {
      child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      cleanup()
      return resolve({ ok: false, reason: 'spawn-failed: ' + err.message, results: [] })
    }

    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      cleanup()
      try { fs.unlinkSync(outFile) } catch (_) {}
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch (_) {}
      finish({ ok: false, reason: 'timeout', results: [] })
    }, timeoutMs)

    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => finish({ ok: false, reason: 'spawn-failed: ' + err.message, results: [] }))
    child.on('close', () => {
      // The elevated child's stdout is NOT ours — the truth is in outFile.
      let raw = ''
      try { raw = fs.readFileSync(outFile, 'utf8') } catch (_) { raw = '' }
      if (!raw) {
        const launched = stdout.indexOf('LAUNCH_FAILED=') >= 0
        return finish({
          ok: false,
          // Start-Process throws "操作已被用户取消" when the user clicks No.
          reason: launched ? 'uac-denied-or-cancelled' : 'no-result-file',
          stderr: (stdout + stderr).slice(-500),
          results: [],
        })
      }
      try {
        const parsed = JSON.parse(raw.replace(/^\uFEFF/, '').trim())
        const arr = Array.isArray(parsed) ? parsed : [parsed]
        const killed = arr.filter((r) => r.Killed).length
        finish({ ok: killed > 0, results: arr, killedCount: killed, total: arr.length })
      } catch (err) {
        finish({ ok: false, reason: 'json-parse: ' + err.message, stderr: raw.slice(-300), results: [] })
      }
    })
  })
}

/**
 * Graceful, elevation-aware batch CLOSE (WM_CLOSE = "per-window Alt+F4").
 *
 * Use this instead of taskkill when we want a friendly close of an elevated
 * app's windows (taskkill /F is only for when a graceful close is refused).
 * Runs inside ONE elevated child (one UAC prompt) that PostMessage(WM_CLOSE)s
 * each hwnd, then reports which windows are actually gone via a temp JSON file.
 *
 * @param {number[]} hwnds decimal window handles
 * @param {number} timeoutMs
 */
const ELEVATED_CLOSE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$hwnds = @(__HWND_LIST__)
if (-not ('PInvoke.CloseW' -as [type])) {
  Add-Type -TypeDefinition @"
  using System; using System.Runtime.InteropServices;
  namespace PInvoke {
    public class CloseW {
      [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
      [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    }
  }
"@
}
$res = @()
foreach ($hv in $hwnds) {
  $h = [IntPtr][int64]$hv
  $aliveBefore = [PInvoke.CloseW]::IsWindow($h)
  $posted = $false
  if ($aliveBefore) { $posted = [PInvoke.CloseW]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
  Start-Sleep -Milliseconds 220
  $aliveAfter = [PInvoke.CloseW]::IsWindow($h)
  $res += [PSCustomObject]@{ Hwnd = [int64]$hv; Posted = [bool]$posted; Closed = (-not $aliveAfter); WasAlive = [bool]$aliveBefore }
}
$json = ConvertTo-Json -InputObject @($res) -Depth 4 -Compress
[System.IO.File]::WriteAllText('__OUT_FILE__', $json, (New-Object System.Text.UTF8Encoding($false)))
`

export function runElevatedClose(hwnds, timeoutMs = 120000) {
  const list = (hwnds || [])
    .map((h) => Number(h))
    .filter((h) => Number.isInteger(h) && h > 0)
  if (list.length === 0) return Promise.resolve({ ok: false, reason: 'no-hwnds', results: [] })

  const stamp = Date.now() + '_' + Math.floor(Math.random() * 1e6)
  const outFile = path.join(os.tmpdir(), 'dsh-sentinel-ec-' + stamp + '.json')
  const psFile = path.join(os.tmpdir(), 'dsh-sentinel-ec-' + stamp + '.ps1')
  const body = ELEVATED_CLOSE_SCRIPT
    .replace('__HWND_LIST__', list.join(','))
    .replace('__OUT_FILE__', outFile.replace(/'/g, "''"))
  fs.writeFileSync(psFile, '\ufeff' + body, 'utf8')

  const cleanup = () => { try { fs.unlinkSync(psFile) } catch (_) {} }
  const launcher =
    "$ErrorActionPreference='Stop'\n" +
    "try {\n" +
    "  $p = Start-Process -FilePath 'powershell.exe' " +
    "-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','" + psFile.replace(/'/g, "''") + "') " +
    "-Verb RunAs -WindowStyle Hidden -PassThru -Wait\n" +
    "  Write-Output ('EXIT=' + $p.ExitCode)\n" +
    "} catch { Write-Output ('LAUNCH_FAILED=' + $_.Exception.Message) }\n"

  return new Promise((resolve) => {
    let child
    try {
      child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', launcher],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      cleanup()
      return resolve({ ok: false, reason: 'spawn-failed: ' + err.message, results: [] })
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (result) => {
      if (done) return
      done = true; clearTimeout(timer); cleanup()
      try { fs.unlinkSync(outFile) } catch (_) {}
      resolve(result)
    }
    const timer = setTimeout(() => { try { child.kill() } catch (_) {} finish({ ok: false, reason: 'timeout', results: [] }) }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => finish({ ok: false, reason: 'spawn-failed: ' + err.message, results: [] }))
    child.on('close', () => {
      let raw = ''
      try { raw = fs.readFileSync(outFile, 'utf8') } catch (_) { raw = '' }
      if (!raw) {
        const launched = stdout.indexOf('LAUNCH_FAILED=') >= 0
        return finish({ ok: false, reason: launched ? 'uac-denied-or-cancelled' : 'no-result-file', stderr: (stdout + stderr).slice(-500), results: [] })
      }
      try {
        const parsed = JSON.parse(raw.replace(/^\uFEFF/, '').trim())
        const arr = Array.isArray(parsed) ? parsed : [parsed]
        const closed = arr.filter((r) => r.Closed).length
        finish({ ok: closed > 0, results: arr, closedCount: closed, total: arr.length })
      } catch (err) {
        finish({ ok: false, reason: 'json-parse: ' + err.message, stderr: raw.slice(-300), results: [] })
      }
    })
  })
}

/**
 * Elevation-aware batch close used by the panel's "强制关闭(管理员)" button.
 *
 * @param {number[]} pids
 * @param {object} opts { selfPid, allowedProcesses: string[], timeoutMs }
 */
export async function forceCloseElevated(pids, opts = {}) {
  const hardBlocked = (name) => {
    const n = String(name || '').toLowerCase().replace(/\.exe$/, '')
    return n === 'dsh' || n.startsWith('dsh ') || n.startsWith('dsh next') || n === 'dsh desktop'
  }

  const allowed = new Set((opts.allowedProcesses || []).map((s) => String(s).toLowerCase().replace(/\.exe$/, '')))
  const selfPid = Number(opts.selfPid || 0)
  const requested = (pids || []).map((p) => Number(p)).filter((p) => Number.isInteger(p) && p > 0)
  if (!requested.length) return { ok: false, reason: 'no-pids', results: [] }

  const accepted = []
  const rejected = []
  for (const pid of requested) {
    if (selfPid && pid === selfPid) { rejected.push({ pid, reason: 'self' }); continue }
    let pname = ''
    try {
      const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 8000 })
      const line = out.trim().split(/\r?\n/)[0] || ''
      const m = line.match(/^"([^"]+)"/)
      pname = m ? m[1] : ''
    } catch (_) { pname = '' }
    if (!pname) { rejected.push({ pid, reason: 'not-running' }); continue }
    if (hardBlocked(pname)) { rejected.push({ pid, reason: 'dsh-host', process: pname }); continue }
    if (!allowed.has(String(pname).toLowerCase().replace(/\.exe$/, ''))) {
      rejected.push({ pid, reason: 'not-in-request', process: pname })
      continue
    }
    accepted.push(pid)
  }

  if (!accepted.length) return { ok: false, reason: 'all-rejected', results: [], rejected }

  const kill = await runElevatedKill(accepted, opts.timeoutMs)
  return { ...kill, rejected }
}
