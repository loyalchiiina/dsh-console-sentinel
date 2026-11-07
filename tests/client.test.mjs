// Regression test for the client half (lib/client.js).
//
// node --check only proves the bundle parses; it cannot catch a broken
// registration, a wrong bundle id, or DOM writes that never happen. This test
// evaluates the real bundle against a tiny DOM stub and asserts the observable
// contract:
//   - __ModuleLoader__.load id === package name
//   - exports.inject is a plain array (a function form silently disables slots)
//   - settings.section is registered with the right id/name
//   - first mount fetches /status and paints counts / window rows / whitelist chips
//   - a card button issues the expected host route call
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const CLIENT_URL = new URL('../lib/client.js', import.meta.url)

function makeHarness() {
  const registry = {}
  const mkEl = (tag) => {
    const e = {
      nodeType: 1, tagName: tag, id: '', type: '', title: '', placeholder: '',
      style: {}, value: '', disabled: false, children: [], _text: '', _onClick: null,
      appendChild(c) { this.children.push(c); return c },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c },
      addEventListener(t, f) { if (t === 'click') this._onClick = f },
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
    counts: { total: 9, empty: 1, visibleEmpty: 0, hidden: 2 },
    windows: [
      { hwnd: 111, pid: 30632, processName: 'powershell', title: 'Windows PowerShell', source: 'orphaned', visible: false, cpuPct: 0, idleSec: 300, childCount: 1, isEmpty: true, hidden: false },
      { hwnd: 222, pid: 999, processName: 'mpiexec', title: 'MPI run', source: 'orphaned', visible: false, cpuPct: 50, idleSec: 0, childCount: 0, isEmpty: false, hidden: false }
    ],
    whitelist: { processes: ['chrome', 'code'], titles: ['记事本'] },
    whitelistPath: 'C:/x/whitelist.json', protectedProcesses: ['explorer']
  }
  const calls = []
  const fetch = (url) => {
    calls.push(url)
    let data = STATUS
    if (url.indexOf('/hide-empty') >= 0) data = { ok: true, hidden: 1, status: STATUS }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) })
  }
  return { registry, doc, React, mount, STATUS, calls, fetch, mkEl }
}

function loadBundle(h) {
  const code = fs.readFileSync(CLIENT_URL, 'utf8')
  const win = { __ModuleLoader__: { load(def) { win.__def = def } }, React: undefined, confirm: () => true }
  const queue = []
  const fakeSetTimeout = (fn) => { queue.push(fn); return queue.length }
  const requireFn = (name) => { if (name === 'react') return { default: h.React }; throw new Error('no module ' + name) }
  // The panel arms a setInterval for auto-refresh; without a stub Node would
  // never exit. Record it instead of scheduling.
  const intervals = []
  const fakeSetInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length }
  const fakeClearInterval = (id) => { if (id) intervals[id - 1] = null }
  const fn = new Function('window', 'document', 'fetch', 'setTimeout', 'setInterval', 'clearInterval', 'console', code)
  fn(win, h.doc, h.fetch, fakeSetTimeout, fakeSetInterval, fakeClearInterval, console)
  return { def: win.__def, queue, intervals }
}

const tick = () => new Promise((r) => setImmediate(r))

test('bundle id equals package name', () => {
  const h = makeHarness()
  const { def } = loadBundle(h)
  assert.equal(def.id, 'dsh-console-sentinel')
})

test('settings.section.icon id MUST equal settings.section id (else host keeps the default gear)', () => {
  const h = makeHarness()
  const { def } = loadBundle(h)
  const exported = def.factory((n) => ({ default: h.React }))
  const regs = []
  exported.apply({
    slots: {
      inject(name, cb) { cb() },
      register(cfg, comp) { regs.push({ cfg, comp }); return {} }
    }
  })
  const section = regs.find((r) => r.cfg.name === 'settings.section')
  const icon = regs.find((r) => r.cfg.name === 'settings.section.icon')
  assert.ok(section, 'settings.section registered')
  assert.ok(icon, 'settings.section.icon registered (without it the host shows the default gear)')
  assert.equal(icon.cfg.id, section.cfg.id, 'icon id must EXACTLY equal the section id')
})

