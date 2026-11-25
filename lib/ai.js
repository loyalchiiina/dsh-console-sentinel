// dsh-console-sentinel — 本地 AI 显存占用与「安全优雅释放」（宿主端）。
//
// 目标：看清本机哪些进程在吃显存（本地大模型 / 生图 / 视频 / 音乐 / 语音服务），
// 需要时**安全优雅地**把显存还回来 —— 释放后下次还能正常用。界面在 lib/client.js
// 的「本地AI」页签。
//
// 识别的通用性（不绑定任何安装路径，别人装的也能认出来）：
//   1) 权威判据 = nvidia-smi --query-compute-apps 的 PID 集合：谁真占显存就抓谁，
//      与安装目录、软件名、机器都无关。
//   2) 用 PID 反查进程表拿 name / path / 本地监听端口（一次 PowerShell 内完成）。
//   3) 通用特征正则认身份（llama.cpp / Ollama / LM Studio / vLLM / ComfyUI /
//      SD WebUI / MOSS / YuE2 / 语音克隆 / 换脸 / 超分 / Xinference / Kobold …）。
//   4) 兜底：占显存但认不出名字的，也照样列出来（kind='unknown'，标「未识别的本地模型」），
//      可逐行手动释放 —— 这是「别人安装也能识别」的关键，不能删。
//
// 释放的安全优雅性（graceful-first）：
//   L1 HTTP 卸载  —— ComfyUI POST /free {unload_models,free_memory}（官方端点，
//                    server.py 里 @routes.post("/free")，队列忙时延后到任务结束，
//                    不打断出图）；Ollama POST /api/generate {keep_alive:0}。
//                    → 服务主体存活，只是把模型从显存卸掉，下次请求自动重载。
//   L2 WM_CLOSE   —— taskkill /PID（不带 /F），只给这一个进程发 WM_CLOSE。
//   L3 强制       —— 最后才 taskkill /T /F，并在结果里明确标注「已强制结束」。
//
// ⚠️ 曾经有过 L3「CTRL_BREAK」，2026-11-25 事故后整层删除，不得恢复：
// GenerateConsoleCtrlEvent 的第二个参数是进程组 id，传 0 = 向**整个共享控制台的所有进程**广播。
// 给 llama-server 发 CTRL_BREAK 时，同控制台的父进程 tier_router（8080 档位网关）一起收到 ^C
// 直接退出 → 用户现象「安全释放之后，本地模型再也点不出来」（日志里就是一行 ^C）。
// Windows 上没有「只给某个子进程发 Ctrl+C」的可靠办法，所以这层只能删，不能收窄条件。
//
// 为什么不需要停网关、也不能杀网关：tier_router（8080）在下次请求时会调用 ensure_tier()，
// 发现后端 poll() 非 None 就 stop_backend()+start_backend() 自动重新拉起 —— 前提是它自己还活着。
// 所以「只杀模型后端、绝不碰网关」才同时满足「释放显存」和「下次照常能用」。
// 网关本身不占显存，本模块一律不列、不动。
//
// 性能（2026-11-21 本机实测）：
//   Get-Process + Path        0.39 s (477 进程)
//   Get-NetTCPConnection      1.68 s (55 监听)
//   nvidia-smi 两条查询       0.20 s
//   合计约 2.8~3.3 s / 次；禁用手段：Get-CimInstance 按名查询实测 ~5 s/个、
//   全量枚举 39 s，wmic 在本机已被移除。

import { spawn } from 'node:child_process'

const MARK_BEGIN = '===SENTINEL-AI-BEGIN==='
const MARK_END = '===SENTINEL-AI-END==='

// --- 特征表：进程名 / 路径（allow-list）------------------------------------

// kind='model'：本地推理 / 生图 / 视频 / 音乐 / 语音服务，通常直接吃显存。
// 这些是「通用」特征 —— 不依赖安装目录，任何机器、任何路径装上都能命中。
const MODEL_RULES = [
  { key: 'llama.cpp', label: 'llama.cpp', re: /llama[-_.]?(server|cli|bench|box)|llamacpp|llama_box/i },
  { key: 'ollama', label: 'Ollama', re: /\bollama\b|ollama_llama_server/i },
  { key: 'lmstudio', label: 'LM Studio', re: /lm-?studio|\blms\b/i },
  { key: 'vllm', label: 'vLLM', re: /\bvllm\b|vllm\.entrypoints/i },
  { key: 'sglang', label: 'SGLang', re: /sglang/i },
  { key: 'kobold', label: 'KoboldCpp', re: /koboldcpp/i },
  { key: 'textgen', label: 'text-generation-webui', re: /text-generation-webui|oobabooga/i },
  // 注意：不要用「安装目录名」做识别（如 local-?ai）——那会把同一个目录下
  // 无关的 python（MCP 服务、训练脚本、ansys-mcp）全都标成同一个软件，
  // 而且别人装在别的盘/别的目录就完全认不出。识别只认软件自身的特征。
  { key: 'jan', label: 'Jan', re: /\bjan(-?ai)?\.exe|\bjan-?ai\b/i },
  { key: 'gpt4all', label: 'GPT4All', re: /gpt4all/i },
  { key: 'tabby', label: 'TabbyAPI / ExLlama', re: /tabbyapi|exllama/i },
  { key: 'llamafile', label: 'llamafile', re: /llamafile/i },
  { key: 'mlx', label: 'TGI / MLX', re: /text-generation-inference|mlx_lm/i },
  { key: 'xinference', label: 'Xinference', re: /xinference/i },
  { key: 'fastchat', label: 'FastChat', re: /fastchat/i },
  { key: 'anythingllm', label: 'AnythingLLM / Msty', re: /anythingllm|\bmsty\b/i },
  { key: 'aphrodite', label: 'Aphrodite / TGI', re: /aphrodite|huggingface[-_]?tgi/i },

  // 生图 / 视频 / 换脸 / 超分
  { key: 'comfyui', label: 'ComfyUI', re: /comfyui|comfy\.cli|ComfyUI\\main\.py/i },
  { key: 'sdwebui', label: 'Stable Diffusion WebUI', re: /stable-diffusion|sd[.-]?webui|a1111|forge-webui|invokeai/i },
  { key: 'moss', label: 'MOSS 生图', re: /\bmoss\b|moss[-_]?image|moss[-_]?qwen/i },
  { key: 'minimax', label: 'MiniMax H3 视频', re: /minimax[-_]?h3|\bh3[-_]?(video|addguide)|addguide/i },
  { key: 'faceswap', label: '换脸 / 姿势控制', re: /faceswap|face[-_]?swap|vnccs|pose[-_]?studio|bfs[-_]?swap|inswapper|roop(?!t)/i },
  { key: 'upscale', label: '超分 / 修复（GFPGAN 等）', re: /gfpgan|codeformer|realesrgan|esrgan|facexlib|hand[-_]?repair/i },
  { key: 'kohya', label: '训练脚本（Kohya / Diffusers）', re: /kohya|sd[-_]?scripts|train_network|diffusers/i },

  // 音乐 / 语音
  { key: 'yue2', label: 'YuE2 音乐生成', re: /\byue2?\b|yue[-_]?2|ace[-_]?step|musicgen|audiocraft/i },
  { key: 'voice', label: '语音克隆 / TTS（CosyVoice、GPT-SoVITS）', re: /cosyvoice|sovits|gpt-?sovits|chattts|index[-_]?tts|\bbark\b/i },
  { key: 'asr', label: '语音识别（Whisper）', re: /whisper|faster[-_]?whisper/i },
]

