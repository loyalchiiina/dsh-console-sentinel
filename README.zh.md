# dsh-console-sentinel

自动隐藏（或关闭）Windows 上空闲的 AI/脚本控制台窗口 —— 一个
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。

长时间运行的自动化工作流（Fluent 无人值守任务、批量脚本、WMI 拉起的脱离进程）
会在任务栏堆下一排 PowerShell/Python 黑窗口。你分不清哪些还在跑，也不敢随手关。
本插件替你追踪它们、区分「在忙」和「用完了」，并把用完的隐藏掉 —— 进程继续跑、
数据不丢，每个窗口都能随时叫回来。

## 工作原理

1. 每隔 `scanIntervalSec` 秒（默认 10）用零依赖的 Windows PowerShell 探针
   （`user32` + `ntdll` P/Invoke）枚举控制台窗口：`CASCADIA_HOSTING_WINDOW_CLASS`
   （Windows Terminal）、`ConsoleWindowClass`（传统 conhost）、
   `PseudoConsoleWindow`（ConPTY 伪控制台）。
2. 按进程归类：优先看**父进程**（父进程是 `WmiPrvSE.exe` → `wmi-detached`，
   WMI 拉起的脱离任务，无人值守 Fluent 计算正是这样启动的；父进程是
   `DSH Desktop.exe` → `dsh-host`；父进程已退出 → `orphaned`）。当父链说明
   不了问题时（Windows Terminal 的窗口归属于 WindowsTerminal 进程，而不是
   它里面跑的脚本），改看**控制台标题**：脚本启动的控制台标题默认是
   被启动程序的路径（`...\python.exe`），而交互式手开的控制台是提示符式
   标题（`Windows PowerShell`）→ 归为 `script-console`。
3. 每轮采样进程 CPU（累计 CPU 时间差值）。CPU 低于 `cpuThresholdPct`（默认 1%）
   且持续 `idleThresholdSec`（默认 60 秒）即判定为**用完了**。单次采样的后台
   CPU 抖动不会重置空闲时钟（`spikeTolerance`，默认 2）。
4. 在管理范围内的「用完了」窗口执行配置的 `autoAction`（默认 `hide` = `SW_HIDE`，
   进程继续跑）。`close` 发送 `WM_CLOSE`。前台窗口永不自动处理（`guardForeground`）。

父进程 PID 用 `NtQueryInformationProcess` 而非 CIM（`Get-CimInstance Win32_Process`）
—— 参考机上实测 **39 秒 vs 24 毫秒**（13 个进程）。单次完整探针约 350 毫秒。

## 安装

```sh
dsh plugin --profile <name> add dsh-console-sentinel
```

Bundle 插件（`dsh.bundle.patch`）：进入 profile bundle 栈，重启后生效。
仅限 Windows —— patch 行在其他平台 `disabled`，`apply()` 运行时也会再守一次。

## 工具（模型可见）

- `console_windows_list` —— 列出所有被追踪的控制台窗口及其空闲状态和来源归类。先用它。
- `console_window_action` —— 对单个窗口执行 hide / show / minimize / restore / close
  （用 `hwnd` 或 `pid` 定位）。`hide` 无损；`close` 可能丢失未保存输出。
  对前台窗口操作需传 `force`。
- `console_windows_sweep` —— 一次性对所有空闲且在范围内的窗口执行动作
  （跑完一批 Fluent 任务后清任务栏很好用）。
- `desktop_windows_cleanup` —— 一键关闭其它程序的窗口（受保护进程与白名单自动跳过）。
- `sentinel_whitelist` —— 管理豁免白名单（list/add/remove/reset，kind=process|title）。

## 设置面板（DSH 设置页 · 0.3.0+）

插件在 DSH「设置」里注册了一个「控制台哨兵」分区（客户端 bundle `lib/client.js`），
不用记工具名，点按钮即可：

