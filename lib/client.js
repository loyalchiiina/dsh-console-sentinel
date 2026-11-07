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
      desktop: null,
      taskbar: null,
      taskbarLoading: false,
      taskbarQueued: false,
      taskbarView: "icon",  // "icon" (compact icon grid, DEFAULT) | "detail" (grouped cards)
      autoTimer: null,
      visHooked: false
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
              cursor: closable ? "pointer" : "default", flex: "0 0 auto"
            });
            var ic = iconImg(w.icon, w.process);
            ic.style.width = "20px"; ic.style.height = "20px";
            cell.appendChild(ic);
            cell.title = (w.process || "?") + (w.title ? (" — " + w.title) : "") +
              (closable ? "（点击关闭此窗口）" : (w.whitelisted ? "（白名单，不可关闭）" : "（系统保护，不可关闭）"));
            if (closable) {
              cell.addEventListener("click", function (ev) {
                try { ev.preventDefault(); } catch (e) {}
                doWindow(w.hwnd, "close", Boolean(w.elevated), w.process);
              });
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

        // 操作栏 —— 全部动作压成一行（说明走 title 悬浮提示，不占版面）
        React.createElement("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" } },
          React.createElement("button", {
            type: "button", style: S.btn,
            title: "把「空壳」控制台窗口隐藏起来（进程不杀，可恢复）",
            onClick: function () { hideEmpty(); }
          }, "隐藏可见空壳"),
          React.createElement("button", {
            type: "button", style: S.btnDanger,
            title: "真正结束「空壳」控制台进程（只关 cmd/powershell/pwsh/python 且无任务在跑；宿主与 Fluent 不动）",
            onClick: function () { closeEmpty(); }
          }, "关闭空壳窗口"),
          React.createElement("span", { style: { width: "1px", height: "18px", background: TOKEN.borderSoft, flex: "0 0 auto" } }),
          React.createElement("button", {
            type: "button", style: S.btn,
            title: "预演：列出将被关闭的窗口（保护项与白名单自动跳过）",
            onClick: function () { desktopCleanup(true); }
          }, "预演清理"),
          React.createElement("button", {
            id: "dcs-exec-cleanup", type: "button", style: S.btnPrimary,
            title: "执行清理：关闭其他程序的窗口（需先预演；管理员窗口会弹一次 UAC）",
            onClick: function () { desktopCleanup(false); }
          }, "执行清理")
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
  }
} catch (__dcsLoadErr) {
  try { console.error("[dsh-console-sentinel] client bundle failed to load", __dcsLoadErr); } catch (e) {}
}
