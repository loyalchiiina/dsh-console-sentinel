// dsh-console-sentinel — testable ledger logic (no ctx, no I/O).
//
// Everything stateful about window tracking lives here as pure functions so
// the idle-detection algorithm can be regression-tested with stub probe data.
// index.js only wires this into the Cordis lifecycle (scan scheduler + tools).

// ConPTY backend windows never occupy the taskbar; hiding them is a no-op for
// the user. Protocol invariant, not a tunable.
export const UNMANAGED_CLASSES = new Set(['PseudoConsoleWindow'])

// Windows Explorer clones a separate window class for each File Explorer folder
// view ("CabinetWClass" on Win10/11, "ExploreWClass" on older NT / classic
// "Win32 文件恢复" paths). A folder window is closable at the hwnd level with
// WM_CLOSE (like Alt+F4) WITHOUT touching the explorer.exe process — the
// process keeps alive and the desktop / taskbar stay up. Explorer windows must
// therefore be treated separately from the console path: they are never
// eligible for the auto console sweep, but the user may single-close them.
export const EXPLORER_FOLDER_CLASSES = new Set(['cabinetwclass', 'explorewclass'])

// Desktop / shell surfaces that must NEVER be side-bar-closed — closing them
// kills the desktop, taskbar, start menu or IME. This is the lead's red-line
// list. Class names are compared case-insensitively.
export const DESKTOP_SHELL_CLASSES = new Set([
  'progman',            // desktop icon layer
  'workerw',            // desktop wallpaper
  'shell_traywnd',      // taskbar
  'shell_secondarytraywnd', // secondary monitor taskbar
  'dv2controlhost',     // start menu / action center host
  'msgrimewindowclass', // IME message window
  'sysshadow',          // desktop shadow surface
])

// Only a real folder WINDOW (not a desktop shell surface owned by explorer.exe)
// may be WM_CLOSE'd. `rec` must carry `.class` (lowercased) and `.processName`
// (bare explorer, i.e. "explorer" after normName()).
export function isExplorerFolderWindow(rec) {
  if (!rec) return false
  if (normName(rec?.processName) !== 'explorer') return false
  const cls = String(rec?.class ?? '').toLowerCase()
  if (DESKTOP_SHELL_CLASSES.has(cls)) return false
  return EXPLORER_FOLDER_CLASSES.has(cls)
}

// Whether a window (by class name, lowercased) is a desktop shell surface that
// must never be closed, regardless of its owning process.
export function isDesktopShellClass(cls) {
  return DESKTOP_SHELL_CLASSES.has(String(cls ?? '').toLowerCase())
}

export const SOURCES = ['wmi-detached', 'dsh-host', 'orphaned', 'script-console', 'manual', 'unknown']

// --- process classes that must NEVER be auto-managed -------------------------
// Console hosts / shells / Fluent-MPI processes are either the harness itself
// or a live compute job; touching them can kill work. The user-managed
// whitelist (lib/whitelist.js) is a separate, additive layer checked in the
// same pass.
// Values are compared after normName() strips a trailing ".exe", so listing them
// bare keeps them correct whether the probe reports "fl2610" or "fl2610.exe".
export const HARD_PROTECTED_PROCESSES = new Set([
  'explorer', 'taskmgr', 'dsh desktop', 'dwm', 'winlogon',
  'csrss', 'wininit', 'services', 'lsass', 'svchost',
  'sihost', 'ctfmon', 'conhost', 'openconsole',
  'fl2610', 'cx2610', 'mpiexec', 'smpd', 'fluent',
  'fluent-meshing', 'launcher1',
])

// Interpreters whose console window is "just a shell" when it has no workload
// child process (conhost / OpenConsole are console hosts, not workload).
export const INTERPRETER_PROCESSES = new Set([
  'powershell', 'pwsh', 'cmd', 'python', 'pythonw',
])

const CONSOLE_HOST_CHILDREN = new Set(['conhost', 'openconsole'])