// 网关（额度中转 / 档位路由 / 账号聚合）：**本身不占显存，一律不列、不动**。
// 这里只用于「排除」—— 名字命中的进程不会进入清单。
const GATEWAY_EXCLUDE_RE = /tier_router|litellm|one[-_]?api|new[-_]?api|open[-_]?webui|openwebui|agent2api|agent[-_]?2[-_]?api|\bmagpie\b|magpie[-_]?bun|lobsterai|lobster[-_]?daddy|opensquilla|tokenrhythm|autoclaw|autoglm|\bhermes\b|aisix|warpgate|cherry[-_]?studio/i

// 端口线索（本地监听）。名字/路径认不出来时的第二路证据，置信度中等。
const PORT_HINTS = {
  // 文本推理后端
  11434: { kind: 'model', label: 'Ollama 默认端口' },
  1234: { kind: 'model', label: 'LM Studio 默认端口' },
  8099: { kind: 'model', label: 'llama.cpp 后端端口' },
  8081: { kind: 'model', label: 'llama.cpp 后端端口' },
  8000: { kind: 'model', label: 'vLLM / 推理服务端口' },
  2242: { kind: 'model', label: 'Xinference 端口' },
  // Gradio 家族（MOSS 生图、YuE2 音乐、语音克隆、各类自建 WebUI 都是它）
  7860: { kind: 'model', label: 'Gradio WebUI（MOSS / YuE2 / 语音克隆常见）' },
  7861: { kind: 'model', label: 'Gradio WebUI 端口' },
  7862: { kind: 'model', label: 'Gradio WebUI 端口' },
  7863: { kind: 'model', label: 'Gradio WebUI 端口' },
  7864: { kind: 'model', label: 'Gradio WebUI 端口' },
  7865: { kind: 'model', label: 'Gradio WebUI 端口' },
  7870: { kind: 'model', label: '换脸 / 姿势控制台端口' },
  7871: { kind: 'model', label: '生图控制台端口' },
  // ComfyUI 家族
  8188: { kind: 'model', label: 'ComfyUI 默认端口' },
  8189: { kind: 'model', label: 'ComfyUI 端口' },
  8190: { kind: 'model', label: 'ComfyUI 端口' },
  // 网关 / 额度中转（只用于排除）
  3000: { kind: 'gateway', label: 'Open WebUI 默认端口' },
  4000: { kind: 'gateway', label: 'LiteLLM 默认端口' },
  5000: { kind: 'gateway', label: '网关/档位路由端口' },
  5001: { kind: 'gateway', label: '网关/档位路由端口' },
  8080: { kind: 'gateway', label: '本地 AI 网关/档位路由端口' },
  3065: { kind: 'gateway', label: 'Agent2API 额度中转站端口' },
  17819: { kind: 'gateway', label: 'LobsterAI 控制台端口' },
  3425: { kind: 'gateway', label: 'magpie 账号聚合端口' },
  18500: { kind: 'gateway', label: 'magpie 服务端口' },
}

// 「未识别的本地模型」里要滤掉的日常噪音：占 GPU 上下文但和本地 AI 无关。
const OTHER_GPU_EXCLUDE_RE = /^(msedge|msedgewebview2|chrome|firefox|brave|opera|360se|360chrome|qq|weixin|wechat|wechatappex|wps|wpscloudsvr|et|wpp|excel|winword|powerpnt|onenote|outlook|teams|dingtalk|feishu|explorer|shellexperiencehost|startmenuexperiencehost|searchhost|searchapp|textinputhost|snippingtool|screensketch|lockapp|applicationframehost|windowsterminal|conhost|openconsole|mintty|gameviewer|gameviewerserver|sunloginclient|oray|awesun|todesk|ikuuuvpncore|ikuuuvpn|lmgrd|ansyslmd|tomcat|tomcat10|java|promecefpluginhost|printdialog|crossdeviceresume|chatgpt|codex.*|system|svchost|dwm|wininit|csrss|winlogon|lsass|services|smss|nvidia.*|nvcontainer.*|nvsphelper64|amdow|radeonsoftware|taskmgr|taskhostw|mmc|perfmon|regedit|searchui|backgroundtaskhost|runtimebroker|wmiprvse)$/i

