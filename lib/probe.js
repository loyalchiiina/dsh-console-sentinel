// dsh-console-sentinel — Win32 console window probe.
//
// Zero native dependencies: the work is done by an embedded Windows
// PowerShell script (user32 + ntdll P/Invoke) spawned per scan. The script
// prints one JSON document between sentinel markers on stdout; everything
// else is parsing and policy in JS. Non-Windows hosts never reach here
// (the plugin guards in apply()).
//
// Probe contract (runProbe):
//   { windows: [{ hwnd, class, title, pid, visible }],
//     procs: { "<pid>": { name, cpuMs, ws, responding, ppid, pName } },
//     fgHwnd }
//
// Probe cost on the reference machine: ~350 ms end-to-end (Add-Type compile
// ~150 ms + EnumWindows ~40 ms + GetProcesses ~90 ms + NtQuery ~25 ms).
// The parent-pid path uses NtQueryInformationProcess instead of CIM
// (Get-CimInstance Win32_Process), which measured 39 s for 13 processes.
//
// NOTE: the PowerShell snippets below use `$var` (PS variables). In a JS
// template literal only `${...}` interpolates, so plain `$vars` pass through
// untouched. Do NOT introduce `${` sequences into the snippets.

import { spawn } from 'node:child_process'

const CONSOLE_CLASSES = new Set([
  'CASCADIA_HOSTING_WINDOW_CLASS', // Windows Terminal top-level windows
  'PseudoConsoleWindow',           // ConPTY pseudo-consoles
  'ConsoleWindowClass',            // classic conhost windows
])

const JSON_BEGIN = '===SENTINEL-JSON-BEGIN==='
const JSON_END = '===SENTINEL-JSON-END==='

// --- embedded PowerShell: enumerate console windows + process metadata ------

const PROBE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

if (-not ('PInvoke.W32' -as [type])) {
  Add-Type -Name W32 -Namespace PInvoke -MemberDefinition @"
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PROCESS_BASIC_INFORMATION pbi, int size, out int len);
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
"@
}

$global:__sentinelWins = @()
$global:__sentinelFg = [PInvoke.W32]::GetForegroundWindow()

$cb = [PInvoke.W32+EnumWindowsProc]{
  param($hWnd, $lParam)
  $sb = [System.Text.StringBuilder]::new(64); $null = [PInvoke.W32]::GetClassName($hWnd, $sb, 64)
  $cls = $sb.ToString()
  if ($cls -eq 'CASCADIA_HOSTING_WINDOW_CLASS' -or $cls -eq 'PseudoConsoleWindow' -or $cls -eq 'ConsoleWindowClass') {
    $t = [System.Text.StringBuilder]::new(512); $null = [PInvoke.W32]::GetWindowText($hWnd, $t, 512)
    $procid = 0; $null = [PInvoke.W32]::GetWindowThreadProcessId($hWnd, [ref]$procid)
    $global:__sentinelWins += [PSCustomObject]@{ Hwnd = $hWnd.ToInt64(); Class = $cls; Title = $t.ToString(); PID = [int]$procid; Visible = [PInvoke.W32]::IsWindowVisible($hWnd) }
  }
  return $true
}
[System.GC]::KeepAlive($cb)
$null = [PInvoke.W32]::EnumWindows($cb, [IntPtr]::Zero)

$consolePids = @($global:__sentinelWins | ForEach-Object { [int]$_.PID } | Select-Object -Unique)
$byPid = @{}
foreach ($p in [System.Diagnostics.Process]::GetProcesses()) { $byPid[$p.Id] = $p }

$ppidMap = @{}
foreach ($pid_ in $consolePids) {
  $h = [PInvoke.W32]::OpenProcess(0x1000, $false, $pid_)
  if ($h -ne [IntPtr]::Zero) {
    $pbi = New-Object PInvoke.W32+PROCESS_BASIC_INFORMATION
    $len = 0
    $status = [PInvoke.W32]::NtQueryInformationProcess($h, 0, [ref]$pbi, [System.Runtime.InteropServices.Marshal]::SizeOf($pbi), [ref]$len)
    if ($status -eq 0) { $ppidMap[$pid_] = [int]$pbi.InheritedFromUniqueProcessId.ToInt64() }
    $null = [PInvoke.W32]::CloseHandle($h)
  }
}