test('exports.inject is a plain array including slots', () => {
  const h = makeHarness()
  const { def } = loadBundle(h)
  const exported = def.factory((n) => ({ default: h.React }))
  assert.ok(Array.isArray(exported.inject))
  assert.ok(exported.inject.includes('slots'))
})

test('registers settings.section and paints first load', async () => {
  const h = makeHarness()
  const { def, queue } = loadBundle(h)
  const exported = def.factory((n) => ({ default: h.React }))
  let registered = null
  exported.apply({
    slots: {
      inject(name, cb) { if (name === 'settings.section') cb() },
      register(cfg, comp) { registered = { cfg, comp }; return {} }
    }
  })
  assert.ok(registered)
  assert.equal(registered.cfg.id, 'dsh-console-sentinel')
  assert.equal(registered.cfg.name, 'settings.section')

  const root = h.mkEl('div')
  h.mount(registered.comp(), root)
  while (queue.length) queue.shift()()
  await tick(); await tick()

  assert.equal(h.registry['dcs-counts'].children.length, 4)
  assert.ok(h.registry['dcs-platform'].textContent.includes('Windows'))
  assert.equal(h.registry['dcs-windows'].children.length, 2)
  assert.equal(h.registry['dcs-wl-proc'].children.length, 2)
  assert.equal(h.registry['dcs-wl-title'].children.length, 1)
  assert.ok(h.calls.some((u) => u.includes('/dsh-console-sentinel/status')))
})

test('card button issues host route call', async () => {
  const h = makeHarness()
  const { def, queue } = loadBundle(h)
  const exported = def.factory((n) => ({ default: h.React }))
  let registered = null
  exported.apply({ slots: { inject(n, cb) { if (n === 'settings.section') cb() }, register(c, comp) { registered = { cfg: c, comp }; return {} } } })
  const root = h.mkEl('div')
  h.mount(registered.comp(), root)
  while (queue.length) queue.shift()()
  await tick(); await tick()

  const textOf = (n) => n._text || (n.children || []).map((c) => c.textContent || '').join('')
  let hideBtn = null
  ;(function walk(n) {
    if (!n || !n.children) return
    for (const c of n.children) {
      if (c.tagName === 'button' && textOf(c).includes('隐藏可见空壳')) hideBtn = c
      walk(c)
    }
  })(root)
  assert.ok(hideBtn, 'hide-empty button should exist')
  hideBtn._onClick({ preventDefault() {} })
  await tick(); await tick()
  assert.ok(h.calls.some((u) => u.includes('/hide-empty')))
})

test('关闭空壳窗口 button issues /close-empty (not hide)', async () => {  const h = makeHarness()
  const { def, queue } = loadBundle(h)
  const exported = def.factory((n) => ({ default: h.React }))
  let registered = null
  exported.apply({ slots: { inject(n, cb) { if (n === 'settings.section') cb() }, register(c, comp) { registered = { cfg: c, comp }; return {} } } })
  const root = h.mkEl('div')
  h.mount(registered.comp(), root)
  while (queue.length) queue.shift()()
  await tick(); await tick()
  const textOf = (n) => n._text || (n.children || []).map((c) => c.textContent || '').join('')
  let closeBtn = null
  ;(function walk(n) {
    if (!n || !n.children) return
    for (const c of n.children) {
      if (c.tagName === 'button' && textOf(c).includes('关闭空壳窗口')) closeBtn = c
      walk(c)
    }
  })(root)
  assert.ok(closeBtn, '关闭空壳窗口 button should exist')
  closeBtn._onClick({ preventDefault() {} })
  await tick(); await tick()
  assert.ok(h.calls.some((u) => u.includes('/close-empty')), 'close-empty route called')
})

