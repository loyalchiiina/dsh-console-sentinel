# Changelog

## 0.1.2 (2026-09-23) — the ledger claimed hides it never verified

Reported by the user, correctly: “你说你隐藏了 13 个真的假的”. It was **partly
false**. An independent Win32 check (`IsWindowVisible`) of the 13 hwnds the
plugin had reported as `[hidden]` found **9 genuinely hidden, 4 already
destroyed, and 1 still visible** (a minimised Windows Terminal). Three defects:

1. **`hidden` was set from intent, not from observation** (`lib/index.js`
   `actOn`). `rec.hidden = true` ran as soon as `runWindowAction` returned
   `ok`, before anything re-checked the window. The action script *already*
   measured the post-state (`afterVisible`, `stillWindow`) — the ledger simply
   never looked at it. `hidden` is now derived from that measured state, and a
   failed action can no longer leave a stale `hidden` claim behind.
2. **“destroyed” and “hidden” were conflated.** A window that no longer exists
   was counted as a successful hide, which inflated the reported number. There
   is now a separate `destroyed` flag, surfaced in the list as `[gone]`, and a
   gone window is never counted as hidden. This is why “I hid 13” was wrong:
   4 of them were gone, not hidden.
3. **`console_window_action` returned invalid output on every success**
   (`lib/index.js`). It built `reason: res.ok ? undefined : res.reason`, so a
   successful call carried an explicit `reason: undefined` against a
   schema-declared `string` → validation failed and the runtime dropped the
   whole result as *“value is not lossless JSON”*. The hide really happened;
   the caller just never saw it. `reason` is now omitted on success (and
   coerced to a string on failure) instead of being set to `undefined`.
   **`desktop_windows_cleanup` had the identical defect** — and there it sat on
   the tool's *normal* path (returning a dry-run plan), so it broke every call,
   not just some. Fixed in both; a grep for the pattern now matches only the
   explanatory comment.

Also added:

- **`probeVisibility()`** (`lib/probe.js`) — a lightweight batch
  `IsWindowVisible` query (no full scan), used as an independent source of
  truth.
- **`ledger.reconcileVisibility()`** (`lib/logic.js`) — an anti-lie guard.
  `console_windows_list` now re-measures every tracked window before printing,
  so `[hidden]` can only appear for a window that is genuinely not visible at
  that moment; windows missing from the truth map are reported as `[gone]`.

Tests: `tests/logic.test.mjs` 24 → 29 assertions (destroyed-vs-hidden, and
reconcileVisibility in all three directions); new `tests/tool-output.test.mjs`
(5 assertions) locks the schema contract and **asserts the old shape was
buggy**, so the defect cannot silently return.

Lesson recorded: a plugin’s own ledger is not evidence. “The bookkeeping says
success” and “the user can see it worked” are different claims, and only the
second one is worth reporting — verify with something outside the component
that is making the claim.

## 0.1.1 (2026-09-22) — desktop-cleanup path repaired + protected set widened

The console path (`console_windows_list` / `_action` / `_sweep`) was fine, but
the **desktop-cleanup path was dead on arrival** — `desktop_windows_cleanup`,
`desktop-cli.mjs list|cleanup`, and the 一键关闭其他窗口 shortcut all failed.
Four defects, each found by running the code rather than reading it:

1. **Marker never substituted** (`lib/desktop.js`). The probe template used
   `'${JSON_BEGIN}'` but was never `.replace()`d, so the literal text
   `${JSON_BEGIN}` reached PowerShell and `extractMarkeredJson` found nothing
   → `no-marker-output`. `probe.js` had always done this correctly
   (`.replace(/__JSON_BEGIN__/g, …)`); desktop.js now matches it.
2. **`@(['Progman',…])` is a PowerShell parse error** (`lib/desktop.js`).
   `SHELL_CLASSES_PS` wrapped the list in `[ … ]`, and the call site wrapped
   that again in `@( … )` → *"Missing type name after '['"*, aborting the
   probe before any window was enumerated.
