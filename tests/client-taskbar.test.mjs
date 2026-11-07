// Regression test for the taskbar panel (group-by-software UI).
//   - one checkbox per program group; icons per group
//   - checkbox disabled for system-locked (host) programs
//   - toggling a program checkbox adds it to the whitelist
//   - 「关掉该软件」posts /close-process with that program
//   - per-window「关闭」is enabled only for closable programs; elevated close
//     posts /window with elevated:true
//   - compact tab switching
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const CLIENT_URL = new URL('../lib/client.js', import.meta.url)
const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

function makeHarness() {
  const registry = {}
  const mkEl = (tag) => {
    const listeners = {}
    const e = {
      nodeType: 1, tagName: tag, id: '', type: '', title: '', placeholder: '', src: '',
      style: {}, value: '', disabled: false, checked: false, children: [], _text: '',
      appendChild(c) { this.children.push(c); return c },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c },
      addEventListener(t, f) { (listeners[t] || (listeners[t] = [])).push(f) },
      _fire(t, ev) { (listeners[t] || []).forEach((f) => f(ev || {})) },
      _hasListener(t) { return Boolean(listeners[t] && listeners[t].length) },
      get firstChild() { return this.children[0] || null },
      get textContent() { return this._text },
      set textContent(v) { this._text = v; this.children.length = 0 }
    }
    return e
  }
  const doc = {
    getElementById: (id) => registry[id] || null,
    createElement: (tag) => mkEl(tag),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), style: {} })
  }
  const React = {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      const p = Object.assign({}, props || {})
      if (children.length === 1) p.children = children[0]
      else if (children.length > 1) p.children = children
      return { type, props: p }
    }
  }
  const mount = (node, parent) => {
    if (node == null || node === false || node === true) return
    if (typeof node === 'string' || typeof node === 'number') { parent.appendChild(doc.createTextNode(node)); return }
    if (Array.isArray(node)) { for (const n of node) mount(n, parent); return }
    const el = doc.createElement(node.type)
    const p = node.props || {}
    if (p.id) { el.id = p.id; registry[p.id] = el }
    if (p.style) el.style = p.style
    if (p.type) el.type = p.type
    if (p.placeholder) el.placeholder = p.placeholder
    if (p.title) el.title = p.title
    if (typeof p.onClick === 'function') el._onClick = p.onClick
    parent.appendChild(el)
    if (p.children != null) (Array.isArray(p.children) ? p.children : [p.children]).forEach((c) => mount(c, el))
  }
  const STATUS = {
    ok: true, platform: 'win32',
    config: { enabled: true, autoAction: 'none', emptyConsoleAction: 'hide', idleThresholdSec: 180, scanIntervalSec: 10, guardForeground: true },
    counts: { total: 0, empty: 0, visibleEmpty: 0, hidden: 0 },
    windows: [], whitelist: { processes: [], titles: [] }, whitelistPath: 'C:/x.json', protectedProcesses: []
  }
  // chrome: 2 windows (grouping test) | explorer: whitelisted | taskmgr: elevated
  // Dsh Next: host-locked (system-protected) | iScrRec: elevated, closable
  const TASKBAR = {
    ok: true, selfElevated: false,
    windows: [
      { hwnd: 10, pid: 100, process: 'chrome', title: 'Chrome Tab 1', icon: ICON, whitelisted: false, hostLocked: false, elevated: false, protected: false, hardProtected: false, unprotected: false },
      { hwnd: 11, pid: 100, process: 'chrome', title: 'Chrome Tab 2', icon: ICON, whitelisted: false, hostLocked: false, elevated: false, protected: false, hardProtected: false, unprotected: false },
      { hwnd: 20, pid: 101, process: 'explorer', title: '文件资源管理器', icon: ICON, whitelisted: true, hostLocked: false, elevated: false, protected: false, hardProtected: false, unprotected: false },
      { hwnd: 30, pid: 102, process: 'taskmgr', title: '任务管理器', icon: '', whitelisted: false, hostLocked: false, elevated: true, protected: false, hardProtected: false, unprotected: false },
      { hwnd: 40, pid: 103, process: 'Dsh Next', title: 'DSH', icon: ICON, whitelisted: false, hostLocked: true, elevated: false, protected: false, hardProtected: false, unprotected: false },
      { hwnd: 50, pid: 104, process: 'iScrRec', title: 'iTop Screen Recorder', icon: ICON, whitelisted: false, hostLocked: false, elevated: true, protected: false, hardProtected: false, unprotected: false }
    ]
  }
  const calls = []
  const bodies = []
  const fetch = (url, init) => {
    calls.push(url)
    if (init && init.body) bodies.push({ url, body: init.body })
    let data = STATUS
    if (url.indexOf('/taskbar-windows') >= 0) data = TASKBAR
    else if (url.indexOf('/whitelist') >= 0) data = { ok: true, processes: ['chrome'], titles: [], unprotect: [] }
    else if (url.indexOf('/close-process') >= 0) data = { ok: true, process: 'iScrRec', total: 1, closedCount: 1, elevated: 1 }
    else if (url.indexOf('/window') >= 0) data = { ok: true, hwnd: 0, action: 'close', elevated: true, status: STATUS }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) })
  }
  return { registry, doc, React, mount, STATUS, calls, bodies, fetch, mkEl }
}

