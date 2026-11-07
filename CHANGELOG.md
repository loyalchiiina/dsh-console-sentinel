# Changelog

## 1.0.1 (2026-11-08) — 修复客户端重复注册报错 + 元数据一致性

发布后五方核验发现的问题，逐条修复。

### 修复
1. **客户端 bundle 重复注册**（`client-modules: duplicate factory registration for "dsh-console-sentinel"`）：
   宿主会通过**两条路径**投递同一个 bundle —— 客户端模块图 + 插件自己的 `/client.bundle.js` 回退路由，
   两次 `__ModuleLoader__.load` 同 id → 加载器抛错并每次刷新都记 error。
   原 `__DCS_APPLIED__` 守卫在 `apply()` 里，**太晚**。改为在 **load 层**加 `window.__DCS_MODULE_LOADED__` 守卫。
2. **`files` 白名单 3 条死条目**：`README.es.md/.pt.md/.hi.md` 与实际文件名（连字符版 `README-es.md` 等）不符，
   已改为真实文件名。
3. **本地源码 `package.json` 与 GitHub/npm 不一致**：本地仍是 0.3.0 时代的 description、且 `files` 缺
   `docs/screenshots/*.png`（**若从本地重新发布，6 张截图会全部掉出包**）。已同步为与发布版**字节一致**，
   并把 `docs/screenshots/` 六张图补进本地源码目录。

### 生效方式
含 `lib/client.js`（客户端）→ **Ctrl+Shift+R 硬刷新**；`package.json` 变更随 npm 1.0.1 生效。
## 1.0.0 (2026-11-08) — 大版本：一键清理 + 按软件关闭 + 提权关闭 + 全新面板 UI

首个稳定大版本。把此前只在对话里能用的能力全部搬进设置面板，并围绕「安全地批量关窗」重建了 UI 与保护模型。

### 主要能力
1. **一键清理任务栏窗口（预演优先）**：`预演清理` 列出将被关闭的窗口（带图标）与保护跳过项；
   未预演时 `执行清理` 禁用。执行时普通窗口走 `WM_CLOSE`，管理员窗口走一次 UAC 的提权 `WM_CLOSE`。
2. **按软件一键关闭**：任务栏按进程分组，`关掉该软件(N)` 一次关闭该程序全部窗口
   （等同对每个窗口按 Alt+F4，但不用挨个点）。
3. **两种视图**：默认「仅图标网格」（30×30，一排排，点图标即关），可切「详细视图」
   （分组卡片 + 白名单勾选 + 每窗口 `关闭`）。
4. **空壳控制台**：`隐藏可见空壳`（无损）/ `关闭空壳窗口`（真结束，仅限裸 cmd/powershell/pwsh/python）。
5. **提权关闭链路**：临时 `.ps1` + `Start-Process -Verb RunAs` + 结果 JSON 回传；
   用户点「否」如实报 `uac-denied-or-cancelled`，绝不假装成功。
6. **自定义设置页图标**（`settings.section.icon`，id 必须等于 section id，否则宿主回退默认齿轮）。
7. **面板可见时自动刷新**（3s），关闭设置界面/切走即时停止。

### 安全（本版本的核心）
- **宿主进程树硬保护**：自身 + 全部祖先 + 所有 dsh/electron/deepseek 进程及其全部后代；
- **计算保护**：`mpi|fluent|ansys|^cx\d|solver|cae|launcher` 一律不选（mpiexec 控制台会被误判成普通窗口）；
- **只动裸解释器**；前台窗口与自身进程跳过；白名单永久豁免；
- 全链路只用 `WM_CLOSE`，**不提供 taskkill /F 强杀**。

### 修复（本轮累计）
- 关闭空壳时误杀宿主进程树（事故级）；
- 提权关闭四连坑：ESM 模板字面量吞 PS 变量、`-Command` 吞换行、`spawn` 不提权、拿不到提权子进程 stdout；
- 「取消保护」`var` 闭包导致点哪行都操作最后一行；
- 关窗后列表不刷新（`loadTaskbar` 丢弃并发请求）；
- 设置页图标不生效（icon id 与 section id 不一致）。

### 文档
- README（中/英）重写：功能、安全模型、管理员窗口原理、配置表、安装；
- 新增 `docs/screenshots/` 六张实拍效果图并嵌入 README。
## 0.5.6 (2026-11-08) — 去掉面板标题里的盾牌 emoji

用户：「把这个盾牌图标删除」——指的是面板标题「🛡️ 控制台哨兵」前的盾牌 emoji。
（左侧导航栏的图标已换成自定义终端图标，保留不动。）

### 改动
- `lib/client.js`：面板标题 `"🛡️ 控制台哨兵"` → `"控制台哨兵"`。

