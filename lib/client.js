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

try {
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
        padding: "14px 16px",
        marginBottom: "12px",
        color: TOKEN.text,
        fontSize: "13px",
        lineHeight: 1.5
      },
      cardHead: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "10px",
        marginBottom: "10px"
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
        padding: "5px 11px",
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
        padding: "5px 11px",
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
        gap: "10px",
        padding: "7px 0",
        borderBottom: "1px solid " + TOKEN.borderSoft
      }
    };

    var cache = {
      status: null,
      loading: false,
      busy: false,
      message: "",
      tone: "muted",
      desktop: null
    };

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
      renderCounts();
      renderWindows();
      renderWhitelist();
      renderDesktopResult();
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
      setText("dcs-cfg", "扫描间隔 " + cfg.scanIntervalSec + "s · 空闲阈值 " + cfg.idleThresholdSec +
        "s · 自动动作 " + (cfg.autoAction || "none") + " · 空壳动作 " + (cfg.emptyConsoleAction || "hide"));
    }

    function renderCounts() {
      var st = cache.status;
      var box = el("dcs-counts");
      if (!box || !st) return;
      clear(box);
      var counts = st.counts || {};
      var items = [
        ["控制台窗口", counts.total || 0],
        ["空壳 PowerShell", counts.empty || 0],
        ["可见空壳", counts.visibleEmpty || 0],
        ["已隐藏", counts.hidden || 0]
      ];
      for (var i = 0; i < items.length; i++) {
        var cell = mk("div", {
          flex: "1 1 0",
          minWidth: "96px",
          background: TOKEN.bgCardSoft,
          border: "1px solid " + TOKEN.borderSoft,
          borderRadius: "8px",
          padding: "8px 10px"
        });
        cell.appendChild(mk("div", { fontSize: "20px", fontWeight: "600", color: TOKEN.text }, items[i][1]));
        cell.appendChild(mk("div", S.muted, items[i][0]));
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
      if (!box) return;
      clear(box);
      var d = cache.desktop;
      if (!d) { box.appendChild(mk("div", S.muted, "点「预演」列出将被关闭的窗口；点「执行」真正关闭（保护项与白名单自动跳过）。")); return; }
      var head = (d.dryRun ? "预演" : "已执行") + "：可关闭 " + (d.plannedCount || 0) + " 个" +
        (d.dryRun ? "" : ("，已关闭 " + (d.closedCount || 0) + " 个")) +
        (d.kept && d.kept.length ? ("，保护跳过 " + d.kept.length + " 个") : "");
      box.appendChild(mk("div", { fontSize: "12px", fontWeight: "600", color: d.dryRun ? TOKEN.text : TOKEN.success }, head));
      var ul = mk("div", { marginTop: "6px" });
      var planned = d.planned || [];
      if (!planned.length) ul.appendChild(mk("div", S.muted, "没有可关闭的窗口。"));
      for (var i = 0; i < planned.length && i < 40; i++) {
        ul.appendChild(mk("div", Object.assign({}, S.mono, { color: TOKEN.textDim, padding: "1px 0" }), planned[i]));
      }
      box.appendChild(ul);
    }

    // ---- actions -------------------------------------------------------------

    function doWindow(hwnd, action) {
      if (!hwnd) return;
      cache.busy = true;
      setStatus("正在 " + action + " …", "muted");
      api("/window", { method: "POST", body: JSON.stringify({ hwnd: hwnd, action: action }) })
        .then(function (body) {
          cache.busy = false;
          setStatus(action + " 完成", "ok");
          applyStatus(body);
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
          applyStatus(body);
        })
        .catch(function (error) {
          cache.busy = false;
          setStatus("隐藏失败：" + (error && error.message ? error.message : error), "error");
        });
    }

    function desktopCleanup(dryRun) {
      if (!dryRun) {
        var yes = true;
        try { yes = window.confirm("将关闭所有可关闭的窗口（任务栏窗口），受保护的程序和白名单会自动跳过。确定执行？"); } catch (e) {}
        if (!yes) return;
      }
      cache.busy = true;
      setStatus(dryRun ? "正在预演…" : "正在关闭其他窗口…", "muted");
      api("/desktop-cleanup", { method: "POST", body: JSON.stringify({ dryRun: Boolean(dryRun) }) })
        .then(function (body) {
          cache.busy = false;
          cache.desktop = body;
          setStatus(dryRun ? "预演完成" : ("已关闭 " + (body.closedCount || 0) + " 个窗口"), "ok");
          renderDesktopResult();
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

    // ---- React component -----------------------------------------------------

    function SettingsSection() {
      if (!React) return null;
      // Repaint after the host commits the slot: containers get rebuilt empty on
      // every slot re-render, so re-hydrate from cache. First mount loads data.
      try {
        setTimeout(function () {
          if (cache.status) { renderAll(); }
          else { loadStatus(); }
        }, 0);
      } catch (e) {}

      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "0px" } },

        // Header
        React.createElement("div", { style: S.card },
          React.createElement("div", { style: S.cardHead },
            React.createElement("div", null,
              React.createElement("div", { style: S.title }, "🛡️ 控制台哨兵"),
              React.createElement("div", { id: "dcs-cfg", style: S.muted }, "读取中…")
            ),
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
              React.createElement("span", { id: "dcs-platform", style: { fontSize: "12px", fontWeight: 600 } }, "读取中…"),
              React.createElement("button", {
                type: "button", style: S.btnPrimary,
                onClick: function () { loadStatus(); }
              }, "刷新")
            )
          ),
          React.createElement("div", { id: "dcs-status", style: { fontSize: "12px", color: TOKEN.textDim, minHeight: "16px" } }, "")
        ),

        // Counts
        React.createElement("div", { style: S.card },
          React.createElement("div", { style: S.cardHead },
            React.createElement("div", { style: S.title }, "概览"),
            React.createElement("button", { type: "button", style: S.btn, onClick: function () { hideEmpty(); } }, "隐藏可见空壳")
          ),
          React.createElement("div", { id: "dcs-counts", style: { display: "flex", gap: "8px", flexWrap: "wrap" } })
        ),

        // Taskbar window cleanup (the "一键关闭其他窗口" feature)
        React.createElement("div", { style: S.card },
          React.createElement("div", { style: S.cardHead },
            React.createElement("div", null,
              React.createElement("div", { style: S.title }, "任务栏窗口清理"),
              React.createElement("div", { style: S.muted }, "关闭其它程序的窗口；受保护进程与白名单自动跳过，前台窗口不会被关。")
            ),
            React.createElement("div", { style: { display: "flex", gap: "8px" } },
              React.createElement("button", { type: "button", style: S.btn, onClick: function () { desktopCleanup(true); } }, "预演"),
              React.createElement("button", { type: "button", style: S.btnPrimary, onClick: function () { desktopCleanup(false); } }, "一键关闭其他窗口")
            )
          ),
          React.createElement("div", { id: "dcs-desktop-result" })
        ),

        // Tracked windows
        React.createElement("div", { style: S.card },
          React.createElement("div", { style: S.cardHead },
            React.createElement("div", { style: S.title }, "控制台窗口"),
            React.createElement("div", { style: S.muted }, "空壳 = 解释器无业务子进程（只剩 conhost）")
          ),
          React.createElement("div", { id: "dcs-windows" })
        ),

        // Whitelist
        React.createElement("div", { style: S.card },
          React.createElement("div", { style: S.cardHead },
            React.createElement("div", null,
              React.createElement("div", { style: S.title }, "豁免白名单"),
              React.createElement("div", { style: S.muted }, "这些进程/窗口标题永远不被隐藏或关闭。")
            ),
            React.createElement("button", { type: "button", style: S.btnDanger, onClick: function () { whitelistReset(); } }, "清空运行时白名单")
          ),
          React.createElement("div", { style: { marginTop: "6px" } },
            React.createElement("div", { style: Object.assign({}, S.muted, { marginBottom: "4px" }) }, "进程名"),
            React.createElement("div", { id: "dcs-wl-proc", style: { marginBottom: "4px" } }),
            React.createElement("div", { style: { display: "flex", gap: "8px", alignItems: "center", marginTop: "4px" } },
              React.createElement("input", { id: "dcs-wl-proc-input", type: "text", placeholder: "如 chrome / code / excel", style: S.input }),
              React.createElement("button", { type: "button", style: S.btn, onClick: function () { whitelistAdd("process", "dcs-wl-proc-input"); } }, "加入进程白名单")
            )
          ),
          React.createElement("div", { style: { marginTop: "12px" } },
            React.createElement("div", { style: Object.assign({}, S.muted, { marginBottom: "4px" }) }, "窗口标题包含"),
            React.createElement("div", { id: "dcs-wl-title", style: { marginBottom: "4px" } }),
            React.createElement("div", { style: { display: "flex", gap: "8px", alignItems: "center", marginTop: "4px" } },
              React.createElement("input", { id: "dcs-wl-title-input", type: "text", placeholder: "如 Visual Studio Code / 记事本", style: S.input }),
              React.createElement("button", { type: "button", style: S.btn, onClick: function () { whitelistAdd("title", "dcs-wl-title-input"); } }, "加入标题白名单")
            )
          ),
          React.createElement("div", { id: "dcs-wl-path", style: Object.assign({}, S.muted, S.mono, { marginTop: "10px" }) })
        )
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
        return true;
      } catch (e) {
        try { console.warn("[dsh-console-sentinel] settings registration failed", e); } catch (e2) {}
        return false;
      }
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
    };
    exports.__dcsTest = {
      cache: cache,
      SettingsSection: SettingsSection,
      registerSettings: registerSettings,
      loadStatus: loadStatus
    };

    return module.exports;
  }
});
} catch (__dcsLoadErr) {
  try { console.error("[dsh-console-sentinel] client bundle failed to load", __dcsLoadErr); } catch (e) {}
}