// The probe reports image names bare ("powershell", "conhost"), while a config
// whitelist often carries ".exe"; normalise both sides so a comparison can
// never silently miss on the suffix (2026-11-03 实测：不带 .exe 的名字会让空判定
// 与硬保护全部失效).
function normName(n) {
  return String(n ?? '').toLowerCase().replace(/\.exe$/, '')
}

// PowerShell can serialise a single-element array as a bare string, so coerce
// defensively — a lone workload child must never look like "no children".
function toNameArray(v) {
  if (Array.isArray(v)) return v.map((s) => String(s))
  if (v === null || v === undefined) return []
  return [String(v)]
}

export function isHardProtected(rec) {
  const n = normName(rec?.processName)
  return n !== '' && HARD_PROTECTED_PROCESSES.has(n)
}

// A window title that just names an interpreter with no running command is the
// default title of a brand-new/idle terminal tab (e.g.
// "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"). Titles that show
// a command ("cmd - npm run dev") are NOT bare.
export function isBareShellTitle(title) {
  const t = String(title ?? '').trim()
  if (t === '') return false
  if (/ [-–—] /.test(t)) return false
  const base = t.split('\\').pop().toLowerCase()
  return /^(?:powershell|pwsh|cmd|python|pythonw)(?:\.exe)?$/.test(base)
}

export function isEmptyConsole(rec) {
  const n = normName(rec?.processName)
  if (INTERPRETER_PROCESSES.has(n)) {
    const kids = Array.isArray(rec.childNames) ? rec.childNames : []
    return kids.filter((k) => !CONSOLE_HOST_CHILDREN.has(normName(k))).length === 0
  }
  // Windows Terminal (CASCADIA) windows are owned by WindowsTerminal.exe, not by
  // the shell running inside, so the child-process test above cannot see the
  // inner shell. Treat such a window as an empty shell only when its title is the
  // default bare interpreter path and the terminal is not burning CPU. Whether it
  // may actually be acted on is decided separately by isHardProtected /
  // isWhitelisted / eligibility — this only answers "is it empty?".
  if (/cascadia/i.test(String(rec?.class ?? ''))) {
    return isBareShellTitle(rec?.title) && (rec?.cpuPct == null || rec.cpuPct <= 1)
  }
  return false
}

// User whitelist: process image names (case-insensitive, ".exe" optional) or
// window-title substrings. Matching either exempts a window from every action.
export function isWhitelisted(rec, config) {
  const wl = config?.whitelist ?? {}
  const procNames = (Array.isArray(wl.processes) ? wl.processes : []).map((s) => normName(s))
  const n = normName(rec?.processName)
  if (n !== '' && procNames.includes(n)) return true
  const titles = Array.isArray(wl.titles) ? wl.titles : []
  const t = String(rec?.title ?? '')
  return titles.some((frag) => frag !== '' && t.includes(String(frag)))
}

// A Windows Terminal top-level window belongs to the WindowsTerminal process
// (whose parent is usually svchost/explorer), NOT to the script it is running —
// so the parent chain cannot tell a scripted session from a hand-opened one.
// The console title does: a launched process defaults its console title to its
// own full path ("C:\app\python.exe"), while a console the user opened
// interactively keeps a prompt-style title ("Windows PowerShell", a directory,
// ...). Matching the path form is deliberately conservative — it can miss a
// scripted session that retitles itself, but it never claims an interactive
// console that happens to sit idle.
const SCRIPT_TITLE_RE = /(\\|^)(python|pythonw|powershell|pwsh|cmd|fluent|fluent-meshing)\.exe$/i

export function isScriptConsoleTitle(title) {
  const t = String(title ?? '').trim()
  if (!t || t.length > 512) return false
  return SCRIPT_TITLE_RE.test(t)
}

export function classifySource(proc, title) {
  if (!proc) {
    // parent info missing; the title alone can still identify a scripted session
    return isScriptConsoleTitle(title) ? 'script-console' : 'unknown'
  }
  const pname = String(proc.PName ?? '').toLowerCase()
  if (pname === 'wmiprvse.exe') return 'wmi-detached'
  if (pname === 'dsh desktop.exe') return 'dsh-host'
  if (proc.PPid && proc.PPid > 0 && !proc.PName) return 'orphaned'
  // parent chain says "launched normally" (typical for a WT window): fall back
  // to the console title, which still carries the session identity.
  if (isScriptConsoleTitle(title)) return 'script-console'
  return 'manual'
}

