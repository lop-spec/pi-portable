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

  function normalizeWorktreePath(value) {
    return String(value ?? "").replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
  }

  // Treat Pi Web's own <repo>-worktrees directory as the project-category
  // namespace. Agent-created checkouts elsewhere (for example
  // .claude/worktrees) remain usable by their sessions, but never clutter the
  // category switcher. This is derived from paths, so there is no registry to
  // maintain and existing user-created worktrees are discovered automatically.
  function filterProjectCategoryWorktrees(body) {
    if (!body || typeof body !== "object" || typeof body.projectRoot !== "string" || !Array.isArray(body.worktrees)) {
      throw new Error("unexpected /api/worktrees response shape");
    }
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
    return { ...body, currentWorktreePath, worktrees };
  }

  async function projectCategoryWorktreeResponse(response) {
    const body = filterProjectCategoryWorktrees(await response.clone().json());
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
    toast.style.cssText = "position:fixed;left:50%;bottom:24px;z-index:2147483647;transform:translateX(-50%);max-width:min(520px,calc(100vw - 32px));padding:9px 13px;border:1px solid rgba(220,38,38,.35);border-radius:8px;background:var(--bg,#fff);color:#dc2626;box-shadow:0 8px 28px rgba(0,0,0,.16);font:12px/1.45 system-ui,sans-serif";
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
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
      "[data-pi-session-archive-handoff='true']{background:var(--bg-selected)!important;border-left-color:var(--accent)!important}",
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
    clearTimeout(pending.handoffTimer);
    pending.animation?.cancel();
    state.optimisticActions.delete(pending);
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
      handedOff: false,
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
    pending.handoffTimer = setTimeout(() => {
      if (nextRow.isConnected) nextRow.click();
    }, 190);
    const startedAt = performance.now();
    const settle = () => {
      if (!nextRow.isConnected) return;
      if (nextRow.style.background.includes("--bg-selected") || performance.now() - startedAt >= 5000) {
        delete nextRow.dataset.piSessionArchiveHandoff;
        return;
      }
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }

  function scheduleHandoffRefresh() {
    setTimeout(() => nativeRefreshButton()?.click(), 1400);
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
      else setTimeout(() => nativeRefreshButton()?.click(), 220);
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

(() => {
  "use strict";

  const VERSION = "piweb-account-usage-v2";
  const ENDPOINT = "/__pi_account_usage";
  const SELECT_ENDPOINT = "/__pi_account_select";
  // The bridge refreshes upstream data every four minutes. Reading its local
  // snapshot every 45 seconds keeps the rendered value safely below five
  // minutes old even with timer jitter; this never calls a model endpoint.
  const BROWSER_REFRESH_MS = 45_000;
  if (window.__piAccountUsageUiVersion === VERSION) return;
  window.__piAccountUsageUiVersion = VERSION;

  const state = {
    data: null,
    error: "",
    loading: false,
    open: false,
    switchingId: "",
    switchFailedId: "",
    switchError: "",
    lastFetchAt: 0,
    suppressClick: false,
    renderedLocale: "",
    host: null,
    button: null,
    panel: null,
    list: null,
    title: null,
    freshness: null,
  };

  const labels = {
    en: {
      title: "Account pool usage",
      button: "View account pool usage",
      remaining: "left",
      used: "Used",
      resets: "Reset credits",
      resetAt: "Resets",
      resetCountShort: "Credits",
      current: "Current",
      cached: "Cached",
      switchAccount: "Switch",
      switchingAccount: "Switching…",
      retrySwitch: "Retry",
      switchFailed: "Switch failed",
      loading: "Loading usage…",
      empty: "No rotating accounts found",
      unavailable: "Usage is temporarily unavailable",
      retrying: "Retrying automatically",
      updatedNow: "Updated now",
      updatedMinutes: (minutes) => `Updated ${minutes}m ago`,
      updating: "Updating…",
      soon: "soon",
      minutes: (minutes) => `${minutes}m`,
      hours: (hours) => `${hours}h`,
      days: (days, hours) => `${days}d ${hours}h`,
    },
    "zh-CN": {
      title: "账号池额度",
      button: "查看轮转账号池额度",
      remaining: "剩余",
      used: "已用",
      resets: "重置次数",
      resetAt: "重置时间",
      resetCountShort: "次数",
      current: "当前",
      cached: "缓存",
      switchAccount: "切换",
      switchingAccount: "切换中…",
      retrySwitch: "重试",
      switchFailed: "切换失败",
      loading: "正在读取额度…",
      empty: "未发现轮转账号",
      unavailable: "额度暂不可用",
      retrying: "稍后自动重试",
      updatedNow: "刚刚更新",
      updatedMinutes: (minutes) => `${minutes} 分钟前更新`,
      updating: "更新中…",
      soon: "即将重置",
      minutes: (minutes) => `${minutes} 分钟后`,
      hours: (hours) => `${hours} 小时后`,
      days: (days, hours) => `${days} 天 ${hours} 小时后`,
    },
    "zh-TW": {
      title: "帳號池額度",
      button: "檢視輪轉帳號池額度",
      remaining: "剩餘",
      used: "已用",
      resets: "重置次數",
      resetAt: "重置時間",
      resetCountShort: "次數",
      current: "目前",
      cached: "快取",
      switchAccount: "切換",
      switchingAccount: "切換中…",
      retrySwitch: "重試",
      switchFailed: "切換失敗",
      loading: "正在讀取額度…",
      empty: "未發現輪轉帳號",
      unavailable: "額度暫時無法使用",
      retrying: "稍後自動重試",
      updatedNow: "剛剛更新",
      updatedMinutes: (minutes) => `${minutes} 分鐘前更新`,
      updating: "更新中…",
      soon: "即將重置",
      minutes: (minutes) => `${minutes} 分鐘後`,
      hours: (hours) => `${hours} 小時後`,
      days: (days, hours) => `${days} 天 ${hours} 小時後`,
    },
  };

  function locale() {
    try {
      const stored = localStorage.getItem("pi-locale");
      if (stored === "en" || stored === "zh-CN" || stored === "zh-TW") return stored;
    } catch { /* storage is optional */ }
    const value = String(document.documentElement.lang || navigator.language || "en").toLowerCase();
    if (value.includes("zh-tw") || value.includes("zh-hant")) return "zh-TW";
    if (value.includes("zh")) return "zh-CN";
    const titles = [...document.querySelectorAll("button[title]")].map((button) => button.title);
    if (titles.some((title) => title === "關閉完成提示音" || title === "開啟完成提示音")) return "zh-TW";
    if (titles.some((title) => title === "关闭完成提示音" || title === "开启完成提示音")) return "zh-CN";
    return "en";
  }

  function words() { return labels[locale()] || labels.en; }

  function staticSvg(markup) {
    const holder = document.createElement("span");
    holder.style.display = "contents";
    holder.insertAdjacentHTML("afterbegin", markup);
    return holder.firstElementChild;
  }

  function gaugeIcon() {
    return staticSvg('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15a8 8 0 1 1 16 0"/><path d="m12 15 4-4"/><path d="M5.5 18h13"/></svg>');
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function findAnchor() {
    const soundNames = new Set([
      "Disable completion sound", "Enable completion sound",
      "关闭完成提示音", "开启完成提示音",
      "關閉完成提示音", "開啟完成提示音",
    ]);
    const sound = [...document.querySelectorAll("button[title]")]
      .filter((button) => soundNames.has(button.title) && isVisible(button))
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
    if (sound?.parentElement) {
      const rect = sound.parentElement.getBoundingClientRect();
      if (rect.top > 40) return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }
    const moreNames = new Set(["More controls", "更多控件", "更多控制項"]);
    const more = [...document.querySelectorAll("button[aria-label]")]
      .filter((button) => moreNames.has(button.getAttribute("aria-label")) && isVisible(button))
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
    if (!more) return null;
    const rect = more.getBoundingClientRect();
    return rect.top > 40 ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
  }

  function positionUi() {
    if (!state.host || !state.panel) return;
    if (state.data && state.renderedLocale && state.renderedLocale !== locale()) {
      render();
      return;
    }
    const anchor = findAnchor();
    if (!anchor) {
      state.host.style.visibility = "hidden";
      state.panel.style.visibility = "hidden";
      return;
    }
    const left = Math.max(8, anchor.left - 38);
    state.host.style.left = `${left}px`;
    state.host.style.top = `${anchor.top}px`;
    state.host.style.visibility = "visible";
    state.panel.style.right = `${Math.max(8, window.innerWidth - anchor.right)}px`;
    state.panel.style.bottom = `${Math.max(8, window.innerHeight - anchor.top + 8)}px`;
    state.panel.style.maxHeight = `${Math.min(360, Math.max(180, anchor.top - 20))}px`;
    state.panel.style.visibility = state.open ? "visible" : "hidden";
  }

  function relativeReset(resetAt) {
    const text = words();
    const left = Date.parse(String(resetAt || "")) - Date.now();
    if (!Number.isFinite(left) || left <= 0) return text.soon;
    const minutes = Math.max(1, Math.ceil(left / 60_000));
    if (minutes < 60) return text.minutes(minutes);
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return text.hours(hours);
    return text.days(Math.floor(hours / 24), hours % 24);
  }

  function exactReset(resetAt) {
    const milliseconds = Date.parse(String(resetAt || ""));
    if (!Number.isFinite(milliseconds)) return "—";
    return new Intl.DateTimeFormat(locale(), {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(milliseconds));
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
    const dot = document.createElement("span");
    dot.className = "pi-account-usage-dot";
    dot.dataset.state = account.error && account.remainingPercent == null ? "error" : account.active ? "active" : "idle";
    identity.appendChild(dot);
    const email = String(account.email || account.id || "—");
    appendText(identity, "pi-account-usage-email", email, account.error ? `${email} · ${account.error}` : email);
    top.appendChild(identity);

    const action = document.createElement("button");
    action.type = "button";
    action.className = "pi-account-usage-switch";
    const isSwitching = state.switchingId === account.id;
    const didFail = state.switchFailedId === account.id;
    action.dataset.state = account.active ? "current" : didFail ? "failed" : "idle";
    action.textContent = account.active ? text.current : isSwitching ? text.switchingAccount : didFail ? text.retrySwitch : text.switchAccount;
    action.title = account.active ? `${email} · ${text.current}` : `${text.switchAccount} ${email}`;
    action.setAttribute("aria-label", action.title);
    action.disabled = Boolean(account.active || state.switchingId);
    action.addEventListener("click", () => { void switchAccount(String(account.id || "")); });
    top.appendChild(action);
    row.appendChild(top);

    if (account.remainingPercent != null) {
      const meter = document.createElement("div");
      meter.className = "pi-account-usage-meter";
      meter.setAttribute("role", "progressbar");
      meter.setAttribute("aria-label", `${email} ${text.remaining}`);
      meter.setAttribute("aria-valuemin", "0");
      meter.setAttribute("aria-valuemax", "100");
      meter.setAttribute("aria-valuenow", String(account.remainingPercent));
      const fill = document.createElement("span");
      fill.style.width = `${Math.max(0, Math.min(100, Number(account.remainingPercent) || 0))}%`;
      fill.dataset.level = account.remainingPercent <= 5 ? "critical" : account.remainingPercent <= 20 ? "low" : "normal";
      meter.appendChild(fill);
      row.appendChild(meter);
    }

    const meta = document.createElement("div");
    meta.className = "pi-account-usage-meta";
    appendText(meta, "pi-account-usage-remaining-compact", `${text.remaining} ${account.remainingPercent == null ? "—" : `${account.remainingPercent}%`}`);
    appendText(meta, "", account.usedPercent == null ? text.unavailable : `${text.used} ${account.usedPercent}%`);
    appendText(meta, "", `${text.resetCountShort} ${account.resetCredits ?? "—"}`);
    const reset = appendText(meta, "", account.resetAt ? exactReset(account.resetAt) : `${text.resetAt} —`);
    if (account.resetAt) {
      const full = new Date(account.resetAt).toLocaleString(locale(), { hour12: false });
      reset.title = `${text.resetAt} ${full} · ${relativeReset(account.resetAt)}`;
    }
    row.appendChild(meta);
    return row;
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

  function render() {
    if (!state.list || !state.title || !state.freshness || !state.panel || !state.button) return;
    const text = words();
    state.renderedLocale = locale();
    state.title.textContent = text.title;
    state.button.title = text.button;
    state.button.setAttribute("aria-label", text.button);
    state.panel.setAttribute("aria-label", text.title);
    state.list.replaceChildren();
    state.panel.setAttribute("aria-busy", String(state.loading));

    const accounts = Array.isArray(state.data?.accounts) ? state.data.accounts : [];
    if (!state.data && state.loading) emptyState(text.loading);
    else if (!state.data && state.error) emptyState(text.unavailable, text.retrying);
    else if (!state.data?.enabled || accounts.length === 0) emptyState(text.empty);
    else for (const account of accounts) state.list.appendChild(accountRow(account));

    const ages = accounts.map((account) => Number(account.ageMs)).filter(Number.isFinite);
    const oldestAge = ages.length ? Math.max(...ages) : 0;
    const minutes = Math.max(0, Math.floor(oldestAge / 60_000));
    state.freshness.textContent = state.switchingId
      ? text.switchingAccount
      : state.switchError ? text.switchFailed
        : state.loading ? text.updating
          : minutes < 1 ? text.updatedNow : text.updatedMinutes(minutes);
    state.freshness.title = state.switchError || "";
    state.freshness.dataset.stale = String(Boolean(state.switchError || state.error || accounts.some((account) => account.stale)));
    state.button.dataset.state = state.error && !state.data ? "error" : accounts.some((account) => account.remainingPercent != null && account.remainingPercent <= 20) ? "low" : "ready";
    positionUi();
  }

  async function refresh(force = false) {
    if (state.loading) return;
    state.loading = true;
    state.lastFetchAt = Date.now();
    render();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    try {
      const response = await fetch(`${ENDPOINT}${force ? "?refresh=1" : ""}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(data.accounts)) throw new Error(data.error || `HTTP ${response.status}`);
      state.data = data;
      state.error = "";
    } catch (error) {
      state.error = String(error?.message || error || "request failed").slice(0, 120);
      console.error("[pi-web account usage] refresh failed:", state.error);
    } finally {
      clearTimeout(timeout);
      state.loading = false;
      render();
    }
  }

  function setOpen(open, startedAt = performance.now()) {
    state.open = Boolean(open);
    state.button.setAttribute("aria-expanded", String(state.open));
    state.panel.dataset.open = String(state.open);
    positionUi();
    if (!state.open) return;
    document.documentElement.dataset.piAccountUsageOpenLatencyMs = (performance.now() - startedAt).toFixed(2);
    if (!state.lastFetchAt || Date.now() - state.lastFetchAt >= BROWSER_REFRESH_MS) void refresh(false);
  }

  function ensureStyle() {
    if (document.querySelector("style[data-pi-account-usage-style]")) return;
    const style = document.createElement("style");
    style.dataset.piAccountUsageStyle = "true";
    style.textContent = `
      #pi-account-usage-host{position:fixed;z-index:2147482500;width:32px;height:32px;pointer-events:none}
      #pi-account-usage-button{position:relative;display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--text-muted);cursor:pointer;pointer-events:auto;transition:background 140ms ease-out,color 140ms ease-out,transform 140ms ease-out}
      #pi-account-usage-button:hover,#pi-account-usage-button[aria-expanded='true']{background:var(--bg-hover);color:var(--text)}
      #pi-account-usage-button:active{transform:scale(.96)}
      #pi-account-usage-button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
      #pi-account-usage-button::after{position:absolute;top:5px;right:5px;width:4px;height:4px;border-radius:50%;background:transparent;content:''}
      #pi-account-usage-button[data-state='low']::after{background:#d97706}
      #pi-account-usage-button[data-state='error']::after{background:#dc2626}
      #pi-account-usage-panel{position:fixed;z-index:2147482499;width:280px;max-width:calc(100vw - 16px);overflow:auto;overscroll-behavior:contain;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--text);box-shadow:0 7px 18px rgba(0,0,0,.12);opacity:0;transform:translateY(4px) scale(.99);transform-origin:bottom right;pointer-events:none;visibility:hidden;transition:opacity 150ms ease-out,transform 150ms ease-out,visibility 0s linear 150ms;font:13px/1.35 'Segoe UI Variable','Segoe UI','Microsoft YaHei UI',system-ui,sans-serif}
      #pi-account-usage-panel[data-open='true']{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;visibility:visible;transition-delay:0s}
      .pi-account-usage-header{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:8px;height:29px;padding:0 7px;border-bottom:1px solid var(--border);background:var(--bg)}
      .pi-account-usage-title{font-size:13px;font-weight:650;color:var(--text)}
      .pi-account-usage-freshness{overflow:hidden;color:var(--text-dim);font-size:11px;font-variant-numeric:tabular-nums;text-overflow:ellipsis;white-space:nowrap}
      .pi-account-usage-freshness[data-stale='true']{color:#b45309}
      .pi-account-usage-row{padding:3px 7px;border-top:1px solid color-mix(in srgb,var(--border) 72%,transparent)}
      .pi-account-usage-row:first-child{border-top:0}
      .pi-account-usage-row[data-active='true']{background:color-mix(in srgb,var(--accent) 3%,var(--bg))}
      .pi-account-usage-top{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px;min-width:0;height:20px}
      .pi-account-usage-identity{display:flex;align-items:center;gap:5px;min-width:0}
      .pi-account-usage-dot{width:5px;height:5px;flex:0 0 5px;border-radius:50%;background:var(--text-dim)}
      .pi-account-usage-dot[data-state='active']{background:var(--accent)}
      .pi-account-usage-dot[data-state='error']{background:#dc2626}
      .pi-account-usage-email{min-width:0;overflow:hidden;color:var(--text);font-size:13px;font-weight:600;line-height:18px;text-overflow:ellipsis;white-space:nowrap}
      .pi-account-usage-switch{min-width:36px;height:20px;padding:0 6px;border:1px solid var(--border);border-radius:5px;background:var(--bg);color:var(--text-muted);font:inherit;font-size:11px;font-weight:600;line-height:18px;cursor:pointer;transition:background 100ms ease-out,border-color 100ms ease-out,color 100ms ease-out}
      .pi-account-usage-switch:hover:not(:disabled){border-color:color-mix(in srgb,var(--accent) 45%,var(--border));background:color-mix(in srgb,var(--accent) 6%,var(--bg));color:var(--accent)}
      .pi-account-usage-switch:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
      .pi-account-usage-switch:disabled{cursor:default;opacity:.72}
      .pi-account-usage-switch[data-state='current']{border-color:color-mix(in srgb,var(--accent) 28%,var(--border));background:color-mix(in srgb,var(--accent) 7%,var(--bg));color:var(--accent)}
      .pi-account-usage-switch[data-state='failed']{border-color:color-mix(in srgb,#dc2626 35%,var(--border));color:#b91c1c}
      .pi-account-usage-meter{height:2px;margin:2px 0 1px;overflow:hidden;border-radius:2px;background:var(--bg-hover)}
      .pi-account-usage-meter>span{display:block;height:100%;border-radius:inherit;background:var(--accent);transition:width 180ms ease-out}
      .pi-account-usage-meter>span[data-level='low']{background:#d97706}
      .pi-account-usage-meter>span[data-level='critical']{background:#dc2626}
      .pi-account-usage-meta{display:flex;align-items:center;min-width:0;overflow:hidden;color:var(--text-muted);font-size:11px;line-height:14px;font-variant-numeric:tabular-nums;white-space:nowrap}
      .pi-account-usage-meta>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
      .pi-account-usage-meta>.pi-account-usage-remaining-compact{flex:0 0 auto;color:var(--text);font-weight:650}
      .pi-account-usage-meta>span+span::before{margin:0 4px;color:var(--text-dim);content:'·'}
      .pi-account-usage-empty{display:flex;min-height:58px;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:10px;color:var(--text-muted);text-align:center}
      .pi-account-usage-empty-title{font-size:13px;font-weight:600;color:var(--text-muted)}
      .pi-account-usage-empty-note{font-size:11px;color:var(--text-dim)}
      @media(max-width:480px){#pi-account-usage-panel{width:min(280px,calc(100vw - 16px))}}
      @media(prefers-reduced-motion:reduce){#pi-account-usage-button,#pi-account-usage-panel,.pi-account-usage-meter>span{transition:none!important}}
    `;
    document.head.appendChild(style);
  }

  function createUi() {
    if (state.host) return;
    ensureStyle();
    const host = document.createElement("div");
    host.id = "pi-account-usage-host";
    const button = document.createElement("button");
    button.id = "pi-account-usage-button";
    button.type = "button";
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", "pi-account-usage-panel");
    button.appendChild(gaugeIcon());
    host.appendChild(button);

    const panel = document.createElement("section");
    panel.id = "pi-account-usage-panel";
    panel.dataset.open = "false";
    panel.setAttribute("role", "dialog");
    const header = document.createElement("header");
    header.className = "pi-account-usage-header";
    const title = appendText(header, "pi-account-usage-title", words().title);
    const freshness = appendText(header, "pi-account-usage-freshness", words().updating);
    freshness.setAttribute("aria-live", "polite");
    const list = document.createElement("div");
    list.className = "pi-account-usage-list";
    panel.append(header, list);
    document.documentElement.append(host, panel);

    state.host = host;
    state.button = button;
    state.panel = panel;
    state.list = list;
    state.title = title;
    state.freshness = freshness;
    title.textContent = words().title;

    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const startedAt = performance.now();
      state.suppressClick = true;
      setTimeout(() => { state.suppressClick = false; }, 500);
      setOpen(!state.open, startedAt);
    });
    button.addEventListener("click", () => {
      if (state.suppressClick) {
        state.suppressClick = false;
        return;
      }
      setOpen(!state.open, performance.now());
    });
    document.addEventListener("pointerdown", (event) => {
      if (!state.open || event.composedPath().includes(button) || event.composedPath().includes(panel)) return;
      setOpen(false);
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !state.open) return;
      event.preventDefault();
      setOpen(false);
      button.focus({ preventScroll: true });
    }, true);
    window.addEventListener("resize", positionUi, { passive: true });
    render();
    void refresh(false);
  }

  const start = () => {
    createUi();
    positionUi();
    setInterval(positionUi, 1000);
    setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - state.lastFetchAt >= BROWSER_REFRESH_MS) void refresh(false);
      if (state.open) render();
    }, BROWSER_REFRESH_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - state.lastFetchAt >= BROWSER_REFRESH_MS) void refresh(false);
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