# Build parent -> child image-name map across ALL processes so an empty shell
# (no workload child) can be told apart from one actually running work. NtQuery
# is used (not CIM) because Get-CimInstance-per-process took ~39s on this host.
$childMap = @{}
foreach ($proc in $byPid.Values) {
  try {
    $h = [PInvoke.W32]::OpenProcess(0x1000, $false, $proc.Id)
    if ($h -eq [IntPtr]::Zero) { continue }
    try {
      $pbi = New-Object PInvoke.W32+PROCESS_BASIC_INFORMATION
      $len = 0
      $st = [PInvoke.W32]::NtQueryInformationProcess($h, 0, [ref]$pbi, [System.Runtime.InteropServices.Marshal]::SizeOf($pbi), [ref]$len)
      if ($st -eq 0) {
        $parent = [int]$pbi.InheritedFromUniqueProcessId.ToInt64()
        if ($parent -gt 0) {
          if (-not $childMap.ContainsKey($parent)) { $childMap[$parent] = New-Object System.Collections.ArrayList }
          $null = $childMap[$parent].Add($proc.Name)
        }
      }
    } finally { $null = [PInvoke.W32]::CloseHandle($h) }
  } catch { }
}

$procs = @{}
foreach ($pid_ in $consolePids) {
  $p = $byPid[$pid_]
  if (-not $p) { continue }
  $ppid = $ppidMap[$pid_]
  $pName = $null
  if ($ppid -and $byPid.ContainsKey([int]$ppid)) { $pName = $byPid[[int]$ppid].Name }
  $kids = @()
  if ($childMap.ContainsKey([int]$pid_)) { $kids = @($childMap[[int]$pid_]) }
  $procs[[string]$pid_] = @{
    Name = $p.Name
    CpuMs = [int64]($p.TotalProcessorTime.TotalMilliseconds)
    WS = $p.WorkingSet64
    Responding = [bool]$p.Responding
    PPid = [int]$ppid
    PName = $pName
    Children = $kids
  }
}

$json = ConvertTo-Json -InputObject @{ windows = $global:__sentinelWins; procs = $procs; fgHwnd = [int64]$global:__sentinelFg.ToInt64() } -Depth 6 -Compress
Write-Output ([string]::Join([char]10, @('__JSON_BEGIN__', $json, '__JSON_END__')))
`.replace(/__JSON_BEGIN__/g, JSON_BEGIN).replace(/__JSON_END__/g, JSON_END)

// --- embedded PowerShell: batch visibility ground truth -----------------------
//
// Answers one question only: for these hwnds, is the window still alive and is
// it currently visible? This is the ledger's independent source of truth, so
// "[hidden]" can never be printed for a window the user can actually see, and a
// destroyed window is never counted as a successful hide (2026-09-23 实证).
const VISIBILITY_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
if (-not ('PInvoke.Vis' -as [type])) {
  Add-Type -Name Vis -Namespace PInvoke -MemberDefinition @"
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
"@
}
$out = @{}
foreach ($h in ($env:SENTINEL_HWNDS -split ',')) {
  if (-not $h) { continue }
  $h = $h.Trim()
  if (-not $h) { continue }
  $p = [IntPtr]([int64]$h)
  if (-not [PInvoke.Vis]::IsWindow($p)) { continue }   # gone -> omitted from the map
  $out[$h] = [bool][PInvoke.Vis]::IsWindowVisible($p)
}
Write-Output ([string]::Join([char]10, @('__JSON_BEGIN__', (ConvertTo-Json -InputObject $out -Compress), '__JSON_END__')))
`.replace(/__JSON_BEGIN__/g, JSON_BEGIN).replace(/__JSON_END__/g, JSON_END)

/**
 * Ask Windows whether each hwnd is currently visible.
 * @returns {Promise<Record<string, boolean>|null>} hwnd -> visible. Windows that
 *   no longer exist are OMITTED (caller treats a missing key as destroyed).
 *   Returns null when the probe could not run, so callers fall back to the
 *   ledger instead of silently reporting everything as gone.
 */
export async function probeVisibility(hwnds, timeoutMs = 8000) {
  const list = (hwnds ?? []).filter((h) => Number.isFinite(h) && h > 0)
  if (list.length === 0) return {}
  const res = await spawnPowerShell(VISIBILITY_SCRIPT, {
    SENTINEL_HWNDS: list.map((h) => String(Number(h))).join(','),
  }, timeoutMs)
  const parsed = extractMarkeredJson(res.stdout)
  if (!parsed || typeof parsed !== 'object') return null
  const out = {}
  for (const [k, v] of Object.entries(parsed)) out[Number(k)] = Boolean(v)
  return out
}

// --- embedded PowerShell: one window action ----------------------------------

const ACTION_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

if (-not ('PInvoke.W32' -as [type])) {
  Add-Type -Name W32 -Namespace PInvoke -MemberDefinition @"
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
"@
}

$hwnd = [IntPtr][int64]$env:SENTINEL_HWND
$action = $env:SENTINEL_ACTION