- **概览**：总窗口 / 空壳 PowerShell / 可见空壳 / 已隐藏 四个计数；「隐藏可见空壳」一键清理。
- **任务栏窗口清理**：先「预演」列出将被关闭的窗口，再「一键关闭其他窗口」真正执行
  （前台窗口、系统进程、白名单自动跳过）。
- **控制台窗口**：逐行显示进程名 / 标题 / hwnd / pid / CPU / 空闲秒数 / 子进程数，每行可隐藏 / 显示 / 关闭。
- **豁免白名单**：以标签形式管理进程名与窗口标题关键字，改动即时落盘
  `~/.dsh/console-sentinel/whitelist.json`。

面板通过宿主路由 `/dsh-console-sentinel/*` 取数（客户端 fetch 相对路径，桌面端自动带
capability header），不使用 iframe。改 `lib/client.js` 后按 **Ctrl+Shift+R** 硬刷新；
改宿主（`lib/index.js` / `package.json`）需**完全退出 DSH 再启动**。

## 配置（cordis.yml）

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `scanIntervalSec` | `10` | 扫描 + CPU 采样间隔 |
| `idleThresholdSec` | `60` | 持续低 CPU 多少秒算「用完了」 |
| `cpuThresholdPct` | `1` | CPU 低于此值算空闲 |
| `autoAction` | `hide` | `none` \| `hide` \| `close` |
| `probeTimeoutMs` | `20000` | 探针硬超时 |
| `spikeTolerance` | `2` | 连续多少次「忙」采样才重置空闲时钟 |
| `guardForeground` | `true` | 永不自动处理前台窗口 |
| `scope.wmiDetached` | `true` | 管理 WMI 拉起的脱离控制台 |
| `scope.dshHost` | `true` | 管理宿主派生的控制台 |
| `scope.orphaned` | `false` | 管理父进程已退出的控制台 |
| `scope.scriptConsole` | `true` | 管理标题是脚本可执行文件路径的控制台（Windows Terminal 承载的脚本会话） |
| `scope.excludeTitles` | `[]` | 标题 substring 黑名单 |

```yaml
- id: dsh-console-sentinel
  config:
    idleThresholdSec: 90
    scope:
      excludeTitles:
        - keep-alive
```

## 安全性

`hide` 只调用 `ShowWindow(SW_HIDE)` —— 进程、日志、输出一概不动；
`console_window_action` 的 `show` 可随时恢复（用 `SW_SHOWNORMAL` ——
实测 `SW_SHOW` 无法恢复被隐藏的 Windows Terminal 窗口）。`close` 发 `WM_CLOSE`
（优雅关闭，和你点 X 一样），但可能丢失未保存状态，所以从不是默认动作。
自动动作绝不触碰：前台窗口、手动打开的控制台（`manual` 来源）、
标题命中黑名单的窗口。每个动作都发 `console-sentinel/action` 事件并写日志。

## 开发

```
lib/index.js     Cordis 插件：配置、扫描调度、工具、设置面板 HTTP 路由
lib/logic.js     纯台账/空闲状态机 + 空壳判定（单测覆盖）
lib/probe.js     内嵌 PowerShell 探针（含父子进程表）+ 窗口动作
lib/desktop.js   任务栏窗口清理（受保护进程/白名单/前台守卫）
lib/whitelist.js 持久化豁免白名单（~/.dsh/console-sentinel/whitelist.json）
lib/client.js    设置面板客户端 bundle（__ModuleLoader__，settings.section）
tests/           仅 node 的回归测试，不需要真实 Windows
```

`node --test tests/` —— logic / desktop / tool-output / client 四组断言；
client 组用 DOM stub 评估真实 bundle，覆盖注册契约与首屏渲染。

`node tests/logic.test.mjs` —— 24 项断言，覆盖来源归类、空闲累积、
忙碌脉冲重置、范围守卫、台账 GC、排序。

MIT License。