// 只有路径落在这些字样里的 node/python 才允许被当作 AI 服务。
const AI_PATH_RE = /local-?ai|ollama|lm-?studio|comfyui|koboldcpp|text-generation-webui|\bvllm\b|sglang|llamafile|gpt4all|moss|yue|cosyvoice|sovits|faceswap|stable-diffusion|diffusers|gradio|xinference|minimax|whisper|musicgen|audiocraft/i

// --- 硬保护（deny-list）----------------------------------------------------

// 无论从哪个入口都不允许结束：DSH 自身 / 系统外壳 / 输入法 / 录屏 / 日常软件。
// 用非锚定匹配 —— 进程名可能带空格（如 "DSH NEXT"），精确匹配会漏。
const NEVER_KILL_RE = /\bdsh\b|dsh[-_ ]?next|deepseek|electron|tabtip|ctfmon|textinputhost|piliaurora|pililive|bilibili|iscrrec|wechatappex|shellhost|useroobebroker|shellexperiencehost|searchhost|conhost|openconsole|windowsterminal|mintty|gameviewer/i

const PROTECT_NAME_RE = /^(electron|dsh|dsh-desktop|dsh-host|deepseek|fluent|fl_mpi|mpiexec|ansys|solver|cortex|spaceclaim|workbench|svchost|system|systemsettings|services|explorer|csrss|wininit|winlogon|lsass)$/i
// 路径里出现这些字样 → 计算相关（Fluent/Ansys 自动化脚本），保护。
const PROTECT_PATH_RE = /fluent|ansys|spaceclaim|workbench|mpiexec|cfx-|tgrid|icem/i

// --- 子进程执行 ------------------------------------------------------------

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, { windowsHide: true, timeout: opts.timeoutMs || 15000 })
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String((error && error.message) || error) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (error) => resolve({ ok: false, code: -1, stdout, stderr: String(error) }))
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- nvidia-smi ------------------------------------------------------------

const NVIDIA_SMI_NAMES = [
  'nvidia-smi',
  'C:\\Windows\\System32\\nvidia-smi.exe',
  'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe',
]

async function queryNvidiaSmi(args, timeoutMs = 8000) {
  for (const bin of NVIDIA_SMI_NAMES) {
    const res = await run(bin, args, { timeoutMs })
    if (res.ok && res.stdout.trim()) return res
  }
  return { ok: false, stdout: '', stderr: 'nvidia-smi not available', code: -1 }
}

export function parseGpuQuery(text) {
  const rows = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const c = line.split(',').map((s) => s.trim())
    if (c.length < 5) continue
    const totalMiB = Number(c[2])
    const usedMiB = Number(c[3])
    const freeMiB = Number(c[4])
    if (![totalMiB, usedMiB, freeMiB].every((n) => Number.isFinite(n))) continue
    rows.push({
      index: Number(c[0]) || 0,
      name: c[1] || 'GPU',
      totalMiB,
      usedMiB,
      freeMiB,
      utilPct: Number.isFinite(Number(c[5])) ? Number(c[5]) : null,
    })
  }
  return rows
}

// WDDM 模式下 used_memory 常为 [N/A]：此时该列表只代表「有 GPU 上下文」，不代表吃显存。
export function parseAppQuery(text) {
  const rows = []
  let unnamed = 0
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (/no running processes/i.test(line)) continue
    const c = line.split(',').map((s) => s.trim())
    if (c.length < 2) continue
    const pid = Number(c[0])
    if (!Number.isFinite(pid) || pid <= 0) continue
    const nameRaw = c[1] || ''
    const memRaw = c[2] || ''
    const mem = Number(memRaw)
    if (/insufficient|n\/a/i.test(nameRaw)) unnamed += 1
    rows.push({
      pid,
      name: /insufficient/i.test(nameRaw) ? '' : nameRaw,
      usedMiB: Number.isFinite(mem) ? mem : 0,
      hasMem: Number.isFinite(mem),
    })
  }
  return { rows, unnamed, hasMem: rows.some((r) => r.hasMem) }
}

// --- 进程表（一次 PowerShell：Get-Process + 本地监听端口）-------------------

const PROC_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'

$rows = New-Object System.Collections.ArrayList
foreach ($p in (Get-Process)) {
  $path = ''
  try { $path = [string]$p.Path } catch { }
  $null = $rows.Add([pscustomobject]@{
    pid  = [int]$p.Id
    name = [string]$p.ProcessName
    ws   = [int64]$p.WorkingSet64
    path = $path
  })
}

$ports = New-Object System.Collections.ArrayList
try {
  foreach ($c in (Get-NetTCPConnection -State Listen)) {
    $null = $ports.Add([pscustomobject]@{ pid = [int]$c.OwningProcess; port = [int]$c.LocalPort })
  }
} catch { }

