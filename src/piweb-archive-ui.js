(() => {
  "use strict";

  const VERSION = "piweb-session-archive-v8";
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
  };

  const copy = {
    en: {
      archive: "Archive",
      restore: "Restore",
      actionArchive: "Archive",
      actionRestore: "Restore",
      showArchived: (count) => `View archived sessions (${count})`,
      showActive: "Back to active sessions",
      archivedView: "Archive",
      emptyArchive: "No archived sessions",
      requestFailed: "Session archive request failed",
    },
    "zh-CN": {
      archive: "归档",
      restore: "恢复",
      actionArchive: "归档",
      actionRestore: "恢复",
      showArchived: (count) => `查看归档会话（${count}）`,
      showActive: "返回当前会话",
      archivedView: "归档",
      emptyArchive: "暂无归档会话",
      requestFailed: "会话归档请求失败",
    },
    "zh-TW": {
      archive: "歸檔",
      restore: "還原",
      actionArchive: "歸檔",
      actionRestore: "還原",
      showArchived: (count) => `檢視歸檔工作階段（${count}）`,
      showActive: "返回目前工作階段",
      archivedView: "歸檔",
      emptyArchive: "沒有歸檔工作階段",
      requestFailed: "工作階段歸檔請求失敗",
    },
  };

  const oldDeleteTitles = new Set([
    "Delete (Shift+click to delete without confirmation)",
    "删除（按住 Shift 点击可跳过确认）",
    "刪除（按住 Shift 點選可跳過確認）",
  ]);
  const refreshTitles = new Set(["Refresh", "刷新", "重新整理"]);
  const forwardedActionEvents = new WeakSet();

  function language() {
    const html = String(document.documentElement?.lang || "").toLowerCase();
    if (html.includes("zh-tw") || html.includes("zh-hant")) return "zh-TW";
    if (html.includes("zh")) return "zh-CN";
    const refresh = [...document.querySelectorAll("button[title]")]
      .map((button) => button.getAttribute("title"))
      .find((title) => refreshTitles.has(title || ""));
    if (refresh === "刷新") return "zh-CN";
    if (refresh === "重新整理") return "zh-TW";
    return "en";
  }

  function words() { return copy[language()] || copy.en; }

  function icon(kind) {
    if (kind === "restore") {
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/><path d="M12 7v5l3 2"/></svg>';
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

  function showError(message) {
    if (!document.body) return;
    document.querySelector("[data-pi-session-archive-toast]")?.remove();
    const toast = document.createElement("div");
    toast.dataset.piSessionArchiveToast = "true";
    toast.setAttribute("role", "alert");
    toast.textContent = message;
    toast.style.cssText = "position:fixed;left:50%;bottom:24px;z-index:2147483647;transform:translateX(-50%);max-width:min(520px,calc(100vw - 32px));padding:9px 13px;border:1px solid rgba(220,38,38,.35);border-radius:8px;background:var(--bg,#fff);color:#dc2626;box-shadow:0 8px 28px rgba(0,0,0,.16);font:12px/1.45 system-ui,sans-serif";
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  window.fetch = async function piSessionArchiveFetch(input, init) {
    const url = requestUrl(input);
    const requestMethod = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
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
      }
      throw error;
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
    if (url && url.origin === window.location.origin && url.pathname === "/api/sessions" && method === "GET") {
      void response.clone().json().then((body) => {
        const count = Number(body?.archive?.archivedCount);
        if (Number.isFinite(count) && count >= 0) state.archivedCount = count;
        scheduleDecorate();
      }).catch(() => {});
    }
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

  function nativeNewSessionButton() {
    return [...document.querySelectorAll("button")].find((button) => {
      if (button.dataset.piSessionArchiveControl) return false;
      const title = String(button.getAttribute("title") || "");
      const label = String(button.textContent || "").trim();
      return /new session/iu.test(title) || /新建会话|新增工作階段/u.test(title) || ["New", "新建", "新增"].includes(label);
    }) || null;
  }

  function ensureStyle() {
    if (document.querySelector("style[data-pi-session-archive-style]")) return;
    const style = document.createElement("style");
    style.dataset.piSessionArchiveStyle = "true";
    style.textContent = [
      "[data-pi-session-archive-action]{color:var(--text-muted)!important;position:relative!important}",
      "[data-pi-session-archive-action]>svg{opacity:0!important}",
      "[data-pi-session-archive-action]::before{content:'';position:absolute;width:14px;height:14px;background:currentColor;-webkit-mask:center/14px 14px no-repeat url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22black%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M3 8h18v13H3z%22/%3E%3Cpath d=%22M1 3h22v5H1z%22/%3E%3Cpath d=%22M10 12h4%22/%3E%3C/svg%3E');mask:center/14px 14px no-repeat url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22black%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M3 8h18v13H3z%22/%3E%3Cpath d=%22M1 3h22v5H1z%22/%3E%3Cpath d=%22M10 12h4%22/%3E%3C/svg%3E')}",
      "[data-pi-session-archive-action][data-pi-session-archive-mode='restore']::before{-webkit-mask-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22black%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M3 12a9 9 0 1 0 3-6.7%22/%3E%3Cpath d=%22M3 4v6h6%22/%3E%3C/svg%3E');mask-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22black%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M3 12a9 9 0 1 0 3-6.7%22/%3E%3Cpath d=%22M3 4v6h6%22/%3E%3C/svg%3E')}",
      "[data-pi-session-archive-action]:hover{color:var(--accent)!important;border-color:rgba(37,99,235,.35)!important;background:var(--bg-selected)!important}",
      "[data-pi-session-archive-pending]{pointer-events:none!important;overflow:hidden!important}",
      "[data-pi-session-archive-hidden]{display:none!important}",
      "[data-pi-session-archive-control]:focus-visible,[data-pi-session-archive-action]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}",
    ].join("");
    document.head.appendChild(style);
  }

  function requestListRefresh(baselineSerial, expectedView, attempt = 0) {
    if (state.view !== expectedView) return;
    if (state.listRequestSerial > baselineSerial && state.lastRequestedListView === expectedView) return;
    nativeRefreshButton()?.click();
    const delays = [120, 240, 480, 800];
    setTimeout(() => {
      if (state.view !== expectedView) return;
      if (state.listRequestSerial > baselineSerial && state.lastRequestedListView === expectedView) return;
      if (attempt < delays.length - 1) requestListRefresh(baselineSerial, expectedView, attempt + 1);
      else window.location.reload();
    }, delays[attempt]);
  }

  function ensureControl() {
    const refresh = nativeRefreshButton();
    if (!refresh) return;
    let host = document.getElementById("pi-session-archive-control-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "pi-session-archive-control-host";
      host.style.cssText = "position:fixed;z-index:2147483000;width:max-content;height:32px;pointer-events:auto";
      document.documentElement.appendChild(host);
    }
    let control = host.querySelector("button[data-pi-session-archive-control]");
    if (!control) {
      control = document.createElement("button");
      control.type = "button";
      control.dataset.piSessionArchiveControl = "true";
      control.addEventListener("click", () => {
        for (const pending of [...state.optimisticActions]) restoreOptimisticAction(pending);
        const baselineSerial = state.listRequestSerial;
        state.view = state.view === "active" ? "archived" : "active";
        try { sessionStorage.setItem(VIEW_KEY, state.view); } catch {}
        decorate();
        requestListRefresh(baselineSerial, state.view);
      });
      host.appendChild(control);
    }
    const text = words();
    const archivedView = state.view === "archived";
    const label = archivedView ? text.showActive : text.showArchived(state.archivedCount);
    control.title = label;
    control.setAttribute("aria-label", label);
    control.setAttribute("aria-pressed", String(archivedView));
    control.style.cssText = [
      "display:flex", "align-items:center", "justify-content:center", "gap:5px", "height:32px",
      `width:${archivedView ? "auto" : state.archivedCount > 0 ? "auto" : "32px"}`,
      `padding:${archivedView || state.archivedCount > 0 ? "0 8px" : "0"}`,
      "border:1px solid var(--border)", "border-radius:7px", "cursor:pointer",
      `background:${archivedView ? "var(--bg-selected)" : "var(--bg-hover)"}`,
      `color:${archivedView ? "var(--accent)" : "var(--text-muted)"}`,
      "font:600 11px/1 system-ui,sans-serif", "white-space:nowrap",
    ].join(";");
    const suffix = archivedView
      ? `<span>${text.archivedView}</span>`
      : state.archivedCount > 0 ? `<span>${state.archivedCount}</span>` : "";
    const markup = icon("archive") + suffix;
    if (control.innerHTML !== markup) control.innerHTML = markup;
    const refreshRect = refresh.getBoundingClientRect();
    const createRect = nativeNewSessionButton()?.getBoundingClientRect();
    const controlWidth = control.getBoundingClientRect().width || 32;
    const betweenGap = createRect ? refreshRect.left - createRect.right - 16 : 0;
    const left = createRect && betweenGap >= controlWidth
      ? createRect.right + 8
      : createRect ? createRect.left - controlWidth - 8 : refreshRect.left - controlWidth - 8;
    host.style.top = `${Math.max(0, refreshRect.top)}px`;
    host.style.left = `${Math.max(4, left)}px`;
  }

  function decorateActions() {
    const text = words();
    const restoring = state.view === "archived";
    const buttons = [...document.querySelectorAll("button")];
    for (const button of buttons) {
      const title = button.getAttribute("title") || "";
      if (!button.dataset.piSessionArchiveAction && !oldDeleteTitles.has(title)) continue;
      button.dataset.piSessionArchiveAction = "true";
      const label = restoring ? text.actionRestore : text.actionArchive;
      if (button.title !== label) button.title = label;
      button.setAttribute("aria-label", label);
      button.dataset.piSessionArchiveMode = restoring ? "restore" : "archive";
    }
  }

  function sessionRow(button) {
    let row = button?.parentElement;
    while (row && row !== document.body) {
      if (row.style.height === "54px" && row.style.display === "flex") return row;
      row = row.parentElement;
    }
    return null;
  }

  function restoreOptimisticAction(pending) {
    if (!pending) return;
    clearTimeout(pending.hideTimer);
    clearTimeout(pending.cleanupTimer);
    pending.animation?.cancel();
    state.optimisticActions.delete(pending);
    if (pending.button?.isConnected) delete pending.button.dataset.piSessionArchiveBusy;
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

  function beginOptimisticAction(button) {
    const row = sessionRow(button);
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
      wasSelected: row.style.background.includes("--bg-selected") || row.style.borderLeftColor.includes("--accent"),
      nextRow: row.nextElementSibling || row.previousElementSibling || null,
    };
    state.optimisticActions.add(pending);
    row.dataset.piSessionArchivePending = "true";
    row.setAttribute("aria-busy", "true");
    row.style.pointerEvents = "none";
    const computed = getComputedStyle(row);
    const rowHeight = row.getBoundingClientRect().height || 54;
    pending.animation = row.animate([
      { opacity: computed.opacity || "1", transform: computed.transform === "none" ? "translateX(0)" : computed.transform, height: `${rowHeight}px` },
      { opacity: "0", transform: "translateX(-6px)", height: "0px" },
    ], { duration: 180, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "forwards" });
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

  function sessionIdFromRow(row) {
    const fiberKey = row ? Object.keys(row).find((key) => key.startsWith("__reactFiber$")) : "";
    let fiber = fiberKey ? row[fiberKey] : null;
    for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
      const session = fiber.memoizedProps?.session || fiber.pendingProps?.session;
      if (session?.id) return String(session.id);
    }
    return "";
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
      if (action === "archive" && pending.wasSelected && pending.nextRow?.isConnected) pending.nextRow.click();
      scheduleDecorate();
      setTimeout(() => nativeRefreshButton()?.click(), 220);
    } catch (error) {
      const message = `${words().requestFailed}：${String(error?.message || error || "network error")}`;
      console.error("[pi-web archive]", message);
      restoreOptimisticAction(pending);
      showError(message);
    }
  }

  function immediateActionClick(event) {
    if (forwardedActionEvents.has(event)) return;
    if (event.type === "pointerdown" && event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const button = target?.closest("button[data-pi-session-archive-action]");
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (button.dataset.piSessionArchiveBusy) return;
    button.dataset.piSessionArchiveBusy = "true";
    const pending = beginOptimisticAction(button);
    const sessionId = sessionIdFromRow(pending?.row);
    if (pending && sessionId) {
      void performDirectAction(pending, sessionId);
      return;
    }
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
    document.addEventListener("pointerdown", immediateActionClick, true);
    document.addEventListener("click", immediateActionClick, true);
  }

  function decorate() {
    state.scheduled = false;
    if (!document.body) return;
    ensureStyle();
    ensureControl();
    decorateActions();
    document.documentElement.dataset.piSessionArchiveView = state.view;
  }

  function scheduleDecorate() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(decorate);
  }

  const observer = new MutationObserver(scheduleDecorate);
  const start = () => {
    enableImmediateActions();
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["title", "lang"] });
    scheduleDecorate();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
