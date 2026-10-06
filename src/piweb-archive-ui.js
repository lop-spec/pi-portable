// Pi Web 注入脚本（pi-portable UI 代理在 <head> 同步注入，必须早于 Next 执行：下面两层 fetch 包装
// 负责归档视图与速度 TIER）。只做四件事：目标暂停/恢复按钮、归档视图（列表头「归档 858」与行内归档）、
// 账号池额度、速度 TIER。DOM 契约见 pi-web-redesign/impl/dom-contract.md：控件只 append 进 React 预留的
// 空插槽（[data-pi-archive-slot] [data-pi-row-slot] [data-pi-composer-slot]），从不改 React 管理的子节点；
// 插槽缺失（旧版 pi-web）时降级为 fixed 浮层，console.warn 并上报代理日志。

// Shared slot watcher: one rAF-coalesced pass, scoped to the sidebar subtree and the composer
// area (plus childList-only watches on their ancestors to notice remounts). Never the whole
// document, never characterData outside the extension status shelf, never layout reads in
// slot mode. Also owns the single injected stylesheet and the proxy event log beacon.
(() => {
  "use strict";
  if (window.__piUiSlots) return;
  const SIDEBAR = 1, COMPOSER = 2, ALL = 3;
  const STARTUP_DISCOVERY_MS = 15_000;
  const HYDRATION_WAIT_MS = 10_000;
  const nativeFetch = window.fetch.bind(window);
  // Observable cost of the watcher (P23): passes, mutation records per scope, time spent, layout reads.
  const stats = { runs: 0, ms: 0, sidebarRecords: 0, composerRecords: 0, chainRecords: 0, mounts: 0, fallbacks: 0, hydrationWaits: 0, layoutReads: 0 };
  const clients = [];
  const sidebarListeners = new Set(), composerListeners = new Set(), reported = new Set();
  const chain = new Set();
  const slots = {
    archive: { selector: "[data-pi-archive-slot]", className: "pw-archive-slot", anchor: archiveAnchor, waitSince: 0, virtual: null, mode: "" },
    composer: { selector: "[data-pi-composer-slot]", className: "pw-composer-slot", anchor: composerAnchor, waitSince: 0, virtual: null, mode: "" },
  };
  let started = false, frame = 0, pending = 0, retry = 0, retryDelay = 50, startedAt = 0;
  let sidebar = null, composerRoot = null, shelf = null, fallbackListeners = false, anchorResize = null, observedAnchor = null;
  let sidebarObserver = null, composerObserver = null, shelfObserver = null, chainObserver = null;

  const CSS = `
[data-pi-slot-item]{display:contents}
[data-pi-slot-item] [hidden],[data-pi-fallback-slot][hidden]{display:none!important}
.pw-archive-ctl{display:inline-flex;align-items:center;gap:6px;min-width:0;margin-right:-4px}
.pw-archive-ctl .pw-btn{gap:5px}
.pw-archive-meta{color:var(--text-dim);font-size:var(--fs-meta);font-variant-numeric:tabular-nums;white-space:nowrap}
.pw-archive-meta::after{content:"·";margin-left:6px}
.pw-sess-row:not(:hover,:focus-within,.is-menu-open) [data-pi-row-slot]:has(>[data-pi-session-archive-action]){position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
[data-pi-session-archive-pending]{pointer-events:none!important;overflow:hidden!important}
[data-pi-session-archive-hidden]{display:none!important}
[data-pi-session-archive-handoff='true']{background:var(--bg-selected)!important}
[data-pi-session-archive-toast]{position:fixed;left:50%;bottom:24px;z-index:2147483647;transform:translateX(-50%);max-width:min(520px,calc(100vw - 32px));padding:8px 12px;border:1px solid var(--danger-border,var(--border));border-radius:var(--r-lg,8px);background:var(--bg-elevated,var(--bg));color:var(--danger,var(--text));box-shadow:var(--shadow-pop);font-size:var(--fs-meta,12px);line-height:var(--lh-ui,1.45)}
#pi-followup-toggle{position:fixed;z-index:800;display:inline-grid;place-items:center;width:24px;height:24px;padding:0;border:1px solid var(--border);border-radius:var(--r-sm,4px);background:var(--bg);color:var(--text-muted);font-size:var(--fs-meta,12px);cursor:pointer}
#pi-followup-toggle[hidden]{display:none}
#pi-followup-toggle:hover{border-color:var(--accent);color:var(--accent)}
#pi-followup-toggle:disabled{cursor:wait;opacity:.6}
#pi-followup-resume-notice{position:fixed;bottom:48px;left:50%;z-index:1000;max-width:90vw;transform:translateX(-50%);padding:8px 12px;border:1px solid var(--border-strong,var(--border));border-radius:var(--r-lg,8px);background:var(--bg-elevated,var(--bg));color:var(--text);box-shadow:var(--shadow-pop);font-size:var(--fs-ui,13px)}
.pw-quota-value{min-width:3ch;text-align:right}
.pw-quota-panel{padding:0;color:var(--text);font-size:var(--fs-ui)}
.pw-quota-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:36px;padding:0 12px;border-bottom:1px solid var(--border);background:var(--bg-elevated)}
.pw-quota-title{flex:none;font-weight:var(--fw-strong)}
.pw-quota-fresh{min-width:0;overflow:hidden;color:var(--text-dim);font-size:var(--fs-meta);font-variant-numeric:tabular-nums;text-overflow:ellipsis;white-space:nowrap}
.pw-quota-fresh[data-stale='true']{color:var(--warning)}
.pi-account-usage-row{display:flex;flex-direction:column;gap:2px;padding:8px 12px;border-top:1px solid var(--border)}
.pi-account-usage-row:first-child{border-top:0}
.pi-account-usage-row{position:relative}
.pi-account-usage-top{display:flex;align-items:center;gap:8px;min-height:24px}
.pi-account-usage-identity{display:flex;flex:1;align-items:center;gap:6px;min-width:0}
.pi-account-usage-email{min-width:0;overflow:hidden;color:var(--text);text-overflow:ellipsis;white-space:nowrap}
.pi-account-usage-row[data-active='true'] .pi-account-usage-email{font-weight:var(--fw-medium)}
.pi-account-usage-identity .pw-badge{flex:none}
.pi-account-usage-value{display:inline-flex;flex:none;align-items:center;gap:6px;color:var(--text-secondary);font-size:var(--fs-meta);font-variant-numeric:tabular-nums;white-space:nowrap}
.pi-account-usage-meter.pw-quota-bar{width:48px}
.pi-account-row-controls{display:inline-flex;flex:none;align-items:center;gap:2px}
.pi-account-usage-row:not(:hover,:focus-within) .pi-account-row-controls{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.pi-account-usage-row:is(:hover,:focus-within) .pi-account-usage-value{display:none}
@media (hover:none){.pi-account-usage-row .pi-account-row-controls{position:static;width:auto;height:auto;overflow:visible;clip-path:none}.pi-account-usage-row .pi-account-usage-value{display:none}}
.pi-account-usage-meta{display:flex;flex-wrap:wrap;color:var(--text-dim);font-size:var(--fs-meta);font-variant-numeric:tabular-nums}
.pi-account-usage-meta>span+span::before{margin:0 5px;content:'·'}
.pi-account-usage-warning{display:flex;align-items:flex-start;gap:5px;color:var(--warning);font-size:var(--fs-meta);overflow-wrap:anywhere}
.pi-account-usage-warning>svg{flex:none;width:13px;height:13px;margin-top:2px}
.pi-account-remove-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding-top:6px}
.pi-account-remove-confirm>span{flex-basis:100%;color:var(--text-secondary);font-size:var(--fs-meta)}
.pi-account-usage-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:64px;padding:12px;color:var(--text-muted);text-align:center}
.pi-account-usage-empty-title{font-weight:var(--fw-medium)}
.pi-account-usage-empty-note{color:var(--text-dim);font-size:var(--fs-meta)}
#pi-account-login-box{display:flex;flex-direction:column;gap:6px;padding:0 12px;font-size:var(--fs-meta);overflow-wrap:anywhere}
#pi-account-login-box:not(:empty){padding:8px 12px;border-top:1px solid var(--border)}
#pi-account-login-box a{color:var(--accent);text-decoration:underline}
#pi-account-login-box form{display:flex;flex-direction:column;gap:6px}
.pi-account-login-hint{color:var(--text-muted)}
.pi-account-login-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 6px;border-top:1px solid var(--border)}
.pw-quota-note{padding:0 12px 8px;color:var(--warning);font-size:var(--fs-meta)}
.pw-quota-note:empty{display:none}
.pw-tier-menu{width:auto;min-width:168px}
.pw-tier-note{margin:4px 8px;color:var(--warning);font-size:var(--fs-meta);line-height:var(--lh-ui)}
.pw-tier-note:empty{display:none}
[data-pi-fallback-slot]{position:fixed;z-index:210;display:inline-flex;align-items:center;gap:2px}
[data-pi-fallback-slot] .pw-slot-popover{position:absolute;right:0;bottom:calc(100% + 8px);width:320px;max-width:calc(100vw - 16px);max-height:min(420px,70vh);overflow:auto;padding:4px;border:1px solid var(--border-strong,var(--border));border-radius:var(--r-lg,8px);background:var(--bg-elevated,var(--bg));box-shadow:var(--shadow-pop,0 8px 24px color-mix(in srgb,var(--text) 16%,transparent))}
[data-pi-fallback-slot] .pw-tier-menu{width:auto;min-width:168px}
[data-pi-fallback-slot] button{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:0 6px;border:0;border-radius:var(--r-md,6px);background:transparent;color:var(--text-muted);font:inherit;font-size:var(--fs-meta,12px);cursor:pointer}
[data-pi-fallback-slot] button:hover{background:var(--bg-hover);color:var(--text)}
[data-pi-fallback-slot] .pw-menu-item{width:100%;justify-content:flex-start}
[data-pi-fallback-slot] .pw-quota-bar{display:inline-block;width:26px;height:4px;overflow:hidden;border-radius:2px;background:var(--border-strong,var(--border))}
[data-pi-fallback-slot] .pw-quota-bar>i{display:block;height:100%;background:var(--text-muted)}
`;

  function ensureStyle() {
    if (!document.head || document.querySelector("style[data-pi-ui-style]")) return;
    const style = document.createElement("style");
    style.dataset.piUiStyle = "v1";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const reactOwned = node => Object.keys(node).some(key => key.startsWith("__reactFiber$"));

  // Same order as the app's useI18n: an explicit pi-locale wins; otherwise Chinese, which is what
  // every redesigned surface renders (the injected copy has zh-CN/zh-TW/en tables).
  function locale() {
    try {
      const stored = localStorage.getItem("pi-locale");
      if (stored === "en" || stored === "zh-CN" || stored === "zh-TW") return stored;
    } catch { /* storage is optional */ }
    const lang = String(document.documentElement?.lang || "").toLowerCase();
    if (lang.includes("zh-tw") || lang.includes("zh-hant")) return "zh-TW";
    const nav = String(globalThis.navigator?.language || "").toLowerCase();
    if (nav.includes("zh-tw") || nav.includes("zh-hant")) return "zh-TW";
    return "zh-CN";
  }

  // Fail-open paths must leave a trace in the existing proxy log (piweb-ui-proxy.log), once per page.
  function report(event, detail = {}) {
    const key = `${event}:${JSON.stringify(detail)}`;
    if (reported.has(key)) return;
    reported.add(key);
    nativeFetch("/__pi_ui_event", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, detail }), keepalive: true,
    }).catch(error => console.warn("[pi-web ui] event log unavailable:", event, String(error?.message || error)));
  }

  function warnOnce(event, message, detail) {
    if (reported.has(`warn:${event}`)) return;
    reported.add(`warn:${event}`);
    console.warn(message, detail);
    report(event, detail);
  }

  function schedule(flags = ALL) {
    pending |= flags;
    if (!frame && started) frame = requestAnimationFrame(run);
  }

  function retryLater() {
    if (retry) return;
    retry = setTimeout(() => { retry = 0; schedule(ALL); }, retryDelay);
    retryDelay = Math.min(1000, retryDelay * 2);
  }

  function visibleRect(element) {
    if (!element?.isConnected) return null;
    stats.layoutReads++;
    const rect = element.getBoundingClientRect();
    return rect.width && rect.height ? rect : null;
  }

  // Fallback anchors exist only on older pi-web builds without the redesign slots.
  function archiveAnchor() {
    const buttons = document.querySelector(".sidebar-container")?.querySelectorAll("button[title]") || [];
    for (const button of buttons) {
      if (/new session|新建会话|新增工作階段/iu.test(button.getAttribute("title") || "")) return visibleRect(button);
    }
    return null;
  }

  function composerAnchor() {
    const models = document.querySelectorAll(".model-selector.is-toolbar");
    for (let index = models.length - 1; index >= 0; index -= 1) {
      const rect = visibleRect(models[index]);
      if (rect) return rect;
    }
    return null;
  }

  function insertOrdered(target, host, order) {
    const before = [...target.children].find(node => node !== host && Number(node.dataset?.piSlotOrder) > order);
    if (before) target.insertBefore(host, before); else target.appendChild(host);
  }

  // Returns the element the slot's clients belong in, or null; `waiting` asks for a retry.
  function resolve(name) {
    const def = slots[name];
    const slot = document.querySelector(def.selector);
    if (slot) {
      if (!reactOwned(slot)) {
        // React has not hydrated this node yet: children appended now would be a hydration mismatch.
        def.waitSince ||= performance.now();
        if (performance.now() - def.waitSince < HYDRATION_WAIT_MS) { stats.hydrationWaits++; return { target: null, waiting: true }; }
        warnOnce(`slot-unhydrated-${name}`, `[pi-web ui] ${def.selector} was never claimed by React; mounting anyway`, { slot: name });
      }
      def.waitSince = 0;
      if (def.mode === "fallback") console.info(`[pi-web ui] ${def.selector} appeared; leaving the fixed fallback`);
      def.mode = "slot";
      if (def.virtual) def.virtual.hidden = true;
      return { target: slot, waiting: false };
    }
    const rect = def.anchor();
    if (!rect) {
      if (def.virtual) def.virtual.hidden = true;
      return { target: null, waiting: performance.now() - startedAt < STARTUP_DISCOVERY_MS };
    }
    if (!def.virtual) {
      def.virtual = document.createElement("span");
      def.virtual.className = def.className;
      def.virtual.dataset.piFallbackSlot = name;
      document.body.appendChild(def.virtual);
    }
    if (def.mode !== "fallback") {
      def.mode = "fallback";
      stats.fallbacks++;
      warnOnce(`slot-missing-${name}`, `[pi-web ui] ${def.selector} missing; injected controls use the fixed fallback`, { slot: name });
      if (!fallbackListeners) {
        fallbackListeners = true;
        window.addEventListener("resize", () => schedule(ALL), { passive: true });
        anchorResize = new ResizeObserver(() => schedule(ALL));
      }
    }
    def.virtual.hidden = false;
    def.virtual.style.top = `${Math.round(rect.top)}px`;
    def.virtual.style.height = `${Math.round(rect.height)}px`;
    def.virtual.style.right = `${Math.max(4, Math.round(innerWidth - rect.left + 6))}px`;
    return { target: def.virtual, waiting: false };
  }

  function rebindChain() {
    chainObserver.disconnect();
    chain.clear();
    for (const root of [sidebar, composerRoot]) {
      for (let node = root?.parentElement; node && node !== document.documentElement; node = node.parentElement) {
        if (!chain.has(node)) { chain.add(node); chainObserver.observe(node, { childList: true }); }
      }
    }
  }

  function bindSidebar() {
    const next = document.querySelector(".sidebar-container");
    if (next === sidebar) return false;
    sidebarObserver.disconnect();
    sidebar = next;
    if (sidebar) sidebarObserver.observe(sidebar, { childList: true, subtree: true, attributes: true, attributeFilter: ["tabindex", "aria-current"] });
    rebindChain();
    return true;
  }

  function bindComposer() {
    const anchor = document.querySelector("[data-pi-composer-slot]") || document.querySelector(".model-selector.is-toolbar");
    const root = anchor ? (anchor.closest(".pw-composer-wrap, fieldset, form")?.parentElement || anchor.parentElement) : null;
    let changed = false;
    if (root !== composerRoot) {
      composerObserver.disconnect();
      composerRoot = root;
      if (root) composerObserver.observe(root, { childList: true });
      rebindChain();
      changed = true;
    }
    const nextShelf = document.querySelector(".extension-status-shelf");
    if (nextShelf !== shelf) {
      shelfObserver.disconnect();
      shelf = nextShelf;
      // The goal status text changes in place (text node value), so only this small subtree
      // is watched with characterData.
      if (shelf) shelfObserver.observe(shelf, { childList: true, subtree: true, characterData: true });
      changed = true;
    }
    return changed;
  }

  function call(listener) {
    try { listener(); } catch (error) { console.error("[pi-web ui] slot listener failed:", error); }
  }

  function run() {
    const began = performance.now();
    try { pass(); } finally { stats.ms += performance.now() - began; }
  }

  function pass() {
    frame = 0;
    stats.runs++;
    let flags = pending;
    pending = 0;
    if (bindSidebar()) flags |= SIDEBAR;
    if (bindComposer()) flags |= COMPOSER;
    let waiting = (!sidebar || !composerRoot) && performance.now() - startedAt < STARTUP_DISCOVERY_MS;
    let fallbackAnchor = null;
    for (const name of Object.keys(slots)) {
      const members = clients.filter(client => client.slot === name);
      if (!members.length) continue;
      const { target, waiting: wait } = resolve(name);
      waiting ||= wait;
      if (!target) continue;
      for (const client of members) {
        if (client.host.parentNode !== target) {
          insertOrdered(target, client.host, client.order);
          stats.mounts++;
          call(() => client.onMount?.(slots[name].mode));
        }
      }
      if (name === "composer" && slots[name].mode === "fallback") fallbackAnchor = document.querySelector(".model-selector.is-toolbar");
    }
    // The fallback follows the model selector's width; observe a node only when it changes,
    // since a fresh observation always reports once (re-observing every pass would loop).
    if (anchorResize && fallbackAnchor !== observedAnchor) {
      anchorResize.disconnect();
      observedAnchor = fallbackAnchor;
      if (observedAnchor) anchorResize.observe(observedAnchor);
    }
    if (flags & SIDEBAR) for (const listener of sidebarListeners) call(listener);
    if (flags & COMPOSER) for (const listener of composerListeners) call(listener);
    if (waiting) retryLater();
    else retryDelay = 50;
  }

  function ownMutation(record) {
    const target = record.target;
    if (target.nodeType !== 1) return false;
    if (record.type === "attributes") return Boolean(target.closest("[data-pi-slot-item],[data-pi-session-archive-action]"));
    return Boolean(target.closest("[data-pi-slot-item],[data-pi-row-slot],[data-pi-archive-slot]"));
  }

  sidebarObserver = new MutationObserver(records => {
    stats.sidebarRecords += records.length;
    if (records.some(record => !ownMutation(record))) schedule(SIDEBAR);
  });
  composerObserver = new MutationObserver(records => { stats.composerRecords += records.length; schedule(COMPOSER); });
  shelfObserver = new MutationObserver(records => { stats.composerRecords += records.length; schedule(COMPOSER); });
  chainObserver = new MutationObserver(records => {
    stats.chainRecords += records.length;
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node.nodeType === 1 && ((sidebar && node.contains(sidebar)) || (composerRoot && node.contains(composerRoot)))) { schedule(ALL); return; }
      }
      if (sidebar && composerRoot) continue;
      for (const node of record.addedNodes) {
        if (node.nodeType === 1 && (node.matches(".sidebar-container,.pw-composer-wrap") || node.querySelector(".sidebar-container,[data-pi-composer-slot],.model-selector"))) { schedule(ALL); return; }
      }
    }
  });

  function start() {
    if (started) return;
    started = true;
    startedAt = performance.now();
    ensureStyle();
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") schedule(ALL); });
    window.addEventListener("popstate", () => schedule(ALL));
    document.addEventListener("focusin", () => { if (!sidebar?.isConnected || !composerRoot?.isConnected) schedule(ALL); }, true);
    schedule(ALL);
  }

  window.__piUiSlots = {
    stats,
    locale,
    report,
    warnOnce,
    reactOwned,
    register(client) { clients.push(client); schedule(ALL); },
    onSidebarChange(listener) { sidebarListeners.add(listener); schedule(SIDEBAR); },
    onComposerChange(listener) { composerListeners.add(listener); schedule(COMPOSER); },
    schedule,
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();
})();

