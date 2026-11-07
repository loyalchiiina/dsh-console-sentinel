# dsh-console-sentinel

[![npm](https://img.shields.io/npm/v/dsh-console-sentinel.svg)](https://www.npmjs.com/package/dsh-console-sentinel)
[![license](https://img.shields.io/npm/l/dsh-console-sentinel.svg)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%20only-0078D4)

**DSH（DeepSeek Harness）Windows 插件**：一键清理任务栏窗口——按软件整体关闭、
关掉残留的空壳控制台，关闭方式等同于对每个窗口按 **Alt+F4**（优雅 `WM_CLOSE`，非强杀），
并且**绝不碰 DSH 宿主本身、也绝不碰正在计算的 Fluent / MPI**。

> English: [README.md](./README.md)

![面板总览](docs/screenshots/01-panel-overview.png)

---

## 为什么需要它

Windows 上总会攒下一堆不再需要的窗口：工具留下的空 PowerShell / cmd 空壳、忘了关的终端、
文档关了但程序还开着的软件。一个个点太麻烦，而粗暴的"全杀掉"脚本又会顺手带走你的宿主或正在跑的 CFD。

这个插件**安全地**帮你关：

* **优雅关闭**（`WM_CLOSE`，正是 Alt+F4 发出的消息），软件能正常保存退出；
* 支持**按窗口 / 按软件 / 批量**三种粒度，不用挨个点；
* **永不关闭** DSH 宿主，**永不关闭** Fluent / MPI / ANSYS 求解器进程；
* 支持关闭**管理员权限窗口**——弹一次 UAC 即可。

## 功能

### 一键清理任务栏窗口（先预演）

`预演清理` 列出将被关闭的窗口（带图标），核对无误再点 `执行清理`。
**没预演时「执行清理」是禁用的**——不会让你盲着执行破坏性操作。

![预演结果](docs/screenshots/03-preview-result.png)

### 任务栏窗口 · 按软件分组

默认是 **仅图标视图**：每个窗口压成一个 30×30 图标格，**点一下即关闭该窗口**，最省空间。
切到 **详细视图** 则按软件分组显示完整标题、白名单勾选框、`关掉该软件`（整个软件一次关掉）
以及每个窗口独立的 `关闭` 按钮。

![详细视图](docs/screenshots/04-detail-view.png)

每次关闭都会先确认：

![确认弹窗](docs/screenshots/02-confirm-dialog.png)

### 空壳控制台清理

没有业务子进程（只剩 `conhost`）的解释器窗口即"空壳"。可以**隐藏**（无损，进程继续跑），
也可以**真正关闭**——且只针对裸 `cmd` / `powershell` / `pwsh` / `python`。

![控制台页](docs/screenshots/05-console-tab.png)

### 持久化白名单

进程名与窗口标题关键字，命中即永不隐藏、永不关闭。存于
`~/.dsh/console-sentinel/whitelist.json`，面板里点标签即可增删。

![白名单页](docs/screenshots/06-whitelist-tab.png)

## 安全模型

批量关窗口是不可逆操作，因此叠加了多重硬保护：

| 保护层 | 行为 |
|---|---|
| **宿主进程树** | DSH 宿主本身、其全部祖先、以及所有 `dsh` / `electron` / `deepseek` 进程**及其全部后代**永不触碰——关掉其中某个控制台会连带把宿主杀掉。 |
| **计算保护** | `mpi` / `fluent` / `ansys` / `cx*` / `solver` / `cae` / `launcher` 一律不选。`mpiexec` 的控制台看上去像普通窗口，但它被杀就等于终止正在跑的仿真。 |
| **只动裸解释器** | 空壳关闭仅限 `cmd` / `powershell` / `pwsh` / `python`。 |
| **前台与自身** | 当前焦点窗口、插件自身进程一律跳过。 |
| **白名单** | 你勾选过的软件永久豁免。 |

全链路只用优雅关闭（`WM_CLOSE`），**刻意不提供 `taskkill /F` 强杀**。

## 管理员窗口关不掉怎么办

普通权限进程无法关闭管理员窗口——Windows 的 UIPI 会把消息**静默丢弃**，表现就是"点了没反应"。
关这类窗口时（任务管理器、录屏工具等），插件会启动**一个**提权助手：你只会看到**一次** UAC，
它发出同样的 `WM_CLOSE`，并通过临时文件把结果回传（提权子进程的 stdout 是拿不到的）。
点「否」则什么都不做，插件会**如实告知失败**，而不是假装成功。

## 安装

```bash
dsh plugin --profile desktop add dsh-console-sentinel
```

仅支持 Windows。同时声明 `dsh.bundle`（宿主半边）与 `dsh.client`（设置面板半边），
装好后在 **设置 → 控制台哨兵** 出现，带自定义终端图标。

## 配置

`cordis.patch.yml` 默认值：

| 键 | 默认 | 含义 |
|---|---|---|
| `scanIntervalSec` | `10` | 扫描间隔（秒） |
| `idleThresholdSec` | `60` | 判定空闲所需的秒数 |
| `cpuThresholdPct` | `1` | 空闲判定的 CPU 下限 |
| `autoAction` | `none` | 空闲控制台动作：`none` / `hide` / `close` |
| `emptyConsoleAction` | `hide` | 空壳动作 |
| `guardForeground` | `true` | 不处理前台窗口 |
| `cleanup.protectedProcesses` | 见上表 | 桌面清理永不选中 |
| `whitelist.processes` / `.titles` / `.unprotect` | `[]` | 运行时豁免清单 |

## 工具

宿主侧工具：`console_windows_list`、`console_windows_action`、`console_windows_sweep`、
`desktop_windows_cleanup`，以及管理豁免清单的 `sentinel_whitelist`。
命令行：`lib/desktop-cli.mjs list|cleanup`。

## 许可

MIT