function loadBundle(h) {
  const code = fs.readFileSync(CLIENT_URL, 'utf8')
  const win = { __ModuleLoader__: { load(def) { win.__def = def } }, React: undefined, confirm: () => true }
  const queue = []
  const fakeSetTimeout = (fn) => { queue.push(fn); return queue.length }
  // The panel arms a setInterval for auto-refresh; in Node it would keep the
  // process alive forever → provide a no-op interval that records the callback.
  const intervals = []
  const fakeSetInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length }
  const fakeClearInterval = (id) => { if (id) intervals[id - 1] = null }
  const fn = new Function('window', 'document', 'fetch', 'setTimeout', 'setInterval', 'clearInterval', 'console', code)
  fn(win, h.doc, h.fetch, fakeSetTimeout, fakeSetInterval, fakeClearInterval, console)
  return { def: win.__def, queue, intervals }
}
const tick = () => new Promise((r) => setImmediate(r))

async function mountPanel(h) {
  const { def, queue } = loadBundle(h)
  const exported = def.factory((n) => ({ default: h.React }))
  let registered = null
  exported.apply({ slots: { inject(n, cb) { if (n === 'settings.section') cb() }, register(c, comp) { registered = { cfg: c, comp }; return {} } } })
  const root = h.mkEl('div')
  h.mount(registered.comp(), root)
  while (queue.length) queue.shift()()
  await tick(); await tick(); await tick()
  return root
}

// Default view is the compact icon grid → most tests want the detail view.
function switchToDetail(h) {
  const t = h.registry['dcs-taskbar-view']
  if (t && t._onClick) t._onClick()
}

function findAll(node, pred, acc) {
  acc = acc || []
  if (!node || !node.children) return acc
  for (const c of node.children) { if (pred(c)) acc.push(c); findAll(c, pred, acc) }
  return acc
}

test('one checkbox per program group + icons per group', async () => {
  const h = makeHarness()
  await mountPanel(h)
  switchToDetail(h)
  const box = h.registry['dcs-taskbar']
  assert.ok(box, 'taskbar container exists')
  const boxes = findAll(box, (n) => n.tagName === 'input' && n.type === 'checkbox')
  const imgs = findAll(box, (n) => n.tagName === 'img')
  assert.equal(boxes.length, 5, 'one checkbox per program (5 programs)')
  assert.equal(imgs.length, 4, 'icon per group that has one (taskmgr has none)')
})

test('whitelist checkbox state; host program disabled', async () => {
  const h = makeHarness()
  await mountPanel(h)
  switchToDetail(h)
  const boxes = findAll(h.registry['dcs-taskbar'], (n) => n.tagName === 'input' && n.type === 'checkbox')
  // group order: chrome, explorer, taskmgr, Dsh Next, iScrRec
  assert.equal(boxes[0].checked, false, 'chrome not whitelisted')
  assert.equal(boxes[1].checked, true, 'explorer whitelisted')
  assert.equal(boxes[3].disabled, true, 'host (Dsh Next) checkbox disabled')
  assert.equal(boxes[2].disabled, false, 'taskmgr (admin) checkbox enabled')
})

test('toggling a program checkbox adds it to whitelist', async () => {
  const h = makeHarness()
  await mountPanel(h)
  switchToDetail(h)
  const boxes = findAll(h.registry['dcs-taskbar'], (n) => n.tagName === 'input' && n.type === 'checkbox')
  boxes[0].checked = true
  boxes[0]._fire('change')
  await tick(); await tick()
  const post = h.bodies.find((b) => b.url.indexOf('/whitelist') >= 0)
  assert.ok(post)
  const p = JSON.parse(post.body)
  assert.equal(p.action, 'add')
  assert.equal(p.kind, 'process')
  assert.deepEqual(p.items, ['chrome'])
})

