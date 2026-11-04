# Changelog

## 0.3.0 (2026-11-03) — 设置面板 UI（任务栏窗口清理 / 白名单 / 窗口状态）

用户需求：想看插件「现在什么状态」，并要「清理任务栏窗口」的操作入口 + 有没有 UI 设计。
此前插件是纯宿主插件（无 `dsh.client`），只能在对话里让模型调工具，用户自己点不了。

### 新增
1. **客户端设置面板** `lib/client.js`（`__ModuleLoader__` bundle，`dsh.client` 声明，
   platform `web`，id=完整包名）：在 DSH「设置」页注册「控制台哨兵」分区。分区内含
   - 概览：总窗口 / 空壳 / 可见空壳 / 已隐藏 计数 + 「隐藏可见空壳」按钮；
   - 任务栏窗口清理：预演 / 一键关闭其他窗口；
   - 控制台窗口列表：逐行显示并可 隐藏 / 显示 / 关闭；
   - 豁免白名单：进程名 / 标题关键字 标签式增删与清空。
2. **宿主 HTTP 路由** `lib/index.js` `registerHttpUi()`：`/dsh-console-sentinel/{status,scan,hide-empty,window,desktop-cleanup,whitelist}`，
   均做 loopback 校验；客户端 fetch 根相对路径（桌面端 Electron renderer 自动带
   capability header，普通 curl 仍 403）。webServer 缺失时面板优雅降级，不影响工具功能。
3. `package.json`：新增 `dsh.client`、`exports["./client"]`，版本 0.2.0→0.3.0。
4. `tests/client.test.mjs`：DOM stub 评估真实 bundle，断言 bundle id / `exports.inject`
   为数组 / `settings.section` 注册 / 首屏计数-窗口-白名单渲染 / 按钮触发路由。

### 约束（都遵守，来自本机踩坑）
- `exports.inject` 必须是普通数组；`ctx.slots.inject("settings.section", …)` 直接调用不包 `ctx.effect`；
  组件不用 React hooks，结果按 id 写回 DOM 并在渲染入口 `setTimeout(0)` 自愈重挂载。
- 样式只用 `--dsw-alias-*` 设计令牌；不使用 iframe；不轮询 agent/status。
- 客户端无绝对 URL（探针断言 https?:// 计数 0、iframe 计数 0）。

### 修复（2026-11-04，仍在 0.3.0 内）
1. **插件根本没加载（duplicate loader entry）**：`dsh-console-sentinel` 同时出现在
   `profiles/desktop/package.json` 的 `dsh.profile.bundles` 与 `profiles/desktop/cordis.patch.yml`
   两条同 id 条目中，加载器按 duplicate 处理 → 插件不挂载（日志无任何 mounted 行、对话里
   也无 `console_windows_list` 等工具）。按 `dsh-artifact-linker` 的约定，**配置迁入插件自身
   bundle patch `cordis.patch.yml`**，并删除 profile `cordis.patch.yml` 里的手工条目（bundles 保留）。
   校验：profile 28 条目、无 sentinel、bundles 36 项含 sentinel、trueDuplicates=[]。
2. **Windows Terminal 空壳识别**：可见的「黑窗」主要是 `CASCADIA_HOSTING_WINDOW_CLASS`
   （窗口属主是 `WindowsTerminal.exe`，不是里面的 shell），旧的 `isEmptyConsole` 只认解释器
   进程本身 → 永远判「非空」。新增 `isBareShellTitle()` 与 `isEmptyConsole` 的 CASCADIA 分支
   （标题为裸解释器路径如 `…\powershell.exe` / `…\cmd.exe` 且 `cpuPct ≤ 1` 才算空），并把
   `windowsterminal` 从 `HARD_PROTECTED_PROCESSES` 移出（`autoAction` 仍为 `none`，只经
   `emptyConsoleAction: hide` 处理空壳）。实测 8 个可见窗口中 5 个 CASCADIA 黑窗被判空。