// Goal pause/resume: a small fixed button beside the goal status. Its body portal never
// changes React-owned status text or children; commands own the actual mode.
(() => {
  "use strict";
  if (window.__piFollowupResumeUi) return;
  window.__piFollowupResumeUi = true;
  const modes = { "目标 · 彻底": "thorough", "目标 · 达标": "target", "目标 · 根因": "root-cause", "目标 · 根治": "root-fix", "计划": "plan" };
  const pending = new Set();
  const modeOf = text => modes[String(text || "").trim().match(/^自动追问\s*·\s*(.*?)\s*·\s*(?:已暂停|待发送|\d+\/\d+)$/u)?.[1]];
  const paused = text => /·\s*已暂停$/u.test(String(text || "").trim());
  let button, anchor, resize;
  const session = () => new URL(location.href).searchParams.get("session");
  let frame = 0, note;
  function notify(message, error = false) {
    if (!note) {
      note = document.createElement("div");
      note.id = "pi-followup-resume-notice";
      note.tabIndex = 0;
      note.title = "点击关闭";
      note.addEventListener("click", () => { note.hidden = true; });
      note.addEventListener("keydown", event => { if (event.key === "Escape") note.hidden = true; });
      document.body.appendChild(note);
    }
    note.setAttribute("role", error ? "alert" : "status");
    note.textContent = message;
    note.hidden = false;
  }
  async function command(id, body) {
    const response = await fetch(`/api/agent/${encodeURIComponent(id)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || result.error || result.success === false) throw new Error(result.error || `HTTP ${response.status}`);
    return result.data;
  }
  async function toggle(element) {
    const id = session(), mode = modeOf(element.textContent);
    if (!id || !mode || pending.has(id)) return;
    const action = paused(element.textContent) ? "resume" : "pause";
    const ensureCurrent = () => { if (session() !== id || !element.isConnected) throw new Error("会话已切换，操作已取消"); };
    pending.add(id); refresh();
    try {
      const state = await command(id, { type: "get_state" });
      const status = state.extensionStatuses?.find(item => item.key === "lop-followup");
      if (modeOf(status?.text) !== mode || paused(status?.text) !== (action === "resume")) throw new Error("目标状态已变化，请以最新状态为准");
      let result = await command(id, { type: "get_commands" });
      const supported = value => value.commands?.some(item => item.name === "lop-followup-control" && item.source === "extension");
      if (!supported(result)) {
        ensureCurrent();
        console.info("[lop-followup-ui] loading controls reason=old-extension-runtime");
        // Official resource reload replaces future handlers; it does not abort
        // the agent. The extension restores its saved goal in paused state.
        await command(id, { type: "reload" });
        result = await command(id, { type: "get_commands" });
      }
      if (!supported(result)) throw new Error("目标控制扩展未加载，未发送操作命令");
      ensureCurrent();
      await command(id, { type: "prompt", message: `/lop-followup-control ${action} ${mode}` });
      const updated = await command(id, { type: "get_state" });
      const text = updated.extensionStatuses?.find(item => item.key === "lop-followup")?.text;
      if (action === "pause" ? !paused(text) : text && (paused(text) || /待发送/u.test(text))) throw new Error("目标状态未切换，请稍后重试");
      if (session() === id) notify(action === "pause" ? "目标已暂停，当前执行不中断。" : "已恢复上次目标并继续执行。");
    } catch (error) {
      console.error("[lop-followup-ui] toggle failed:", error);
      if (session() === id) notify(`目标切换失败：${error instanceof Error ? error.message : String(error)}`, true);
    } finally { pending.delete(id); refresh(); }
  }
  function refresh() {
    const next = [...document.querySelectorAll(".extension-status-text")].find(text => modeOf(text.textContent));
    if (next !== anchor) {
      resize?.disconnect(); anchor = next;
      if (anchor) {
        resize?.observe(anchor);
        const shelf = anchor.closest?.(".extension-status-shelf");
        if (shelf) resize?.observe(shelf);
      }
    }
    if (!anchor || !session()) { if (button) button.hidden = true; return; }
    if (!button) {
      button = document.createElement("button");
      button.id = "pi-followup-toggle";
      button.type = "button";
      button.addEventListener("click", () => { if (anchor && !button.disabled) void toggle(anchor); });
      document.body.appendChild(button);
    }
    // The native status span is flex:1 and stretches across the whole footer.
    // Measure the last rendered text fragment, not that full-width element.
    const range = document.createRange();
    range.selectNodeContents(anchor);
    const rect = [...range.getClientRects()].filter(item => item.width && item.height).at(-1);
    button.hidden = !rect || rect.bottom <= 0 || rect.top >= innerHeight;
    if (button.hidden) return;
    button.disabled = pending.has(session());
    const isPaused = paused(anchor.textContent);
    button.textContent = isPaused ? "▶" : "⏸";
    button.setAttribute("aria-label", isPaused ? "恢复目标" : "暂停目标");
    button.setAttribute("aria-busy", String(button.disabled));
    button.title = button.disabled ? "正在切换目标状态…" : isPaused ? "恢复上次目标并立即继续" : "暂停目标（不中断当前执行）";
    button.style.left = `${Math.max(4, Math.min(rect.right + 6, innerWidth - 28))}px`;
    button.style.top = `${Math.max(0, Math.min(rect.top + (rect.height - 24) / 2, innerHeight - 24))}px`;
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; refresh(); });
  }
  function start() {
    resize = new ResizeObserver(schedule);
    // The shared slot watcher reports status shelf insertion/removal and its text changes;
    // no document-wide observer and no scroll hook (the shelf sits below the transcript).
    window.__piUiSlots?.onComposerChange(schedule);
    window.addEventListener("popstate", schedule);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    refresh();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();
})();

// Session archive view: list-head control in [data-pi-archive-slot], per-row action in
// [data-pi-row-slot], and the fetch rewrite that must run before Next's first /api/sessions.
(() => {
  "use strict";

  const VERSION = "piweb-session-archive-v9";
  const VIEW_KEY = "piweb-session-archive-view";
  if (window.__piSessionArchiveUiVersion === VERSION) return;
  window.__piSessionArchiveUiVersion = VERSION;

  const nativeFetch = window.fetch.bind(window);
  const state = {
    view: (() => {
      try { return sessionStorage.getItem(VIEW_KEY) === "archived" ? "archived" : "active"; }
      catch { return "active"; }
    })(),
    archivedCount: 0,
    scheduled: false,
    listRequestSerial: 0,
    lastRequestedListView: "",
    pendingActions: [],
    optimisticActions: new Set(),
    optimisticLayouts: new Map(),
  };

  const copy = {
    en: {
      archive: "Archive",
      restore: "Restore",
      actionArchive: "Archive",
      actionRestore: "Restore",
      archiveTitle: "Archive this conversation",
      restoreTitle: "Restore this conversation",
      showArchived: (count) => `View archived sessions (${count})`,
      showActive: "Back to active sessions",
      archivedView: "Archive",
      back: "Back",
      archivedConversations: (count) => `${count} conversations`,
      emptyArchive: "No archived sessions",
      requestFailed: "Session archive request failed",
    },
    "zh-CN": {
      archive: "归档",
      restore: "恢复",
      actionArchive: "归档",
      actionRestore: "恢复",
      archiveTitle: "归档这个会话",
      restoreTitle: "恢复这个会话",
      showArchived: (count) => `查看归档会话（${count}）`,
      showActive: "返回当前会话",
      archivedView: "归档",
      back: "返回",
      archivedConversations: (count) => `${count} 个对话`,
      emptyArchive: "暂无归档会话",
      requestFailed: "会话归档请求失败",
    },
    "zh-TW": {
      archive: "歸檔",
      restore: "還原",
      actionArchive: "歸檔",
      actionRestore: "還原",
      archiveTitle: "歸檔這個工作階段",
      restoreTitle: "還原這個工作階段",
      showArchived: (count) => `檢視歸檔工作階段（${count}）`,
      showActive: "返回目前工作階段",
      archivedView: "歸檔",
      back: "返回",
      archivedConversations: (count) => `${count} 個對話`,
      emptyArchive: "沒有歸檔工作階段",
      requestFailed: "工作階段歸檔請求失敗",
    },
  };

  const refreshTitles = new Set(["Refresh", "刷新", "重新整理"]);
  const forwardedActionEvents = new WeakSet();

  function language() { return window.__piUiSlots?.locale() || "zh-CN"; }

  function words() { return copy[language()] || copy["zh-CN"]; }

  function icon(kind) {
    if (kind === "restore") {
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/><path d="M12 7v5l3 2"/></svg>';
    }
    if (kind === "back") {
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>';
    }
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h18v13H3z"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>';
  }

  function requestUrl(input) {
    try {
      const value = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      return new URL(value, window.location.href);
    } catch { return null; }
  }

  function rewrittenInput(input, url) {
    if (input instanceof Request) return new Request(url.href, input);
    if (input instanceof URL) return new URL(url.href);
    return url.href;
  }

  function normalizeWorktreePath(value) {
    return String(value ?? "").replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
  }

  // Treat Pi Web's own <repo>-worktrees directory as the project-category
  // namespace. Agent-created checkouts elsewhere (for example
  // .claude/worktrees) remain usable by their sessions, but never clutter the
  // category switcher. This is derived from paths, so there is no registry to
  // maintain and existing user-created worktrees are discovered automatically.
  // Returns null when nothing needs hiding, so the native response is kept as is.
  function filterProjectCategoryWorktrees(body) {
    if (!body || typeof body !== "object" || typeof body.projectRoot !== "string" || !Array.isArray(body.worktrees)) {
      throw new Error("unexpected /api/worktrees response shape");
    }
    // Non-git projects (isGit:false) list no worktrees: there is nothing to filter.
    if (body.worktrees.length === 0) return null;
    const projectRoot = normalizeWorktreePath(body.projectRoot);
    if (!projectRoot) throw new Error("project root is empty");
    const categoryRoot = `${projectRoot}-worktrees/`;
    const worktrees = body.worktrees.filter((worktree) => (
      worktree?.isMain === true || normalizeWorktreePath(worktree?.path).startsWith(categoryRoot)
    ));
    const mainWorktree = worktrees.find((worktree) => worktree?.isMain === true);
    if (!mainWorktree?.path) throw new Error("main worktree is missing");
    const visiblePaths = new Set(worktrees.map((worktree) => normalizeWorktreePath(worktree?.path)));
    const currentWorktreePath = visiblePaths.has(normalizeWorktreePath(body.currentWorktreePath))
      ? body.currentWorktreePath
      : mainWorktree.path;
    if (worktrees.length === body.worktrees.length && currentWorktreePath === body.currentWorktreePath) return null;
    return { ...body, currentWorktreePath, worktrees };
  }

  async function projectCategoryWorktreeResponse(response) {
    const body = filterProjectCategoryWorktrees(await response.clone().json());
    if (!body) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  function showError(message) {
    if (!document.body) return;
    document.querySelector("[data-pi-session-archive-toast]")?.remove();
    const toast = document.createElement("div");
    toast.dataset.piSessionArchiveToast = "true";
    toast.setAttribute("role", "alert");
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  function acceptArchivedCount(response) {
    // The UI proxy puts the group count in a header so the 44-886 KB list is parsed only once (by Next).
    const header = response.headers.get("x-pi-archived-count");
    const count = header === null ? Number.NaN : Number(header);
    if (Number.isFinite(count) && count >= 0) {
      if (count !== state.archivedCount) { state.archivedCount = count; scheduleDecorate(); }
      return;
    }
    window.__piUiSlots?.warnOnce?.("archived-count-header-missing", "[pi-web archive] x-pi-archived-count missing; reading the list body", {});
    void response.clone().json().then((body) => {
      const value = Number(body?.archive?.archivedCount);
      if (Number.isFinite(value) && value >= 0) state.archivedCount = value;
      scheduleDecorate();
    }).catch(() => {});
  }

  window.fetch = async function piSessionArchiveFetch(input, init) {
    const url = requestUrl(input);
    const requestMethod = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const isWorktreeListRequest = Boolean(
      url && url.origin === window.location.origin && url.pathname === "/api/worktrees" && requestMethod === "GET"
    );
    let method = requestMethod;
    let action = "";
    let requestedListView = "";
    let pendingAction = null;
    let nextInput = input;
    const nextInit = init ? { ...init } : {};

    if (url && url.origin === window.location.origin && url.pathname === "/api/sessions" && method === "GET") {
      requestedListView = state.view;
      state.listRequestSerial += 1;
      state.lastRequestedListView = requestedListView;
      if (requestedListView === "archived") url.searchParams.set("archiveView", "archived");
      else url.searchParams.delete("archiveView");
      nextInput = rewrittenInput(input, url);
    } else if (url && url.origin === window.location.origin && /^\/api\/sessions\/[^/]+$/u.test(url.pathname) && method === "DELETE") {
      action = state.view === "archived" ? "restore" : "archive";
      pendingAction = state.pendingActions.shift() || null;
      if (pendingAction) {
        pendingAction.started = true;
        clearTimeout(pendingAction.timeout);
      }
      url.pathname += action === "restore" ? "/restore" : "/archive";
      nextInput = rewrittenInput(input, url);
      method = "POST";
      nextInit.method = "POST";
      delete nextInit.body;
    }

    let response;
    try {
      response = await nativeFetch(nextInput, nextInit);
    } catch (error) {
      if (action) {
        const detail = String(error?.message || error || "network error");
        const message = `${words().requestFailed}：${detail}`;
        console.error("[pi-web archive]", message);
        restoreOptimisticAction(pendingAction);
        showError(message);
      } else if (isWorktreeListRequest) {
        console.error("[pi-web worktrees] list request failed:", error);
      }
      throw error;
    }
    if (isWorktreeListRequest) {
      if (!response.ok) {
        console.error(`[pi-web worktrees] list request returned HTTP ${response.status}`);
      } else {
        try {
          response = await projectCategoryWorktreeResponse(response);
        } catch (error) {
          // Fail open so an upstream response-shape change does not break the
          // selector, but never make the visibility policy fail silently.
          console.error("[pi-web worktrees] visibility filter failed:", error);
        }
      }
    }
    // A delete callback refresh and an immediate archive-view toggle can overlap.
    // Never let the older view's slower response overwrite the current React list.
    for (let retry = 0; requestedListView && requestedListView !== state.view && retry < 3; retry += 1) {
      requestedListView = state.view;
      state.listRequestSerial += 1;
      state.lastRequestedListView = requestedListView;
      if (requestedListView === "archived") url.searchParams.set("archiveView", "archived");
      else url.searchParams.delete("archiveView");
      nextInput = rewrittenInput(nextInput, url);
      response = await nativeFetch(nextInput, nextInit);
    }
    if (requestedListView && response.ok) acceptArchivedCount(response);
    if (action && !response.ok) {
      let detail = "";
      try { detail = String((await response.clone().json())?.error || ""); } catch {}
      const message = `${words().requestFailed}${detail ? `：${detail}` : ` (HTTP ${response.status})`}`;
      console.error("[pi-web archive]", message);
      restoreOptimisticAction(pendingAction);
      showError(message);
      throw new Error(message);
    }
    return response;
  };

  function nativeRefreshButton() {
    return [...document.querySelectorAll("button[title]")].find((button) => (
      refreshTitles.has(button.getAttribute("title") || "") && !button.dataset.piSessionArchiveControl
    )) || null;
  }

  function requestNativeRefresh() {
    // The redesigned sidebar listens for this event; older builds exposed a 刷新 button.
    if (document.querySelector("[data-pi-archive-slot]")) {
      document.dispatchEvent(new Event("pi-web:refresh-sessions"));
      return;
    }
    const button = nativeRefreshButton();
    if (button) button.click();
    else console.error("[pi-web archive] session refresh control unavailable");
  }

  function requestListRefresh(baselineSerial, expectedView, attempt = 0) {
    if (state.view !== expectedView) return;
    if (state.listRequestSerial > baselineSerial && state.lastRequestedListView === expectedView) return;
    requestNativeRefresh();
    const delays = [120, 240, 480, 800];
    setTimeout(() => {
      if (state.view !== expectedView) return;
      if (state.listRequestSerial > baselineSerial && state.lastRequestedListView === expectedView) return;
      if (attempt < delays.length - 1) requestListRefresh(baselineSerial, expectedView, attempt + 1);
      else window.location.reload();
    }, delays[attempt]);
  }

  // List-head control: 「归档 858」 in the active view; 「858 个对话 · 返回」 in the archived view.
  // One button keeps keyboard focus across the toggle; React renders the label on its left.
  let host = null, control = null, meta = null;
  function archiveHost() {
    if (host) return host;
    host = document.createElement("span");
    host.className = "pw-archive-ctl";
    host.dataset.piSlotItem = "archive";
    host.dataset.piSlotOrder = "0";
    meta = document.createElement("span");
    meta.className = "pw-archive-meta";
    meta.hidden = true;
    control = document.createElement("button");
    control.type = "button";
    control.className = "pw-btn pw-btn--ghost pw-btn--sm";
    control.dataset.piSessionArchiveControl = "true";
    control.addEventListener("click", () => {
      for (const pending of [...state.optimisticActions]) restoreOptimisticAction(pending);
      const baselineSerial = state.listRequestSerial;
      state.view = state.view === "active" ? "archived" : "active";
      try { sessionStorage.setItem(VIEW_KEY, state.view); } catch {}
      decorate();
      requestListRefresh(baselineSerial, state.view);
    });
    host.append(meta, control);
    return host;
  }

  // Archived-view head count = the SELECTED project's archived conversations. The proxy header (state.archivedCount) counts every
  // project, but the list is filtered to the selected one (QA F13: "858 个对话" above 「没有已归档的会话」), so the redesigned sidebar
  // publishes the number it actually shows in html[data-pi-session-archive-project-count]; it leaves the attribute off while the new
  // list is still loading, and then no number is shown rather than a wrong one. A sidebar without the archive slot never publishes
  // it and keeps the global number.
  function archivedHeaderCount() {
    const raw = document.documentElement.dataset.piSessionArchiveProjectCount;
    if (raw !== undefined) {
      const count = Number(raw);
      return Number.isFinite(count) && count >= 0 ? count : null;
    }
    return host?.closest?.("[data-pi-archive-slot]") ? null : state.archivedCount;
  }

  function renderControl() {
    if (!control) return;
    const text = words();
    const archivedView = state.view === "archived";
    const label = archivedView ? text.showActive : text.showArchived(state.archivedCount);
    if (control.title !== label) control.title = label;
    if (control.getAttribute("aria-label") !== label) control.setAttribute("aria-label", label);
    const markup = archivedView
      ? `${icon("back")}<span>${text.back}</span>`
      : `${icon("archive")}<span>${text.archivedView}</span>${state.archivedCount > 0 ? `<span class="pw-num">${state.archivedCount}</span>` : ""}`;
    if (control.innerHTML !== markup) control.innerHTML = markup;
    const headerCount = archivedView ? archivedHeaderCount() : null;
    const metaText = headerCount === null ? "" : text.archivedConversations(headerCount);
    if (meta.textContent !== metaText) meta.textContent = metaText;
    meta.hidden = !metaText;
  }

  // No per-row archive shortcut (lop 2026-09-15「remove row archive shortcut and reclaim title width」,
  // 4c3c575): archiving goes through the row ⋯ menu (pi-web:archive-session). The empty
  // [data-pi-row-slot] stays reserved; anything left in it by an older script build is removed.
  function decorateRows() {
    const root = document.querySelector(".sidebar-container");
    if (!root) return;
    for (const action of root.querySelectorAll("[data-pi-session-row] [data-pi-row-slot] > [data-pi-session-archive-action]")) action.remove();
  }

  function sessionRow(button) {
    return button?.closest?.("[data-pi-session-row]") || null;
  }

  // Rows and date-group headers are absolutely positioned virtual-list children.
  // Shrinking the row alone cannot move its neighbours. Animate wrappers,
  // leaving React's top/height coordinates untouched, until it reconciles.
  function syncOptimisticLayout(animate = false) {
    if (!state.optimisticActions.size && !state.optimisticLayouts.size) return;
    const removed = [...state.optimisticActions].filter(item => item.row?.isConnected);
    const offsets = new Map();
    for (const node of document.querySelectorAll('.sidebar-container [data-pi-session-id], .sidebar-container .pw-sess-group')) {
      const wrapper = node.dataset?.piSessionId ? node.parentElement : node;
      if (wrapper?.style.position !== 'absolute') continue;
      const top = Number.parseFloat(wrapper.style.top);
      if (!Number.isFinite(top)) continue;
      const offset = removed.reduce((sum, item) => {
        const other = item.row.parentElement;
        return other?.parentElement === wrapper.parentElement && Number.parseFloat(other.style.top) < top
          ? sum - item.rowHeight : sum;
      }, 0);
      if (offset) offsets.set(wrapper, { offset, top });
    }
    for (const [wrapper, previous] of state.optimisticLayouts) {
      if (!offsets.has(wrapper)) {
        previous.animation.cancel();
        state.optimisticLayouts.delete(wrapper);
      }
    }
    for (const [wrapper, { offset, top }] of offsets) {
      const previous = state.optimisticLayouts.get(wrapper);
      if (previous?.offset === offset && previous.top === top) continue;
      const from = getComputedStyle(wrapper).transform;
      previous?.animation.cancel();
      const animation = wrapper.animate([
        { transform: from === 'none' ? 'translateY(0)' : from },
        { transform: `translateY(${offset}px)` },
      ], { duration: animate && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 180 : 0,
        easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' });
      state.optimisticLayouts.set(wrapper, { offset, top, animation });
    }
  }

  function restoreOptimisticAction(pending) {
    if (!pending) return;
    clearTimeout(pending.timeout);
    clearTimeout(pending.hideTimer);
    clearTimeout(pending.cleanupTimer);
    clearTimeout(pending.handoffTimer);
    pending.animation?.cancel();
    state.optimisticActions.delete(pending);
    syncOptimisticLayout();
    if (pending.button?.isConnected) delete pending.button.dataset.piSessionArchiveBusy;
    if (pending.nextRow?.isConnected) delete pending.nextRow.dataset.piSessionArchiveHandoff;
    if (!pending.row?.isConnected) return;
    delete pending.row.dataset.piSessionArchivePending;
    delete pending.row.dataset.piSessionArchiveHidden;
    pending.row.style.display = pending.display;
    pending.row.style.opacity = pending.opacity;
    pending.row.style.transform = pending.transform;
    pending.row.style.pointerEvents = pending.pointerEvents;
    pending.row.style.transition = pending.transition;
    pending.row.removeAttribute("aria-busy");
  }

  function isSelectedRow(row) {
    return row?.getAttribute?.("aria-current") === "page" || Boolean(row?.classList?.contains("is-selected"));
  }

  function beginOptimisticAction(button, explicitRow = null) {
    const row = explicitRow || sessionRow(button);
    if (!row) return null;
    const pending = {
      row,
      button,
      display: row.style.display,
      opacity: row.style.opacity,
      transform: row.style.transform,
      pointerEvents: row.style.pointerEvents,
      transition: row.style.transition,
      started: false,
      hideTimer: 0,
      timeout: 0,
      cleanupTimer: 0,
      animation: null,
      wasSelected: isSelectedRow(row),
      nextRow: adjacentSessionRow(row),
      handedOff: false,
    };
    state.optimisticActions.add(pending);
    row.dataset.piSessionArchivePending = "true";
    row.setAttribute("aria-busy", "true");
    row.style.pointerEvents = "none";
    const computed = getComputedStyle(row);
    const rowHeight = row.getBoundingClientRect().height || 30;
    pending.rowHeight = rowHeight;
    syncOptimisticLayout(true);
    pending.animation = row.animate([
      { opacity: computed.opacity || "1", transform: computed.transform === "none" ? "translateX(0)" : computed.transform, height: `${rowHeight}px` },
      { opacity: "0", transform: "translateX(-6px)", height: "0px" },
    ], { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "forwards" });
    pending.hideTimer = setTimeout(() => {
      row.dataset.piSessionArchiveHidden = "true";
      row.style.display = "none";
    }, 190);
    pending.cleanupTimer = setTimeout(() => restoreOptimisticAction(pending), 30000);
    pending.timeout = setTimeout(() => {
      if (pending.started) return;
      const message = `${words().requestFailed}：action was not dispatched`;
      console.error("[pi-web archive]", message);
      restoreOptimisticAction(pending);
      showError(message);
      state.pendingActions = state.pendingActions.filter((item) => item !== pending);
    }, 2000);
    state.pendingActions.push(pending);
    return pending;
  }

  function adjacentSessionRow(row) {
    if (row.dataset.piSessionId) {
      const rows = [...document.querySelectorAll('.sidebar-container [data-pi-session-id]')]
        .filter(candidate => candidate === row || !candidate.dataset.piSessionArchivePending);
      const at = rows.indexOf(row);
      return rows[at + 1] || rows[at - 1] || null;
    }
    return row.nextElementSibling || row.previousElementSibling || null;
  }

  function sessionIdFromRow(row) {
    if (row?.dataset.piSessionId) return row.dataset.piSessionId;
    const fiberKey = row ? Object.keys(row).find((key) => key.startsWith("__reactFiber$")) : "";
    let fiber = fiberKey ? row[fiberKey] : null;
    for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
      const session = fiber.memoizedProps?.session || fiber.pendingProps?.session;
      if (session?.id) return String(session.id);
    }
    return "";
  }

  function handOffSelectedConversation(pending) {
    const nextRow = pending?.nextRow;
    if (!pending?.wasSelected || !nextRow?.isConnected) return;
    nextRow.dataset.piSessionArchiveHandoff = "true";
    pending.handedOff = true;
    pending.originHref = location.href;
    pending.nextSessionId = sessionIdFromRow(nextRow);
    if (pending.nextSessionId) {
      const nextUrl = new URL(location.href);
      nextUrl.searchParams.set("session", pending.nextSessionId);
      history.replaceState(history.state, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    } else {
      console.error("[pi-web archive] adjacent session id unavailable for immediate route handoff");
    }
    pending.visualHandoffLatencyMs = performance.now() - pending.pointerStartedAt;
    document.documentElement.dataset.piSessionArchiveHandoffLatencyMs = pending.visualHandoffLatencyMs.toFixed(2);
    queueMicrotask(() => {
      if (state.optimisticActions.has(pending) && nextRow.isConnected) nextRow.click();
    });
    const startedAt = performance.now();
    const settle = () => {
      if (!nextRow.isConnected) return;
      if (nextRow.getAttribute?.("aria-current") === "page" || performance.now() - startedAt >= 5000) {
        delete nextRow.dataset.piSessionArchiveHandoff;
        return;
      }
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }

  function scheduleHandoffRefresh() {
    queueMicrotask(requestNativeRefresh);
  }

  async function performDirectAction(pending, sessionId) {
    pending.started = true;
    clearTimeout(pending.timeout);
    state.pendingActions = state.pendingActions.filter((item) => item !== pending);
    const action = state.view === "archived" ? "restore" : "archive";
    try {
      const response = await nativeFetch(`/api/sessions/${encodeURIComponent(sessionId)}/${action}`, { method: "POST" });
      if (!response.ok) {
        let detail = "";
        try { detail = String((await response.json())?.error || ""); } catch {}
        throw new Error(detail || `HTTP ${response.status}`);
      }
      state.archivedCount = Math.max(0, state.archivedCount + (action === "archive" ? 1 : -1));
      scheduleDecorate();
      if (pending.handedOff) scheduleHandoffRefresh();
      else queueMicrotask(requestNativeRefresh);
    } catch (error) {
      const message = `${words().requestFailed}：${String(error?.message || error || "network error")}`;
      console.error("[pi-web archive]", message);
      restoreOptimisticAction(pending);
      if (pending.handedOff && pending.originHref) history.replaceState(history.state, "", pending.originHref);
      if (pending.handedOff && pending.row?.isConnected) queueMicrotask(() => pending.row?.click());
      showError(message);
    }
  }

  function immediateActionClick(event) {
    if (forwardedActionEvents.has(event)) return;
    if (event.type === "pointerdown" && event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const button = target?.closest("button[data-pi-session-archive-action]");
    if (!button || button.disabled) return;
    const pointerStartedAt = performance.now();
    event.preventDefault();
    event.stopImmediatePropagation();
    if (button.dataset.piSessionArchiveBusy) return;
    button.dataset.piSessionArchiveBusy = "true";
    const pending = beginOptimisticAction(button);
    if (pending) pending.pointerStartedAt = pointerStartedAt;
    const sessionId = sessionIdFromRow(pending?.row);
    if (pending && sessionId) {
      if (state.view === "active") handOffSelectedConversation(pending);
      void performDirectAction(pending, sessionId);
      return;
    }
    console.error('[pi-web archive] direct action unavailable: row or session id missing; using native callback');
    const forwarded = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      shiftKey: true,
    });
    forwardedActionEvents.add(forwarded);
    button.dispatchEvent(forwarded);
  }

  function enableImmediateActions() {
    window.addEventListener('pi-web:archive-session', event => {
      const { id, row } = event.detail || {};
      if (!id || !row?.isConnected || sessionIdFromRow(row) !== id) {
        console.error('[pi-web archive] context action rejected: missing or mismatched session row');
        return;
      }
      event.preventDefault();
      if (row.dataset.piSessionArchivePending) return;
      const startedAt = performance.now();
      const pending = beginOptimisticAction(row.querySelector('[data-pi-session-archive-action]'), row);
      if (!pending) return;
      pending.pointerStartedAt = startedAt;
      if (state.view === 'active') handOffSelectedConversation(pending);
      void performDirectAction(pending, id);
    });
    document.addEventListener("pointerdown", immediateActionClick, true);
    document.addEventListener("click", immediateActionClick, true);
  }

  // The model menu's "一键归档超过 N 天的对话" button calls this. The conversation that is open
  // (?session=) is sent as `keep`, so nothing is archived from under the reader.
  async function archiveOlder(days) {
    const keep = [new URL(window.location.href).searchParams.get("session")].filter(Boolean);
    const response = await nativeFetch("/__pi_archive_older", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ days, keep }),
    });
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok || !body?.ok) {
      const message = `${words().requestFailed}：${String(body?.error || `HTTP ${response.status}`)}`;
      console.error("[pi-web archive]", message);
      throw new Error(message);
    }
    state.archivedCount += Number(body.groupCount) || 0;
    scheduleDecorate();
    if (body.groupCount > 0) requestNativeRefresh();
    return body;
  }
  window.__piArchiveOlder = archiveOlder;

  function decorate() {
    state.scheduled = false;
    if (!document.body) return;
    renderControl();
    decorateRows();
    if (document.documentElement.dataset.piSessionArchiveView !== state.view) document.documentElement.dataset.piSessionArchiveView = state.view;
    // All projects' archived count, for the sidebar's empty state (「本项目没有归档，其他项目共 N 个」).
    const total = String(state.archivedCount);
    if (document.documentElement.dataset.piSessionArchiveTotal !== total) document.documentElement.dataset.piSessionArchiveTotal = total;
  }

  function scheduleDecorate() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(decorate);
  }

  const start = () => {
    enableImmediateActions();
    // The sidebar publishes the selected project's archived count once its list is loaded and announces the change
    // with this event; re-render the head then (an event, not an observer on documentElement).
    document.addEventListener("pi-web:archive-project-count", scheduleDecorate);
    window.__piUiSlots.register({ name: "archive", slot: "archive", order: 0, host: archiveHost(), onMount: scheduleDecorate });
    // New rows, roving tabindex and selection changes arrive through the sidebar-scoped watcher.
    window.__piUiSlots.onSidebarChange(() => { syncOptimisticLayout(); decorateRows(); });
    scheduleDecorate();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();

// Account pool usage: gauge in [data-pi-composer-slot] and a panel that pops up from it.
(() => {
  "use strict";

  const VERSION = "piweb-account-usage-v3";
  const ENDPOINT = "/__pi_account_usage";
  const SELECT_ENDPOINT = "/__pi_account_select";
  const LOGIN_ENDPOINT = "/__pi_account_login";
  // The bridge refreshes upstream data every four minutes. Reading its local
  // snapshot every 45 seconds keeps the rendered value safely below five
  // minutes old even with timer jitter; this never calls a model endpoint.
  const BROWSER_REFRESH_MS = 45_000;
  // A failed read retries sooner (5 s, 15 s, then the normal 45 s), with ±20 % jitter so tabs spread out.
  const RETRY_MS = [5_000, 15_000, 45_000];
  // The proxy waits up to 2.5 s for a busy bridge before answering from its snapshot.
  const REQUEST_TIMEOUT_MS = 4_000;
  // Bar turns amber at 85 % used and red at 95 % used (design spec §3.4).
  const LOW_USED = 85, CRITICAL_USED = 95;
  if (window.__piAccountUsageUiVersion === VERSION) return;
  window.__piAccountUsageUiVersion = VERSION;

  const state = {
    data: null,
    error: "",
    loading: false,
    open: false,
    switchingId: "",
    login: null,
    loginPending: false,
    loginError: "",
    loginTimer: null,
    removeConfirmId: "",
    removingId: "",
    loginBox: null,
    loginSignature: "",
    addButton: null,
    autoResetButton: null,
    autoResetPending: false,
    autoResetError: "",
    autoResetNote: null,
    switchFailedId: "",
    switchError: "",
    lastFetchAt: 0,
    failures: 0,
    refreshTimer: 0,
    suppressClick: false,
    renderedLocale: "",
    host: null,
    button: null,
    bar: null,
    value: null,
    badge: null,
    panel: null,
    list: null,
    title: null,
    freshness: null,
    listSignature: "",
    receivedAt: 0,
  };

  const labels = {
    en: {
      title: "Account pool usage",
      button: "View account pool usage",
      buttonUsed: (percent) => `Account usage: current account ${percent}% used`,
      accountsAbnormal: (count) => `${count} account${count === 1 ? "" : "s"} unavailable`,
      remaining: "left",
      used: "Used",
      resets: "Reset card balance (not current redemption eligibility)",
      resetAt: "Resets",
      resetCountShort: "Reset cards",
      autoReset: "Auto-use cards", on: "On", off: "Off",
      autoResetHint: "Only when quota is exhausted. Uses existing cards, never purchases. A submitted redemption cannot be cancelled.",
      autoResetUnavailable: "Auto-use unavailable · bridge update required",
      autoResetFailed: "Auto-use setting was not saved",
      autoResetStates: { using: "Using reset card…", used: "Card used · quota restored", uncertain: "Reset unconfirmed · further cards paused", failed: "Auto-use failed", skipped: "Auto-use skipped" },
      current: "Current",
      cached: "Cached",
      switchAccount: "Switch",
      reauth: "Sign in again", addAccount: "Add account", loginOpen: "Open authorization page",
      removeAccount: "Delete", confirmRemove: "Confirm removal", cancelRemove: "Cancel",
      removeHint: "Remove from rotation? Local login files are preserved. Adding this account again restores it.",
      removeActive: "Switch away from the current account before deleting it.",
      loginHint: "Sign in with the intended account, then return here. If localhost cannot open, paste its full URL below.",
      callback: "Full localhost callback URL", completeLogin: "Complete sign-in", cancelLogin: "Cancel",
      loginWaiting: "Waiting for authorization", loginWorking: "Processing…", loginSuccess: "Signed in. You can now switch to this account.",
      loginCancelled: "Sign-in cancelled", loginExpired: "Sign-in expired. Please retry.", loginFailed: "Sign-in failed",
      loginManual: "Callback port unavailable. Paste the full callback URL to finish.",
      switchingAccount: "Switching…",
      retrySwitch: "Retry",
      switchFailed: "Switch failed",
      loading: "Loading usage…",
      empty: "No rotating accounts found",
      unavailable: "Usage is temporarily unavailable",
      retrying: "Retrying automatically",
      updatedNow: "Checked now",
      updatedMinutes: (minutes) => `Checked ${minutes}m ago`,
      abnormal: (count) => `${count} unavailable`,
      authFailed: "Authentication failed · sign in again",
      staleQuota: "Quota expired · cached values only",
      refreshFailed: "Refresh failed",
      lastSuccess: "Last successful update",
      updating: "Updating…",
      soon: "soon",
      minutes: (minutes) => `${minutes}m`,
      hours: (hours) => `${hours}h`,
      days: (days, hours) => `${days}d ${hours}h`,
    },
    "zh-CN": {
      title: "账号池额度",
      button: "查看轮转账号池额度",
      buttonUsed: (percent) => `账号额度：当前账号已用 ${percent}%`,
      accountsAbnormal: (count) => `${count} 个账号异常`,
      remaining: "剩余",
      used: "已用",
      resets: "重置卡余额（不是当前可立即使用的次数）",
      resetAt: "重置时间",
      resetCountShort: "重置卡",
      autoReset: "自动用卡", on: "开", off: "关",
      autoResetHint: "额度耗尽后使用已有卡，不购买、不充值。已提交的用卡操作无法撤回。",
      autoResetUnavailable: "自动用卡不可用 · 桥接服务需更新",
      autoResetFailed: "自动用卡设置未保存",
      autoResetStates: { using: "正在用卡…", used: "已用卡 · 额度已恢复", uncertain: "用卡结果待核实 · 已暂停继续用卡", failed: "自动用卡失败", skipped: "本次未用卡" },
      current: "当前",
      cached: "缓存",
      switchAccount: "切换",
      reauth: "重新登录", addAccount: "添加账号", loginOpen: "打开授权页面",
      removeAccount: "删除", confirmRemove: "确认删除", cancelRemove: "取消",
      removeHint: "从轮转池移除？保留本机登录文件，再次添加可恢复。",
      removeActive: "请先切换到其他账号，再删除当前账号。",
      loginHint: "请使用目标账号登录后返回这里。若 localhost 页面无法打开，请复制地址栏完整网址并粘贴到下方。",
      callback: "完整的 localhost 回调网址", completeLogin: "完成登录", cancelLogin: "取消登录",
      loginWaiting: "等待授权", loginWorking: "处理中…", loginSuccess: "登录成功，可切换到此账号使用。",
      loginCancelled: "已取消登录", loginExpired: "登录已超时，请重试。", loginFailed: "登录失败",
      loginManual: "回调端口被占用，请粘贴完整回调网址完成登录。",
      switchingAccount: "切换中…",
      retrySwitch: "重试",
      switchFailed: "切换失败",
      loading: "正在读取额度…",
      empty: "未发现轮转账号",
      unavailable: "额度暂不可用",
      retrying: "稍后自动重试",
      updatedNow: "刚刚检查",
      updatedMinutes: (minutes) => `${minutes} 分钟前检查`,
      abnormal: (count) => `${count} 个异常`,
      authFailed: "认证失败 · 需重新登录",
      staleQuota: "额度已过期 · 仅为历史缓存",
      refreshFailed: "刷新失败",
      lastSuccess: "最后成功更新",
      updating: "更新中…",
      soon: "即将重置",
      minutes: (minutes) => `${minutes} 分钟后`,
      hours: (hours) => `${hours} 小时后`,
      days: (days, hours) => `${days} 天 ${hours} 小时后`,
    },
    "zh-TW": {
      title: "帳號池額度",
      button: "檢視輪轉帳號池額度",
      buttonUsed: (percent) => `帳號額度：目前帳號已用 ${percent}%`,
      accountsAbnormal: (count) => `${count} 個帳號異常`,
      remaining: "剩餘",
      used: "已用",
      resets: "重置卡餘額（不是目前可立即使用的次數）",
      resetAt: "重置時間",
      resetCountShort: "重置卡",
      autoReset: "自動用卡", on: "開", off: "關",
      autoResetHint: "額度耗盡後使用既有卡，不購買、不儲值。已提交的用卡操作無法撤回。",
      autoResetUnavailable: "自動用卡不可用 · 橋接服務需更新",
      autoResetFailed: "自動用卡設定未儲存",
      autoResetStates: { using: "正在用卡…", used: "已用卡 · 額度已恢復", uncertain: "用卡結果待核實 · 已暫停繼續用卡", failed: "自動用卡失敗", skipped: "本次未用卡" },
      current: "目前",
      cached: "快取",
      switchAccount: "切換",
      reauth: "重新登入", addAccount: "新增帳號", loginOpen: "開啟授權頁面",
      removeAccount: "刪除", confirmRemove: "確認刪除", cancelRemove: "取消",
      removeHint: "從輪轉池移除？保留本機登入檔案，再次新增可恢復。",
      removeActive: "請先切換到其他帳號，再刪除目前帳號。",
      loginHint: "請使用目標帳號登入後返回這裡。若 localhost 頁面無法開啟，請複製網址列完整網址並貼到下方。",
      callback: "完整的 localhost 回呼網址", completeLogin: "完成登入", cancelLogin: "取消登入",
      loginWaiting: "等待授權", loginWorking: "處理中…", loginSuccess: "登入成功，可切換到此帳號使用。",
      loginCancelled: "已取消登入", loginExpired: "登入已逾時，請重試。", loginFailed: "登入失敗",
      loginManual: "回呼連接埠被佔用，請貼上完整回呼網址完成登入。",
      switchingAccount: "切換中…",
      retrySwitch: "重試",
      switchFailed: "切換失敗",
      loading: "正在讀取額度…",
      empty: "未發現輪轉帳號",
      unavailable: "額度暫時無法使用",
      retrying: "稍後自動重試",
      updatedNow: "剛剛檢查",
      updatedMinutes: (minutes) => `${minutes} 分鐘前檢查`,
      abnormal: (count) => `${count} 個異常`,
      authFailed: "認證失敗 · 需重新登入",
      staleQuota: "額度已過期 · 僅為歷史快取",
      refreshFailed: "更新失敗",
      lastSuccess: "最後成功更新",
      updating: "更新中…",
      soon: "即將重置",
      minutes: (minutes) => `${minutes} 分鐘後`,
      hours: (hours) => `${hours} 小時後`,
      days: (days, hours) => `${days} 天 ${hours} 小時後`,
    },
  };

  function locale() { return window.__piUiSlots?.locale() || "zh-CN"; }

  function words() { return labels[locale()] || labels["zh-CN"]; }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgIcon(paths, size = 14) {
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: String(size), height: String(size), fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  function gaugeIcon() { return svgIcon(["M4 15a8 8 0 1 1 16 0", "m12 15 4-4", "M5.5 18h13"]); }

  function accountActionIcon(action) {
    return svgIcon([action === "reauth"
      ? "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 7l5 5-5 5M15 12H3"
      : "M3 6h18M9 6V4h6v2M5 6l1 15h12l1-15M10 10v7M14 10v7"]);
  }

  function warningIcon() { return svgIcon(["M12 9v4", "M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"], 13); }

  function clampPercent(value) { return Math.max(0, Math.min(100, Math.round(Number(value) || 0))); }

  function usedPercent(account) {
    if (!account || account.stale || account.error) return null;
    if (account.usedPercent != null) return clampPercent(account.usedPercent);
    if (account.remainingPercent != null) return 100 - clampPercent(account.remainingPercent);
    return null;
  }

  function usageLevel(used) {
    return used == null ? "" : used >= CRITICAL_USED ? "critical" : used >= LOW_USED ? "low" : "";
  }

  function relativeReset(resetAt) {
    const text = words();
    const left = Date.parse(String(resetAt || "")) - Date.now();
    if (!Number.isFinite(left)) return "—";
    if (left <= 0) return text.soon;
    const minutes = Math.max(1, Math.ceil(left / 60_000));
    if (minutes < 60) return text.minutes(minutes);
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return text.hours(hours);
    return text.days(Math.floor(hours / 24), hours % 24);
  }

  let dateLocale = '', dateFormat, fullDateFormat;
  function exactReset(resetAt, full = false) {
    const milliseconds = Date.parse(String(resetAt || ""));
    if (!Number.isFinite(milliseconds)) return "—";
    const currentLocale = locale();
    if (dateLocale !== currentLocale) {
      dateLocale = currentLocale;
      dateFormat = new Intl.DateTimeFormat(dateLocale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      fullDateFormat = new Intl.DateTimeFormat(dateLocale, { dateStyle: 'short', timeStyle: 'medium', hour12: false });
    }
    return (full ? fullDateFormat : dateFormat).format(milliseconds);
  }

  function appendText(parent, className, text, title = "") {
    const node = document.createElement("span");
    node.className = className;
    node.textContent = text;
    if (title) node.title = title;
    parent.appendChild(node);
    return node;
  }

  function emptyState(primary, secondary = "") {
    const row = document.createElement("div");
    row.className = "pi-account-usage-empty";
    appendText(row, "pi-account-usage-empty-title", primary);
    if (secondary) appendText(row, "pi-account-usage-empty-note", secondary);
    state.list.appendChild(row);
  }

  function warningLine(parent, text, title = "") {
    const line = document.createElement("div");
    line.className = "pi-account-usage-warning";
    if (title) line.title = title;
    line.appendChild(warningIcon());
    appendText(line, "", text);
    parent.appendChild(line);
    return line;
  }

  // Row: line 1 = email + 当前 badge + 「剩余 81%」 and a 48 px bar (swapped for 切换/重新登录/删除 on
  // hover or keyboard focus); line 2 = 已用 · 重置卡 · 重置时间; abnormal accounts add one status line.
  function accountRow(account) {
    const text = words();
    const row = document.createElement("div");
    row.className = "pi-account-usage-row";
    row.dataset.accountId = String(account.id || "");
    row.dataset.active = String(Boolean(account.active));
    if (account.stale || account.error) row.dataset.stale = "true";

    const top = document.createElement("div");
    top.className = "pi-account-usage-top";
    const identity = document.createElement("div");
    identity.className = "pi-account-usage-identity";
    const email = String(account.email || account.id || "—");
    appendText(identity, "pi-account-usage-email", email, account.error ? `${email} · ${account.error}` : email);
    if (account.active) appendText(identity, "pw-badge pw-badge--accent", text.current);
    top.appendChild(identity);

    const value = document.createElement("span");
    value.className = "pi-account-usage-value";
    const fresh = account.remainingPercent != null && !account.stale && !account.error;
    appendText(value, "", `${account.stale || account.error ? `${text.cached} · ` : ""}${text.remaining} ${account.remainingPercent == null ? "—" : `${account.remainingPercent}%`}`);
    if (fresh) {
      const meter = document.createElement("span");
      meter.className = "pw-quota-bar pi-account-usage-meter";
      meter.setAttribute("role", "progressbar");
      meter.setAttribute("aria-label", `${email} ${text.remaining}`);
      meter.setAttribute("aria-valuemin", "0");
      meter.setAttribute("aria-valuemax", "100");
      meter.setAttribute("aria-valuenow", String(account.remainingPercent));
      const level = usageLevel(100 - clampPercent(account.remainingPercent));
      if (level) meter.dataset.level = level;
      const fill = document.createElement("i");
      fill.style.width = `${clampPercent(account.remainingPercent)}%`;
      meter.appendChild(fill);
      value.appendChild(meter);
    }
    top.appendChild(value);

    const action = document.createElement("button");
    action.type = "button";
    action.className = "pw-btn pw-btn--sm";
    const isSwitching = state.switchingId === account.id;
    const didFail = state.switchFailedId === account.id;
    action.dataset.state = account.active ? "current" : didFail ? "failed" : "idle";
    action.textContent = isSwitching ? text.switchingAccount : didFail ? text.retrySwitch : text.switchAccount;
    action.title = `${text.switchAccount} ${email}`;
    action.setAttribute("aria-label", action.title);
    action.hidden = Boolean(account.active);
    action.disabled = Boolean(account.active || state.switchingId || state.removingId);
    action.addEventListener("click", () => { void switchAccount(String(account.id || "")); });
    const reauth = document.createElement("button");
    reauth.type = "button";
    reauth.className = "pw-icon-btn pw-icon-btn--sm pi-account-reauth";
    reauth.dataset.action = "reauth";
    reauth.appendChild(accountActionIcon("reauth"));
    reauth.title = `${text.reauth} ${email}`;
    reauth.setAttribute("aria-label", reauth.title);
    reauth.disabled = loginBusy();
    reauth.addEventListener("click", () => { void loginAction({ action: "start", mode: "reauth", id: account.id }); });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "pw-icon-btn pw-icon-btn--sm pw-icon-btn--danger pi-account-remove";
    remove.appendChild(accountActionIcon("remove")); remove.dataset.action = "remove";
    remove.setAttribute("aria-label", `${text.removeAccount} ${email}`);
    remove.title = account.active ? text.removeActive : `${text.removeAccount} ${email}`;
    remove.disabled = loginBusy() || Boolean(state.switchingId);
    remove.addEventListener("click", () => {
      state.removeConfirmId = String(account.id); render();
      state.list?.querySelector(".pi-account-remove-confirm button")?.focus();
    });
    const controls = document.createElement("div");
    controls.className = "pi-account-row-controls";
    // Management actions share line 1 with the value they replace on hover; never an extra row.
    controls.append(reauth, remove, action);
    top.appendChild(controls);
    row.appendChild(top);

    const meta = document.createElement("div");
    meta.className = "pi-account-usage-meta";
    appendText(meta, "", account.usedPercent == null ? text.unavailable : `${text.used} ${account.usedPercent}%`);
    const resetCards = appendText(meta, "", `${text.resetCountShort} ${account.resetCredits ?? "—"}`);
    resetCards.title = text.resets;
    const reset = appendText(meta, "", account.resetAt ? exactReset(account.resetAt) : `${text.resetAt} —`);
    if (account.resetAt) {
      const full = exactReset(account.resetAt, true);
      reset.title = `${text.resetAt} ${full} · ${relativeReset(account.resetAt)}`;
    }
    row.appendChild(meta);
    const resetStatus = state.data?.autoReset?.accounts?.[account.id];
    if (resetStatus) warningLine(row, text.autoResetStates[resetStatus.status] || text.autoResetStates.failed,
      `${resetStatus.reason || ""} · ${exactReset(resetStatus.at, true)}`);
    if (account.stale || account.error) {
      const reason = account.error === "HTTP 401" ? text.authFailed
        : account.error ? `${text.refreshFailed} · ${account.error}` : text.staleQuota;
      const lastSuccess = account.fetchedAt ? `${text.lastSuccess} ${exactReset(account.fetchedAt, true)}` : "";
      warningLine(row, reason, lastSuccess);
    }
    if (state.removeConfirmId === account.id) {
      const confirmation = document.createElement("div"); confirmation.className = "pi-account-remove-confirm";
      appendText(confirmation, "pi-account-login-hint", account.active ? text.removeActive : `${email} · ${text.removeHint}`);
      if (!account.active) {
        const yes = document.createElement("button"); yes.type = "button"; yes.className = "pw-btn pw-btn--sm pw-btn--danger-solid pi-account-remove";
        yes.textContent = state.removingId ? text.loginWorking : text.confirmRemove; yes.disabled = loginBusy();
        yes.addEventListener("click", () => { void removeAccount(account); }); confirmation.appendChild(yes);
      }
      const no = document.createElement("button"); no.type = "button"; no.className = "pw-btn pw-btn--sm pw-btn--ghost";
      no.textContent = text.cancelRemove; no.disabled = Boolean(state.removingId);
      no.addEventListener("click", () => { state.removeConfirmId = ""; render(); }); confirmation.appendChild(no);
      row.appendChild(confirmation);
    }
    return row;
  }

  async function removeAccount(account) {
    if (loginBusy() || account.active || state.switchingId) return;
    state.removingId = account.id; state.loginError = ""; render();
    try {
      const response = await fetch(LOGIN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", id: account.id, email: account.email }), cache: "no-store", signal: AbortSignal.timeout(4000) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      state.data = { ...state.data, accounts: result.accounts };
      state.removeConfirmId = "";
    } catch (error) {
      state.loginError = String(error?.message || "Remove failed").slice(0, 180);
      console.error("[pi-web account login] remove failed:", state.loginError);
    } finally { state.removingId = ""; render(); }
  }

  async function switchAccount(id) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) || state.switchingId) return;
    const startedAt = performance.now();
    state.switchingId = id;
    state.switchFailedId = "";
    state.switchError = "";
    render();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(SELECT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
        cache: "no-store",
        signal: controller.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) throw new Error(result.error || `HTTP ${response.status}`);
      if (Array.isArray(result.accounts)) state.data = { ...(state.data || {}), enabled: true, accounts: result.accounts };
      else if (Array.isArray(state.data?.accounts)) {
        state.data = { ...state.data, accounts: state.data.accounts.map((account) => ({ ...account, active: account.id === id })) };
      }
      state.switchingId = "";
      document.documentElement.dataset.piAccountSwitchLatencyMs = (performance.now() - startedAt).toFixed(2);
    } catch (error) {
      state.switchingId = "";
      state.switchFailedId = id;
      state.switchError = String(error?.message || error || "request failed").slice(0, 120);
      console.error("[pi-web account usage] account switch failed:", state.switchError);
    } finally {
      clearTimeout(timeout);
      render();
    }
  }

  function loginBusy() { return Boolean(state.removingId) || state.loginPending || ["waiting", "exchanging"].includes(state.login?.status); }

  async function loginAction(input, polling = false) {
    if (state.loginPending) return;
    if (!polling) { state.loginPending = true; state.loginError = ""; render(); }
    clearTimeout(state.loginTimer);
    try {
      const response = await fetch(LOGIN_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: state.login?.session, ...input }), cache: "no-store",
        signal: AbortSignal.timeout(input.action === "complete" ? 25_000 : 5000),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      state.login = result.login;
      state.loginError = "";
      try {
        if (["waiting", "exchanging"].includes(state.login.status)) sessionStorage.setItem("pi-account-login", state.login.session);
        else sessionStorage.removeItem("pi-account-login");
      } catch { console.warn("[pi-web account login] session persistence unavailable"); }
      if (state.login.status === "success") void refresh(true);
    } catch (error) {
      state.loginError = String(error?.message || "Login failed").slice(0, 180);
      console.error("[pi-web account login] request failed:", state.loginError);
      if (polling && Date.now() > (state.login?.expiresAt || 0)) state.login = null;
    } finally {
      state.loginPending = false;
      render();
      if (!polling && input.action === "start") {
        state.loginBox?.scrollIntoView({ block: "nearest" });
        state.loginBox?.querySelector("a")?.focus({ preventScroll: true });
      } else if (!polling && input.action === "cancel") state.addButton?.focus();
      if (["waiting", "exchanging"].includes(state.login?.status)) {
        state.loginTimer = setTimeout(() => { void loginAction({ action: "status" }, true); }, 2000);
      }
    }
  }

  function renderLogin() {
    if (!state.loginBox || !state.addButton) return;
    const text = words(), login = state.login;
    state.addButton.textContent = `+ ${text.addAccount}`;
    state.addButton.disabled = loginBusy();
    // Polling must not replace a focused callback input or discard its draft.
    const signature = JSON.stringify([locale(), login?.session, login?.status, state.loginPending, state.loginError]);
    if (signature === state.loginSignature) return;
    state.loginSignature = signature;
    const draft = state.loginBox.querySelector("input")?.value || "";
    state.loginBox.replaceChildren();
    if (!login && !state.loginPending && !state.loginError) return;
    const title = state.loginPending || login?.status === "exchanging" ? text.loginWorking
      : ({ waiting: text.loginWaiting, success: text.loginSuccess, cancelled: text.loginCancelled, expired: text.loginExpired, failed: text.loginFailed })[login?.status] || "";
    appendText(state.loginBox, "pi-account-login-status", `${title}${login?.email ? ` · ${login.email}` : ""}`);
    if (state.loginError || login?.error) warningLine(state.loginBox, state.loginError || login.error);
    if (login?.status === "waiting") {
      const link = document.createElement("a");
      link.textContent = text.loginOpen;
      // The backend owns this URL; nevertheless allow only the official origin.
      try {
        const url = new URL(login.url);
        if (url.origin !== "https://auth.openai.com" || url.pathname !== "/oauth/authorize") throw new Error("Unexpected authorization URL");
        link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
        state.loginBox.appendChild(link);
      } catch { warningLine(state.loginBox, text.loginFailed); console.error("[pi-web account login] invalid authorization URL"); }
      appendText(state.loginBox, "pi-account-login-hint", login.manual ? text.loginManual : text.loginHint);
      const form = document.createElement("form"), input = document.createElement("input");
      input.type = "text"; input.autocomplete = "off"; input.spellcheck = false; input.className = "pw-input pw-input--sm";
      input.placeholder = text.callback; input.setAttribute("aria-label", text.callback); input.value = draft;
      const complete = document.createElement("button");
      complete.type = "submit"; complete.className = "pw-btn pw-btn--sm pw-btn--primary"; complete.textContent = text.completeLogin; complete.disabled = state.loginPending;
      form.append(input, complete);
      form.addEventListener("submit", event => { event.preventDefault(); if (input.value.trim()) void loginAction({ action: "complete", callback: input.value.trim() }); });
      state.loginBox.appendChild(form);
    }
    if (["waiting", "exchanging"].includes(login?.status)) {
      const cancel = document.createElement("button");
      cancel.type = "button"; cancel.className = "pw-btn pw-btn--sm pw-btn--ghost"; cancel.textContent = text.cancelLogin; cancel.disabled = state.loginPending;
      cancel.addEventListener("click", () => { void loginAction({ action: "cancel" }); });
      state.loginBox.appendChild(cancel);
    }
  }

  async function toggleAutoReset() {
    if (state.autoResetPending || !state.data?.autoReset) return;
    state.autoResetPending = true; state.autoResetError = ""; render();
    try {
      const response = await fetch("/__pi_account_auto_reset", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !state.data.autoReset.enabled }), signal: AbortSignal.timeout(4500),
      });
      const body = await response.json();
      if (!response.ok || !body.ok || !body.autoReset) throw new Error("setting rejected");
      state.data.autoReset = body.autoReset;
    } catch {
      state.autoResetError = words().autoResetFailed;
      console.error("[pi-web auto reset] configuration failed");
    } finally { state.autoResetPending = false; render(); }
  }

  function renderButton(accounts) {
    const text = words();
    const active = accounts.find(account => account.active) || null;
    const used = usedPercent(active);
    const abnormal = accounts.filter(account => account.stale || account.error).length;
    state.bar.firstChild.style.width = `${used ?? 0}%`;
    const level = usageLevel(used);
    if (level) state.bar.dataset.level = level; else delete state.bar.dataset.level;
    const valueText = used == null ? "—" : `${used}%`;
    if (state.value.textContent !== valueText) state.value.textContent = valueText;
    state.badge.hidden = abnormal === 0;
    state.badge.textContent = String(abnormal);
    const lines = [used != null ? text.buttonUsed(used)
      : !state.data && state.error ? `${text.unavailable} · ${text.retrying}` : text.button];
    if (abnormal) lines.push(text.accountsAbnormal(abnormal));
    state.button.title = lines.join("\n");
    state.button.setAttribute("aria-label", lines.join("，"));
    state.button.dataset.state = !state.data && state.error ? "error" : level || "ready";
  }

  function render() {
    if (!state.list || !state.title || !state.freshness || !state.panel || !state.button) return;
    const text = words();
    state.renderedLocale = locale();
    state.title.textContent = text.title;
    state.panel.setAttribute("aria-label", text.title);
    state.panel.setAttribute("aria-busy", String(state.loading));
    renderLogin();
    if (state.autoResetButton) {
      const setting = state.data?.autoReset;
      state.autoResetButton.textContent = `${text.autoReset} · ${setting ? (setting.enabled ? text.on : text.off) : "—"}`;
      state.autoResetButton.setAttribute("aria-label", text.autoReset);
      state.autoResetButton.setAttribute("aria-checked", String(setting?.enabled === true));
      state.autoResetButton.title = setting ? text.autoResetHint : text.autoResetUnavailable;
      state.autoResetButton.disabled = !setting || state.autoResetPending;
      state.autoResetNote.textContent = state.autoResetError || (setting?.settingsError ? text.autoResetFailed : "");
    }

    const accounts = (Array.isArray(state.data?.accounts) ? state.data.accounts : []).map(account => {
      const fetched = Date.parse(account.fetchedAt || "");
      return { ...account, stale: account.stale || !Number.isFinite(fetched)
        || Date.now() - fetched > (state.data.accuracyMaxAgeMs || 300_000) };
    });
    // Keep cached rows (and keyboard focus) through loading transitions. Closed
    // panels never construct account DOM or date formatters.
    if (state.open) {
      const signature = JSON.stringify([state.renderedLocale, state.data?.enabled, state.data?.autoReset, accounts.map(({ ageMs, ...account }) => account), state.switchingId, state.switchFailedId, loginBusy(), state.removeConfirmId, state.removingId, !state.data && [state.loading, state.error]]);
      if (signature !== state.listSignature) {
        state.listSignature = signature;
        const focusedId = state.list.contains(document.activeElement) ? document.activeElement.closest('[data-account-id]')?.dataset.accountId : null;
        state.list.replaceChildren();
        if (!state.data && state.loading) emptyState(text.loading);
        else if (!state.data && state.error) emptyState(text.unavailable, text.retrying);
        else if (!state.data?.enabled || accounts.length === 0) emptyState(text.empty);
        else {
          const rows = document.createDocumentFragment();
          for (const account of accounts) rows.appendChild(accountRow(account));
          state.list.appendChild(rows);
        }
        if (focusedId) {
          const row = [...state.list.children].find(item => item.dataset.accountId === focusedId);
          const action = row?.querySelector('button:not(:disabled):not([hidden])');
          (action || state.addButton || state.panel).focus({ preventScroll: true });
        }
      }
    }

    const checkedAt = Date.parse(state.data?.lastCompletedAt || "");
    const minutes = Math.max(0, Math.floor((Date.now() - checkedAt) / 60_000));
    const abnormal = accounts.filter(account => account.stale || account.error).length;
    const checkStatus = Number.isFinite(checkedAt) ? (minutes < 1 ? text.updatedNow : text.updatedMinutes(minutes)) : '—';
    state.freshness.textContent = state.switchingId
      ? text.switchingAccount
      : state.switchError ? text.switchFailed
        : state.loading && !state.data ? text.updating
          : !state.data && state.error ? text.unavailable
            : !state.data || accounts.length === 0 ? '—'
              : `${state.data?.refreshing ? text.updating : checkStatus}${abnormal ? ` · ${text.abnormal(abnormal)}` : ''}`;
    state.freshness.title = state.switchError || state.error || "";
    state.freshness.dataset.stale = String(Boolean(state.switchError || (!state.data && state.error) || abnormal));
    renderButton(accounts);
  }

  function scheduleRefresh(delay) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
      if (document.visibilityState !== "visible") { scheduleRefresh(BROWSER_REFRESH_MS); return; }
      void refresh(false);
    }, delay);
  }

  async function refresh(force = false) {
    if (state.loading) return;
    state.loading = true;
    state.lastFetchAt = Date.now();
    render();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${ENDPOINT}${force ? "?refresh=1" : ""}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(data.accounts)) throw new Error(data.error || `HTTP ${response.status}`);
      state.data = data;
      state.receivedAt = Date.now();
      state.error = "";
      state.failures = 0;
    } catch (error) {
      state.error = String(error?.message || error || "request failed").slice(0, 120);
      state.failures += 1;
      console.error("[pi-web account usage] refresh failed:", state.error);
    } finally {
      clearTimeout(timeout);
      state.loading = false;
      render();
      const base = state.error ? RETRY_MS[Math.min(state.failures, RETRY_MS.length) - 1] : BROWSER_REFRESH_MS;
      scheduleRefresh(state.error ? Math.round(base * (0.8 + Math.random() * 0.4)) : base);
    }
  }

  // Mouse opens never focus the panel itself (no ring on the whole popover); a keyboard
  // open (click with detail 0) moves focus to the first actionable item.
  function setOpen(open, startedAt = performance.now(), focusFirst = false) {
    state.open = Boolean(open);
    state.button.setAttribute("aria-expanded", String(state.open));
    state.panel.dataset.open = String(state.open);
    state.panel.hidden = !state.open;
    if (!state.open) return;
    document.dispatchEvent(new CustomEvent("pi-ui:popover-open", { detail: "account" }));
    render();
    if (focusFirst) state.panel.querySelector("button:not(:disabled):not([hidden]),a[href],input")?.focus({ preventScroll: true });
    document.documentElement.dataset.piAccountUsageOpenLatencyMs = (performance.now() - startedAt).toFixed(2);
    if (state.error || !state.lastFetchAt || Date.now() - state.lastFetchAt >= BROWSER_REFRESH_MS) void refresh(false);
  }

  function createUi() {
    if (state.host) return;
    const host = document.createElement("span");
    host.dataset.piSlotItem = "quota";
    host.dataset.piSlotOrder = "1";
    const button = document.createElement("button");
    button.id = "pi-account-usage-button";
    button.type = "button";
    button.className = "pw-quota";
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", "pi-account-usage-panel");
    const bar = document.createElement("span");
    bar.className = "pw-quota-bar";
    bar.appendChild(document.createElement("i"));
    const value = document.createElement("span");
    value.className = "pw-quota-value";
    value.textContent = "—";
    const badge = document.createElement("span");
    badge.className = "pw-quota-badge";
    badge.hidden = true;
    badge.setAttribute("aria-hidden", "true");
    button.append(gaugeIcon(), bar, value, badge);

    const panel = document.createElement("section");
    panel.id = "pi-account-usage-panel";
    panel.className = "pw-menu pw-menu--up pw-slot-popover pw-quota-panel";
    panel.dataset.open = "false";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.tabIndex = -1;
    const header = document.createElement("header");
    header.className = "pw-quota-head";
    const title = appendText(header, "pw-quota-title", words().title);
    const freshness = appendText(header, "pw-quota-fresh", words().updating);
    freshness.setAttribute("aria-live", "polite");
    const list = document.createElement("div");
    list.className = "pi-account-usage-list";
    const loginBox = document.createElement("div");
    loginBox.id = "pi-account-login-box";
    const footer = document.createElement("footer");
    footer.className = "pi-account-login-footer";
    const addButton = document.createElement("button");
    addButton.id = "pi-account-add";
    addButton.type = "button";
    addButton.className = "pw-btn pw-btn--ghost pw-btn--sm";
    addButton.addEventListener("click", () => { void loginAction({ action: "start", mode: "add" }); });
    const autoResetButton = document.createElement("button");
    autoResetButton.id = "pi-account-auto-reset"; autoResetButton.type = "button";
    autoResetButton.className = "pw-btn pw-btn--ghost pw-btn--sm";
    autoResetButton.setAttribute("role", "switch");
    autoResetButton.addEventListener("click", () => { void toggleAutoReset(); });
    const autoResetNote = document.createElement("div");
    autoResetNote.className = "pw-quota-note";
    autoResetNote.setAttribute("role", "status");
    footer.append(addButton, autoResetButton);
    panel.append(header, list, loginBox, footer, autoResetNote);
    host.append(button, panel);
    Object.assign(state, { host, button, bar, value, badge, panel, list, title, freshness, loginBox, addButton, autoResetButton, autoResetNote });

    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const startedAt = performance.now();
      event.preventDefault();
      state.suppressClick = true;
      setTimeout(() => { state.suppressClick = false; }, 500);
      setOpen(!state.open, startedAt);
    });
    button.addEventListener("click", (event) => {
      if (state.suppressClick) {
        state.suppressClick = false;
        return;
      }
      setOpen(!state.open, performance.now(), event.detail === 0);
    });
    document.addEventListener("pointerdown", (event) => {
      if (!state.open || event.composedPath().includes(button) || event.composedPath().includes(panel)) return;
      setOpen(false);
    }, true);
    document.addEventListener('pi-ui:popover-open', event => { if (event.detail !== 'account' && state.open) setOpen(false); });
    document.addEventListener('focusin', event => {
      if (state.open && !panel.contains(event.target) && event.target !== button) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !state.open) return;
      event.preventDefault();
      setOpen(false);
      button.focus({ preventScroll: true });
    }, true);
    window.__piUiSlots.register({ name: "quota", slot: "composer", order: 1, host });
    render();
    void refresh(false);
    try {
      const session = sessionStorage.getItem("pi-account-login");
      if (session) { state.login = { session }; void loginAction({ action: "status" }); }
    } catch { console.warn("[pi-web account login] session restore unavailable"); }
  }

  const start = () => {
    createUi();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - state.lastFetchAt >= BROWSER_REFRESH_MS) void refresh(false);
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();

// Speed / service TIER: ⚡ menu in [data-pi-composer-slot] and the submission guard that makes
// the displayed tier the one the session actually runs.
(() => {
  "use strict";
  if (window.__piServiceTierUi) return;
  window.__piServiceTierUi = true;
  const KEY = "pi-service-tier";
  const APPLIED_KEY = "pi-service-tier-applied";
  // lop 2026-09-29: the menu offers 默认 and Fast only, with no explanatory text; switching
  // the model puts the choice back on 默认 at once.
  const choices = [
    ["native", "默认"],
    ["priority", "Fast"],
  ];
  // Keep in step with GPT6_CODEX_IDS (live-model-catalog.mjs): 2026-09-30 GPT-6.1 Sol was added to the
  // picker without this list, so its Fast switch stayed greyed out and it ran on the default tier.
  const supportedCodexModels = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]);
  const SUBMISSIONS = new Set(["prompt", "steer", "follow_up"]);
  let selected = "native", explicitSelection = false, button, panel, note, host, currentModel = null;
  let migrationWarning = "";
  // Session runtimes created by ensure_session in this page start on the native tier.
  const freshRuntimes = new Set();
  const supportsTier = model => model?.provider === "openai-codex" && supportedCodexModels.has(model.id);
  // The panel shows text only when something went wrong (a choice that could not be applied).
  const noteText = () => migrationWarning;
  try { const saved = localStorage.getItem(KEY); explicitSelection = saved !== null; selected = saved || "native"; }
  catch (error) { console.error("[pi-web service tier] preference read failed:", error); }
  if (!choices.some(([value]) => value === selected)) {
    // A saved tier this menu no longer offers (Standard): back to 默认, logged, not announced.
    console.error("[pi-web service tier] unsupported saved tier; using native:", selected);
    selected = "native";
    try { localStorage.setItem(KEY, selected); } catch (error) { console.error("[pi-web service tier] migration write failed:", error); }
  }

  // Which tier this browser last applied to each session runtime (shared by its tabs). A recreated
  // runtime starts native, so a recorded "native" stays true until some tab applies Fast.
  function appliedTiers() {
    try { return JSON.parse(localStorage.getItem(APPLIED_KEY) || "{}") || {}; } catch { return {}; }
  }
  function recordApplied(sessionId, tier) {
    try {
      const map = appliedTiers();
      if (map[sessionId] === tier) return;
      delete map[sessionId];
      map[sessionId] = tier;
      const ids = Object.keys(map);
      for (const id of ids.slice(0, Math.max(0, ids.length - 200))) delete map[id];
      localStorage.setItem(APPLIED_KEY, JSON.stringify(map));
    } catch (error) { console.error("[pi-web service tier] applied-tier record failed:", error); }
  }

  const fetchNative = window.fetch.bind(window);
  async function readModel(url, signal) {
    const response = await fetchNative(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "get_state" }), signal,
    });
    const result = await response.json();
    if (!response.ok || result.error || !result.data?.model) throw new Error(result.error || "无法确认当前模型");
    currentModel = result.data.model;
    if (button) render();
    return currentModel;
  }
  async function applyTier(url, tier, signal) {
    const response = await fetchNative(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "set_service_tier", serviceTier: tier === "native" ? null : tier }),
      signal,
    });
    const result = await response.json();
    if (!response.ok || result.error || result.success === false) throw new Error(result.error || `HTTP ${response.status}`);
  }

  // App commands are JSON.stringify({ type, ... }): read the type from the prefix instead of parsing
  // a body that may carry megabytes of base64 images. Unknown layouts fall back to a full parse.
  function commandType(body) {
    const match = /^\s*\{\s*"type"\s*:\s*"([a-z_]+)"/u.exec(body.slice(0, 64));
    if (match) return match[1];
    try { return String(JSON.parse(body)?.type || ""); } catch { return ""; }
  }

  window.fetch = async function piServiceTierFetch(input, init) {
    let url, type = "", rawBody = null, created = null, submissionInput = input, submissionInit = init;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    try {
      url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method || (input instanceof Request ? input.method : "GET");
      if (url.origin === location.origin && method.toUpperCase() === "POST" && /^\/api\/agent\/[^/]+$/.test(url.pathname)) {
        rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
        if (typeof rawBody === "string") type = commandType(rawBody);
      }
    } catch (error) { console.error("[pi-web service tier] request inspection failed:", error); }
    if (explicitSelection && SUBMISSIONS.has(type)) {
      // Reapply an explicit Fast choice on every submission so resumed/recreated sessions
      // cannot display Fast while silently running at native speed.
      try {
        const tier = selected;
        // A fresh session's first prompt must not bypass the speed selection.
        // Native ensure_session creates the runtime without invoking a model.
        if (url.pathname === "/api/agent/new") {
          const command = JSON.parse(rawBody);
          const response = await fetchNative(input, { ...init, method: "POST", body: JSON.stringify({ ...command, type: "ensure_session" }), signal });
          created = await response.json();
          if (!response.ok || created.error || !created.sessionId) throw new Error(created.error || "创建会话失败");
          freshRuntimes.add(created.sessionId);
          url = new URL(`/api/agent/${encodeURIComponent(created.sessionId)}`, location.origin);
          submissionInput = url.href;
          submissionInit = { ...init, method: "POST", headers: init?.headers ?? (input instanceof Request ? input.headers : { "Content-Type": "application/json" }), body: rawBody, signal };
        }
        const sessionId = decodeURIComponent(url.pathname.slice("/api/agent/".length));
        const known = freshRuntimes.has(sessionId) ? "native" : appliedTiers()[sessionId];
        if (tier === "native") {
          // Native is the default of every new runtime; only clear a tier this browser may have set.
          if (known !== "native") await applyTier(url.href, tier, signal);
          recordApplied(sessionId, "native");
        } else {
          // Recorded first: even a failed or rejected attempt may have left Fast on the runtime,
          // so a later 默认 submission must clear it rather than skip.
          recordApplied(sessionId, tier);
          // Model check and tier write are independent: run them together, send only if both pass.
          const [model] = await Promise.all([readModel(url.href, signal), applyTier(url.href, tier, signal)]);
          if (!supportsTier(model)) throw new Error("当前模型/渠道未确认支持此速度；请先选择默认");
        }
        freshRuntimes.delete(sessionId);
      } catch (error) {
        console.error("[pi-web service tier] selection not applied:", error);
        if (note) note.textContent = `TIER 未生效：${error.message}。本次消息未发送。`;
        return new Response(JSON.stringify({ error: `TIER 未生效：${error.message}`, code: "prompt_rejected", accepted: false, ...(created?.sessionId ? { sessionId: created.sessionId } : {}) }), { status: 409, headers: { "Content-Type": "application/json" } });
      }
    }
    const response = await fetchNative(submissionInput, submissionInit);
    if (created) {
      const result = await response.json();
      return new Response(JSON.stringify({ ...created, ...result, success: response.ok && result.success !== false, sessionId: created.sessionId }), { status: response.status, headers: { "Content-Type": "application/json" } });
    }
    // Observe only metadata, never consume or change the caller's response.
    if (url?.origin === location.origin && (url.pathname === "/api/models" || type === "set_model" || type === "ensure_session")) {
      try {
        const result = await response.clone().json();
        if (response.ok && !result.error && result.success !== false) {
          if (type === "set_model") {
            const command = JSON.parse(rawBody);
            currentModel = { provider: command.provider, id: command.modelId };
            resetTierAfterModelSwitch(url.href);
          } else if (type === "ensure_session" && url.pathname === "/api/agent/new" && result.sessionId) freshRuntimes.add(String(result.sessionId));
          else if (!currentModel && result.defaultModel) currentModel = { provider: result.defaultModel.provider, id: result.defaultModel.modelId };
          if (button) render();
        }
      } catch (error) { console.error("[pi-web service tier] model metadata read failed:", error); }
    }
    return response;
  };

  // A model switch puts the speed back on 默认 at once: the toolbar and menu show it, the
  // stored preference follows, and the session's own tier is cleared now rather than at the
  // next submission.
  function resetTierAfterModelSwitch(sessionUrl) {
    if (!explicitSelection) return;
    selected = "native"; migrationWarning = "";
    try { localStorage.setItem(KEY, selected); } catch (error) { console.error("[pi-web service tier] preference write failed:", error); }
    if (button) { note.textContent = noteText(); render(); }
    const sessionId = decodeURIComponent(new URL(sessionUrl).pathname.slice("/api/agent/".length));
    applyTier(sessionUrl, "native").then(() => recordApplied(sessionId, "native")).catch(error => {
      console.error("[pi-web service tier] reset after model switch failed:", error);
      if (note) note.textContent = `切换模型后未能恢复默认速度：${error.message}`;
    });
  }
  function closePanel(focus = false) {
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focus) button.focus({ preventScroll: true });
  }
  const checkIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  function render() {
    const choice = choices.find(([value]) => value === selected);
    button.title = `速度 / TIER：${choice[1]}`;
    button.setAttribute("aria-label", `速度：${choice[1]}`);
    button.dataset.tier = selected;
    button.classList.toggle("is-on", selected === "priority");
    for (const item of panel.querySelectorAll("button[data-tier]")) {
      const checked = item.dataset.tier === selected;
      item.setAttribute("aria-checked", String(checked));
      const mark = item.querySelector(".pw-menu-check");
      if (mark.innerHTML !== (checked ? checkIcon : "")) mark.innerHTML = checked ? checkIcon : "";
      item.disabled = item.dataset.tier !== "native" && !supportsTier(currentModel);
    }
  }
  function start() {
    host = document.createElement("span");
    host.dataset.piSlotItem = "tier";
    host.dataset.piSlotOrder = "2";
    button = document.createElement("button");
    button.id = "pi-service-tier-button";
    button.type = "button";
    button.className = "pw-icon-btn";
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-controls", "pi-service-tier-panel");
    button.setAttribute("aria-expanded", "false");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
    const bolt = document.createElementNS(svg.namespaceURI, "path");
    bolt.setAttribute("d", "M13 2 4 14h7l-1 8 10-13h-7l1-7Z");
    svg.appendChild(bolt); button.appendChild(svg);
    panel = document.createElement("div");
    panel.id = "pi-service-tier-panel";
    panel.className = "pw-menu pw-menu--up pw-slot-popover pw-tier-menu";
    panel.hidden = true;
    panel.setAttribute("role", "menu");
    panel.setAttribute("aria-label", "速度 / TIER");
    for (const [value, label] of choices) {
      const item = document.createElement("button"); item.type = "button"; item.className = "pw-menu-item"; item.dataset.tier = value; item.setAttribute("role", "menuitemradio");
      const mark = document.createElement("span"); mark.className = "pw-menu-check";
      const text = document.createElement("span"); text.className = "pw-menu-label"; text.textContent = label;
      item.append(mark, text);
      item.onclick = () => { selected = value; explicitSelection = true; migrationWarning = ""; note.textContent = noteText(); try { localStorage.setItem(KEY, selected); } catch (error) { console.error("[pi-web service tier] preference write failed:", error); } render(); closePanel(true); };
      panel.appendChild(item);
    }
    note = document.createElement("p"); note.className = "pw-tier-note"; note.textContent = noteText(); panel.appendChild(note);
    host.append(button, panel);
    button.onclick = async (event) => {
      if (!panel.hidden) { closePanel(); return; }
      const keyboard = event.detail === 0;
      panel.hidden = false; button.setAttribute("aria-expanded", "true");
      document.dispatchEvent(new CustomEvent("pi-ui:popover-open", { detail: "tier" }));
      note.textContent = noteText();
      const sessionId = new URL(location.href).searchParams.get("session");
      if (sessionId) {
        currentModel = null; render();
        try { await readModel(`/api/agent/${encodeURIComponent(sessionId)}`, AbortSignal.timeout(10000)); }
        catch (error) { console.error("[pi-web service tier] model check failed:", error); note.textContent = `仅默认速度可用：${error.message}`; }
      }
      // Keyboard opens move focus into the menu; mouse opens leave focus where it was.
      if (keyboard && !panel.hidden) panel.querySelector('[aria-checked="true"]:not(:disabled)')?.focus();
    };
    document.addEventListener('pi-ui:popover-open', event => { if (event.detail !== 'tier') closePanel(); });
    document.addEventListener('focusin', event => { if (!panel.hidden && !panel.contains(event.target) && event.target !== button) closePanel(); });
    document.addEventListener("pointerdown", event => { if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) closePanel(); });
    document.addEventListener("keydown", event => { if (panel.hidden) return; if (event.key === "Escape") { closePanel(true); } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); const items = [...panel.querySelectorAll("button[data-tier]:not(:disabled)")]; const at = items.indexOf(document.activeElement); items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length]?.focus(); } });
    render();
    window.__piUiSlots.register({ name: "tier", slot: "composer", order: 2, host });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();
})();