if (-not [PInvoke.W32]::IsWindow($hwnd)) {
  Write-Output 'RESULT {"ok": false, "reason": "hwnd-not-a-window"}'
  exit 0
}
$beforeVisible = [PInvoke.W32]::IsWindowVisible($hwnd)

switch ($action) {
  'hide'     { $null = [PInvoke.W32]::ShowWindow($hwnd, 0) }   # SW_HIDE
  # SW_SHOWNORMAL, not SW_SHOW(5): measured 2026-09-16, SW_SHOW leaves a
  # SW_HIDDEN Windows Terminal window invisible; SW_SHOWNORMAL restores it.
  'show'     {
    $null = [PInvoke.W32]::ShowWindow($hwnd, 1)
    Start-Sleep -Milliseconds 250
    if (-not [PInvoke.W32]::IsWindowVisible($hwnd)) { $null = [PInvoke.W32]::ShowWindow($hwnd, 9) }  # fallback SW_RESTORE
  }
  'minimize' { $null = [PInvoke.W32]::ShowWindow($hwnd, 6) }   # SW_MINIMIZE
  'restore'  { $null = [PInvoke.W32]::ShowWindow($hwnd, 9) }   # SW_RESTORE
  'close'    { $null = [PInvoke.W32]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }  # WM_CLOSE
  default    { Write-Output 'RESULT {"ok": false, "reason": "unknown-action"}'; exit 0 }
}

Start-Sleep -Milliseconds 400
$afterVisible = [PInvoke.W32]::IsWindowVisible($hwnd)
$stillWindow = [PInvoke.W32]::IsWindow($hwnd)

$ok = switch ($action) {
  'close'    { -not $stillWindow }
  'hide'     { -not $afterVisible }
  'show'     { $afterVisible }
  'restore'  { $true }
  'minimize' { $true }
  default    { $false }
}$resultObj = @{ ok = $ok; action = $action; beforeVisible = $beforeVisible; afterVisible = $afterVisible; stillWindow = $stillWindow }
Write-Output ('RESULT ' + (ConvertTo-Json $resultObj -Compress))
`

function spawnPowerShell(script, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, ...env },
      timeout: timeoutMs,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (err) => resolve({ ok: false, stdout, stderr: String(err) }))
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }))
  })
}

// Extract the JSON document emitted between the sentinel markers.
function extractMarkeredJson(stdout) {
  const begin = stdout.indexOf(JSON_BEGIN)
  if (begin < 0) return null
  const start = begin + JSON_BEGIN.length
  const end = stdout.indexOf(JSON_END, start)
  if (end < 0) return null
  try { return JSON.parse(stdout.slice(start, end).trim()) } catch { return null }
}

function tryParse(text) {
  try { return JSON.parse(text) } catch { return null }
}

// --- public API -------------------------------------------------------------

export async function runProbe(timeoutMs = 20000) {
  const res = await spawnPowerShell(PROBE_SCRIPT, {}, timeoutMs)
  if (!res.ok) {
    return { ok: false, reason: 'powershell-failed', stderr: res.stderr.slice(-800), windows: [], procs: {}, fgHwnd: 0 }
  }
  const data = extractMarkeredJson(res.stdout)
  if (!data) {
    return { ok: false, reason: 'parse-failed', stderr: res.stderr.slice(-800), windows: [], procs: {}, fgHwnd: 0 }
  }
  const windows = Array.isArray(data.windows)
    ? data.windows.filter((w) => CONSOLE_CLASSES.has(w.Class))
    : []
  return {
    ok: true,
    windows: windows.map((w) => ({
      hwnd: Number(w.Hwnd),
      class: String(w.Class),
      title: String(w.Title ?? ''),
      pid: Number(w.PID),
      visible: Boolean(w.Visible),
    })),
    procs: (data.procs && typeof data.procs === 'object') ? data.procs : {},
    fgHwnd: Number(data.fgHwnd ?? 0),
  }
}

export async function runWindowAction(hwnd, action, timeoutMs = 8000) {
  const allowed = ['hide', 'show', 'minimize', 'restore', 'close']
  if (!allowed.includes(action)) return { ok: false, reason: 'unknown-action' }
  const res = await spawnPowerShell(ACTION_SCRIPT, {
    SENTINEL_HWND: String(Number(hwnd)),
    SENTINEL_ACTION: action,
  }, timeoutMs)
  const line = res.stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('RESULT '))
  if (!line) {
    return { ok: false, reason: res.ok ? 'no-result-line' : 'powershell-failed', stderr: res.stderr.slice(-400) }
  }
  return tryParse(line.slice('RESULT '.length)) ?? { ok: false, reason: 'result-parse-failed' }
}

export const supportedActions = ['hide', 'show', 'minimize', 'restore', 'close']
export const consoleClasses = [...CONSOLE_CLASSES]
