(() => {
  "use strict";

  const VERSION = "piweb-session-archive-v1";
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
  };

  const copy = {
    en: {
      archive: "Archive",
      restore: "Restore",
      archiveQuestion: (subject) => `Archive ${subject}?`,
      restoreQuestion: (subject) => `Restore ${subject}?`,
      actionArchive: "Archive (Shift+click to skip confirmation)",
      actionRestore: "Restore (Shift+click to skip confirmation)",
      showArchived: (count) => `View archived sessions (${count})`,
      showActive: "Back to active sessions",
      archivedView: "Archive",
      emptyArchive: "No archived sessions",
      requestFailed: "Session archive request failed",
    },
    "zh-CN": {
      archive: "归档",
      restore: "恢复",
      archiveQuestion: (subject) => `归档 ${subject}？`,
      restoreQuestion: (subject) => `恢复 ${subject}？`,
      actionArchive: "归档（按住 Shift 点击可跳过确认）",
      actionRestore: "恢复（按住 Shift 点击可跳过确认）",
      showArchived: (count) => `查看归档会话（${count}）`,
      showActive: "返回当前会话",
      archivedView: "归档",
      emptyArchive: "暂无归档会话",
      requestFailed: "会话归档请求失败",
    },
    "zh-TW": {
      archive: "歸檔",
      restore: "還原",
      archiveQuestion: (subject) => `歸檔 ${subject}？`,
      restoreQuestion: (subject) => `還原 ${subject}？`,
      actionArchive: "歸檔（按住 Shift 點選可跳過確認）",
      actionRestore: "還原（按住 Shift 點選可跳過確認）",
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
  const emptySessionTexts = new Set(["No sessions found", "未找到会话", "暂无会话", "找不到工作階段"]);

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
      url.pathname += action === "restore" ? "/restore" : "/archive";
      nextInput = rewrittenInput(input, url);
      method = "POST";
      nextInit.method = "POST";
      delete nextInit.body;
    }

    let response = await nativeFetch(nextInput, nextInit);
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

  function ensureStyle() {
    if (document.querySelector("style[data-pi-session-archive-style]")) return;
    const style = document.createElement("style");
    style.dataset.piSessionArchiveStyle = "true";
    style.textContent = [
      "[data-pi-session-archive-action]{color:var(--text-muted)!important}",
      "[data-pi-session-archive-action]:hover{color:var(--accent)!important;border-color:rgba(37,99,235,.35)!important;background:var(--bg-selected)!important}",
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
    if (!refresh?.parentElement) return;
    let control = document.querySelector("button[data-pi-session-archive-control]");
    if (!control) {
      control = document.createElement("button");
      control.type = "button";
      control.dataset.piSessionArchiveControl = "true";
      control.addEventListener("click", () => {
        const baselineSerial = state.listRequestSerial;
        state.view = state.view === "active" ? "archived" : "active";
        try { sessionStorage.setItem(VIEW_KEY, state.view); } catch {}
        decorate();
        requestListRefresh(baselineSerial, state.view);
      });
    }
    if (control.parentElement !== refresh.parentElement || control.nextElementSibling !== refresh) {
      refresh.parentElement.insertBefore(control, refresh);
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
      "flex-shrink:0", "border:1px solid var(--border)", "border-radius:7px", "cursor:pointer",
      `background:${archivedView ? "var(--bg-selected)" : "var(--bg-hover)"}`,
      `color:${archivedView ? "var(--accent)" : "var(--text-muted)"}`,
      "font:600 11px/1 system-ui,sans-serif", "white-space:nowrap",
    ].join(";");
    const suffix = archivedView
      ? `<span>${text.archivedView}</span>`
      : state.archivedCount > 0 ? `<span>${state.archivedCount}</span>` : "";
    const markup = icon("archive") + suffix;
    if (control.innerHTML !== markup) control.innerHTML = markup;
  }

  function subjectFromQuestion(value) {
    const text = String(value || "").trim();
    const patterns = [
      /^(?:Delete|Archive|Restore)\s+(.+)\?$/u,
      /^(?:删除|归档|恢复)\s+(.+)[？?]$/u,
      /^(?:刪除|歸檔|還原)\s+(.+)[？?]$/u,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match) return match[1];
    }
    return "";
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
      const markup = icon(restoring ? "restore" : "archive");
      if (button.innerHTML !== markup) button.innerHTML = markup;
    }
  }

  function decorateConfirmations() {
    const text = words();
    const restoring = state.view === "archived";
    for (const button of document.querySelectorAll("button")) {
      const container = button.parentElement;
      const question = container?.previousElementSibling;
      if (!question) continue;
      let subject = question.dataset.piSessionArchiveSubject || subjectFromQuestion(question.textContent);
      if (!subject) continue;
      question.dataset.piSessionArchiveSubject = subject;
      button.dataset.piSessionArchiveConfirm = "true";
      const questionText = restoring ? text.restoreQuestion(subject) : text.archiveQuestion(subject);
      if (question.textContent !== questionText) question.textContent = questionText;
      const actionText = restoring ? text.restore : text.archive;
      const markup = icon(restoring ? "restore" : "archive") + `<span>${actionText}</span>`;
      if (button.innerHTML !== markup) button.innerHTML = markup;
      button.style.setProperty("background", "var(--accent)", "important");
      button.style.setProperty("color", "#fff", "important");
      button.style.setProperty("border", "none", "important");
      const row = container.parentElement;
      if (row) {
        row.style.setProperty("background", "var(--bg-selected)", "important");
        row.style.setProperty("border-left-color", "var(--accent)", "important");
      }
    }
  }

  function decorateEmptyState() {
    for (const element of document.querySelectorAll("div")) {
      const value = String(element.textContent || "").trim();
      if (!element.dataset.piSessionArchiveEmpty && !emptySessionTexts.has(value)) continue;
      element.dataset.piSessionArchiveEmpty = "true";
      const next = state.view === "archived" ? words().emptyArchive : element.dataset.piSessionArchiveOriginal || value;
      if (!element.dataset.piSessionArchiveOriginal) element.dataset.piSessionArchiveOriginal = value;
      if (element.textContent !== next) element.textContent = next;
    }
  }

  function decorate() {
    state.scheduled = false;
    if (!document.body) return;
    ensureStyle();
    ensureControl();
    decorateActions();
    decorateConfirmations();
    decorateEmptyState();
    document.documentElement.dataset.piSessionArchiveView = state.view;
  }

  function scheduleDecorate() {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(decorate);
  }

  const observer = new MutationObserver(scheduleDecorate);
  const start = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["title", "lang"] });
    scheduleDecorate();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