$payload = [pscustomobject]@{ ok = $true; procs = $rows; ports = $ports }
Write-Output '${MARK_BEGIN}'
Write-Output (ConvertTo-Json -InputObject $payload -Depth 5 -Compress)
Write-Output '${MARK_END}'
`

function extractMarked(stdout) {
  const begin = stdout.indexOf(MARK_BEGIN)
  if (begin < 0) return null
  const start = begin + MARK_BEGIN.length
  const end = stdout.indexOf(MARK_END, start)
  if (end < 0) return null
  try { return JSON.parse(stdout.slice(start, end).trim()) } catch { return null }
}

async function readProcessTable(timeoutMs = 25000) {
  const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROC_SCRIPT], { timeoutMs })
  const data = extractMarked(res.stdout)
  if (!data) {
    return { ok: false, procs: [], ports: new Map(), reason: res.ok ? 'no-marked-json' : 'powershell-failed' }
  }
  const procs = (Array.isArray(data.procs) ? data.procs : []).map((p) => ({
    pid: Number(p.pid) || 0,
    name: String(p.name || ''),
    memMB: Math.round((Number(p.ws) || 0) / 1048576),
    path: String(p.path || ''),
  })).filter((p) => p.pid > 0)

  const ports = new Map()
  for (const item of (Array.isArray(data.ports) ? data.ports : [])) {
    const pid = Number(item && item.pid)
    const port = Number(item && item.port)
    if (!Number.isFinite(pid) || !Number.isFinite(port) || pid <= 0) continue
    if (!ports.has(pid)) ports.set(pid, [])
    ports.get(pid).push(port)
  }
  return { ok: true, procs, ports }
}

// --- 识别 ------------------------------------------------------------------

export function classifyProcess(name, path, ports = []) {
  const hay = String(name || '') + ' ' + String(path || '')

  // ① 网关端口是**最强证据**，必须排在模型规则之前。
  // 反例（2026-11-25 实测）：tier_router.py 的进程名是 python.exe、路径是共享 runtime 的 python，
  // 名字/路径都认不出它是网关，但它监听 8080 —— 旧代码先跑 MODEL_RULES 就把它当成了模型，
  // 结果「安全释放」把网关本身一起干掉，用户下次再也点不出本地模型。
  const sorted = [...ports].sort((a, b) => a - b)
  for (const port of sorted) {
    const hint = PORT_HINTS[port]
    if (hint && hint.kind === 'gateway') {
      return { kind: 'gateway', key: 'port:' + port, label: hint.label, via: 'port', port }
    }
  }

  // ② 名字/路径命中网关名单（tier_router / litellm / agent2api / magpie …）
  if (GATEWAY_EXCLUDE_RE.test(hay)) return { kind: 'gateway', key: 'gateway', label: '网关（不参与显存释放）', via: 'name' }

  // ③ 模型特征规则
  for (const rule of MODEL_RULES) {
    if (rule.re.test(hay)) return { kind: 'model', key: rule.key, label: rule.label, via: 'name' }
  }

  // ④ 模型端口（Gradio / ComfyUI / llama.cpp 后端 …）
  for (const port of sorted) {
    const hint = PORT_HINTS[port]
    if (hint && hint.kind === 'model') {
      return { kind: 'model', key: 'port:' + port, label: hint.label, via: 'port', port }
    }
  }
  return null
}

export function protectReason(name, path) {
  const raw = String(name || '')
  const bare = raw.toLowerCase().replace(/\.exe$/, '')
  // 先拦 DSH 自身与系统外壳 —— 名字带空格（如 "DSH NEXT"）时精确匹配会漏，故用非锚定正则。
  if (NEVER_KILL_RE.test(raw)) return 'DSH / 系统外壳相关进程（不参与结束）'
  if (PROTECT_NAME_RE.test(bare)) return '核心/计算进程（DSH 宿主、Electron、Fluent、Ansys、MPI 等）'
  if (PROTECT_PATH_RE.test(String(path || ''))) return 'Fluent/Ansys 相关程序（计算中）'
  // node 可能是 DSH 自身宿主或插件运行时：路径不在 AI 目录就一律保护。
  if (bare === 'node' && !AI_PATH_RE.test(String(path || ''))) return 'Node 进程（可能是 DSH 宿主或插件运行时）'
  return ''
}

// --- 忙碌探测 & HTTP 卸载（优雅释放的 L1 级）--------------------------------

async function httpJson(url, init, timeoutMs = 1800) {
  if (typeof fetch !== 'function') return { ok: false, error: 'fetch unavailable' }
  try {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(timeoutMs)
      : undefined
    const res = await fetch(url, { ...(init || {}), signal })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
    return { ok: res.ok, status: res.status, json, text }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

// 认出「这个服务支持哪种 HTTP 卸载」以及「现在忙不忙」。
// 返回 { unloadKind, port, busy, detail }
async function detectUnload(proc) {
  const ports = Array.isArray(proc.ports) ? proc.ports : []
  const label = String(proc.label || '')
  const name = String(proc.name || '')

  // ComfyUI 家族（含跑在 ComfyUI 上的 MiniMax H3 视频）：官方 /free 卸载端点。
  const isComfy = /comfy|minimax|\bh3\b/i.test(label) || /comfy/i.test(name) || ports.some((p) => p >= 8188 && p <= 8190)
  if (isComfy) {
    for (const port of ports) {
      const r = await httpJson(`http://127.0.0.1:${port}/queue`, { method: 'GET' }, 1500)
      if (r.ok && r.json) {
        const running = Array.isArray(r.json.queue_running) ? r.json.queue_running.length : 0
        const pending = Array.isArray(r.json.queue_pending) ? r.json.queue_pending.length : 0
        return { unloadKind: 'comfyui', port, busy: running > 0 || pending > 0, detail: `队列 running=${running} pending=${pending}` }
      }
    }
    return { unloadKind: 'comfyui', port: ports[0] || null, busy: null, detail: '' }
  }

  // Ollama：/api/ps 看已加载模型。
  if (ports.includes(11434) || /ollama/i.test(name)) {
    const port = ports.includes(11434) ? 11434 : ports[0]
    const ps = await httpJson(`http://127.0.0.1:${port}/api/ps`, { method: 'GET' }, 1500)
    const models = (ps.json && Array.isArray(ps.json.models)) ? ps.json.models : []
    return { unloadKind: 'ollama', port, busy: models.length > 0, detail: models.length ? `已加载 ${models.length} 个模型` : '无已加载模型' }
  }

  // llama.cpp：/slots 的 is_processing。
  if (/llama/i.test(name) || ports.includes(8099) || ports.includes(8081)) {
    const port = ports.includes(8099) ? 8099 : (ports.includes(8081) ? 8081 : ports[0])
    if (port) {
      const r = await httpJson(`http://127.0.0.1:${port}/slots`, { method: 'GET' }, 1500)
      const slots = Array.isArray(r.json) ? r.json : []
      const busy = slots.some((s) => s && s.is_processing)
      return { unloadKind: '', port, busy, detail: Array.isArray(r.json) ? `slots=${slots.length}` : '' }
    }
  }

  return { unloadKind: '', port: ports[0] || null, busy: null, detail: '' }
}