export function createLedger() {
  const records = new Map()

  function makeRecord(win, proc, now) {
    return {
      hwnd: win.hwnd,
      class: win.class,
      title: win.title,
      pid: win.pid,
      processName: proc ? proc.Name : '',
      parentName: proc ? String(proc.PName ?? '') : '',
      source: classifySource(proc, win.title),
      visible: Boolean(win.visible),
      firstSeen: now,
      lastSeen: now,
      lastCpuMs: proc ? Number(proc.CpuMs) : null,
      lastSampleAt: proc ? now : 0,
      idleTicks: 0,
      idleSince: 0,
      busyStreak: 0,
      hidden: false,
      closed: false,
      // true once we have OBSERVED that the window no longer exists. Distinct
      // from `hidden`: a destroyed window was never successfully hidden, so it
      // must not be reported as such (2026-09-23 实证).
      destroyed: false,
      cpuPct: 0,
      idleSec: 0,
      // Child process image names (console hosts such as conhost are kept but
      // ignored by isEmptyConsole). Lets us tell an empty shell from one that
      // is running a workload.
      childNames: toNameArray(proc ? proc.Children : null),
    }
  }

  // Apply one probe result to the ledger. Returns what changed so callers
  // (auto-action loop, tests) can react without re-reading the whole map.
  // `spikeTolerance` lets a single busy sample (background jitter of a host
  // process such as WindowsTerminal) pass without resetting the idle clock;
  // only `spikeTolerance` consecutive busy samples break the idle streak.
  function update(probe, now) {
    const seen = new Set()
    const added = []
    const removed = []

    for (const win of probe.windows) {
      seen.add(win.hwnd)
      const proc = (probe.procs && probe.procs[String(win.pid)]) || null
      let rec = records.get(win.hwnd)

      if (!rec) {
        rec = makeRecord(win, proc, now)
        records.set(win.hwnd, rec)
        added.push(rec)
      } else {
        rec.lastSeen = now
        rec.visible = Boolean(win.visible)
        if (proc) {
          rec.processName = proc.Name
          if (proc.Children !== undefined) rec.childNames = toNameArray(proc.Children)
          if (proc.PName !== undefined) rec.parentName = String(proc.PName ?? '')
          if (rec.lastCpuMs !== null && rec.lastSampleAt > 0) {
            const dCpu = Number(proc.CpuMs) - rec.lastCpuMs
            const dtSec = (now - rec.lastSampleAt) / 1000
            let pct = dtSec > 0 ? (dCpu / 1000 / dtSec) * 100 : 0
            if (pct < 0) pct = 0
            rec.cpuPct = pct
            const tolerance = (probe.spikeTolerance && probe.spikeTolerance > 0) ? probe.spikeTolerance : 1
            if (rec.cpuPct < probe.cpuThresholdPct) {
              rec.idleTicks += 1
              rec.busyStreak = 0
              if (rec.idleSince === 0) rec.idleSince = now
            } else {
              rec.busyStreak += 1
              if (rec.busyStreak >= tolerance) {
                rec.idleTicks = 0
                rec.idleSince = 0
              }
              // else: single-sample jitter, keep the idle clock running
            }
          }
          rec.lastCpuMs = Number(proc.CpuMs)
          rec.lastSampleAt = now
        }
      }
      rec.idleSec = rec.idleSince ? (now - rec.idleSince) / 1000 : 0
    }

    for (const [hwnd, rec] of records) {
      if (!seen.has(hwnd)) {
        records.delete(hwnd)
        removed.push(rec)
      }
    }

    return { added, removed }
  }

  // `hidden` is only ever set from an OBSERVED post-action state (see index.js
  // actOn) — it is never inferred from the fact that we issued a hide. `destroyed`
  // marks windows we have observed to be gone, which is a different outcome and
  // must never be counted as a hide (2026-09-23 实证).
  //
  // `reconcileVisibility` is the anti-lie guard: a caller can hand in a live map
  // of hwnd -> IsWindowVisible measured independently of this plugin, and any
  // record whose claimed `hidden` disagrees with that ground truth is corrected.
  // Without it the ledger can assert "[hidden]" for a window the user can see.
  function reconcileVisibility(truth) {
    if (!truth) return []
    const corrected = []
    for (const rec of records.values()) {
      const actual = truth[rec.hwnd]
      if (actual === undefined) continue
      const reallyVisible = Boolean(actual)
      rec.visible = reallyVisible
      if (rec.hidden === reallyVisible) {
        // We claimed hidden but it is visible (or vice versa) — believe reality.
        rec.hidden = !reallyVisible
        corrected.push(rec.hwnd)
      }
    }
    return corrected
  }

  function snapshot({ includeHidden = true } = {}) {
    return [...records.values()]
      .filter((r) => includeHidden || r.visible)
      .map((r) => ({
        hwnd: r.hwnd,
        class: r.class,
        title: r.title,
        pid: r.pid,
        processName: r.processName,
        parentName: r.parentName,
        source: r.source,
        visible: r.visible,
        hidden: r.hidden,
        destroyed: Boolean(r.destroyed),
        cpuPct: Math.round(r.cpuPct * 10) / 10,
        idleSec: Math.round(r.idleSec),
        childCount: Array.isArray(r.childNames) ? r.childNames.length : 0,
        isEmpty: isEmptyConsole(r),
        firstSeen: r.firstSeen,
      }))
      .sort((a, b) => b.idleSec - a.idleSec)
  }

  function findByTarget(target) {
    if (typeof target.hwnd === 'number' && target.hwnd > 0) {
      return records.get(target.hwnd) ?? null
    }
    if (typeof target.pid === 'number' && target.pid > 0) {
      return [...records.values()].find((r) => r.pid === target.pid && r.visible)
        ?? [...records.values()].find((r) => r.pid === target.pid)
        ?? null
    }
    return null
  }

  return { records, update, snapshot, findByTarget, reconcileVisibility }
}