3. **Every selection guard silently fell through** (`lib/desktop.js`).
   `selectCleanupTargets` read `w.hwnd` / `w.process` / `w.class` / `w.title`,
   but the embedded probe emits **PascalCase** (`Hwnd` / `Process` / `Class` /
   `Title`). All comparisons were `undefined !== anything`, so the foreground
   guard, the shell-class filter **and the protected-process guarantee** did
   nothing — DSH Desktop itself, explorer and Taskmgr landed in the close list.
   Rows are now normalised through one `raw.x ?? raw.X` shim.
4. **CLI crashed printing the plan** (`lib/desktop-cli.mjs`). `t.title.slice()`
   on the same casing mismatch → `TypeError: Cannot read properties of
   undefined`. Shares the normaliser now, and tolerates empty titles.

### Protected set widened (user-approved, beyond upstream)

Upstream protected only `powershell / pwsh / python / pythonw`. Each addition
below was justified against a live probe, not guessed:

| added | why |
|---|---|
| `dsh desktop` | closing the harness host kills the session |
| `explorer` | shell/taskbar; multiple file-manager Hwnds share one pid |
| `taskmgr` | closing Task Manager is a forced-end acting on other apps |
| `fluent`, `launcher1` | Fluent Launcher / solver front-ends are long-running CFD work |

### Verification

- `node tests/logic.test.mjs` — **24/24 still pass** (no regression)
- live probe: enumerates 30 windows, 10 visible consoles
- `desktop-cli.mjs list` — 14–18 targets, **0** protected/foreground/shell-class
  windows selected (DSH Desktop, explorer, Taskmgr, Fluent all correctly kept)
- `desktop-cli.mjs cleanup` — dry run prints the plan, closes nothing

## 0.1.0 (2026-09-16) — first MVP

Host-side cordis plugin: auto-hide idle AI/script console windows on Windows.

### Configured defaults (per user's MVP decision)
- `autoAction: hide` (lossless; process keeps running, `show` restores it)
- `idleThresholdSec: 60`, `cpuThresholdPct: 1`, `spikeTolerance: 2`
- scope: `wmiDetached` + `dshHost` + `scriptConsole` ON, `orphaned` OFF
- host-side only; no client bundle in v1

### Empirical findings fixed during development
1. **Windows Terminal windows are classified by title, not parent chain.**
   A WT top-level window belongs to the WindowsTerminal process (parent
   svchost), not to the script it hosts — parent-chain classification left
   all 8 stacked black windows as `manual` (unmanaged). Added `script-console`
   source keyed on the console title being a script executable path.
   (Interactive consoles keep prompt-style titles like "Windows PowerShell"
   and stay unmanaged.)
2. **`SW_SHOW(5)` cannot restore a hidden WT window.** Measured: after
   `SW_HIDE`, `SW_SHOW` leaves `IsWindowVisible` false; `SW_SHOWNORMAL(1)`
   restores it. Show action now uses SW_SHOWNORMAL with SW_RESTORE fallback.
3. **Single-sample CPU spikes reset the idle clock.** The WindowsTerminal
   host process spikes briefly even when all its sessions are idle, so
   stacked windows never accumulated 60s of idle. `spikeTolerance=2` now
   requires two consecutive busy samples to break an idle streak.
4. **`NtQueryInformationProcess` over CIM for parent-pid.** Measured 39 s vs
   24 ms for 13 processes (`Get-CimInstance Win32_Process`). Full probe
   ~350 ms at a 10 s scan interval.
5. **dsh-tools output-schema constraints**: object schemas must declare
   `additionalProperties` explicitly; output value schemas reject `required`.
   Caught only by the real-runtime load precheck, not by `node --check`.

### Verification
- `node tests/logic.test.mjs` — 24/24 (classification, idle accumulation,
  spike tolerance, scope guards, GC, ordering)
- `node tests/e2e.mjs` — live probe (24 windows), reversible hide→show
- load precheck against the profile's real cordis/schemastery/dsh-tools —
  3 tools register, scheduler effect mounts, config defaults correct
- privacy audit: 0 hits across 9 files; `npm pack` 8 files / 16.1 kB