### 生效方式
仅改 `lib/client.js` → **Ctrl+Shift+R 硬刷新**。

## 0.5.5 (2026-11-08) — 修复设置页图标仍是默认齿轮（icon id 必须等于 section id）

用户实测：图标没变，仍是齿轮。

### 根因（宿主契约，从 app.asar 里挖出来的原文）
`@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 里 `settings.section.icon` 槽的 doc 明确写着：

> **The registration id must equal the target section's id; unmatched ids never render.**
> The shell owns the button and label and **keeps its default glyph** when no icon is registered for that id.

0.5.4 我把图标条目 id 写成了 `dsh-console-sentinel-icon`（多了一个后缀），**与分区 id 不匹配 → 永不渲染 → 回退齿轮**。
渲染侧也确实是 `renderSlot("settings.section.icon", {...}, { only: row.id, fallback: navIcon(row.id) })`，
`row.id` 就是分区 id。

### 修法
图标注册的 `id` 改为与分区**完全一致**：`"dsh-console-sentinel"`（`order` 同 28）。

### 测试（防止再犯）
新增断言：注册后取 `settings.section` 与 `settings.section.icon` 两条记录，断言
**`icon.cfg.id === section.cfg.id`**；若图标槽没注册也直接失败（`.ok(icon, ...)`）。
client 6 条、taskbar 8 条全绿。

### 生效方式
仅改 `lib/client.js` → **Ctrl+Shift+R 硬刷新**。

## 0.5.4 (2026-11-08) — 自定义设置页图标 + 图标视图设为默认 + 面板可见时自动刷新

用户反馈：①设置页显示的是默认齿轮图标，要换成与插件内容相关的图标 ②已选的图标视图要作为默认
③进入插件设置页/点预演后自动刷新，关闭设置界面就停止刷新。

### 改动（仅 `lib/client.js`）
1. **注册设置页导航图标**：新增 `SettingsIcon` 组件（终端窗口 + `>_` 提示符，与"控制台哨兵"语义一致），
   通过 **`settings.section.icon` 槽**注册（`only` 限定本分区）。
   🔴 根因：宿主 `navIcon(row.id)` 对未知 id 走 **默认齿轮 fallback** —— 不注册该槽就永远显示齿轮。
2. **图标网格设为默认视图**：`cache.taskbarView` 默认 `"icon"`；按钮文案相应为「详细视图」。
3. **面板可见时才自动刷新**（3s 一次）：
   - `panelAlive()` 三重判定：`document.visibilityState==='visible'` + 容器仍在文档中(`document.contains`)
     + `offsetParent` 非空 / 有非零尺寸；
   - 不可见 → `stopAutoRefresh()` 立即清 `setInterval`；
   - 监听 `visibilitychange` / `beforeunload` / `pagehide` 即时停表，重新可见时恢复并立即刷一次；
   - `cache.busy || taskbarLoading` 时跳过该轮，避免打断正在进行的操作。
4. 任务栏面板顶部那句长说明压缩成一行小字 + `title` 悬浮提示（含完整规则），释放纵向空间。

### 测试（含一个必须修的坑）
- 新增「图标网格是默认视图」用例；原详细视图用例改为先 `switchToDetail()`。
- 🔴 **测试挂起修复**：面板现在会 `setInterval`，而单测用 `new Function` 注入替身——没注入
  `setInterval/clearInterval` 时真实定时器让 **Node 进程永不退出**（实测两次挂死 120s+）。
  两个测试文件的 `loadBundle` 都改为注入假 interval（只记录不调度）。

### 生效方式
仅改 `lib/client.js` → **Ctrl+Shift+R 硬刷新**。

## 0.5.3 (2026-11-08) — 操作区压成一行按钮，说明改悬浮提示

用户反馈：一键清理那块说明文字太多、太占地方，要"一行按钮 + 悬浮提醒"。

### 改动（仅 `lib/client.js`）
- 删除「🧹 一键清理任务栏窗口」大卡片 + 两行说明文字；
- 所有动作合并成**一行按钮栏**：`隐藏可见空壳 | 关闭空壳窗口 ┃ 预演清理 | 执行清理`（竖线为视觉分隔）；
  每个按钮的说明改到 `title` **悬浮提示**（鼠标悬停才显示），不占版面。
- 「预演清理 / 执行清理」保留**预演优先**语义：未预演时「执行清理」仍为禁用态（半透明、不可点）。
- 预演/执行结果区：**无内容时什么都不渲染**（原来那句提示文字也去掉），有内容才出现，最高 160px 内部滚动。

### 测试
6 个测试文件全绿（client / client-taskbar / desktop / logic / tool-output / cascadia）。

### 生效方式
仅改 `lib/client.js` → **Ctrl+Shift+R 硬刷新**。

## 0.5.2 (2026-11-08) — 合并刷新按钮 + 状态更紧凑 + 任务栏「仅图标」视图

用户反馈：①顶部「刷新」和「刷新任务栏」像重复 ②顶部状态太占地方，要紧凑 ③任务栏清单想能只显示图标、一排排省空间。

### 改动（仅 `lib/client.js`）
1. **合并刷新**：顶部「刷新」改为 `refreshAll()`，一次刷新**状态/计数 + 任务栏窗口列表**；删除「刷新任务栏」按钮。
2. **顶部状态更紧凑**：
   - 头部卡片内边距 14→9px；
   - 配置行精简为「扫描 10s · 空闲 60s · 空壳 hide」（去掉"自动动作 none"噪音）；
   - 计数从 4 个大卡片改为**一行小圆角药丸**（`控制台 36 · 空壳 11 · 可见空壳 0 · 已隐藏 11`），自适应宽度不再撑满。
3. **任务栏「仅图标视图」**：任务栏面板右上加「仅图标视图 / 详细视图」切换按钮。
   - 详细视图（默认）：按软件分组的卡片（同前）。
   - **仅图标视图**：把每个窗口压成一个 30×30 图标格，`flex-wrap` **一排排排列**，省空间；
     悬停显示"进程 — 标题（点击关闭此窗口）"；可关闭的可点（管理员走 UAC），白名单/系统保护的置灰不可点。

### 测试
- 新增「图标视图切换」用例：切到仅图标后无复选框、渲染图标网格、按钮文案翻转。client-taskbar 7 条全绿；其余 5 个测试文件全绿。

### 生效方式
仅改 `lib/client.js` → **Ctrl+Shift+R 硬刷新**即可。（若上次 0.5.1 的宿主改动还没生效，则需彻底重启一次。）

## 0.5.1 (2026-11-08) — 关窗即时刷新 + 预演优先的显眼「一键清理」+ 按软件分组美化 + 每窗口独立关闭

用户反馈：①关了窗口列表不立即更新 ②一键清理要有预演且放显眼位置 ③UI 要美观整齐、有逻辑、清晰。

### 关闭方式（澄清 + 保持）
- 普通窗口关闭 = `WM_CLOSE`，**等同 Alt+F4**（优雅、非强杀）。
- 管理员窗口关闭 = 同 0.5.0，**提权后仍发 WM_CLOSE**（弹一次 UAC），也是优雅关闭；不再需要先「取消保护」。
- 只有「强制关闭(管理员)」(taskkill /F) 才是强杀——本版已从面板移除该按钮（日常不需要）。

### 改动
1. **关窗后即时更新**（修"关了不刷新"的真因）：
   - `loadTaskbar()` 改为**队列式**：加载中再次请求不再被丢弃，完成后再补跑一次。
   - 新增 **`pruneTaskbar()` 乐观删除** + **`afterMutation()` 统一收尾**：关闭动作一返回就先把该窗口/该软件从列表移除并重绘，再后台 `loadStatus()`+`loadTaskbar()` 校准。接入到 关掉该软件 / 单窗口关闭 / 关闭空壳 / 一键清理。
2. **任务栏按软件分组**（更整齐、有逻辑）：一个程序一张卡——组头 `白名单复选框 + 图标 + 进程(pid) + 徽标(白名单/系统保护/管理员) + [关掉该软件(N)]`，
   组内每个窗口一行 `• 标题 ······ [关闭]`。
3. **每个窗口独立「关闭」按钮**：白名单程序、系统保护程序（宿主/Fluent/MPI）的「关闭」**置灰无效**；管理员窗口点「关闭」走提权优雅关闭（UAC 一次）。
4. **一键清理改为显眼卡片 + 预演优先**：任务栏上方独立高亮卡片「🧹 一键清理任务栏窗口」，含 `[预演]` 与 `[执行清理]`；
   **未预演时「执行清理」禁用**，预演结果（图标清单 + 将关闭/保护跳过/管理员窗口数）就在卡片内。工具栏不再堆一堆按钮。
5. **简化保护语义**：去掉了「取消保护/恢复保护」按钮——「管理员」只是提示，不再是关闭前置条件；真正挡关闭的只有**白名单**和**系统保护**（宿主/DSH/Fluent/MPI/ansys）。
6. 后端：`/window` 支持 `elevated:true` 走 `runElevatedClose`（提权 WM_CLOSE），并按 `process` 名拒绝系统保护程序；`/desktop-cleanup` 响应补 `elevatedCount/elevatedUacCancelled`。

### 测试
- 重写 `client-taskbar.test.mjs`：分组(5 程序/图标数)、白名单复选框状态与宿主禁用、勾选加白名单、关掉该软件→`/close-process` 正确进程、每窗口「关闭」仅可关程序可用且提权窗发 `elevated:true`、Tab 切换。6 条全绿。
- client 5 条 + desktop/logic/tool-output/cascadia 全绿。

### 生效方式
改动含 `lib/index.js` + `lib/client.js` → **彻底退出 DSH 客户端再启动**。

## 0.5.0 (2026-11-08) — 按软件一键关闭（Alt+F4 批量优雅关闭）+ 一键清理支持提权

用户需求：「加入对某个软件强制关闭的功能，类似对窗口 Alt+F4 但不用挨个点；一键处理能不能用这种方法」。

### 新增
1. **「关掉该软件(N)」按钮**（任务栏面板，每个程序只出现一次）：
   点一下 = 对该软件的**全部窗口**逐个发 `WM_CLOSE`（就是"每个窗口按一次 Alt+F4"，但一次搞定），
   优雅关闭而非强杀。提权软件走**一次 UAC** 的提权优雅关闭（不是 taskkill /F）。
   宿主（DSH/Electron）永远不出现此按钮、服务端也拒绝（`host-protected`）。
2. **宿主端 `runElevatedClose(hwnds)`**（`lib/desktop.js`）：临时 `.ps1` + `Start-Process -Verb RunAs`
   + 结果文件回传（与 runElevatedKill 同套可靠机制），对被提权的窗口发 `PostMessage(WM_CLOSE)`
   —— 解决"提权窗口收不到非提权 WM_CLOSE（UIPI 丢弃）"的老问题，但是**优雅关闭**不是强杀。
3. **新路由 `POST /dsh-console-sentinel/close-process`** `{ process }`：
   `runDesktopProbe` 取该进程全部窗口 → 普通窗口逐个 WM_CLOSE、提权窗口批量提权优雅关闭；
   返回 `closedCount/total/normal/elevated/uacCancelled`。硬保护：宿主家族、`^dsh|electron|deepseek`。
4. **一键清理也支持提权优雅关闭**（回答"一键处理能不能用这种方法"）：
   `runDesktopCleanup` 现在把目标拆成普通/提权两组——普通走 WM_CLOSE，提权走一次 UAC 的
   `runElevatedClose`（不再像以前那样对提权窗口静默失败）。
5. **Fluent/MPI 硬保护加固**：`selectCleanupTargets` 新增进程名正则兜底，
   `mpi|fluent|ansys|^cx\d|solver|cae|launcher|^dsh|electron|deepseek` 一律不选
   —— 防止"一键清理/一键关闭"误杀正在计算的 Fluent（mpiexec 控制台看起来像普通窗口）。

### 安全性（延续 0.4.4 事故教训）
- 「关掉该软件」仍受 `hostProcessGuard()` 全树保护；
- 破坏性动作（close/kill）与"隐藏"分离，且都叠加进程名白名单/黑名单。

### 测试
- 新增用例：点「关掉该软件」发出 `/close-process` 且带上**正确的进程名**（`iScrRec`）。
- client-taskbar 7 条 + client 5 条 + desktop/logic 等，6 个文件全绿。
- `runElevatedClose` 内嵌 PS 脚本实测可编译并把结果 JSON 正确落盘（无效 hwnd → `WasAlive:false`，无动作）。

### 生效方式
改动含 `lib/index.js` + `lib/desktop.js`（宿主）+ `lib/client.js` → **彻底退出 DSH 客户端再启动**。

## 0.4.4 (2026-11-08) — 🔴 严重事故修复：关闭空壳把 DSH 客户端一起关掉

用户实测：「关闭空壳窗口」直接把 DSH 客户端也关了。**这是重大安全缺陷，已全面加固。**

### 根因
`/close-empty` 只按 `row.isEmpty` 过滤就发 `WM_CLOSE`，没有排除 **宿主自身的进程家族**。
宿主（Electron / 其下 pwsh、node、conhost）里有的控制台窗口恰好"没有业务子进程"，
被当成空壳 → `WM_CLOSE` → 触发 `CTRL_CLOSE_EVENT` → 连带把宿主进程树杀掉 → DSH 关闭。
（实测探针里可见 `pwsh pid=... 祖先链含 DSH NEXT` 这类宿主家族窗口。）

**更危险的连带隐患**：`mpiexec`（Fluent 的 MPI）窗口的 `Children` 只有 `conhost`，会被误判"空壳"
→ 一键关闭会**杀死正在计算的 Fluent 求解器**。

### 修法（三重硬保护）
1. **`hostProcessGuard()` 宿主全树保护**：算出一个 pid 集合 = 宿主进程自身 + 全部祖先 +
   所有镜像名像 `dsh/deepseek/electron` 的进程 + **它们的全部后代**。任何批量关闭/隐藏都跳过该集合。
   （对 `process.pid` 所在树做上下遍历 + 按名扩展，覆盖整个 DSH 进程家族，无论插件跑在树的哪个节点。）
2. **`source === 'dsh-host'` 一律跳过**（修了之前误写的 `'dshHost'` 字面量 bug）。
3. **只关"裸解释器"**：`isSafeClosableShell()` 白名单 = cmd / powershell / pwsh / python，
   且显式排除 `mpi|fluent|ansys|cx\d|solver|launcher|cae`。`node`（托管服务/中继）、
   `WindowsTerminal`（用户终端）、`mpiexec`（Fluent）全部不在白名单 → 不关。

同样的保护也加到了：
- `/hide-empty`（隐藏也不再碰宿主/Fluent）；
- `/window`（控制台列表里的**单窗口**隐藏/关闭，对宿主家族返回 `host-protected` 拒绝）；
- `/desktop-cleanup`（一键清理任务栏窗口，把宿主全树 pid 作为 `keepPids` 传入）。

### 实测验证（当前真实窗口）
- 「关闭空壳」新逻辑**只选 5 个裸 powershell 空壳**；
- **全部 mpiexec（13+ 个 Fluent MPI）、node 中继、WindowsTerminal、openconsole 均被跳过**；
- 6 个单元测试全绿。

### 教训（写入 dev-log）
🔴 **任何"批量关闭进程/窗口"的动作，必须先排除当前进程的整棵进程树（祖先+后代）**——
`process.pid` 自身不够，"空壳"启发式会把宿主自己判成空壳。
🔴 **破坏性动作（close/kill）绝不能复用"隐藏"的启发式（isEmpty）**——隐藏错了可恢复，关闭错了不可逆。
必须叠加**进程名白名单**，宁可少关也不能误杀 Fluent/宿主。

### 生效方式
改动含 `lib/index.js`（宿主逻辑）+ `lib/client.js` → **彻底退出 DSH 客户端再启动**。

## 0.4.3 (2026-11-08) — 新增「关闭空壳窗口」按钮 + 改名「一键清理任务栏窗口」

用户反馈：①「没有一键关闭空壳控制窗口按钮」②「一键关闭其他窗口改为 一键清理任务栏窗口」。

### 改动
1. **新增「关闭空壳窗口」按钮**（红色，工具栏第二个）：真正**结束**空壳控制台进程（`WM_CLOSE`），
   释放资源，区别于原来的「隐藏可见空壳」（只是隐藏、进程仍在）。
   - 新增宿主路由 `POST /dsh-console-sentinel/close-empty`：对 `ledger.snapshot()` 里所有 `isEmpty`
     的行发 `runWindowAction(hwnd,'close')`，返回 `closed` 计数，随后 `scan()` 刷新。
   - 客户端 `closeEmpty()`：二次确认后调用，提示「已关闭 N 个空壳窗口」。
2. **按钮改名**：「一键关闭其他窗口」→ **「一键清理任务栏窗口」**（确认弹窗文案同步改为"清理任务栏窗口"）。
3. 工具栏现为：`隐藏可见空壳` / `关闭空壳窗口` / `预演` / `一键清理任务栏窗口` / `刷新任务栏`（一行自动换行）。

### 测试
- 新增用例：点「关闭空壳窗口」调用 `/close-empty`（而非 `/hide-empty`）。
- 6 个单元测试文件全绿（client 5 条含新增）。

### 生效方式
改动含 `lib/index.js`（新路由）+ `lib/client.js` → **彻底退出 DSH 客户端再启动**。

## 0.4.2 (2026-11-08) — 面板 UI 重做：紧凑 / 不滚太长 / 傻瓜清晰

用户要求：「UI 设计，紧凑简洁、傻瓜清晰明了、页面不要滚动太长」。

### 改版（`lib/client.js` 布局重构，功能与元素 id 全部保留）
- **单屏三段式**：顶部「标题 + 平台 + 刷新」一行、状态一行 → 细条统计（4 个数字并排，矮）→ **操作按钮全部并到一行**
  （隐藏可见空壳 / 预演 / 一键关闭其他窗口 / 刷新任务栏，自动换行）。
- **Tab 分页**取代纵向堆叠：`任务栏`（默认）/ `控制台` / `白名单`，一次只显示一个，页面高度大幅缩短。
  切换是纯 DOM 显隐（`setActiveTab`），不触发重渲染、无抖动。
- **列表内部滚动限高**：任务栏列表 `max-height:270px`、控制台列表 `220px`，`overflow-y:auto` ——
  10+ 个窗口也只占固定高度，**整页不再被列表撑长**。
- 统计数字 20px→16px、卡片内边距收紧、每行留白减少；说明文案压成一行小字放在各 Tab 顶部。

### 测试
- 新增「tab 切换」用例：默认显示任务栏面板、点击「控制台」Tab 后正确切换显隐。
- client + client-taskbar 共 **10 条**全绿；desktop/logic/tool-output/cascadia 全绿。

### 生效方式
仅改 `lib/client.js`（客户端 bundle）→ **Ctrl+Shift+R 硬刷新**即可（不必整机重启）。

## 0.4.1 (2026-11-08) — 修复「强制关闭(管理员)」根本杀不掉（模块加载/提权/回传三重错）

用户反馈：「还是关不掉啊」。实测复现并定位到 **三个独立缺陷**，全部已修。

### 根因（都有实测证据）
1. **多行 PowerShell 经 `-Command` 传参被破坏**（0.4.0 就错的）。
   0.4.0 用 `spawn('powershell.exe', ['-Command', 多行脚本])`，换行在 shell 层被吃掉、
   语句粘连 → 存活检测拿不到 PID → **一律报 `already-gone`**。
   证据：0.4.0 端到端跑 notepad，**337 ms 就"成功"**、`Reason: already-gone`，
   而 `Get-Process notepad` 显示进程**仍然活着** —— 而且全程没弹 UAC（压根没提权）。
2. **`spawn` 根本不触发 UAC**。0.4.0 注释里写的 "`-Verb RunAs`" 只是注释，代码里没有
   `RunAs`，所以子进程继承非提权令牌，`taskkill` 对提权进程只会得到"拒绝访问"。
3. **提权子进程的 stdout 拿不到**。即使真提权了，`spawn` 的 stdout 管道也不属于提升后的
   进程 → 只能靠临时文件回传结果。

### 修法
- 脚本**写进临时 `.ps1`**（UTF-8 **带 BOM**，否则 PS 5.1 按 GBK 解码中文变乱码），
  再用 `Start-Process -Verb RunAs -Wait -PassThru` 启动 → **真正弹 UAC**。
- 结果**通过临时 JSON 文件回传**（`[IO.File]::WriteAllText`，UTF-8 无 BOM），
  不再依赖 stdout。读不到结果文件 → 明确返回 `uac-denied-or-cancelled` / `no-result-file`，
  **绝不假装成功**。
- 存活检测从 `Get-Process`（某些会话下对存在进程返回空）换成
  **`tasklist /FI "PID eq N" /FO CSV /NH` + 精确匹配 `"PID"`**。
- 杀完 `Start-Sleep 250ms` 再复检，只有**确认消失**才报 `killed`，否则 `still-running`。

### 实测（2026-11-08）
| 用例 | 结果 |
|---|---|
| 独立 `.ps1` 跑存活 notepad | `alive-before=True` → `Reason: killed`，进程真消失 |
| 提权路径杀新建 notepad | `killedCount=1/1`、`SUCCESS: The process with PID 171656 has been terminated`，其他 notepad 不受影响 |
| 探针识别提权进程 | `Taskmgr(73860)` / `iScrRec(25904)` / `iScrCompressor(115988)` 全部正确标 `[ADMIN]` |
| 6 个单元测试 | 全绿 |

### 踩坑固化
- 🔴 **多行 PS 脚本永远不要走 `-Command` 传参**：换行会被 shell 层吞掉。统一「写 `.ps1` 文件 + `-File` 执行」。
- 🔴 **`spawn` 不会提权**：要 UAC 必须 `Start-Process -Verb RunAs`，且 `spawn` 无法读取提权子进程的 stdout
  → 结果一律走临时文件。
- 🔴 **PS 5.1 读中文 `.ps1` 必须带 BOM**，否则 GBK 乱码。
- 🔴 **判断进程存活用 `tasklist` 精确匹配 PID**，不要用 `Get-Process` 的 `$null` 判断。

## 0.4.0 (2026-11-07) — 「强制关闭(管理员)」：突破 UIPI 关掉提权窗口

用户反馈：任务管理器 / iTop Video Compressor / iTop Screen Recorder 三个窗口「怎么都关不掉」。
用户明确选择方案 B：「我可以给你权限啊」→ 走 UAC 按需提权，而不是整个宿主以管理员运行。

### 根因（实测，不是插件逻辑错）
2026-11-07 用令牌 API 实测三个进程 **全部是管理员提权**，而 DSH 宿主是普通权限：
`Taskmgr pid=73860`、`iScrCompressor pid=114532`、`iScrRec pid=25904` — 全部 `ElevationType=1`。
Windows **UIPI（用户界面特权隔离）** 规定低完整性进程不能向高完整性窗口 `PostMessage`，
我们的 `WM_CLOSE` 被系统**静默丢弃** → 按钮点了"没反应"。
另：Taskmgr / explorer / fluent 还在 `DEFAULT_PROTECTED_PROCESSES` 硬保护名单里，需先「取消保护」。

### 新增
1. **提权检测** `lib/desktop.js`：探针 Add-Type `PInvoke.ElevK`（`OpenProcess` + `OpenProcessToken`
   + `GetTokenInformation(TokenElevation)`），每个窗口新增 `Elevated` 字段；探针整体新增 `selfElevated`。
2. **按需提权强杀** `runElevatedKill(pids)` / `forceCloseElevated(pids, opts)`：
   一次批量 `taskkill /F /PID ...`，**运行在提权助手进程里，只弹一次 UAC**；用户点「否」返回
   `all-rejected`/`elevated-helper-failed`，**明确报错而不是假装成功**。绝不回退到非提权 taskkill
   （那只会得到"拒绝访问"）。
3. **三道安全闸门**（实测全部生效）：
   - `dsh-host`：进程名以 `dsh` 开头（DSH NEXT 等）一律拒绝 —— 防止把正在用的宿主杀掉；
   - `self`：拒绝当前进程自身 pid；
   - `not-in-request`：用 `tasklist` 复核每个 pid 的真实进程名，必须落在调用方声明的
     `allowedProcesses` 内，**伪造/过期的 pid 直接失效**。
4. **面板** `lib/client.js`：提权行显示「管理员」虚线徽标；对「可关闭 + 未白名单 + 已提权」
   的行显示 **「强制关闭(管理员)」** 按钮（点击前有确认框说明会弹 UAC、会丢未保存内容）。
5. **路由** `GET /dsh-console-sentinel/taskbar-windows` 返回 `selfElevated` 与每行 `elevated`；
   新增 `POST /dsh-console-sentinel/force-close`。

### 踩坑（已固化）
- 🔴 **PowerShell 模板字面量陷阱**：ESM 里 `` `...${PID_LIST}...` `` 会被 JS 当变量插值 →
  `ReferenceError: PID_LIST is not defined`（模块直接加载失败）。嵌入 PS 脚本里的占位符**必须写成
  非 `${}` 形式**，本次改为 `__PID_LIST__` + `.replace()`。
- 提权助手**必须**真正以 UAC 方式启动，否则继承非提权令牌 → 静默失败 → 又变成"按钮没反应"。

### 测试
- `tests/client-taskbar.test.mjs` 扩到 5 条：新增「强制关闭(管理员)」只在"可关闭+提权+未白名单"
  行出现，且点击发送的是**该行 pid**（断言 `pids:[104]` / `allowedProcesses:['iScrRec']`）。
- 6 个单元测试文件全绿。`forceCloseElevated` 三道闸门实测：宿主→`dsh-host`、自身→`self`、
  名称不符→`not-in-request`，均 `all-rejected` 且不弹 UAC。

### 生效方式
改动含 `lib/index.js`（宿主新路由）+ `lib/client.js` + `lib/package.json` 版本
→ **彻底退出 DSH 客户端再启动**。

## 0.3.2 (2026-11-07) — 修复「取消保护」点了没用（var 闭包 #2）

用户实测反馈：「取消保护取消不掉，重启了（仍不行）」。

### 根因
`lib/client.js` 任务栏面板里，`取消保护 / 恢复保护` 按钮的 onClick 闭包了函数级 `var proc`。
`var` 是函数作用域，循环结束时 `proc` 只剩最后一行的进程名 → **无论点哪一行的「取消保护」，
实际发送的都是最后一行的进程**。用户点任务管理器，结果把最后一行 `iScrCompressor` 写进了
`whitelist.unprotect`，Taskmgr / explorer 的保护纹丝不动。文件证据：`~/.dsh/console-sentinel/whitelist.json`
的 `unprotect` 里只有 `iScrCompressor`（=最后一行），没有用户真正点的 Taskmgr。

### 修法
把 `proc` 作为 IIFE 形参按值绑定（`(function(procName,...){...})(w.process,...)`），每行独立。
复选框那条（0.3.1 的闭包 #1）此前已修，本次是同类 bug 的第二处。

### 测试强化
原测试只断言 `items.length===1`，恰好放过此 bug。改为 `deepEqual(items,['taskmgr'])`——点第 2 行
必须发送 `taskmgr`，而不是最后一行。修复前该断言必红，修复后全绿。

### 教训（写入 dev-log）
同一函数内 `var` 声明、又在事件/异步回调里引用的循环变量，一律按值绑定；
测试断言必须校验**具体进程名**，不能只校验数量。`node --check` 与人工读码均发现不了此类运行时 bug。

## 0.3.1 (2026-11-07) — 任务栏窗口白名单（图标 + 勾选）· 取消保护 · 预览显示图标

用户需求：「识别任务栏然后从任务栏中勾选出白名单更方便，图标显示」；
「预览能不能显示出来要关闭的这些窗口的图标」。

### 新增
1. **任务栏窗口白名单面板** `lib/client.js`：新增「任务栏窗口 · 勾选加入白名单」卡片。
   列出当前任务栏上每个可见应用窗口，逐行显示
   - **真实进程图标**（从 exe 提取的 PNG data URL，18×18）；
   - **完整进程名 + pid**（如 `chrome (pid 100)`，可核对到底选的是谁）；
   - 窗口标题（截断 90 字）；
   - **复选框**：勾选即把该进程名加入豁免白名单（`/whitelist` `{action:add,kind:process}`），
     取消勾选即移除。受保护进程（explorer/taskmgr/fluent/powershell…）复选框置灰并标「受保护」。
   - 「刷新任务栏」按钮重新枚举。
2. **取消保护 / 恢复保护（0.3.1 追加）**：内置保护（`DEFAULT_PROTECTED_PROCESSES`：explorer / taskmgr /
   fluent / launcher1 / powershell 等）不再是死名单。面板每行右侧提供
   - **「取消保护」**按钮：确认后把该进程写入持久 `whitelist.unprotect`（`/whitelist {action:add,kind:unprotect}`），
     该进程随即变为可被「一键关闭其他窗口」关闭；行内徽标变成「已取消保护」。
   - **「恢复保护」**：从 `unprotect` 移除，重新受保护。
   - **宿主硬保护**：进程名以 `dsh` 开头（如 `DSH NEXT`）的行显示「宿主·不可取消」，按钮不出现，
     防止把正在使用的 DSH 应用关掉。
   - `/desktop-cleanup` 的实际关闭名单 = `(内置保护 + 配置保护 + 白名单) − unprotect`，
     与面板显示完全一致（不再只是"看起来取消"）。
3. **宿主路由** `lib/index.js` 新增 `GET /dsh-console-sentinel/taskbar-windows`：
   调用 `runDesktopProbe()` 枚举任务栏窗口，附带图标、pid、进程名、标题、是否已白名单、
   `protected / hardProtected / unprotected / hostLocked` 四个保护状态。只读、loopback 校验、优雅降级。
4. **图标提取** `lib/desktop.js`：`runDesktopProbe` 的 PowerShell 探针新增
   `Add-Type System.Drawing` + `Get-IconData()`，用 `Icon.ExtractAssociatedIcon(exePath)`
   转 PNG→base64 data URL，按 exe 路径缓存（同进程多窗口不重复提取）；窗口记录新增 `Icon` 字段。
   受权限限制（如提权的任务管理器）读不到 exe 时返回空串，前端用灰色占位块兜底、不影响布局。
5. **清理预览显示图标**：`/desktop-cleanup` 响应新增 `plannedDetailed`（含 icon）；
   `renderDesktopResult()` 为每个「将被关闭」的窗口渲染图标 + 文本。

### 修复
- **var 闭包陷阱 #1（复选框）**（`tests/client-taskbar.test.mjs` 抓到）：复选框 change 监听器最初把循环变量
  `cb` 直接闭包进 IIFE，导致所有行都读到「最后一个复选框」的 checked（勾 chrome 却发 remove）。
  改为把 `box` 作为 IIFE 形参传入。
- **var 闭包陷阱 #2（取消保护按钮，2026-11-07 用户实测"取消不掉"）**：`取消保护` 按钮的 onClick 闭包了
  函数级 `var proc`，导致**每一行的按钮都发送最后一行进程名**——点任务管理器的「取消保护」实际把最后一行
  `iScrCompressor` 写进了 unprotect，Taskmgr/explorer 纹丝不动。改为把 `proc` 作 IIFE 形参按值绑定。
  **教训**：同一函数里用 `var` 声明、又在异步/事件回调里引用的循环变量，全部要按值绑定；测试断言必须校验
  **具体进程名**（`deepEqual(items,['taskmgr'])`），只断言 `items.length===1` 会放过这个 bug。
  `node --check` 与人工读码都发现不了——两次都是靠 DOM-stub 测试（且第二次靠强化了的断言）才暴露。

### 测试
- 新增 `tests/client-taskbar.test.mjs`（3 条）：图标+复选框逐行渲染 / checked 反映白名单且受保护行置灰 /
  勾选触发 `/whitelist` add（items=[进程名]）。连原 `client.test.mjs` 共 7 条客户端测试全绿；
  `desktop.test.mjs` + `logic.test.mjs` 29 条全绿。

### 生效方式
- 改动了 `lib/index.js`（宿主）+ `lib/client.js`（客户端 bundle）→ **彻底退出 DSH 客户端再启动**（一次全覆盖）。

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