export function isTitleExcluded(title, excludeTitles) {
  const t = String(title ?? '')
  return (excludeTitles ?? []).some((frag) => t.includes(frag))
}

// Shared basic checks for both the automatic loop and explicit sweeps. Config
// shape mirrors the Schemastery schema in index.js (scope/whitelist included).
function consoleBasic(rec, fgHwnd, config, thresholdSec) {
  if (!rec || rec.hidden || rec.closed) return false
  if (UNMANAGED_CLASSES.has(rec.class)) return false
  if (config.guardForeground && rec.hwnd === fgHwnd) return false
  if (rec.idleSec < thresholdSec) return false
  if (isHardProtected(rec)) return false
  if (isWhitelisted(rec, config)) return false
  const scope = config.scope ?? {}
  if (isTitleExcluded(rec.title, scope.excludeTitles)) return false
  return true
}

function inScope(rec, config) {
  const scope = config.scope ?? {}
  const sourceOk =
    (scope.wmiDetached && rec.source === 'wmi-detached') ||
    (scope.dshHost && rec.source === 'dsh-host') ||
    (scope.orphaned && rec.source === 'orphaned') ||
    (scope.scriptConsole && rec.source === 'script-console')
  if (sourceOk) return true
  // Empty-interpreter consoles are eligible across sources (except the DSH host
  // itself) once enabled — this is the precise, safe replacement for switching
  // the whole `orphaned` scope on (which would also match mpiexec / fl2610).
  if (scope.emptyConsole === true && rec.source !== 'dsh-host' && isEmptyConsole(rec)) return true
  return false
}

// Pure eligibility check for the automatic action loop.
export function eligibleForAuto(rec, fgHwnd, config) {
  return consoleBasic(rec, fgHwnd, config, config.idleThresholdSec) && inScope(rec, config)
}

// Sweep eligibility (same rules, minus the foreground guard: explicit sweeps
// already require an opt-in via tool or force for the focused window).
export function eligibleForSweep(rec, thresholdSec, config) {
  return consoleBasic(rec, null, { ...config, guardForeground: false }, thresholdSec) && inScope(rec, config)
}
