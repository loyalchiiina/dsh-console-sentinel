// dsh-console-sentinel - client half (DSH settings section).
//
// Built as a browser bundle on purpose (no build step): the harness injects this
// file into the page, and the top-level __ModuleLoader__.load call is the
// contract (id must equal the package name).
//
// Shape rules (paid for on this machine, see dsh-voice-alert):
//   1. exports.inject must be a PLAIN ARRAY - a function form silently skips the
//      client-side service injection and ctx.slots never appears;
//   2. ctx.slots.inject("settings.section", ...) is called DIRECTLY (no ctx.effect
//      wrapper) - wrapping it releases the registration on hot reload and the
//      section "shows up once and disappears";
//   3. the component uses NO React hooks - results are written back into the DOM
//      by id so a host re-render of the slot cannot strand stale UI;
//   4. React comes from require("react") with a window.React fallback.
//
// The data channel is the plugin's own host routes (/dsh-console-sentinel/*).
// On DSH Desktop an ordinary local request is 403 (the shell's browser-access
// fence), but the Electron renderer carries the capability header automatically,
// so fetch() from this section passes - that is why the UI lives here.

// 🔴 Double-injection guard (2026-11-08): the harness delivers this bundle twice —
// once through the client module graph and once through the plugin's own
// /client.bundle.js fallback route (index-inject). Both call __ModuleLoader__.load
// with the same id, which makes the loader throw
//   "client-modules: duplicate factory registration for dsh-console-sentinel
//    (bundle executed twice without invalidate?)"
// and log a scary error on every page load. Guard at the LOAD level (the old
// __DCS_APPLIED__ flag only guarded apply(), i.e. too late).
try {
  if (window.__DCS_MODULE_LOADED__) {
    // already registered in this page lifetime — skip the second execution
  } else {
    window.__DCS_MODULE_LOADED__ = true;
    window.__ModuleLoader__.load({
  id: "dsh-console-sentinel",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var BASE = "/dsh-console-sentinel";

    // React: prefer require(), fall back to the global the host may expose.
    var React = null;
    try {
      var reactMod = require("react");
      React = (reactMod && reactMod.default) || reactMod;
    } catch (e) {}
    if (!React) {
      try { React = window.React || null; } catch (e2) {}
    }

    // Host design tokens - styles must use --dsw-alias-* only.
    var TOKEN = {
      text: "var(--dsw-alias-label-primary, #1f2328)",
      textDim: "var(--dsw-alias-label-secondary, #6a737d)",
      bgInput: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))",
      bgCard: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
      bgCardSoft: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.10))",
      bgControl: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16))",
      bgControlHover: "var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.24))",
      borderSoft: "var(--dsw-alias-border-l2, rgba(127,127,127,.18))",
      border: "var(--dsw-alias-border-l3, rgba(127,127,127,.28))",
      accent: "var(--dsw-alias-brand-primary, #1f6feb)",
      accentText: "var(--dsw-alias-label-primary-foreground, #ffffff)",
      success: "color-mix(in srgb, var(--dsw-alias-state-success-primary, #1a7f37) 72%, var(--dsw-alias-label-primary, #1f2328))",
      danger: "var(--dsw-alias-state-error-primary, #cf222e)"
    };

    var S = {
      card: {
        background: TOKEN.bgCard,
        border: "1px solid " + TOKEN.borderSoft,
        borderRadius: "10px",
        padding: "11px 13px",
        marginBottom: "8px",
        color: TOKEN.text,
        fontSize: "13px",
        lineHeight: 1.45
      },
      cardHead: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        marginBottom: "8px"
      },
      title: {
        fontSize: "14px",
        fontWeight: 600,
        color: TOKEN.text
      },
      muted: { color: TOKEN.textDim, fontSize: "12px" },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "12px" },
      btn: {
        appearance: "none",
        border: "1px solid " + TOKEN.border,
        background: TOKEN.bgControl,
        color: TOKEN.text,
        borderRadius: "8px",
        padding: "4px 9px",
        fontSize: "12px",
        cursor: "pointer",
        lineHeight: 1.3
      },
      btnPrimary: {
        appearance: "none",
        border: "1px solid " + TOKEN.accent,
        background: TOKEN.accent,
        color: TOKEN.accentText,
        borderRadius: "8px",
        padding: "4px 9px",
        fontSize: "12px",
        fontWeight: 600,
        cursor: "pointer",
        lineHeight: 1.3
      },
      btnDanger: {
        appearance: "none",
        border: "1px solid " + TOKEN.danger,
        background: "transparent",
        color: TOKEN.danger,
        borderRadius: "8px",
        padding: "4px 9px",
        fontSize: "12px",
        cursor: "pointer",
        lineHeight: 1.3
      },
      input: {
        boxSizing: "border-box",
        background: TOKEN.bgInput,
        border: "1px solid " + TOKEN.borderSoft,
        color: TOKEN.text,
        borderRadius: "8px",
        padding: "6px 9px",
        fontSize: "12px",
        outline: "none",
        minWidth: "120px"
      },
      chip: {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        background: TOKEN.bgCardSoft,
        border: "1px solid " + TOKEN.borderSoft,
        borderRadius: "999px",
        padding: "2px 4px 2px 9px",
        margin: "0 6px 6px 0",
        fontSize: "12px",
        color: TOKEN.text
      },
      chipX: {
        appearance: "none",
        border: "none",
        background: "transparent",
        color: TOKEN.textDim,
        cursor: "pointer",
        fontSize: "13px",
        lineHeight: 1,
        padding: "0 4px"
      },
      rowLine: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        padding: "5px 0",
        borderBottom: "1px solid " + TOKEN.borderSoft
      }
    };

    var cache = {
      status: null,
      loading: false,
      busy: false,
      message: "",
      tone: "muted",
      desktop: null,
      taskbar: null,
      taskbarLoading: false,
      taskbarQueued: false,
      taskbarView: "icon",  // "icon" (compact icon grid, DEFAULT) | "detail" (grouped cards)
      autoTimer: null,
      visHooked: false
    };

    // 「未关闭窗口」红框卡片：明细行默认收起，只显示标题行 + 全部关闭。
    // 模块级状态，跨 renderOpenWindows 重渲染保持（不随 refreshAll 重置）。
    var _owCollapsed = true;
    // 「全部关闭」批量进度：{ done, total }；null = 当前没有进行中的批量关闭。
    var _owProg = null;

    // ── DSH 原生右侧边栏面板枚举状态 ──────────────────────────────────
    // 经宿主 API `ctx.sidebarRight.openTabs`(Observable) 读取「当前已打开的面板
    // (openTab)」，不能靠 querySelector 摸宿主侧栏 DOM（renderer 摸不到）。
    // 面板记录只有 kind/sessionId/tabId，无人类标题 → 展示层用 _SIDEBAR_KIND 映射。
    var _sb = {
      ctrl: null,        // visible controller face (ctx.get('sidebarRight'))
      tabs: [],          // [{sessionId, tabId, kind}] —— 全部会话累积的 openTab 记录
      mounted: undefined, // 当前挂载会话 id（右侧边栏正在显示哪一个会话的面板）
      ok: false,         // sidebarRight 可用（宿主 0.1.7+ 才有 openTabs/mounted）
      collapsed: true,   // 面板列表默认折叠，点标题展开
      err: ""            // 探测失败原因（供界面提示）
    };
    // 常见 DSH 侧边栏面板 kind → 中文显示名。未知 kind 回退原样显示。
    var _SIDEBAR_KIND = {
      files: "文件", terminal: "终端", git: "Git", gitgraph: "Git 图",
      markdown: "Markdown 预览", preview: "预览", search: "搜索",
      sessions: "会话", session: "会话", thread: "消息", chat: "对话",
      context: "上下文", diagnostics: "诊断", mediaplayer: "媒体播放器",
      media: "媒体", artifact: "文件", "dsh-resource": "文件", resource: "文件",
      browser: "浏览器", webview: "网页", docs: "文档", notebook: "笔记",
      calendar: "日历", todo: "待办", tasks: "任务", notes: "笔记",
      settings: "设置", person: "个人信息", mediaPlayer: "媒体播放器"
    };
    function _sbKindName(kind) {
      var k = String(kind || "?").toLowerCase();
      return _SIDEBAR_KIND[k] || k;
    }

    function el(id) {
      try { return document.getElementById(id); } catch (e) { return null; }
    }
    function setText(id, value) {
      var node = el(id);
      if (node) node.textContent = value == null ? "" : String(value);
    }
    function clear(node) {
      if (!node) return;
      while (node.firstChild) node.removeChild(node.firstChild);
    }
    function mk(tag, style, text) {
      var node = document.createElement(tag);
      if (style) {
        for (var k in style) {
          if (Object.prototype.hasOwnProperty.call(style, k)) node.style[k] = style[k];
        }
      }
      if (text != null) node.textContent = String(text);
      return node;
    }

    function setStatus(message, tone) {
      cache.message = message || "";
      cache.tone = tone || "muted";
      var node = el("dcs-status");
      if (!node) return;
      node.textContent = cache.message;
      try {
        node.style.color = cache.tone === "error" ? TOKEN.danger
          : cache.tone === "ok" ? TOKEN.success
          : TOKEN.textDim;
      } catch (e) {}
    }

    function api(path, options) {
      var init = options || {};
      init.headers = Object.assign({ "content-type": "application/json" }, init.headers || {});
      return fetch(BASE + path, init).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok) throw new Error((body && body.reason) || ("HTTP " + response.status));
          return body;
        });
      });
    }

    // ---- load + render -------------------------------------------------------

    function loadStatus(silent) {
      if (cache.loading) return;
      cache.loading = true;
      if (!silent) setStatus("正在读取…", "muted");
      api("/status").then(function (body) {
        cache.status = body;
        cache.loading = false;
        if (!silent) setStatus("已刷新 · " + new Date().toLocaleTimeString(), "muted");
        renderAll();
      }).catch(function (error) {
        cache.loading = false;
        setStatus("读取失败：" + (error && error.message ? error.message : error), "error");
      });
    }

    function applyStatus(body) {
      if (body && body.status) cache.status = body.status;
      renderAll();
    }

    function renderAll() {
      renderHeader();
      renderOpenWindows();
      renderSidebarPanels();
      renderCounts();
      renderWindows();
      renderWhitelist();
      renderDesktopResult();
      renderTaskbar();
    }

    // One refresh for everything: status/counts (via /status) AND the taskbar
    // window list (via /taskbar-windows). Replaces the old separate "刷新" +
    // "刷新任务栏" pair that confused users.
    function refreshAll() {
      setStatus("正在刷新…", "muted");
      loadStatus();
      loadTaskbar({ silent: true });
    }

    // ---- compact tab switching (任务栏 / 控制台 / 白名单) --------------------
    var TAB = { active: "taskbar" };
    function setActiveTab(name) {
      TAB.active = name;
      var panels = { taskbar: "dcs-panel-taskbar", console: "dcs-panel-console", whitelist: "dcs-panel-whitelist" };
      for (var k in panels) {
        if (!panels.hasOwnProperty(k)) continue;
        var p = el(panels[k]);
        if (p) p.style.display = (k === name) ? "block" : "none";
      }
      var tabs = { taskbar: "dcs-tab-taskbar", console: "dcs-tab-console", whitelist: "dcs-tab-whitelist" };
      for (var j in tabs) {
        if (!tabs.hasOwnProperty(j)) continue;
        var b = el(tabs[j]);
        if (b) {
          var on = (j === name);
          b.style.color = on ? TOKEN.accent : TOKEN.textDim;
          b.style.borderBottom = "2px solid " + (on ? TOKEN.accent : "transparent");
          b.style.fontWeight = on ? 600 : 500;
        }
      }
    }

    // ---- taskbar window whitelist (icon + checkbox list) --------------------

    // Queue-safe loader: if a load is in flight, remember that another is needed
    // and run it as soon as the current one finishes (a plain early `return`
    // used to silently DROP the refresh after closing windows → list looked stale).
    function loadTaskbar(opts) {
      opts = opts || {};
      if (cache.taskbarLoading) { cache.taskbarQueued = true; return; }
      cache.taskbarLoading = true;
      if (!opts.silent) {
        var box0 = el("dcs-taskbar");
        if (box0 && !(cache.taskbar && cache.taskbar.windows && cache.taskbar.windows.length)) {
          clear(box0); box0.appendChild(mk("div", S.muted, "正在读取任务栏窗口…"));
        }
      }
      api("/taskbar-windows").then(function (body) {
        cache.taskbar = body && body.ok ? body : { ok: false, reason: (body && body.reason) || "读取失败", windows: [] };
      }).catch(function (error) {
        cache.taskbar = { ok: false, reason: (error && error.message ? error.message : String(error)), windows: [] };
      }).then(function () {
        cache.taskbarLoading = false;
        renderTaskbar();
        if (cache.taskbarQueued) { cache.taskbarQueued = false; loadTaskbar({ silent: true }); }
      });
    }

    // Optimistically drop windows from the cached taskbar list so the UI updates
    // the instant a close action returns, before the real refresh reconciles.
    function pruneTaskbar(pred) {
      if (!cache.taskbar || !cache.taskbar.windows) return;
      var before = cache.taskbar.windows.length;
      cache.taskbar.windows = cache.taskbar.windows.filter(function (w) { return !pred(w); });
      if (cache.taskbar.windows.length !== before) renderTaskbar();
    }

    // One call after any mutating action: optimistic prune + refresh counters +
    // refresh the taskbar list (queue-safe). Fixes "关了却不更新".
    function afterMutation(opt) {
      opt = opt || {};
      var rmHwnds = (opt.removeHwnds || []).map(Number);
      var rmProc = String(opt.removeProcess || "").toLowerCase();
      if (rmHwnds.length || rmProc) {
        pruneTaskbar(function (w) {
          if (rmHwnds.length && rmHwnds.indexOf(Number(w.hwnd)) >= 0) return true;
          if (rmProc && String(w.process || "").toLowerCase().replace(/\.exe$/, "") === rmProc.replace(/\.exe$/, "")) return true;
          return false;
        });
      }
      loadStatus(true);
      loadTaskbar({ silent: true });
    }

    function iconImg(icon, label) {
      if (icon && typeof icon === "string" && icon.indexOf("data:image") === 0) {
        var img = document.createElement("img");
        img.src = icon;
        img.alt = label || "";
        img.style.width = "18px";
        img.style.height = "18px";
        img.style.flex = "0 0 auto";
        img.style.objectFit = "contain";
        img.style.borderRadius = "3px";
        return img;
      }
      // Fallback: a small neutral placeholder block keeps rows aligned.
      var ph = mk("span", {
        display: "inline-block", width: "18px", height: "18px", flex: "0 0 auto",
        borderRadius: "3px", background: TOKEN.bgCardSoft,
        border: "1px solid " + TOKEN.borderSoft
      });
      return ph;
    }

    function _badge(text, color, dashed) {
      return mk("span", {
        fontSize: "10.5px", fontWeight: "600", color: color,
        border: (dashed ? "1px dashed " : "1px solid ") + color,
        borderRadius: "6px", padding: "0 5px", whiteSpace: "nowrap", flex: "0 0 auto"
      }, text);
    }

    // System-level protection: host + compute jobs. These can NEVER be closed
    // from the panel (closing them kills the harness or an in-progress Fluent run).
    function isSystemLocked(proc, hostLocked) {
      if (hostLocked) return true;
      return /^dsh|electron|deepseek|mpi|fluent|ansys|^cx\d|solver|cae|launcher/i.test(String(proc || ""));
    }

    function toggleTaskbarView() {
      cache.taskbarView = cache.taskbarView === "icon" ? "detail" : "icon";
      renderTaskbar();
    }

    function renderTaskbar() {
      var box = el("dcs-taskbar");
      if (!box) return;
      clear(box);
      var vb = el("dcs-taskbar-view");
      if (vb) vb.textContent = cache.taskbarView === "icon" ? "详细视图" : "仅图标视图";      var data = cache.taskbar;
      if (!data) { box.appendChild(mk("div", S.muted, "读取中…")); return; }
      if (!data.ok) {
        box.appendChild(mk("div", { fontSize: "12px", color: TOKEN.danger, padding: "4px 0" },
          "读取任务栏失败：" + (data.reason || "未知")));
        return;
      }
      var list = data.windows || [];
      if (!list.length) { box.appendChild(mk("div", S.muted, "任务栏上没有可列出的窗口。")); return; }

      // ---- Icon-only mode: a compact grid, one icon per window, row by row ----
      if (cache.taskbarView === "icon") {
        var grid = mk("div", { display: "flex", flexWrap: "wrap", gap: "6px", alignContent: "flex-start" });
        for (var k = 0; k < list.length; k++) {
          (function (w) {
            var sysLocked = isSystemLocked(w.process, w.hostLocked);
            var closable = !w.whitelisted && !sysLocked;
            var cell = mk("div", {
              display: "flex", alignItems: "center", justifyContent: "center",
              width: "30px", height: "30px", borderRadius: "8px",
              border: "1px solid " + (closable ? TOKEN.borderSoft : TOKEN.borderSoft),
              background: TOKEN.bgCardSoft,
              opacity: closable ? "1" : "0.45",
              cursor: closable ? "pointer" : "default", flex: "0 0 auto",
              position: "relative"
            });
            var ic = iconImg(w.icon, w.process);
            ic.style.width = "20px"; ic.style.height = "20px";
            cell.appendChild(ic);
            cell.title = (w.process || "?") + (w.title ? (" — " + w.title) : "") +
              (closable ? "（点击图标关闭此窗口；右上角 × 也可关闭）" : (w.whitelisted ? "（白名单，不可关闭）" : "（系统保护，不可关闭）"));
            if (closable) {
              cell.addEventListener("click", function (ev) {
                try { ev.preventDefault(); } catch (e) {}
                doWindow(w.hwnd, "close", Boolean(w.elevated), w.process);
              });
            }
            // 右上角红色小 X —— 只对可关闭（非白名单 + 非系统保护）的窗口显示，
            // 点击是「仅关闭这一个窗口」，与「点击图标切到该窗口/关闭」区分开。
            if (closable) {
              var xBadge = mk("div", {
                position: "absolute", top: "-4px", right: "-4px",
                width: "14px", height: "14px", borderRadius: "50%",
                background: "var(--dsw-alias-danger,#e5484d)",
                color: "#fff", fontSize: "10px", lineHeight: "14px",
                textAlign: "center", cursor: "pointer", zIndex: 2,
                fontStyle: "normal", fontWeight: 700, userSelect: "none"
              }, "×");
              xBadge.title = "关闭此窗口";
              xBadge.addEventListener("click", function (ev) {
                try { ev.preventDefault(); } catch (e) {}
                try { ev.stopPropagation(); } catch (e2) {}
                doWindow(w.hwnd, "close", Boolean(w.elevated), w.process);
              });
              cell.appendChild(xBadge);
            }
            grid.appendChild(cell);
          })(list[k]);
        }
        box.appendChild(grid);
        return;
      }

      // Group by software (process). Same process → same pid / protection / elevation.
      var order = [];
      var groups = {};
      for (var i = 0; i < list.length; i++) {
        var w = list[i];
        var key = String(w.process || "?").toLowerCase().replace(/\.exe$/, "");
        if (!groups[key]) { groups[key] = { key: key, meta: w, windows: [] }; order.push(key); }
        groups[key].windows.push(w);
      }

      for (var gi = 0; gi < order.length; gi++) {
        (function () {
          var g = groups[order[gi]];
          var m = g.meta;
          var proc = m.process || "?";
          var pid = m.pid;
          var wl = Boolean(m.whitelisted);
          var sysLocked = isSystemLocked(proc, Boolean(m.hostLocked));
          var elevated = Boolean(m.elevated);
          var closable = !wl && !sysLocked;   // only these can be closed
          var n = g.windows.length;

          var card = mk("div", {
            border: "1px solid " + TOKEN.borderSoft, borderRadius: "8px",
            background: TOKEN.bgCardSoft, padding: "7px 9px", marginBottom: "7px"
          });

          // ---- group header ----
          var head = mk("div", { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" });

          var cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = wl;
          cb.disabled = sysLocked;
          cb.title = sysLocked ? "系统保护程序，不可加入白名单" : "勾选=加入白名单（该软件永不被关闭）";
          cb.style.flex = "0 0 auto";
          cb.style.cursor = sysLocked ? "default" : "pointer";
          (function (el2, procName, locked) {
            el2.addEventListener("change", function () {
              if (locked) return;
              setTaskbarWhitelist(procName, "", el2.checked);
            });
          })(cb, proc, sysLocked);
          head.appendChild(cb);
          head.appendChild(iconImg(m.icon, proc));

          var nameWrap = mk("div", { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", minWidth: "0" });
          nameWrap.appendChild(mk("span", { fontSize: "13px", fontWeight: 600, color: TOKEN.text },
            proc + (pid ? "  (pid " + pid + ")" : "")));
          if (n > 1) nameWrap.appendChild(mk("span", Object.assign({}, S.muted, { fontSize: "11px" }), "· " + n + " 个窗口"));
          if (wl) nameWrap.appendChild(_badge("白名单", TOKEN.success, false));
          if (sysLocked) nameWrap.appendChild(_badge("系统保护", TOKEN.danger, false));
          if (elevated && !sysLocked) nameWrap.appendChild(_badge("管理员", TOKEN.textDim, true));
          head.appendChild(nameWrap);

          var acts = mk("div", { display: "flex", gap: "6px", alignItems: "center", marginLeft: "auto", flex: "0 0 auto" });
          if (closable) {
            (function (procName, cnt) {
              acts.appendChild(button("关掉该软件" + (cnt > 1 ? ("(" + cnt + ")") : ""), S.btn, function () { closeSoftware(procName, cnt); }));
            })(proc, n);
          }
          head.appendChild(acts);
          card.appendChild(head);

          // ---- per-window rows, each with its own 关闭 button ----
          var winsBox = mk("div", { marginTop: "5px", paddingLeft: "22px", display: "flex", flexDirection: "column", gap: "2px" });
          for (var wi = 0; wi < g.windows.length; wi++) {
            (function (winRow) {
              var line = mk("div", { display: "flex", alignItems: "center", gap: "6px" });
              line.appendChild(mk("span", { color: TOKEN.textDim, flex: "0 0 auto", fontSize: "12px" }, "•"));
              line.appendChild(mk("span", {
                fontSize: "11.5px", color: TOKEN.textDim, minWidth: "0", flex: "1 1 auto",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
              }, winRow.title ? String(winRow.title) : "(无标题)"));
              // 关闭此窗口: disabled (ineffective) when whitelisted or system-protected.
              var closeBtn = mk("button", {
                appearance: "none", border: "1px solid " + (closable ? TOKEN.border : TOKEN.borderSoft),
                background: "transparent", color: closable ? TOKEN.text : TOKEN.textDim,
                borderRadius: "6px", padding: "1px 8px", fontSize: "11px",
                flex: "0 0 auto", cursor: closable ? "pointer" : "not-allowed",
                opacity: closable ? "1" : "0.45"
              }, "关闭");
              closeBtn.type = "button";
              if (closable) {
                closeBtn.title = elevated ? "关闭此窗口（管理员窗口会弹一次 UAC）" : "关闭此窗口（优雅关闭，等同 Alt+F4）";
                closeBtn.addEventListener("click", function (ev) {
                  try { ev.preventDefault(); } catch (e) {}
                  doWindow(winRow.hwnd, "close", elevated, proc);
                });
              } else {
                closeBtn.title = wl ? "白名单程序，关闭无效" : "系统保护程序，关闭无效";
              }
              line.appendChild(closeBtn);
              winsBox.appendChild(line);
            })(g.windows[wi]);
          }
          card.appendChild(winsBox);
          box.appendChild(card);
        })();
      }
    }

    // 取消 / 恢复 内置保护（写入持久 whitelist.unprotect 列表）
    function setTaskbarProtection(proc, lift) {
      var name = String(proc || "").trim();
      if (!name) return;
      var msg = lift ? ("确认取消 " + name + " 的保护？取消后它会被「一键关闭其他窗口」关闭。") : ("恢复 " + name + " 的保护？");
      if (lift) { var yes = true; try { yes = window.confirm(msg); } catch (e) {} if (!yes) return; }
      cache.busy = true;
      setStatus(lift ? ("正在取消 " + name + " 的保护…") : ("正在恢复 " + name + " 的保护…"), "muted");
      api("/whitelist", { method: "POST", body: JSON.stringify({ action: lift ? "add" : "remove", kind: "unprotect", items: [name] }) })
        .then(function (body) {
          cache.busy = false;
          if (cache.status) cache.status.whitelist = { processes: body.processes || [], titles: body.titles || [], unprotect: body.unprotect || [] };
          setStatus(lift ? (name + " 的保护已取消") : (name + " 的保护已恢复"), "ok");
          loadTaskbar();
        })
        .catch(function (error) {
          cache.busy = false;
          setStatus("操作失败：" + (error && error.message ? error.message : error), "error");
        });
    }
    function unprotectProcess(proc) { setTaskbarProtection(proc, true); }
    function reprotectProcess(proc) { setTaskbarProtection(proc, false); }

    // 强制关闭(管理员): elevated taskkill. One UAC prompt; answering No changes
    // nothing. Used for windows whose owner runs elevated — an unelevated
    // WM_CLOSE is silently dropped by Windows UIPI, so the normal 关闭 never works.
    function forceCloseElevated(pid, procName) {
      var name = String(procName || "").trim();
      if (!pid) return;
      var yes = true;
      try {
        yes = window.confirm(
          "将以管理员权限强制结束 " + (name || ("PID " + pid)) + "（PID " + pid + "）。\n\n" +
          "接下来会弹出 Windows UAC 授权框，点「是」才会执行。\n" +
          "强制结束会丢弃该程序未保存的内容。确定继续？");
      } catch (e) { yes = true; }
      if (!yes) return;
      cache.busy = true;
      setStatus("正在请求管理员权限…（请在弹出的 UAC 窗口点「是」）", "muted");
      api("/force-close", {
        method: "POST",
        body: JSON.stringify({ pids: [pid], allowedProcesses: name ? [name] : [] })
      })
        .then(function (body) {
          cache.busy = false;
          if (body && body.ok) {
            setStatus("已强制结束 " + (name || ("PID " + pid)) + "（" + (body.killedCount || 0) + " 个）", "ok");
          } else {
            var why = (body && body.reason) || "未知";
            if (why === "uac-denied-or-cancelled" || why.indexOf("elevated-helper-failed") === 0 || why === "no-marker-output") {
              setStatus("未执行：UAC 被取消或被系统策略阻止（" + why + "）", "error");
            } else if (why === "all-rejected") {
              setStatus("未执行：目标进程被安全规则拒绝", "error");
            } else {
              setStatus("强制关闭失败：" + why, "error");
            }
          }
          loadTaskbar();
        })
        .catch(function (error) {
          cache.busy = false;
          setStatus("强制关闭失败：" + (error && error.message ? error.message : error), "error");
          loadTaskbar();
        });
    }

    function setTaskbarWhitelist(proc, title, checked) {
      var name = String(proc || "").trim();
      if (!name) return;
      cache.busy = true;
      setStatus(checked ? ("正在把 " + name + " 加入白名单…") : ("正在把 " + name + " 移出白名单…"), "muted");
      api("/whitelist", { method: "POST", body: JSON.stringify({ action: checked ? "add" : "remove", kind: "process", items: [name] }) })
        .then(function (body) {
          cache.busy = false;
          if (cache.status) cache.status.whitelist = { processes: body.processes || [], titles: body.titles || [] };
          setStatus(checked ? (name + " 已加入白名单") : (name + " 已移出白名单"), "ok");
          // Reflect new state on every row for this process without a full reload.
          if (cache.taskbar && cache.taskbar.windows) {
            for (var i = 0; i < cache.taskbar.windows.length; i++) {
              var row = cache.taskbar.windows[i];
              if (String(row.process || "").toLowerCase() === name.toLowerCase()) {
                row.whitelisted = checked;
                row.whitelistedBy = checked ? "process" : "";
              }
            }
          }
          renderTaskbar();
          renderWhitelist();
        })
        .catch(function (error) {
          cache.busy = false;
          setStatus("白名单更新失败：" + (error && error.message ? error.message : error), "error");
          renderTaskbar();
        });
    }

    function renderHeader() {
      var st = cache.status;
      var pill = el("dcs-platform");
      if (!pill) return;
      if (!st) { pill.textContent = "读取中…"; pill.style.color = TOKEN.textDim; return; }
      var win = st.platform === "win32";
      pill.textContent = win ? "Windows · 运行中" : ("非 Windows（" + st.platform + "）· 不生效");
      pill.style.color = win ? TOKEN.success : TOKEN.danger;
      var cfg = st.config || {};
      setText("dcs-cfg", "扫描 " + cfg.scanIntervalSec + "s · 空闲 " + cfg.idleThresholdSec +
        "s · 空壳 " + (cfg.emptyConsoleAction || "hide"));
    }

    function renderOpenWindows() {
      var st = cache.status;
      var box = el("dcs-open-windows");
      if (!box) return;
      clear(box);
      if (!st) return;
      var list = st.windows || [];
      // 不可关的内置保护进程名（宿主硬保护，前端一并排除，避免「点了也白点」）。
      var hard = new Set((st.protectedProcesses || []).map(function (p) {
        return String(p).toLowerCase().replace(/\.exe$/, "");
      }));
      var isHard = function (p) {
        var n = String(p || "").toLowerCase().replace(/\.exe$/, "");
        return hard.has(n);
      };
      // 「未关闭垃圾窗口」= 可见、未隐藏、未关闭、非宿主、且不在硬保护列表的窗口。
      var open = [];
      for (var i = 0; i < list.length; i++) {
        var w = list[i];
        if (w.closed) continue;
        if (w.hidden) continue;
        if (w.source === "dsh-host") continue;
        if (isHard(w.processName || w.process || w.processImage || w.pid)) continue;
        open.push(w);
      }
      // DSH 正在用的 MCP 服务控制台（ansys-bridge-mcp / fluent-mcp / agent-bridge 等）——
      // 是宿主服务，绝不能关。并入「不可关闭」集合：MCP 行不渲染关闭/隐藏按钮、
      // 「全部关闭」跳过它们。按进程名（小写）匹配 mcp / agent-bridge / ansys-bridge。
      var isMcpService = function (w) {
        var n = String(w.processName || w.process || w.processImage || "").toLowerCase();
        return /mcp|agent-bridge|ansys-bridge/.test(n);
      };
      var openMCP = [];
      var openClosable = [];
      for (i = 0; i < open.length; i++) {
        if (isMcpService(open[i])) openMCP.push(open[i]); else openClosable.push(open[i]);
      }
      if (!open.length) return;
      var card = mk("div", {
        background: TOKEN.bgCard,
        border: "1px solid " + TOKEN.danger,
        borderRadius: "10px",
        padding: "8px 10px",
        marginBottom: "6px"
      });
      var total = open.length;
      var closableTotal = openClosable.length;
      // ── 标题行：折叠箭头+标题（整块可点切换）+「全部关闭」+「展开/收起」 ──
      // 样式与「DSH 侧边栏」卡标题栏完全统一（同 head/gap/marginBottom、同按钮尺寸、同标题文字）。
      var head = mk("div", {
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: "8px", marginBottom: "6px", cursor: "pointer"
      });
      var headL = mk("div", { display: "flex", alignItems: "center", gap: "6px", minWidth: "0", cursor: "pointer" },
        (_owCollapsed ? "▸ " : "▾ ") +
        "系统控制台窗口（" + closableTotal + " 可关 · " + total + " 非DSH侧边栏" +
        (openMCP.length ? (" · MCP " + openMCP.length + " 勿关") : "") + "）");
      headL.style.fontSize = "13px";
      headL.style.fontWeight = "600";
      headL.style.color = TOKEN.text;
      head.appendChild(headL);
      var headR = mk("div", { display: "flex", alignItems: "center", gap: "6px", flex: "0 0 auto" }, null);
      var closeAllBtn = mk("button", Object.assign({}, S.btnDanger, {
        fontWeight: 600, padding: "3px 10px", fontSize: "12px"
      }), _owProg ? "关闭中…" : "关闭全部");
      closeAllBtn.type = "button";
      closeAllBtn.disabled = Boolean(cache.busy || !closableTotal);
      closeAllBtn.style.opacity = cache.busy ? "0.55" : (closableTotal ? "1" : "0.5");
      closeAllBtn.style.cursor = (!cache.busy && closableTotal) ? "pointer" : "not-allowed";
      closeAllBtn.title = closableTotal ? "关闭所有可关闭的系统控制台窗口（MCP / 宿主 / 白名单服务自动跳过）" : "没有可关闭的窗口（都是 DSH 服务 / 白名单 / 宿主）";
      closeAllBtn.addEventListener("click", function (event) {
        try { event.preventDefault(); } catch (e) {}
        try { event.stopPropagation(); } catch (e) {}
        if (cache.busy) return;
        if (!closableTotal) {
          setStatus("没有可关闭的窗口（当前列出的都是 DSH / MCP 服务）", "muted");
          return;
        }
        cache.busy = true;
        var todo = openClosable.slice();
        var totalN = todo.length;
        _owProg = { done: 0, total: totalN };
        setStatus("正在关闭 0/" + totalN + " …", "muted");
        renderOpenWindows();
        // 逐窗关闭，每步更新进度；最后一个回调里统一刷新状态。
        var n = 0, failed = 0;
        function next() {
          if (!todo.length) {
            cache.busy = false;
            _owProg = null;
            renderOpenWindows();
            setStatus(failed ? ("已关闭 " + n + " 个，失败 " + failed + " 个") : ("已关闭 " + n + " 个未关闭窗口"), "ok");
            refreshAll();
            return;
          }
          var w = todo.shift();
          api("/window", { method: "POST", body: JSON.stringify({ hwnd: w.hwnd, action: "close" }) })
            .then(function (body) {
              n++;
              if (body && body.ok === false && body.reason === "host-protected") failed++;
              if (_owProg) _owProg.done = n + failed;
              setStatus("正在关闭 " + (n + failed) + "/" + totalN + " …", "muted");
              renderOpenWindows();
              next();
            })
            .catch(function () {
              failed++;
              if (_owProg) _owProg.done = n + failed;
              renderOpenWindows();
              next();
            });
        }
        next();
      });
      var foldBtn = mk("button", Object.assign({}, S.btn, { padding: "3px 8px", fontSize: "11px" }),
        _owCollapsed ? "展开" : "收起");
      foldBtn.type = "button";
      foldBtn.addEventListener("click", function (event) {
        try { event.preventDefault(); } catch (e) {}
        try { event.stopPropagation(); } catch (e) {}
        _owCollapsed = !_owCollapsed;
        renderOpenWindows();
      });
      headR.appendChild(closeAllBtn);
      headR.appendChild(foldBtn);
      head.appendChild(headR);
      // 标题栏（含箭头+文字，不含「全部关闭/展开收起」按钮）整体点击折叠/展开。
      head.addEventListener("click", function () {
        _owCollapsed = !_owCollapsed;
        renderOpenWindows();
      });
      card.appendChild(head);
      // 2px 批量关闭进度条（仅批量期间显示）
      if (_owProg && _owProg.total > 0) {
        var pct = Math.round((_owProg.done / _owProg.total) * 100);
        var barWrap = mk("div", {
          height: "2px", background: TOKEN.borderSoft, borderRadius: "1px",
          overflow: "hidden", margin: "4px 0 2px"
        });
        barWrap.appendChild(mk("div", {
          height: "2px", width: pct + "%", background: TOKEN.danger, transition: "width 120ms linear"
        }));
        card.appendChild(barWrap);
      }
      var body = mk("div", { display: _owCollapsed ? "none" : "block" }, null);
      // 每个窗口一行：进程名 · 标题（超长截断）。MCP 服务行：红标勿关、不渲染关闭/隐藏按钮。
      for (var j = 0; j < open.length && j < 40; j++) {
        (function (w) {
          var isMCP = isMcpService(w);
          var row = mk("div", S.rowLine);
          var left = mk("div", { minWidth: "0", flex: "1 1 auto" });
          var nameLine = mk("div", {
            fontSize: "12.5px", color: isMCP ? TOKEN.danger : TOKEN.text, whiteSpace: "nowrap",
            overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: "4px"
          });
          nameLine.appendChild(mk("span", { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: "0", flex: "0 1 auto" }, windowLabel(w)));
          if (isMCP) {
            nameLine.appendChild(mk("span", {
              flex: "0 0 auto", fontSize: "10px", fontWeight: 600, color: "#fff",
              background: "var(--dsw-alias-danger,#e5484d)", borderRadius: "3px",
              padding: "0 4px", lineHeight: "14px"
            }, "MCP服务·勿关"));
          }
          left.appendChild(nameLine);
          left.appendChild(mk("div", Object.assign({}, S.muted, S.mono, { fontSize: "10.5px" }),
            "hwnd=0x" + (w.hwnd ? Number(w.hwnd).toString(16) : "?") +
            " · pid=" + (w.pid || "?") +
            " · src=" + (w.source || "?") +
            (w.isEmpty ? " · 空壳" : "")));
          row.appendChild(left);
          // MCP 服务行不渲染关闭/隐藏按钮（点了也没用，是 DSH 宿主服务）。
          if (!isMCP) {
            var act = mk("div", { display: "flex", gap: "4px", flex: "0 0 auto" });
            var b = mk("button", Object.assign({}, S.btn, { padding: "2px 8px", fontSize: "11.5px" }), "隐藏");
            b.type = "button";
            b.addEventListener("click", function (e) { try { e.preventDefault(); } catch (x) {} if (cache.busy) return; doWindow(w.hwnd, "hide"); });
            act.appendChild(b);
            var c = mk("button", Object.assign({}, S.btnDanger, { padding: "2px 8px", fontSize: "11.5px" }), "关闭");
            c.type = "button";
            c.addEventListener("click", function (e) { try { e.preventDefault(); } catch (x) {} if (cache.busy) return; doWindow(w.hwnd, "close"); });
            act.appendChild(c);
            row.appendChild(act);
          } else {
            row.appendChild(mk("span", Object.assign({}, S.muted, { fontSize: "10.5px", flex: "0 0 auto" }), "DSH 服务，不能关"));
          }
          body.appendChild(row);
        })(open[j]);
      }
      if (open.length > 40) body.appendChild(mk("div", S.muted, "（仅显示前 40 个，共 " + open.length + " 个）"));
      card.appendChild(body);
      box.appendChild(card);
    }

    // ── DSH 侧边栏「当前面板」卡片 ──────────────────────────────────
    // 枚举宿主右侧栏「当前正在看的会话」(mounted) 打开的面板，并给出一键关闭。
    // 数据源是宿主 API `ctx.sidebarRight.openTabs`（过滤 sessionId===mounted）。
    // 注意：openTabs 含所有历史会话的元数据残留，宿主只有对 mounted 会话的关闭
    // 才真正生效；历史记录无公开清理入口，故一律不展示、不可关。
    function renderSidebarPanels() {
      var box = el("dcs-sidebar-panels");
      if (!box) return;
      clear(box);
      if (!_sb.ok) {
        box.appendChild(mk("div", Object.assign({}, S.muted, {
          fontSize: "12px", padding: "6px 10px"
        }), _sb.err || "当前 DSH 不支持右侧栏面板枚举"));
        return;
      }
      var tabs = _sb.tabs || [];
      var mounted = _sb.mounted;
      var cur = [];
      for (var i = 0; i < tabs.length; i++) {
        if (mounted !== undefined && tabs[i].sessionId === mounted) cur.push(tabs[i]);
      }
      var total = tabs.length, curN = cur.length;
      var card = mk("div", {
        background: TOKEN.bgCard,
        border: "1px solid " + TOKEN.borderSoft,
        borderRadius: "10px",
        padding: "10px 12px",
        marginBottom: "8px"
      });
      var head = mk("div", {
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: "8px", marginBottom: "6px", cursor: "pointer"
      }, null);
      var headLeft = mk("div", { display: "flex", alignItems: "center", gap: "6px", minWidth: "0" },
        (_sb.collapsed ? "▸ " : "▾ ") + "DSH 侧边栏 · 当前面板（" + curN + "）");
      headLeft.style.fontSize = "13px";
      headLeft.style.fontWeight = "600";
      headLeft.style.color = TOKEN.text;
      head.appendChild(headLeft);
      var headCtr = mk("div", { flex: "0 0 auto", display: "flex", alignItems: "center", gap: "6px" }, null);
      // 「关闭当前面板」移到标题行右侧（foldWrap 前），折叠态也始终可见、不用展开即可一键关。
      var closeAllBtn = mk("button", Object.assign({}, S.btnDanger, { fontWeight: 600, padding: "3px 10px", fontSize: "12px" }),
        "关闭全部");
      closeAllBtn.type = "button";
      closeAllBtn.disabled = Boolean(cache.busy);
      closeAllBtn.style.opacity = cache.busy ? "0.55" : "1";
      closeAllBtn.style.cursor = cache.busy ? "not-allowed" : "pointer";
      closeAllBtn.addEventListener("click", function (event) {
        try { event.preventDefault(); } catch (e) {}
        try { event.stopPropagation(); } catch (e) {}
        if (cache.busy || !_sb.ctrl) return;
        var todo = cur.slice();
        var totalN = todo.length;
        cache.busy = true;
        setStatus("正在关闭 0/" + totalN + " 个面板…", "muted");
        var closed = 0, failed = 0;
        function next() {
          if (!todo.length) {
            cache.busy = false;
            setStatus(failed ? ("已关闭 " + closed + " 个面板，失败 " + failed) :
              ("已关闭全部 " + closed + " 个侧边栏面板"), "ok");
            _syncSidebar();
            return;
          }
          var t = todo.shift();
          closeTab(t, function (ok) {
            if (ok) closed++; else failed++;
            setStatus("正在关闭 " + (closed + failed) + "/" + totalN + " 个面板…", "muted");
            next();
          });
        }
        next();
      });
      headCtr.appendChild(closeAllBtn);
      var foldWrap = mk("button", Object.assign({}, S.btn, {
        padding: "3px 8px", fontSize: "11px"
      }), _sb.collapsed ? "展开" : "收起");
      foldWrap.type = "button";
      foldWrap.addEventListener("click", function (e) {
        try { e.preventDefault(); } catch (x) {}
        try { e.stopPropagation(); } catch (x) {}
        _sb.collapsed = !_sb.collapsed;
        renderSidebarPanels();
      });
      headCtr.appendChild(foldWrap);
      head.appendChild(headCtr);
      // 标题栏（含箭头+文字，不含「展开/收起」按钮）整体可点折叠/展开。
      head.addEventListener("click", function () {
        _sb.collapsed = !_sb.collapsed;
        renderSidebarPanels();
      });
      card.appendChild(head);
      var body = mk("div", { display: _sb.collapsed ? "none" : "block" }, null);
      if (mounted === undefined || mounted === null) {
        body.appendChild(mk("div", Object.assign({}, S.muted, {
          fontSize: "11px", margin: "6px 0"
        }), "当前无会话右侧栏(mounted=undefined)，切换进某个会话后这里才会列出可关闭的面板。"));
        card.appendChild(body);
        box.appendChild(card);
        return;
      }
      body.appendChild(mk("div", Object.assign({}, S.muted, {
        fontSize: "11px", margin: "6px 0"
      }), "当前会话正在观看 " + curN + " 个面板"));
      if (!cur.length) {
        body.appendChild(mk("div", Object.assign({}, S.muted, {
          fontSize: "12px", padding: "4px 0"
        }), "当前会话右侧栏没有打开的面板"));
        card.appendChild(body);
        box.appendChild(card);
        return;
      }
      var renderRow = function (t, tag) {
        var row = mk("div", S.rowLine);
        var left = mk("div", { minWidth: "0", flex: "1 1 auto" });
        var nm = _sbKindName(t.kind);
        left.appendChild(mk("div", { fontSize: "13px", fontWeight: 500, color: TOKEN.text },
          (tag ? ("[" + tag + "] ") : "") + nm + (t.kind ? " · " + t.kind : "")));
        left.appendChild(mk("div", Object.assign({}, S.muted, S.mono, { fontSize: "10.5px" }),
          "tab " + String(t.tabId).slice(0, 12)));
        row.appendChild(left);
        var act = mk("div", { flex: "0 0 auto" });
        var c = mk("button", Object.assign({}, S.btn, { padding: "3px 10px", fontSize: "12px" }), "关闭");
        c.type = "button";
        c.addEventListener("click", function (e) {
          try { e.preventDefault(); } catch (x) {}
          if (cache.busy) return;
          cache.busy = true;
          setStatus("正在关闭面板 " + _sbKindName(t.kind) + "…", "muted");
          closeTab(t, function (ok) {
            cache.busy = false;
            setStatus(ok ? "已关闭面板" : "关闭面板失败", ok ? "ok" : "error");
            _syncSidebar();
          });
        });
        act.appendChild(c);
        row.appendChild(act);
        body.appendChild(row);
      };
      var shown = 0;
      for (i = 0; i < cur.length && shown < 40; i++, shown++) renderRow(cur[i], "正在看");
      if (cur.length > 40) body.appendChild(mk("div", S.muted, "（仅显示前 40 个，共 " + cur.length + " 个）"));
      card.appendChild(body);
      box.appendChild(card);
    }

    // 关闭单个侧边栏面板：只关当前 mounted 会话的 live tab；非当前会话宿主无清理 API，
    // 视为已处理；mounted undefined → 无可关。
    function closeTab(t, cb) {
      cb = cb || function () {};
      if (!_sb.ctrl || !t || typeof _sb.ctrl.close !== "function") { cb(false); return; }
      try {
        var m = _sb.mounted;
        if (m === undefined || m === null) { cb(false); return; }   // 无当前会话 → 无可关
        if (t.sessionId !== m) { cb(true); return; }                 // 非当前会话：宿主无清理 API，视为已处理
        var rows = (typeof _sb.ctrl.openTabs.getSnapshot === "function") ? _sb.ctrl.openTabs.getSnapshot() : [];
        var live = rows.some(function (r) { return r.sessionId === m && r.tabId === t.tabId; });
        if (!live) { cb(true); return; }
        _sb.ctrl.close(t.tabId);                                      // close 同步 void；= closeIn(mounted,tabId)
        cb(true);
      } catch (e) { try { cb(false); } catch (e2) {} }
    }

    // 从宿主 observable 拉最新已打开面板列表并重渲染。tabs=全部会话累积 openTab；
    // mounted=当前挂载会话 id（右侧边栏正在显示哪一个会话），用于区分「正在看」vs「历史累积」。
    function _syncSidebar() {
      if (!_sb.ctrl || !_sb.ok) return;
      try {
        if (!(_sb.ctrl.openTabs && typeof _sb.ctrl.openTabs.getSnapshot === "function")) {
          _sb.tabs = [];
          renderSidebarPanels();
          return;
        }
        var rows = _sb.ctrl.openTabs.getSnapshot();
        _sb.tabs = Array.isArray(rows) ? rows : [];
        try {
          if (_sb.ctrl.mounted && typeof _sb.ctrl.mounted.getSnapshot === "function") {
            _sb.mounted = _sb.ctrl.mounted.getSnapshot();
          }
        } catch (e) {}
      } catch (e) {
        _sb.tabs = [];
      }
      renderSidebarPanels();
    }

    // apply 期接入宿主 sidebarRight：优先用 ctx.inject（cordis 依赖注入，等 service
    // 就绪才回调，最稳）；宿主/旧版无 ctx.inject 则退回 ctx.get 同步探测。
    function _initSidebar(ctx) {
      if (!ctx) return;
      if (typeof ctx.inject === "function") {
        try {
          ctx.inject(["sidebarRight", "sidebarRightTabs"], function (injected) {
            var ctrl = (injected && injected.get) ? injected.get("sidebarRight") : null;
            _attachSidebar(ctrl);
          });
          return;
        } catch (e) { /* 退回 get */ }
      }
      try {
        var ctrl = ctx.get ? ctx.get("sidebarRight") : null;
        _attachSidebar(ctrl);
      } catch (e) {
        _sb.ok = false;
        _sb.err = "侧边栏面板枚举初始化失败";
      }
    }

    // 挂载 sidebarRight 控制器面并订阅 openTabs 变化。
    function _attachSidebar(ctrl) {
      try {
        if (!ctrl || !ctrl.openTabs) {
          _sb.ok = false;
          _sb.err = "宿主未注入 sidebarRight（DSH 需 0.1.7+）";
          return;
        }
        _sb.ctrl = ctrl;
        _sb.ok = true;
        var openTabs = ctrl.openTabs;
        try {
          if (openTabs && typeof openTabs.subscribe === "function") {
            openTabs.subscribe(function () { _syncSidebar(); });
          }
        } catch (e) {}
        _syncSidebar();
      } catch (e) {
        _sb.ok = false;
        _sb.err = "侧边栏面板枚举初始化失败";
      }
    }

    function renderCounts() {
      var st = cache.status;
      var box = el("dcs-counts");
      if (!box || !st) return;
      clear(box);
      var counts = st.counts || {};
      var items = [
        ["控制台", counts.total || 0],
        ["空壳", counts.empty || 0],
        ["可见空壳", counts.visibleEmpty || 0],
        ["已隐藏", counts.hidden || 0]
      ];
      for (var i = 0; i < items.length; i++) {
        // Compact inline pill (auto width, does NOT stretch across the row).
        var cell = mk("div", {
          flex: "0 0 auto",
          display: "inline-flex",
          alignItems: "baseline",
          gap: "4px",
          background: TOKEN.bgCardSoft,
          border: "1px solid " + TOKEN.borderSoft,
          borderRadius: "999px",
          padding: "2px 9px"
        });
        cell.appendChild(mk("span", { fontSize: "13px", fontWeight: "600", color: TOKEN.text }, items[i][1]));
        cell.appendChild(mk("span", Object.assign({}, S.muted, { fontSize: "11px" }), items[i][0]));
        box.appendChild(cell);
      }
    }

    function windowLabel(w) {
      var name = w.processName || w.process || "?";
      var title = w.title ? String(w.title).slice(0, 48) : "(无标题)";
      return name + "  ·  " + title;
    }

    function renderWindows() {
      var st = cache.status;
      var box = el("dcs-windows");
      if (!box) return;
      clear(box);
      if (!st) { box.appendChild(mk("div", S.muted, "读取中…")); return; }
      var list = st.windows || [];
      if (!list.length) { box.appendChild(mk("div", S.muted, "暂无跟踪到的控制台窗口。")); return; }
      for (var i = 0; i < list.length && i < 60; i++) {
        var w = list[i];
        var line = mk("div", S.rowLine);
        var left = mk("div", { minWidth: "0", flex: "1 1 auto" });
        var nameRow = mk("div", { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" });
        nameRow.appendChild(mk("span", { fontSize: "12.5px", color: TOKEN.text }, windowLabel(w)));
        if (w.isEmpty) {
          nameRow.appendChild(mk("span", {
            fontSize: "10.5px", fontWeight: "600", color: TOKEN.success,
            border: "1px solid " + TOKEN.success, borderRadius: "6px", padding: "0 5px"
          }, "空壳"));
        }
        if (w.hidden) {
          nameRow.appendChild(mk("span", {
            fontSize: "10.5px", color: TOKEN.textDim,
            border: "1px solid " + TOKEN.border, borderRadius: "6px", padding: "0 5px"
          }, "已隐藏"));
        }
        left.appendChild(nameRow);
        left.appendChild(mk("div", Object.assign({}, S.muted, S.mono),
          "hwnd=0x" + (w.hwnd ? Number(w.hwnd).toString(16) : "?") +
          " · pid=" + (w.pid || "?") +
          " · src=" + (w.source || "?") +
          " · cpu=" + (w.cpuPct == null ? "?" : w.cpuPct) + "%" +
          " · idle=" + (w.idleSec == null ? "?" : w.idleSec) + "s" +
          " · kids=" + (w.childCount == null ? "?" : w.childCount)));
        line.appendChild(left);

        var actions = mk("div", { display: "flex", gap: "6px", flex: "0 0 auto" });
        var self = w;
        actions.appendChild(button(w.hidden ? "显示" : "隐藏", S.btn, function () {
          doWindow(self.hwnd, self.hidden ? "show" : "hide");
        }));
        actions.appendChild(button("关闭", S.btnDanger, function () {
          doWindow(self.hwnd, "close");
        }));
        line.appendChild(actions);
        box.appendChild(line);
      }
      if (list.length > 60) {
        box.appendChild(mk("div", S.muted, "（仅显示前 60 个，共 " + list.length + " 个）"));
      }
    }

    function button(label, style, onClick) {
      var node = mk("button", style, label);
      node.type = "button";
      node.addEventListener("click", function (event) {
        try { event.preventDefault(); } catch (e) {}
        if (cache.busy) return;
        onClick();
      });
      return node;
    }

    function renderWhitelist() {
      var st = cache.status;
      var procBox = el("dcs-wl-proc");
      var titleBox = el("dcs-wl-title");
      if (!procBox || !titleBox) return;
      clear(procBox); clear(titleBox);
      var wl = (st && st.whitelist) || { processes: [], titles: [] };
      if (!wl.processes.length) procBox.appendChild(mk("span", S.muted, "（空）"));
      if (!wl.titles.length) titleBox.appendChild(mk("span", S.muted, "（空）"));
      var i;
      for (i = 0; i < wl.processes.length; i++) {
        procBox.appendChild(chip(wl.processes[i], "process", wl.processes[i]));
      }
      for (i = 0; i < wl.titles.length; i++) {
        titleBox.appendChild(chip(wl.titles[i], "title", wl.titles[i]));
      }
      if (st) setText("dcs-wl-path", "运行时白名单文件：" + (st.whitelistPath || "—"));
    }

    function chip(label, kind, value) {
      var node = mk("span", S.chip);
      node.appendChild(mk("span", null, label));
      var x = mk("button", S.chipX, "×");
      x.type = "button";
      x.title = "移除";
      x.addEventListener("click", function (event) {
        try { event.preventDefault(); } catch (e) {}
        whitelistAction("remove", kind, [value]);
      });
      node.appendChild(x);
      return node;
    }

    function renderDesktopResult() {
      var box = el("dcs-desktop-result");
      // Enable「执行清理」only after a preview (dryRun) with plans exists.
      var execBtn = el("dcs-exec-cleanup");
      var d = cache.desktop;
      var canExec = Boolean(d && d.dryRun && (d.plannedCount || 0) > 0);
      if (execBtn) {
        execBtn.disabled = !canExec;
        execBtn.style.opacity = canExec ? "1" : "0.5";
        execBtn.style.cursor = canExec ? "pointer" : "not-allowed";
        execBtn.title = canExec ? "执行清理上面预演的窗口" : "请先点「预演」核对清单";
      }
      if (!box) return;
      clear(box);
      if (!d) return;   // no preview yet → render nothing (stay compact)
      var head = (d.dryRun ? "预演" : "已执行") + "：可关闭 " + (d.plannedCount || 0) + " 个" +
        (d.dryRun ? "" : ("，已关闭 " + (d.closedCount || 0) + " 个")) +
        (d.elevatedCount ? ("；其中管理员窗口 " + d.elevatedCount + " 个（执行时弹一次 UAC）") : "") +
        (d.kept && d.kept.length ? ("；保护跳过 " + d.kept.length + " 个") : "") +
        (d.elevatedUacCancelled ? "；管理员窗口的 UAC 被取消" : "");
      box.appendChild(mk("div", { fontSize: "12px", fontWeight: "600", color: d.dryRun ? TOKEN.text : TOKEN.success }, head));
      var ul = mk("div", { marginTop: "6px" });
      var planned = d.planned || [];
      var detailed = d.plannedDetailed || [];
      if (!planned.length) ul.appendChild(mk("div", S.muted, "没有可关闭的窗口。"));
      for (var i = 0; i < planned.length && i < 40; i++) {
        var det = detailed[i];
        if (det) {
          var row = mk("div", { display: "flex", alignItems: "center", gap: "8px", padding: "2px 0" });
          row.appendChild(iconImg(det.icon, det.process));
          row.appendChild(mk("span", Object.assign({}, S.mono, { color: TOKEN.textDim, wordBreak: "break-all" }), planned[i]));
          ul.appendChild(row);
        } else {
          ul.appendChild(mk("div", Object.assign({}, S.mono, { color: TOKEN.textDim, padding: "1px 0" }), planned[i]));
        }
      }
      box.appendChild(ul);
    }

    // ---- actions -------------------------------------------------------------

    function doWindow(hwnd, action, elevated, process) {
      if (!hwnd) return;
      cache.busy = true;
      setStatus(action === "close" && elevated ? "正在请求管理员权限关闭该窗口（请点 UAC「是」）…" : ("正在 " + action + " …"), "muted");
      api("/window", { method: "POST", body: JSON.stringify({ hwnd: hwnd, action: action, elevated: Boolean(elevated), process: process || "" }) })
        .then(function (body) {
          cache.busy = false;
          var refused = body && body.reason === "host-protected";
          if (refused) {
            setStatus("已拒绝：这是 DSH 宿主相关窗口，不能 " + action, "error");
          } else if (body && body.ok === false) {
            var r = body.reason || "未知";
            if (r === "uac-denied-or-cancelled") setStatus("未关闭：UAC 被取消", "error");
            else setStatus(action + " 未成功：" + r, "error");
          } else {
            setStatus(action + " 完成" + (body && body.elevated ? "（管理员提权）" : ""), "ok");
          }
          if (body && body.status) { cache.status = body.status; renderWindows(); renderHeader(); renderCounts(); renderWhitelist(); }
          if (!refused && action === "close") {
            afterMutation({ removeHwnds: [hwnd] });
          } else if (!refused) {
            afterMutation({});
          }
        })
        .catch(function (error) {
          cache.busy = false;
          setStatus(action + " 失败：" + (error && error.message ? error.message : error), "error");
        });
    }

    function hideEmpty() {
      cache.busy = true;
      setStatus("正在隐藏可见空壳…", "muted");
      api("/hide-empty", { method: "POST", body: "{}" })
        .then(function (body) {
          cache.busy = false;
          setStatus("已隐藏 " + (body.hidden || 0) + " 个空壳", "ok");
          if (body && body.status) cache.status = body.status;
          renderWindows(); renderHeader(); renderCounts();
          afterMutation({});
        })
        .catch(function (error) {
          cache.busy = false;
          setStatus("隐藏失败：" + (error && error.message ? error.message : error), "error");
        });
    }

    // 按软件一键关闭：优雅关闭该软件的全部窗口（等同对每个窗口按 Alt+F4）。
    function closeSoftware(processName, count) {
      var name = String(processName || "").trim();
      if (!name) return;
      var yes = true;
      try {
        yes = window.confirm(
          "关闭「" + name + "」的全部窗口" + (count > 1 ? ("（共 " + count + " 个）") : "") + "？\n\n" +
          "这是优雅关闭（等同对每个窗口按 Alt+F4），不是强杀。\n" +
          "若该软件是管理员程序，会弹一次 UAC，请点「是」。");
      } catch (e) { yes = true; }
      if (!yes) return;
      cache.busy = true;
      setStatus("正在关闭 " + name + " 的全部窗口…", "muted");
      api("/close-process", { method: "POST", body: JSON.stringify({ process: name }) })
        .then(function (body) {
          cache.busy = false;
          if (body && body.ok) {
            var m = "已关闭 " + name + " " + (body.closedCount || 0) + "/" + (body.total || 0) + " 个窗口";
            if (body.elevated) m += "（含管理员窗口 " + body.elevated + " 个）";
            if (body.uacCancelled) m += " · UAC 被取消，管理员窗口未关";
            setStatus(m, "ok");
          } else {
            setStatus("关闭失败：" + ((body && body.reason) || "未知"), "error");
          }
          if (body && body.status) cache.status = body.status;
          renderWindows(); renderHeader(); renderCounts();
          if (body && body.ok !== false && !body.uacCancelled) {
            afterMutation({ removeProcess: name });
          } else {
            afterMutation({});
          }
        })
        .catch(function (error) {
          cache.busy = false;
          setStatus("关闭失败：" + (error && error.message ? error.message : error), "error");
        });
    }

    // 关闭空壳窗口：真正结束空壳控制台的进程（不是隐藏），释放资源。
    function closeEmpty() {
      var yes = true;
      try { yes = window.confirm("关闭所有空壳控制台窗口？\n只关闭「裸解释器空壳」（cmd / powershell / pwsh / python 且没有正在运行的任务）；\n宿主程序、Fluent/MPI 等一律不动。确定的请按「确定」。"); } catch (e) { yes = true; }
      if (!yes) return;
      cache.busy = true;
      setStatus("正在关闭空壳窗口…", "muted");
      api("/close-empty", { method: "POST", body: "{}" })
        .then(function (body) {
          cache.busy = false;
          var msg = "已关闭 " + (body.closed || 0) + " 个空壳窗口";
          if (body.skipped) msg += "（跳过 " + body.skipped + " 个受保护/非裸解释器）";
          setStatus(msg, "ok");
          if (body && body.status) cache.status = body.status;
          renderWindows(); renderHeader(); renderCounts();
          afterMutation({});
        })
        .catch(function (error) {
          cache.busy = false;
          setStatus("关闭空壳失败：" + (error && error.message ? error.message : error), "error");
        });
    }

    function desktopCleanup(dryRun) {
      if (!dryRun) {
        var yes = true;
        try { yes = window.confirm("将清理任务栏窗口（关闭其他程序的窗口）。受保护的进程和白名单会自动跳过，前台窗口不会被关。\n\n执行前建议先「预演」核对清单。确定执行？"); } catch (e) {}
        if (!yes) return;
      }
      cache.busy = true;
      setStatus(dryRun ? "正在预演…" : "正在清理任务栏窗口…", "muted");
      api("/desktop-cleanup", { method: "POST", body: JSON.stringify({ dryRun: Boolean(dryRun) }) })
        .then(function (body) {
          cache.busy = false;
          cache.desktop = body;
          renderDesktopResult();
          if (dryRun) {
            setStatus("预演完成：可关闭 " + (body.plannedCount || 0) + " 个，查看清单后点「执行清理」", "ok");
          } else {
            var mm = "已清理 " + (body.closedCount || 0) + " 个窗口";
            if (body.elevatedUacCancelled) mm += "（管理员窗口的 UAC 被取消）";
            setStatus(mm, "ok");
            if (body && body.status) cache.status = body.status;
            renderWindows(); renderHeader(); renderCounts();
            afterMutation({});
          }
        })
        .catch(function (error) {
          cache.busy = false;
          setStatus("清理失败：" + (error && error.message ? error.message : error), "error");
        });
    }

    function whitelistAction(action, kind, items) {
      cache.busy = true;
      setStatus("正在更新白名单…", "muted");
      api("/whitelist", { method: "POST", body: JSON.stringify({ action: action, kind: kind, items: items }) })
        .then(function (body) {
          cache.busy = false;
          if (cache.status) cache.status.whitelist = { processes: body.processes || [], titles: body.titles || [] };
          setStatus("白名单已更新（" + action + "）", "ok");
          renderWhitelist();
        })
        .catch(function (error) {
          cache.busy = false;
          setStatus("白名单更新失败：" + (error && error.message ? error.message : error), "error");
        });
    }

    function whitelistAdd(kind, inputId) {
      var node = el(inputId);
      var value = node && typeof node.value === "string" ? node.value.trim() : "";
      if (!value) { setStatus("请输入要加入白名单的内容", "error"); return; }
      var items = value.split(/[\n,，]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!items.length) return;
      if (node) node.value = "";
      whitelistAction("add", kind, items);
    }

    function whitelistReset() {
      var yes = true;
      try { yes = window.confirm("清空运行时白名单？（内置硬保护仍然生效，不受影响）"); } catch (e) {}
      if (!yes) return;
      whitelistAction("reset", "process", []);
    }

    // ---- Auto refresh while the section is VISIBLE --------------------------
    // 🔴 只在面板真正可见时定时刷新；关闭设置 / 切走 / 隐藏后立刻停表。
    // 判定三重条件，任一不满足即视为不可见（保守，宁可少刷不可空转）：
    //   ① document.visibilityState === 'visible'（窗口最小化/切到别的应用时停）
    //   ② 我们的容器在文档里（document.contains）——设置页关掉后容器被卸载
    //   ③ 容器 offsetParent 非空 或 有非零尺寸（display:none / 被隐藏时停）
    // 另监听 visibilitychange 与设置页消失，即时停表（不只等定时器）。
    var AUTO_MS = 3000;
    function panelAlive() {
      try {
        if (typeof document === "undefined") return false;
        if (document.visibilityState && document.visibilityState !== "visible") return false;
        var box = el("dcs-taskbar") || el("dcs-counts");
        if (!box) return false;
        if (document.contains && !document.contains(box)) return false;
        // offsetParent 为空通常意味着某级祖先 display:none（关闭/隐藏）
        if ("offsetParent" in box && box.offsetParent === null) {
          var r = box.getBoundingClientRect ? box.getBoundingClientRect() : null;
          if (!r || (r.width === 0 && r.height === 0)) return false;
        }
        return true;
      } catch (e) { return false; }
    }

    function startAutoRefresh() {
      if (cache.autoTimer) return;
      cache.autoTimer = setInterval(function () {
        if (!panelAlive()) { stopAutoRefresh(); return; }
        if (cache.busy || cache.taskbarLoading) return;   // 正在操作/加载时跳过，避免打断
        loadTaskbar({ silent: true });
        loadStatus(true);
      }, AUTO_MS);
    }

    function stopAutoRefresh() {
      if (cache.autoTimer) { try { clearInterval(cache.autoTimer); } catch (e) {} cache.autoTimer = null; }
    }

    // 挂一次性全局监听：窗口可见性变化 / 页面卸载 → 停表；重新可见 → 视情况恢复。
    function installVisibilityHooks() {
      if (cache.visHooked) return;
      cache.visHooked = true;
      try {
        document.addEventListener("visibilitychange", function () {
          if (document.visibilityState === "visible") {
            if (panelAlive()) { loadTaskbar({ silent: true }); loadStatus(true); startAutoRefresh(); }
          } else {
            stopAutoRefresh();
          }
        });
      } catch (e) {}
      try {
        window.addEventListener("beforeunload", function () { stopAutoRefresh(); });
        window.addEventListener("pagehide", function () { stopAutoRefresh(); });
      } catch (e) {}
    }

    // ---- React component -----------------------------------------------------

    function SettingsSection() {
      if (!React) return null;
      // Repaint after the host commits the slot: containers get rebuilt empty on
      // every slot re-render, so re-hydrate from cache. First mount loads data.
      try {
        setTimeout(function () {
          if (cache.status) { renderAll(); }
          else { loadStatus(); }
          loadTaskbar({ silent: true });
          installVisibilityHooks();
          startAutoRefresh();
        }, 0);
      } catch (e) {}

      var TABS = [
        { key: "taskbar", label: "任务栏" },
        { key: "console", label: "控制台" },
        { key: "whitelist", label: "白名单" }
      ];
      var activeTab = TAB.active || "taskbar";
      var tabBtn = function (t) {
        var on = activeTab === t.key;
        return React.createElement("button", {
          id: "dcs-tab-" + t.key,
          type: "button",
          onClick: function () { setActiveTab(t.key); },
          style: {
            background: "transparent", border: "none",
            borderBottom: "2px solid " + (on ? TOKEN.accent : "transparent"),
            color: on ? TOKEN.accent : TOKEN.textDim,
            fontWeight: on ? 600 : 500,
            fontSize: "12.5px", padding: "6px 10px", cursor: "pointer", lineHeight: 1.3
          }
        }, t.label);
      };
      var panel = function (t, children) {
        return React.createElement("div", {
          id: "dcs-panel-" + t.key,
          style: { display: (activeTab === t.key) ? "block" : "none" }
        }, children);
      };
      var hint = function (text) {
        return React.createElement("div", {
          style: Object.assign({}, S.muted, { fontSize: "11px", marginBottom: "6px", lineHeight: 1.45 })
        }, text);
      };
      var scrollBox = { maxHeight: "270px", overflowY: "auto", paddingRight: "2px" };

      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "8px" } },

        // Header (compact: title + platform pill + refresh, then cfg + status)
        React.createElement("div", { style: Object.assign({}, S.card, { padding: "9px 12px", marginBottom: "2px" }) },
          React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
              React.createElement("span", { style: S.title }, "控制台哨兵"),
              React.createElement("span", { id: "dcs-platform", style: { fontSize: "11.5px", fontWeight: 600 } }, "读取中…")
            ),
            React.createElement("button", { type: "button", style: S.btnPrimary, onClick: function () { refreshAll(); } }, "刷新")
          ),
          React.createElement("div", { id: "dcs-cfg", style: Object.assign({}, S.muted, { marginTop: "4px", fontSize: "11.5px" }) }, "读取中…"),
          React.createElement("div", { id: "dcs-status", style: { fontSize: "11.5px", color: TOKEN.textDim, minHeight: "14px", marginTop: "2px" } }, "")
        ),

        // Counts — slim inline strip (no card chrome)
        React.createElement("div", { id: "dcs-counts", style: { display: "flex", gap: "6px", flexWrap: "wrap" } }),

        // 未关闭窗口横幅卡片（renderOpenWindows 写入）
        React.createElement("div", { id: "dcs-open-windows" }),

        // DSH 侧边栏已打开面板卡片（renderSidebarPanels 写入，宿主 API 枚举）
        React.createElement("div", { id: "dcs-sidebar-panels" }),

        // 操作栏 —— 全部动作压成一行（说明走 title 悬浮提示，不占版面）
        React.createElement("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" } },
          React.createElement("button", {
            type: "button", style: S.btn, disabled: cache.busy,
            opacity: cache.busy ? "0.55" : "1", cursor: cache.busy ? "not-allowed" : "pointer",
            title: "把「空壳」控制台窗口隐藏起来（进程不杀，可恢复）",
            onClick: function () { hideEmpty(); }
          }, cache.busy ? "隐藏中…" : "隐藏可见空壳"),
          React.createElement("button", {
            type: "button", style: S.btnDanger, disabled: cache.busy,
            opacity: cache.busy ? "0.55" : "1", cursor: cache.busy ? "not-allowed" : "pointer",
            title: "真正结束「空壳」控制台进程（只关 cmd/powershell/pwsh/python 且无任务在跑；宿主与 Fluent 不动）",
            onClick: function () { closeEmpty(); }
          }, cache.busy ? "关闭中…" : "关闭空壳窗口"),
          React.createElement("span", { style: { width: "1px", height: "18px", background: TOKEN.borderSoft, flex: "0 0 auto" } }),
          React.createElement("button", {
            type: "button", style: S.btn, disabled: cache.busy,
            opacity: cache.busy ? "0.55" : "1", cursor: cache.busy ? "not-allowed" : "pointer",
            title: "预演：列出将被关闭的窗口（保护项与白名单自动跳过）",
            onClick: function () { desktopCleanup(true); }
          }, cache.busy ? "预演中…" : "预演清理"),
          React.createElement("button", {
            id: "dcs-exec-cleanup", type: "button", style: S.btnPrimary, disabled: cache.busy,
            opacity: cache.busy ? "0.55" : "1", cursor: cache.busy ? "not-allowed" : "pointer",
            title: "执行清理：关闭其他程序的窗口（需先预演；管理员窗口会弹一次 UAC）",
            onClick: function () { desktopCleanup(false); }
          }, cache.busy ? "清理中…" : "执行清理")
        ),

        // 预演/执行结果（有内容才显示，平时只是一行小字，不占高度）
        React.createElement("div", { id: "dcs-desktop-result", style: { maxHeight: "160px", overflowY: "auto", paddingRight: "2px" } }),

        // Tabs
        React.createElement("div", { style: { display: "flex", gap: "2px", borderBottom: "1px solid " + TOKEN.borderSoft } },
          tabBtn(TABS[0]), tabBtn(TABS[1]), tabBtn(TABS[2])
        ),

        // Panel 1: 任务栏（图标网格 / 详细分组 · 每窗口可单独关闭 / 关掉整个软件 / 白名单）
        panel(TABS[0],
          React.createElement("div", null,
            React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "6px" } },
              React.createElement("span", {
                style: Object.assign({}, S.muted, { fontSize: "11px" }),
                title: "图标=点一下关闭该窗口；详细视图=按软件分组，可勾选加入白名单、可关掉整个软件。管理员窗口会弹一次 UAC；「系统保护」程序（宿主/Fluent/MPI）不可关闭。"
              }, cache.taskbarView === "icon" ? "点击图标关闭对应窗口（悬停看详情）" : "勾选=加入白名单；每窗口后可单独关闭"),
              React.createElement("button", { id: "dcs-taskbar-view", type: "button", style: S.btn, onClick: function () { toggleTaskbarView(); } }, "详细视图")
            ),
            React.createElement("div", { id: "dcs-taskbar", style: scrollBox })
          )
        ),

        // Panel 2: 控制台窗口
        panel(TABS[1],
          React.createElement("div", null,
            hint("空壳 = 解释器无业务子进程（只剩 conhost）。点上方「隐藏可见空壳 / 关闭空壳窗口」一键处理。"),
            React.createElement("div", { id: "dcs-windows", style: { maxHeight: "260px", overflowY: "auto", paddingRight: "2px" } })
          )
        ),

        // Panel 3: 白名单
        panel(TABS[2],
          React.createElement("div", null,
            hint("这些进程 / 标题永远不被隐藏或关闭。"),
            React.createElement("div", { style: Object.assign({}, S.muted, { marginBottom: "3px", fontSize: "11px" }) }, "进程名"),
            React.createElement("div", { id: "dcs-wl-proc", style: { marginBottom: "4px" } }),
            React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginTop: "3px" } },
              React.createElement("input", { id: "dcs-wl-proc-input", type: "text", placeholder: "如 chrome / code / excel", style: S.input }),
              React.createElement("button", { type: "button", style: S.btn, onClick: function () { whitelistAdd("process", "dcs-wl-proc-input"); } }, "加入")
            ),
            React.createElement("div", { style: Object.assign({}, S.muted, { marginTop: "10px", marginBottom: "3px", fontSize: "11px" }) }, "窗口标题包含"),
            React.createElement("div", { id: "dcs-wl-title", style: { marginBottom: "4px" } }),
            React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginTop: "3px" } },
              React.createElement("input", { id: "dcs-wl-title-input", type: "text", placeholder: "如 Visual Studio Code / 记事本", style: S.input }),
              React.createElement("button", { type: "button", style: S.btn, onClick: function () { whitelistAdd("title", "dcs-wl-title-input"); } }, "加入")
            ),
            React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: "10px" } },
              React.createElement("button", { type: "button", style: S.btnDanger, onClick: function () { whitelistReset(); } }, "清空运行时白名单")
            ),
            React.createElement("div", { id: "dcs-wl-path", style: Object.assign({}, S.muted, S.mono, { marginTop: "8px", fontSize: "10.5px", wordBreak: "break-all" }) })
          )
        )
      );
    }

    // 分区导航图标（与插件内容相关：终端窗口 + 盾牌「哨兵」）。
    // 🔴 宿主设置页对未注册 icon 的分区会 fallback 到通用的齿轮图标
    // (navIcon(row.id) 的默认分支) —— 视觉上像"没有图标/缺省图标"。
    // 必须注册 settings.section.icon 槽并用 only 限定到本分区 id。
    function SettingsIcon(props) {
      var size = (props && props.size) || 16;
      var active = Boolean(props && props.active);
      var color = active ? TOKEN.accent : "currentColor";
      return React.createElement(
        "svg",
        {
          width: size, height: size, viewBox: "0 0 16 16",
          fill: "none", stroke: color, strokeWidth: 1.4,
          strokeLinecap: "round", strokeLinejoin: "round",
          "aria-hidden": "true", focusable: "false"
        },
        // 终端窗口外框
        React.createElement("rect", { x: "1.6", y: "2.6", width: "12.8", height: "10.8", rx: "1.9" }),
        // 标题栏分隔线
        React.createElement("path", { d: "M1.6 5.4h12.8" }),
        // 提示符 >_ （控制台的标志性元素）
        React.createElement("path", { d: "M4.3 8.1l1.7 1.5-1.7 1.5" }),
        React.createElement("path", { d: "M7.9 11.1h3.4" })
      );
    }

    function registerSettings(ctx) {
      if (!ctx || !ctx.slots || !React) return false;
      try {
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register(
            {
              name: "settings.section",
              id: "dsh-console-sentinel",
              order: 28,
              label: function () { return "控制台哨兵"; },
              inject: function () { return {}; }
            },
            SettingsSection
          );
        });
      } catch (e) {
        try { console.warn("[dsh-console-sentinel] settings.section registration failed", e); } catch (e2) {}
      }
      // 导航图标：独立注册，失败不影响分区注册本身。
      // 🔴 宿主契约（dsh-cordis-client-runner / slots.ts:65）：
      //   「settings.section.icon」的 registration id **必须等于目标分区的 id**，
      //   不匹配的 id 永不渲染（instead the shell keeps its DEFAULT GLYPH = 齿轮）。
      //   所以这里必须写 "dsh-console-sentinel"，不能加 -icon 后缀。
      try {
        ctx.slots.inject("settings.section.icon", function () {
          return ctx.slots.register(
            {
              name: "settings.section.icon",
              id: "dsh-console-sentinel",
              order: 28,
              inject: function () { return {}; }
            },
            SettingsIcon
          );
        });
      } catch (e) {
        try { console.warn("[dsh-console-sentinel] settings icon registration failed", e); } catch (e2) {}
      }
      return true;
    }

    // MUST be a plain array (see the header comment).
    exports.inject = ["slots", "locale"];
    exports.apply = function (ctx) {
      try {
        if (window.__DCS_APPLIED__) { return; }
        window.__DCS_APPLIED__ = true;
      } catch (eGuard) { /* no window: continue */ }
      try { registerSettings(ctx); }
      catch (e) {
        try { console.warn("[dsh-console-sentinel] settings registration failed", e); } catch (e2) {}
      }
      // 接入宿主侧边栏面板枚举（openTabs 订阅 + getSnapshot 快照）
      try { _initSidebar(ctx); }
      catch (e) {
        try { console.warn("[dsh-console-sentinel] sidebar init failed", e); } catch (e2) {}
      }
    };
    exports.__dcsTest = {
      cache: cache,
      SettingsSection: SettingsSection,
      registerSettings: registerSettings,
      loadStatus: loadStatus,
      _initSidebar: _initSidebar,
      _syncSidebar: _syncSidebar
    };

    return module.exports;
  }
});
  }
} catch (__dcsLoadErr) {
  try { console.error("[dsh-console-sentinel] client bundle failed to load", __dcsLoadErr); } catch (e) {}
}