3. `tests/cascadia.test.mjs`：`isBareShellTitle` + CASCADIA 空判定 3 用例。
4. **bundle patch 里 `disabled: !!js …` 使整条 insert 静默失败**（2026-11-04 二次实测，真凶）：
   插件自己的 `cordis.patch.yml` 属 **bundle patch**，由普通 YAML 解析器读取，不认自定义标签；
   本机 17 个能正常加载的插件其 patch **无一使用自定义标签**。移除该行（平台守卫保留在
   `apply()`：非 Windows 打 `staying inert` 并 return），普通 YAML 解析通过。
   同时在 `apply()` 入口加 `logger.info('host half mounted (v0.3.0, …)')`，以后日志可直接确认挂载。
5. **扫描定时器被宿主 dispose 清掉（真凶 2）**：`ctx.effect(() => () => clearInterval(scanTimer))`
   的 disposer 在宿主侧 teardown/reload 时会被调用，导致**第一轮 `scan #1` 之后定时器被
   `clearInterval`**，之后再无 `scan #2`、也无任何异常日志（`catch` 不触发）。改为**进程自有的
   plain `setInterval`（不挂 `ctx.effect`）**，并保留一个「超过 3×周期未扫描就强制补扫」的自愈
   supervisor；临时的心跳/逐窗口诊断日志已清理。
   实测（修复后）：启动 22 秒内 **6 个空壳窗口被自动隐藏**（5 个 Windows Terminal `CASCADIA` +
   1 个 orphaned powershell），`visibleAfter=false`、`stillWindow=true`。
6. 默认 `idleThresholdSec` 180 → **60**（空壳窗口更快消失；CPU 持续空闲才计数，不影响正在
   计算的 Fluent/mpiexec 控制台）。

### 生效方式
- 改 `lib/client.js` → **Ctrl+Shift+R** 硬刷新；
- 改宿主 `lib/index.js` / `package.json` / 挂载 → **完全退出 DSH 再启动**。

## 0.2.0 (2026-11-03) — 空壳 PowerShell 安全清理 + 一键关窗口统一白名单

用户需求：检查插件运营状态；能否有效隐藏/关闭「没有进程捆绑的空 PowerShell」；
把之前开发的一键关闭其他窗口加进来；可设置豁免软件白名单。

### 修的真问题
0.1.x 的 `scope.orphaned` 默认 `false`，导致最常见的痛点——WMI/脚本退出后残留的
**空 PowerShell 窗口**——永远不被自动处理；而直接打开 `orphaned` 又会误伤
`mpiexec`（Fluent MPI）、`fl2610`（求解器）等在跑的计算（同属「父进程已退出」）。
空判定缺位 = 只能二选一，两个都不对。

### 新增
1. **空控制台安全判定**（`lib/logic.js` `isEmptyConsole`）：解释器进程
   （powershell/pwsh/cmd/python/pythonw）**且没有任何工作子进程**（children 去掉
   conhost/openconsole 后为空）才算「空壳」。probe 现返回每进程 `Children`
   （`lib/probe.js` 用 NtQueryInformationProcess 自建父子表，零依赖）。新配置
   `scope.emptyConsole`（默认 `true`）+ `emptyConsoleAction`（默认 `hide`，独立于
   `autoAction`）——只清空壳、绝不碰在跑计算。
2. **硬保护进程集** `HARD_PROTECTED_PROCESSES`：explorer/taskmgr/dsh desktop/
   dwm/winlogon/csrss/lsass 等系统进程，以及 fl2610/cx2610/mpiexec/smpd/fluent/
   fluent-meshing/launcher1 —— 无论配置如何都拒绝管理。
3. **持久化豁免白名单** `lib/whitelist.js` + 新工具 `sentinel_whitelist`
   （list/add/remove/reset，kind=process|title）。落盘
   `~/.dsh/console-sentinel/whitelist.json`，与静态 `config.whitelist` 合并，工具
   改动即时生效、无需改 yml 或重启。白名单同时作用于自动动作与
   `desktop_windows_cleanup`。
4. **一键关闭其他窗口**（`desktop_windows_cleanup`）现在读统一白名单，
   `protectedProcesses`/`keepTitles` 合并用户名单。
5. `console_windows_list` 每行新增 `kids=`（子进程数）与 `[empty]` 标记。

### 测试
`desktop.test.mjs` D5 默认保护列表断言从 4 项更新为实际 9 项（实现更安全，测试
落后于实现，改测试不改实现）。全套 `node --test` 51 断言全绿
（logic 29 + desktop 17 + tool-output 5）。

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