async function httpUnload(proc) {
  const info = proc.unload || {}
  if (!info.unloadKind || !info.port) {
    return { ok: false, reason: '该服务没有 HTTP 卸载接口（将走优雅关闭）' }
  }

  if (info.unloadKind === 'comfyui') {
    const r = await httpJson(`http://127.0.0.1:${info.port}/free`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    }, 8000)
    if (r.ok) return { ok: true, detail: `POST /free 已提交（服务仍在运行，下次出图自动重载）` }
    return { ok: false, reason: `/free 失败：${r.status || r.error || 'unknown'}` }
  }

  if (info.unloadKind === 'ollama') {
    const ps = await httpJson(`http://127.0.0.1:${info.port}/api/ps`, { method: 'GET' }, 3000)
    const models = (ps.json && Array.isArray(ps.json.models)) ? ps.json.models : []
    if (!models.length) return { ok: true, detail: '当前没有已加载的模型（无需卸载）' }
    let okAll = true
    for (const m of models) {
      const r = await httpJson(`http://127.0.0.1:${info.port}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: m.name, keep_alive: 0 }),
      }, 8000)
      if (!r.ok) okAll = false
    }
    return okAll
      ? { ok: true, detail: `keep_alive=0 已作用于 ${models.length} 个模型（服务仍在运行）` }
      : { ok: false, reason: '部分模型卸载失败' }
  }

  return { ok: false, reason: '未知的卸载方式' }
}

// --- 关闭级别（L2 ~ L3）----------------------------------------------------

async function isAlive(pid) {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但没权限；ESRCH = 已退出
    return Boolean(error && error.code === 'EPERM')
  }
}

async function waitExit(pid, timeoutMs) {
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 8000)
  while (Date.now() < deadline) {
    if (!(await isAlive(pid))) return true
    await sleep(150)
  }
  return !(await isAlive(pid))
}

// L2：WM_CLOSE（taskkill 不带 /F）
async function wmClose(pid) {
  const res = await run('taskkill', ['/PID', String(pid)], { timeoutMs: 8000 })
  const text = (res.stdout + ' ' + res.stderr).trim()
  if (res.ok) return { ok: true, detail: 'WM_CLOSE 已发送' }
  if (res.code === 128 || /not found|没有运行|找不到|no running instance/i.test(text)) {
    return { ok: true, detail: 'already-exited' }
  }
  return { ok: false, reason: text.slice(0, 160) || ('exit ' + res.code) }
}

// ⚠️ 曾经有 L3「CTRL_BREAK」：FreeConsole → AttachConsole(pid) → GenerateConsoleCtrlEvent(1, 0)。
// 2026-11-25 事故后彻底移除，原因写死在这里，别再有人加回来：
// GenerateConsoleCtrlEvent 的第二个参数是「进程组 id」，传 0 = 向**整个共享控制台的所有进程**广播。
// 而 AttachConsole(pid) 只是把我们的进程挂到目标那个控制台上，于是 0 就覆盖了那个控制台里的每一个进程。
// 实测后果：给 llama-server 发 CTRL_BREAK，同控制台的父进程 tier_router（8080 网关）一起收到 ^C，
// 直接 KeyboardInterrupt 退出 —— 用户看到的现象就是「安全释放掉之后，本地模型再也点不出来」。
// Windows 上不存在「只给某一个子进程发 Ctrl+C」的可靠办法（除非这个进程组是我们自己
// 用 CREATE_NEW_PROCESS_GROUP 建的），所以这一层只能整层删掉，不能收窄条件。

// L4：强制
async function forceKill(pid) {
  const res = await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 10000 })
  const text = (res.stdout + ' ' + res.stderr).trim()
  if (res.ok) return { ok: true, detail: '已强制结束' }
  if (res.code === 128 || /not found|没有运行|找不到|no running instance/i.test(text)) {
    return { ok: true, detail: 'already-exited' }
  }
  return { ok: false, reason: text.slice(0, 160) || ('exit ' + res.code) }
}

/**
 * 对单个服务做「优雅优先」的释放。返回 { ok, method, alive, detail, steps }。
 * method: 'unload'（服务仍在）| 'wmclose' | 'force'
 *
 * 层级（2026-11-25 起，CTRL_BREAK 那层已删除，见上方事故注释）：
 *   L1 服务自己的 HTTP 卸载接口（ComfyUI /free、Ollama keep_alive:0）→ 模型卸载、服务仍在
 *   L2 taskkill 不带 /F（= 发 WM_CLOSE，只有带窗口的进程会响应）
 *   L3 taskkill /T /F（强制。对 llama-server 这类无窗口 console 程序，到这里是正常的）
 *
 * 关键设计：永远只动「被选中的那个进程」，绝不向控制台/进程组广播任何信号 ——
 * 否则会连带杀掉同控制台的父进程（典型就是 8080 那个档位路由网关），
 * 那才是「释放完下次就用不了」的真正原因。
 */
export async function gracefulRelease(proc, opts = {}) {
  const mode = String(opts.mode || 'graceful') // graceful | unload | stop
  const waitMs = Number(opts.waitMs) || 8000
  const steps = []

  // L1 HTTP 卸载（只卸模型，服务不动）
  if (mode !== 'stop') {
    const u = await httpUnload(proc)
    steps.push({ level: 'L1', name: 'HTTP 卸载模型', ok: Boolean(u.ok), detail: u.detail || u.reason || '' })
    if (u.ok) return { ok: true, method: 'unload', alive: true, detail: u.detail || '已优雅卸载（服务仍在运行）', steps }
    if (mode === 'unload') return { ok: false, method: 'unload', alive: true, detail: u.reason || '卸载失败', steps }
  }

  // L2 WM_CLOSE（taskkill 不带 /F 的语义就是发 WM_CLOSE，只影响该进程自己的主窗口）
  const l2 = await wmClose(proc.pid)
  steps.push({ level: 'L2', name: 'WM_CLOSE 温和关闭', ok: Boolean(l2.ok), detail: l2.detail || l2.reason || '' })
  if (l2.ok && await waitExit(proc.pid, waitMs)) {
    return { ok: true, method: 'wmclose', alive: false, detail: '已优雅关闭', steps }
  }

  // L3 强制（只针对这一个 PID，/T 只连带它的子孙，不会波及父进程）
  const l3 = await forceKill(proc.pid)
  steps.push({ level: 'L3', name: '强制结束', ok: Boolean(l3.ok), detail: l3.detail || l3.reason || '' })
  const gone = await waitExit(proc.pid, 3000)
  // ok 必须同时满足「taskkill 成功」和「进程确实没了」。
  // detail 跟着 ok 走 —— 否则 pid 不存在时会说「已强制结束」，与 ok:false 自相矛盾。
  const ok = Boolean(l3.ok) && gone
  return {
    ok,
    method: 'force',
    alive: !gone,
    detail: ok
      ? '已强制结束（由父级网关托管的话，下次请求会自动重新拉起）'
      : '强制结束未成功：' + (l3.detail || l3.reason || (gone ? '未知原因' : '进程仍在运行')),
    steps,
  }
}

// --- 状态采集 --------------------------------------------------------------

/**
 * 采集本机本地 AI 占用（显存读数 + 本地大模型服务清单）。
 * 清单里只有本地大模型服务（kind=model / unknown / protected），网关一律不列。
 * @param {{ timeoutMs?: number, probeBusy?: boolean }} [opts]
 */
export async function collectAiStatus(opts = {}) {
  const notes = []
  const gpuQuery = await queryNvidiaSmi([
    '--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu',
    '--format=csv,noheader,nounits',
  ], opts.timeoutMs)
  const appQuery = await queryNvidiaSmi([
    '--query-compute-apps=pid,process_name,used_memory',
    '--format=csv,noheader,nounits',
  ], opts.timeoutMs)

  const gpus = gpuQuery.ok ? parseGpuQuery(gpuQuery.stdout) : []
  const apps = appQuery.ok ? parseAppQuery(appQuery.stdout) : { rows: [], unnamed: 0, hasMem: false }
  if (!gpuQuery.ok) notes.push('未找到 nvidia-smi：显存读数不可用（非 NVIDIA 显卡或驱动未安装）')
  if (appQuery.ok && !apps.hasMem) {
    notes.push('当前驱动未提供逐进程显存读数（Windows WDDM 需管理员权限），清单按进程特征识别')
  }

  const table = await readProcessTable(opts.timeoutMs)
  if (!table.ok) notes.push('进程表读取失败：' + (table.reason || 'unknown'))

  const gpuPids = new Set(apps.rows.map((r) => r.pid))
  const appMem = new Map(apps.rows.map((r) => [r.pid, r.usedMiB]))

  const processes = []
  let gatewayCount = 0
  let unknownCount = 0
  let protectedHiddenCount = 0

  for (const p of table.procs) {
    const ports = table.ports.get(p.pid) || []
    const hit = classifyProcess(p.name, p.path, ports)
    const protect = protectReason(p.name, p.path)
    const onGpu = gpuPids.has(p.pid)

    // 网关：不占显存，且用户明确不要 —— 只计数，不入清单。
    if (hit && hit.kind === 'gateway' && !protect) {
      gatewayCount += 1
      continue
    }

    if (!hit) {
      // 兜底：占显存但认不出名字 —— 可能是别人装的冷门本地模型，照样列出来（可手动释放）。
      if (!onGpu || protect) continue
      const bare = String(p.name || '').toLowerCase()
      if (OTHER_GPU_EXCLUDE_RE.test(bare)) continue
      // 只是「有 GPU 上下文」的小进程（任务管理器、输入法、系统外壳）不算本地模型：
      // 本地模型服务至少要有几百 MB 常驻内存，或者自己监听端口。
      if (!(p.memMB >= 300 || ports.length > 0)) continue
      unknownCount += 1
      const rec = {
        pid: p.pid,
        name: p.name,
        kind: 'unknown',
        key: 'unknown',
        label: '未识别的本地模型',
        via: 'gpu',
        ports,
        usedMiB: appMem.get(p.pid) || 0,
        memMB: p.memMB,
        path: String(p.path || '').slice(0, 260),
        protectReason: '',
        protected: false,
        onGpu: true,
        busy: null,
        unload: { unloadKind: '', port: ports[0] || null, busy: null, detail: '' },
      }
      processes.push(rec)
      continue
    }

    // 受保护但没占显存 → 不列（省屏）。只有「占显存的受保护项」才值得列出来提醒别关。
    if (protect && !onGpu) {
      protectedHiddenCount += 1
      continue
    }

    const rec = {
      pid: p.pid,
      name: p.name,
      kind: protect ? 'protected' : hit.kind,
      key: hit.key,
      label: hit.label,
      via: hit.via,
      ports,
      usedMiB: appMem.get(p.pid) || 0,
      memMB: p.memMB,
      path: String(p.path || '').slice(0, 260),
      protectReason: protect,
      protected: Boolean(protect),
      onGpu,
      busy: null,
      unload: { unloadKind: '', port: ports[0] || null, busy: null, detail: '' },
    }
    processes.push(rec)
  }

  // 忙碌探测 & 卸载能力（只对非保护的模型服务做，串行但每个都有 1.5 s 上限）
  if (opts.probeBusy) {
    for (const rec of processes) {
      if (rec.protected || rec.kind !== 'model') continue
      try {
        const info = await detectUnload(rec)
        rec.unload = info
        rec.busy = info.busy
      } catch {
        rec.busy = null
      }
    }
  }

  processes.sort((a, b) => {
    const rank = (r) => (r.kind === 'model' ? 0 : r.kind === 'unknown' ? 1 : 2)
    const d = rank(a) - rank(b)
    if (d !== 0) return d
    if (b.onGpu !== a.onGpu) return b.onGpu ? 1 : -1
    if ((b.usedMiB || 0) !== (a.usedMiB || 0)) return (b.usedMiB || 0) - (a.usedMiB || 0)
    if ((b.memMB || 0) !== (a.memMB || 0)) return (b.memMB || 0) - (a.memMB || 0)
    return String(a.name).localeCompare(String(b.name))
  })

  const totals = gpus.reduce((acc, g) => ({
    totalMiB: acc.totalMiB + g.totalMiB,
    usedMiB: acc.usedMiB + g.usedMiB,
    freeMiB: acc.freeMiB + g.freeMiB,
  }), { totalMiB: 0, usedMiB: 0, freeMiB: 0 })

  // 与「一键释放」完全同口径：只有占显存的模型服务才算可释放（unknown 需手动点）。
  const appsKnown = appQuery.ok
  const releasable = processes.filter((p) => !p.protected && p.kind === 'model' && (!appsKnown || p.onGpu))

  if (gatewayCount > 0) {
    notes.push(`已忽略 ${gatewayCount} 个网关/额度中转进程（不占显存，本页不显示也不动）`)
  }

  // 网关是否在跑 —— 这决定「释放完下次还能不能自动用」。
  // 2026-11-25 那次事故的直接教训：网关被连带打死之后，用户完全无法从界面上看出来，
  // 只会以为「插件把本地模型弄坏了」。所以这里必须把网关状态摆到明面上。
  const liveGatewayPorts = (() => {
    const watched = [3000, 4000, 5000, 5001, 8080] // 与「模型后端」直接相关的网关端口
    if (!table.ok || !table.ports) return []
    const up = new Set()
    for (const list of table.ports.values()) {
      for (const pt of list || []) up.add(Number(pt))
    }
    return watched.filter((pt) => up.has(pt)).sort((a, b) => a - b)
  })()
  if (liveGatewayPorts.length > 0) {
    notes.push(
      `网关端口 ${liveGatewayPorts.join(' / ')} 正在监听 —— 释放模型后下次对话会自动重新加载，不需要手动启动`,
    )
  } else {
    notes.push('没有检测到本地模型网关端口在监听：释放后如果想再用本地模型，需要先手动启动对应的路由/网关脚本')
  }
  if (unknownCount > 0) {
    notes.push(`有 ${unknownCount} 个进程占着显存但认不出具体软件 —— 已列为「未识别的本地模型」，可逐行手动释放`)
  }

  return {
    ok: true,
    at: Date.now(),
    platform: process.platform,
    gpus,
    totals,
    aiUsedMiB: processes
      .filter((p) => !p.protected)
      .reduce((n, p) => n + (Number(p.usedMiB) || 0), 0),
    releasableCount: releasable.length,
    releasableUsedMiB: releasable.reduce((n, p) => n + (Number(p.usedMiB) || 0), 0),
    processes,
    unknownCount,
    protectedHiddenCount,
    gatewayCount,
    perProcessMem: Boolean(apps.hasMem),
    tools: { nvidiaSmi: gpuQuery.ok, computeApps: appQuery.ok, processTable: table.ok },
    notes,
  }
}

// --- 释放 ------------------------------------------------------------------

function summarize(status) {
  return {
    gpus: status.gpus,
    totals: status.totals,
    aiUsedMiB: status.aiUsedMiB,
    perProcessMem: Boolean(status.perProcessMem),
    releasableCount: status.releasableCount,
    processes: status.processes.map((p) => ({
      pid: p.pid,
      name: p.name,
      kind: p.kind,
      label: p.label,
      usedMiB: p.usedMiB,
      onGpu: p.onGpu,
      protected: p.protected,
    })),
  }
}

/**
 * 释放本地 AI 显存占用 —— **只处理真正占着显存的本地大模型服务**，且**优雅优先**。
 *
 * mode:
 *   'graceful'（默认）—— L1 卸载 → L2 温和关闭 → L3 强制，逐级降级
 *   'unload'          —— 只做 L1（服务一定还在，最安全）
 *   'stop'            —— 跳过 L1，直接 L2→L3（想彻底关服务时）
 *
 * 网关（tier_router / Agent2API / magpie 等）一律不参与 —— 不占显存，且下次请求
 * 会自动把模型重新拉起，正好满足「释放后下次还能用」。**网关本身绝不能杀**：
 * 杀了它没人负责重启后端，用户看到的就是「释放完再也点不出来」。
 *
 * @param {{
 *   mode?: 'graceful'|'unload'|'stop',
 *   gpuOnly?: boolean,           // 默认 true：只结束出现在 GPU 计算进程表里的模型
 *   protectPids?: Array<number|string>,
 *   settleMs?: number,           // 释放完等多久再复查显存
 *   dryRun?: boolean             // 只列候选，不动手
 * }} [opts]
 */
export async function releaseLocalAi(opts = {}) {
  const mode = String(opts.mode || 'graceful')
  const gpuOnly = opts.gpuOnly !== false
  const protectPids = new Set((opts.protectPids || []).map(Number).filter((n) => Number.isFinite(n)))
  const before = await collectAiStatus({ probeBusy: true })
  // nvidia-smi 的 compute-apps 查不到时（非 NVIDIA / 驱动受限），gpuOnly 退化为 false，
  // 否则会把所有模型服务都判成「没占显存」而一个都不释放。
  const appsKnown = Boolean(before.tools && before.tools.computeApps)

  const targets = before.processes.filter((p) => {
    if (p.protected) return false
    if (protectPids.has(p.pid)) return false
    if (p.kind !== 'model') return false          // unknown / 其他 —— 一键释放不碰
    if (gpuOnly && appsKnown && !p.onGpu) return false
    return true
  })

  const candidateList = targets.map((t) => ({
    pid: t.pid,
    name: t.name,
    kind: t.kind,
    label: t.label,
    via: t.via,
    ports: t.ports,
    usedMiB: t.usedMiB,
    onGpu: Boolean(t.onGpu),
    busy: t.busy,
    unloadKind: (t.unload && t.unload.unloadKind) || '',
  }))

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      mode,
      gpuOnly,
      appsKnown,
      freedMiB: 0,
      totalFreedMiB: 0,
      candidates: candidateList,
      results: [],
      killed: [],
      failed: [],
      before: summarize(before),
      after: summarize(before),
    }
  }

  const results = []
  for (const t of targets) {
    const r = await gracefulRelease(t, { mode })
    results.push({
      pid: t.pid,
      name: t.name,
      label: t.label,
      usedMiB: t.usedMiB,
      method: r.method,
      ok: Boolean(r.ok),
      alive: Boolean(r.alive),
      detail: r.detail || '',
      steps: r.steps || [],
    })
    if (r.ok) await sleep(200)
  }

  const killed = results.filter((r) => r.ok).map((r) => ({
    pid: r.pid, name: r.name, label: r.label, method: r.method, alive: r.alive, detail: r.detail,
  }))
  const failed = results.filter((r) => !r.ok).map((r) => ({
    pid: r.pid, name: r.name, label: r.label, method: r.method, reason: r.detail || 'unknown',
  }))

  const settleMs = Number(opts.settleMs)
  if (results.length) await sleep(Number.isFinite(settleMs) && settleMs > 0 ? settleMs : 1500)
  const after = await collectAiStatus({ probeBusy: false })
  const freedMiB = Math.max(0, (before.totals.usedMiB || 0) - (after.totals.usedMiB || 0))

  return {
    ok: true,
    dryRun: false,
    mode,
    gpuOnly,
    appsKnown,
    freedMiB,
    totalFreedMiB: Math.max(0, (before.aiUsedMiB || 0) - (after.aiUsedMiB || 0)),
    candidates: candidateList,
    results,
    killed,
    failed,
    before: summarize(before),
    after: summarize(after),
  }
}

/**
 * 结束单个进程 —— 面板上逐行的「结束」按钮（含「未识别的本地模型」）。
 * 同样是优雅优先；保护名单一律拒绝（DSH 宿主 / Electron / Fluent / Ansys / MPI / node 运行时）。
 * @param {number|string} pid
 * @param {{ mode?: 'graceful'|'stop', name?: string, label?: string, ports?: number[] }} [opts]
 */
export async function releasePid(pid, opts = {}) {
  const id = Number(pid)
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, pid: id, name: '', killed: false, method: '', reason: 'pid 非法' }
  }
  if (id === process.pid) {
    return { ok: false, pid: id, name: '', killed: false, method: '', reason: '不能结束 DSH 自身进程' }
  }
  const table = await readProcessTable(30000)
  if (!table.ok) {
    return { ok: false, pid: id, name: '', killed: false, method: '', reason: '进程表读取失败：' + (table.reason || 'unknown') }
  }
  const target = table.procs.find((p) => p.pid === id)
  if (!target) {
    return { ok: false, pid: id, name: '', killed: false, method: '', reason: '进程不存在（可能已经退出）' }
  }
  const protect = protectReason(target.name, target.path)
  if (protect) {
    return { ok: false, pid: id, name: target.name, killed: false, method: '', reason: '受保护：' + protect }
  }
  const ports = table.ports.get(id) || []
  const hit = classifyProcess(target.name, target.path, ports)
  const proc = {
    pid: id,
    name: target.name,
    label: (hit && hit.label) || String(opts.label || '未识别的本地模型'),
    ports,
    unload: { unloadKind: '', port: ports[0] || null, busy: null, detail: '' },
  }
  const r = await gracefulRelease(proc, { mode: opts.mode === 'unload' ? 'unload' : 'graceful' })
  return {
    ok: Boolean(r.ok),
    pid: id,
    name: target.name,
    killed: Boolean(r.ok) && !r.alive,
    method: r.method,
    alive: Boolean(r.alive),
    detail: r.detail || '',
    reason: r.ok ? '' : (r.detail || '释放失败'),
  }
}
