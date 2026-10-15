# dsh-console-sentinel

Auto-hide (or close) idle AI/script console windows on Windows — a
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin.

Long-running harness workflows (unattended Fluent jobs, batch scripts,
WMI-launched detached processes) leave PowerShell/Python console windows
stacked in the taskbar. You cannot tell which are still working and you do not
want to kill them by hand. This plugin tracks them, tells busy from finished,
and hides the finished ones for you — the process keeps running, nothing is
lost, and every window can be brought back on demand.

## How it works

1. Every `scanIntervalSec` seconds (default 10) it enumerates console windows
   with a zero-dependency Windows PowerShell probe (`user32` + `ntdll`
   P/Invoke): `CASCADIA_HOSTING_WINDOW_CLASS` (Windows Terminal),
   `ConsoleWindowClass` (classic conhost), and `PseudoConsoleWindow` (ConPTY).
2. Each console's process is classified: by its **parent process**
   (`WmiPrvSE.exe` → `wmi-detached` — WMI-launched detached jobs, how
   unattended Fluent runs are started; `DSH Desktop.exe` → `dsh-host`;
   parent already exited → `orphaned`), or, when the parent chain is
   uninformative (a Windows Terminal window belongs to the WindowsTerminal
   process, not to the script it hosts), by the **console title**: a scripted
   session defaults its title to the launched executable path
   (`...\python.exe`), while an interactive console keeps a prompt-style
   title (`Windows PowerShell`) → `script-console`.
3. CPU usage is sampled per scan (process total CPU time deltas). A window
   under `cpuThresholdPct` (default 1%) for `idleThresholdSec` (default 60)
   counts as **finished**. Single-sample background jitter does not reset the
   idle clock (`spikeTolerance`, default 2).
4. Finished windows **in scope** get the configured `autoAction`
   (default `hide` = `SW_HIDE`; the process keeps running). `close` sends
   `WM_CLOSE`. The focused window is never touched (`guardForeground`).

Parent-pid lookup uses `NtQueryInformationProcess` rather than CIM
(`Get-CimInstance Win32_Process`), which measured **39 s vs 24 ms** for 13
processes on the reference machine. A full probe takes ~350 ms.

## Install

```sh
dsh plugin --profile <name> add dsh-console-sentinel
```

Bundle plugin (`dsh.bundle.patch`): enters the profile bundle stack, takes
effect on restart. Windows-only — the patch row is `disabled` on every other
platform and `apply()` also guards at runtime.

## Tools (model-visible)

- `console_windows_list` — every tracked console window with idle state and
  origin classification. Use this first.
- `console_window_action` — hide / show / minimize / restore / close one
  window (by `hwnd` or `pid`). `hide` is lossless; `close` may lose unsaved
  output. Pass `force` to act on the focused window.
- `console_windows_sweep` — apply the action to every idle in-scope window at
  once (handy after a batch of Fluent jobs).

## Config (cordis.yml)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `scanIntervalSec` | `10` | how often to scan + sample CPU |
| `idleThresholdSec` | `60` | sustained-low-CPU seconds before a window counts as finished |
| `cpuThresholdPct` | `1` | average CPU below this = idle |
| `autoAction` | `hide` | `none` \| `hide` \| `close` |
| `probeTimeoutMs` | `20000` | hard probe timeout |
| `spikeTolerance` | `2` | consecutive busy samples needed to reset the idle clock |
| `guardForeground` | `true` | never auto-manage the focused window |
| `scope.wmiDetached` | `true` | manage WMI-launched detached consoles |
| `scope.dshHost` | `true` | manage host-spawned consoles |
| `scope.orphaned` | `false` | manage consoles whose parent already exited |
| `scope.scriptConsole` | `true` | manage consoles whose title is a script executable path (Windows Terminal windows hosting a scripted session) |
| `scope.excludeTitles` | `[]` | title substring blocklist |

```yaml
- id: dsh-console-sentinel
  config:
    idleThresholdSec: 90
    scope:
      excludeTitles:
        - keep-alive
```

## Safety

`hide` only calls `ShowWindow(SW_HIDE)` — the process, its logs, and its
output are untouched; `console_window_action` with `show` restores it
(`SW_SHOWNORMAL` — measured: `SW_SHOW` leaves a hidden Windows Terminal
window invisible). `close` sends `WM_CLOSE` (graceful, same as clicking the
X) but may lose unsaved state, so it is never the default. Automatic actions
never touch the focused window, manually opened consoles (`manual` source),
or title-blocklisted windows. Every action is emitted as
`console-sentinel/action` and logged.

## Development

```
lib/index.js   Cordis plugin: config, scan scheduler, tools
lib/logic.js   pure ledger/idle state machine (unit-tested)
lib/probe.js   embedded PowerShell probe + window actions
tests/         node-only regression tests, no live Windows needed
```

`node tests/logic.test.mjs` — 24 assertions covering classification, idle
accumulation, busy-blip reset, scope guards, GC, and ordering.

MIT License.