test('关掉该软件 posts /close-process for the right program', async () => {
  const h = makeHarness()
  await mountPanel(h)
  switchToDetail(h)
  const box = h.registry['dcs-taskbar']
  const btns = findAll(box, (n) => n.tagName === 'button' && String(n._text || '').indexOf('关掉该软件') === 0)
  // closable programs: chrome, taskmgr, iScrRec (explorer=whitelist, Dsh=host excluded)
  assert.equal(btns.length, 3, 'only closable programs get 关掉该软件')
  btns[2]._fire('click') // iScrRec (last of the closable set in DOM order)
  await tick(); await tick()
  const post = h.bodies.find((b) => b.url.indexOf('/close-process') >= 0)
  assert.ok(post)
  assert.equal(JSON.parse(post.body).process, 'iScrRec')
})

test('per-window 关闭 enabled only for closable programs; elevated close posts elevated:true', async () => {
  const h = makeHarness()
  await mountPanel(h)
  switchToDetail(h)
  const box = h.registry['dcs-taskbar']
  const closeBtns = findAll(box, (n) => n.tagName === 'button' && n._text === '关闭')
  // 6 windows total (chrome x2, explorer, taskmgr, dsh, iScrRec)
  assert.equal(closeBtns.length, 6, 'one 关闭 per window')
  // explorer (whitelisted) + Dsh (host) must be ineffective (no click listener)
  const closedWithListeners = closeBtns.filter((b) => b._hasListener('click'))
  assert.equal(closedWithListeners.length, 4, 'enabled close buttons = chrome x2 + taskmgr + iScrRec')
  // last window = iScrRec (elevated); clicking posts /window with elevated + process
  closeBtns[closeBtns.length - 1]._fire('click')
  await tick(); await tick()
  const post = h.bodies.find((b) => b.url.indexOf('/window') >= 0)
  assert.ok(post, 'window close posted')
  const p = JSON.parse(post.body)
  assert.equal(p.action, 'close')
  assert.equal(p.elevated, true, 'elevated window closes via elevated path')
  assert.equal(p.process, 'iScrRec')
})

test('compact UI: tabs switch panels', async () => {
  const h = makeHarness()
  await mountPanel(h)
  assert.equal(h.registry['dcs-panel-taskbar'].style.display, 'block', 'taskbar default')
  assert.equal(h.registry['dcs-panel-console'].style.display, 'none')
  h.registry['dcs-tab-console']._onClick()
  assert.equal(h.registry['dcs-panel-console'].style.display, 'block')
  assert.equal(h.registry['dcs-panel-taskbar'].style.display, 'none')
})

test('icon grid is the DEFAULT view', async () => {
  const h = makeHarness()
  await mountPanel(h)
  const box = h.registry['dcs-taskbar']
  const imgs = findAll(box, (n) => n.tagName === 'img')
  const boxes = findAll(box, (n) => n.tagName === 'input' && n.type === 'checkbox')
  assert.ok(imgs.length >= 5, '默认渲染图标（每个窗口一个）')
  assert.equal(boxes.length, 0, '默认视图没有复选框（图标网格）')
  assert.equal(h.registry['dcs-taskbar-view']._text, '详细视图', '按钮提示可切到详细视图')
})

test('icon-only view toggle collapses groups into an icon grid', async () => {
  const h = makeHarness()
  await mountPanel(h)
  const toggle = h.registry['dcs-taskbar-view']
  assert.ok(toggle, 'view toggle button exists')
  // 默认已是图标视图 → 先切到详细
  toggle._onClick()
  let boxes = findAll(h.registry['dcs-taskbar'], (n) => n.tagName === 'input' && n.type === 'checkbox')
  assert.ok(boxes.length > 0, 'detail mode has checkboxes')
  assert.equal(toggle._text, '仅图标视图', 'button label flips to 仅图标视图')
  // 再切回图标视图
  toggle._onClick()
  boxes = findAll(h.registry['dcs-taskbar'], (n) => n.tagName === 'input' && n.type === 'checkbox')
  assert.equal(boxes.length, 0, 'icon mode has no checkboxes')
  const imgs = findAll(h.registry['dcs-taskbar'], (n) => n.tagName === 'img')
  assert.ok(imgs.length >= 5, 'icon mode renders one icon per window')
})


