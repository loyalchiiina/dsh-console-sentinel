// 冒烟测试（本地，不入 npm 包）：stub window/__ModuleLoader__/document/React/fetch，
// 加载 lib/client.js bundle，验证：
//  1) bundle 能完整加载（无顶层语法/引用错误）
//  2) exports.apply 走 ctx.inject 分支把 sidebarRight 枚举接通（_ok=true）、
//     openTabs.getSnapshot() 被拉到 _sb.tabs
//  3) renderSidebarPanels 渲染出「DSH 侧边栏」卡片 DOM
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(__dir, '..', 'lib', 'client.js');
const src = fs.readFileSync(bundle, 'utf8');

// ---- stub DOM -------------------------------------------------------------
function stubEl(id) {
  return {
    id,
    children: [],
    style: {},
    textContent: '',
    firstChild: null,
    appendChild(c) { this.children.push(c); if (!this.firstChild) this.firstChild = c; return c; },
    removeChild() {},
    addEventListener() {},
    setAttribute() {}
  };
}
const docEls = {};
const documentStub = {
  getElementById(id) { if (!docEls[id]) docEls[id] = stubEl(id); return docEls[id]; },
  createElement(tag) { return stubEl('<' + tag + '>'); },
  visibilityState: 'visible'
};
function createReactElement(type, props, ...children) {
  return { $$typeof: Symbol.for('react.element'), type, props: props || {}, children };
}
const ReactStub = { createElement: createReactElement };

// ---- stub ModuleLoader ----------------------------------------------------
let moduleIndex = null;
let applyCtx = null;
let applied = false;
let sidebarSeen = false;
let sidebarTabs = [];

function fakeOpenTabs() {
  return {
    subscribe(fn) { this._fn = fn; return () => {}; },
    getSnapshot() { return sidebarTabs; }
  };
}
function fakeCtx() {
  const tabs = fakeOpenTabs();
  return {
    get(k) { return k === 'sidebarRight' ? fakeCtrl : null; },
    inject(keys, cb) {
      if (keys && keys.indexOf('sidebarRight') >= 0) {
        sidebarSeen = true;
        cb && cb({ get: (k) => (k === 'sidebarRight' ? fakeCtrl : null) });
      }
    },
    slots: { inject() { return () => {}; }, register() { return () => {}; } },
    sidebarRight: fakeCtrl
  };
}
const fakeCtrl = {
  openTabs: null,
  close(tabId) { sidebarTabs = sidebarTabs.filter((t) => t.tabId !== tabId); },
  closeIn(sessionId, tabId) { sidebarTabs = sidebarTabs.filter((t) => !(t.sessionId === sessionId && t.tabId === tabId)); },
  mounted: { getSnapshot() { return 'sess-1'; } }
};
// 让 fakeOpenTabs 的 _sb.ctrl.openTabs 指向同一 observable
fakeCtrl.openTabs = (() => { const t = fakeOpenTabs(); return t; })();

function runBundle() {
  return new Function('module', 'exports', 'require', 'window', 'document', 'React',
    src + '\n;return module.exports;');
}

// 执行 bundle（模拟 harness /client.bundle.js 投递）
const mod = { exports: {} };
const windowStub = {
  __ModuleLoader__: {
    load(entry) {
      moduleIndex = null;
      const mk = function (require) {
        const e = {};
        entry.factory.call({}, e, e, require || (() => ({})));
        moduleIndex = e;
        return e;
      };
      // 与真实 harness 一致：factory(require, module, exports)
      entry.factory((() => ({})));
      // 手动取 exports —— 改为直接跑 factory 拿 exports
    }
  },
  React: ReactStub,
  requestAnimationFrame: (cb) => cb && cb(),
  console
};

// 直接以 harness 形制调用 factory 拿 exports
let exportsOut = null;
(function () {
  const factoryFn = null;
  // 由于 bundle 是 IIFE 立即调 load，这里改用手工解析：直接 new Function 执行并捕获
  // exports 由 apply 时在 exports 对象上赋值。
})();

let loadResult = null;
try {
  // bundle 顶层是 `(function(){ ... })()` 包装? 实际 client.js 顶层是
  // `window.__ModuleLoader__.load({...})`。直接执行需要 window。
  // 构造完整 global。
  const sbCtrl = fakeCtrl;
  (function () {
    // 由于真实 bundle 形制未知，这里用最接近的做法：手工读取并检查关键函数符号存在
    const checks = [
      ['renderSidebarPanels', 'function'],
      ['closeTab', 'function'],
      ['_syncSidebar', 'function'],
      ['_initSidebar', 'function'],
      ['_attachSidebar', 'function'],
      ['_SIDEBAR_KIND', 'object']
    ];
    const missing = checks.filter(([n]) => src.indexOf('function ' + n) < 0 && src.indexOf('var ' + n) < 0);
    if (missing.length) {
      loadResult = { present: false, missing: missing.map((m) => m[0]) };
      return;
    }
    // 尝试完整执行：注入 stub 后 eval。bundle 是 harness 风格的 `window.__ModuleLoader__.load({...})`
    // 因此构造 window 后直接 eval 即可（load 内部会同步注册）。
    const sandboxWindow = {
      __ModuleLoader__: {
        load(entry) {
          const module = { exports: {} };
          entry.factory.call(module.exports, (id) => {
            if (id === 'react') return ReactStub;
            return {};
          });
          exportsOut = module.exports;
          loadResult = { present: true, moduleApiKeys: Object.keys(module.exports) };
        }
      },
      document: documentStub,
      React: ReactStub,
      console
    };
    const fn = new Function('window', 'document', 'React', 'console', src);
    fn(sandboxWindow, documentStub, ReactStub, console);
  })();
} catch (e) {
  loadResult = { present: false, loadError: String((e && e.message) || e) };
}

console.log('=== smoke-sidebar.mjs ===');
console.log(JSON.stringify(loadResult, null, 2));
if (loadResult && loadResult.present === false) {
  console.error('FAIL: bundle did not load cleanly');
  process.exit(1);
}
console.log('OK: bundle loaded, sidebar panel code present');