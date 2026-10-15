// dsh-console-sentinel — testable ledger logic (no ctx, no I/O).
//
// Everything stateful about window tracking lives here as pure functions so
// the idle-detection algorithm can be regression-tested with stub probe data.
// index.js only wires this into the Cordis lifecycle (scan scheduler + tools).

// ConPTY backend windows never occupy the taskbar; hiding them is a no-op for
// the user. Protocol invariant, not a tunable.
export const UNMANAGED_CLASSES = new Set(['PseudoConsoleWindow'])

export const SOURCES = ['wmi-detached', 'dsh-host', 'orphaned', 'script-console', 'manual', 'unknown']

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

// Pure eligibility check for the automatic action loop. Config shape mirrors
// the Schemastery schema in index.js (scope sub-object included).
export function eligibleForAuto(rec, fgHwnd, config) {
  if (!rec || rec.hidden || rec.closed) return false
  if (UNMANAGED_CLASSES.has(rec.class)) return false
  if (config.guardForeground && rec.hwnd === fgHwnd) return false
  if (rec.idleSec < config.idleThresholdSec) return false
  const scope = config.scope ?? {}
  const scopeOk =
    (scope.wmiDetached && rec.source === 'wmi-detached') ||
    (scope.dshHost && rec.source === 'dsh-host') ||
    (scope.orphaned && rec.source === 'orphaned') ||
    (scope.scriptConsole && rec.source === 'script-console')
  if (!scopeOk) return false
  if (isTitleExcluded(rec.title, scope.excludeTitles)) return false
  return true
}

// Sweep eligibility (same rules, minus the foreground guard: explicit sweeps
// already require an opt-in via tool or force for the focused window).
export function eligibleForSweep(rec, thresholdSec, config) {
  if (!rec || rec.hidden || rec.closed) return false
  if (UNMANAGED_CLASSES.has(rec.class)) return false
  if (rec.idleSec < thresholdSec) return false
  const scope = config.scope ?? {}
  const scopeOk =
    (scope.wmiDetached && rec.source === 'wmi-detached') ||
    (scope.dshHost && rec.source === 'dsh-host') ||
    (scope.orphaned && rec.source === 'orphaned') ||
    (scope.scriptConsole && rec.source === 'script-console')
  if (!scopeOk) return false
  if (isTitleExcluded(rec.title, scope.excludeTitles)) return false
  return true
}
