// ==UserScript==
// @name         AI Conversation Navigator
// @namespace    https://github.com/local/ai-conversation-navigator
// @version      0.2.0
// @description  Copilot conversation collection, outline, coverage, persistence, and export
// @match        https://m365.cloud.microsoft/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  if (window.__AI_CONVERSATION_NAVIGATOR__) {
    return;
  }

  const PANEL_ID = "ai-conversation-navigator";
  const STORAGE_NAME = "ai-conversation-navigator";
  const SESSION_STORE = "sessions";
  const SAVE_DELAY_MS = 800;
  const ROUTE_CHECK_MS = 1000;
  const SCROLL_STEP_MS = 350;
  const SCROLL_STEP_RATIO = 0.75;
  const state = {
    ready: false,
    currentConversationId: null,
    currentSession: null,
    sessions: new Map(),
    autoScrolling: false
  };

  let panel = null;
  let saveTimer = 0;
  class CopilotProvider {
    match() {
      return location.hostname.includes("m365.cloud.microsoft");
    }

    getConversationId() {
      const match = location.pathname.match(/conversation\/([^/]+)/);
      return match ? match[1] : "unknown";
    }

    getConversationTitle() {
      return document.title.trim() || "Untitled conversation";
    }

    collectVisibleMessages() {
      const nodes = document.querySelectorAll(
        '[data-testid="m365-chat-llm-web-ui-chat-message"]'
      );
      const messages = [];

      nodes.forEach((node, nodeIndex) => {
        const rawIndex = node.getAttribute("data-message-index");
        const parsedIndex = Number(rawIndex);
        const index = Number.isFinite(parsedIndex) ? parsedIndex : nodeIndex;
        const user = node.querySelector('[data-testid="chatInput"], [data-testid="chatOutput"]');
        const assistant = node.querySelector('[data-testid="markdown-reply"]');

        if (user) {
          const content = user.innerText.trim();
          if (content) {
            messages.push(createMessage(index, "user", content));
          }
        }

        if (assistant) {
          const content = assistant.innerText.trim();
          if (content) {
            messages.push(createMessage(index, "assistant", content));
          }
        }
      });

      return messages;
    }

    getMountedIndexes() {
      return new Set(Array.from(document.querySelectorAll(
        '[data-testid="m365-chat-llm-web-ui-chat-message"][data-message-index]'
      )).map((node) => Number(node.getAttribute("data-message-index"))));
    }
  }

  const providers = [new CopilotProvider()];

  function activeProvider() {
    return providers.find((provider) => provider.match()) || null;
  }

  function createSession(id, title) {
    return {
      id,
      title,
      platform: "copilot",
      messages: [],
      messageMap: new Map(),
      visibleMap: new Map(),
      coverage: {
        maxIndex: -1,
        missingRanges: [],
        progress: 0
      },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  function createMessage(index, role, content) {
    return {
      index,
      role,
      content,
      key: `${index}|${role}`
    };
  }

  function compressRanges(values) {
    if (!values.length) {
      return [];
    }

    const ranges = [];
    let start = values[0];
    let previous = values[0];

    for (let position = 1; position < values.length; position += 1) {
      const value = values[position];
      if (value === previous + 1) {
        previous = value;
        continue;
      }

      ranges.push([start, previous]);
      start = value;
      previous = value;
    }

    ranges.push([start, previous]);
    return ranges;
  }

  function calculateCoverage(session) {
    const indexes = Array.from(new Set(
      session.messages
        .map((message) => message.index)
        .filter((index) => Number.isInteger(index) && index >= 0)
    )).sort((left, right) => left - right);

    if (!indexes.length) {
      session.coverage.maxIndex = -1;
      session.coverage.missingRanges = [];
      session.coverage.progress = 0;
      return;
    }

    const userIndexes = new Set(
      session.messages
        .filter((message) => message.role === "user")
        .map((message) => message.index)
    );
    const assistantIndexes = new Set(
      session.messages
        .filter((message) => message.role === "assistant" && message.content.trim())
        .map((message) => message.index)
    );
    const present = new Set(indexes);
    const maxIndex = indexes[indexes.length - 1];
    const missing = [];

    for (let index = 0; index <= maxIndex; index += 1) {
      if (!present.has(index) || (userIndexes.has(index) && !assistantIndexes.has(index))) {
        missing.push(index);
      }
    }

    session.coverage.maxIndex = maxIndex;
    session.coverage.missingRanges = compressRanges(missing);
    session.coverage.progress = Math.round(
      ((maxIndex + 1 - missing.length) / (maxIndex + 1)) * 100
    );
  }

  function collect() {
    const provider = activeProvider();
    const session = state.currentSession;

    if (!provider || !session) {
      return;
    }

    const messages = provider.collectVisibleMessages();
    let structureChanged = false;
    let contentChanged = false;
    session.visibleMap.clear();

    messages.forEach((message) => {
      session.visibleMap.set(message.index, true);

      const existing = session.messageMap.get(message.key);

      if (!existing) {
        session.messageMap.set(message.key, message);
        session.messages.push(message);
        structureChanged = true;
        return;
      }

      if (existing.content !== message.content) {
        existing.content = message.content;
        contentChanged = true;
      }
    });

    if (structureChanged) {
      session.updatedAt = Date.now();
      session.messages.sort(sortMessages);
      calculateCoverage(session);
      scheduleSave(session);
      renderPanel();
    } else if (contentChanged) {
      session.updatedAt = Date.now();
      scheduleSave(session);
      updateJumpStates();
    } else {
      updateJumpStates();
    }

    decorateMessageNodes();
  }

  function sortMessages(left, right) {
    if (left.index !== right.index) {
      return left.index - right.index;
    }

    if (left.role === right.role) {
      return left.key.localeCompare(right.key);
    }

    return left.role === "user" ? -1 : 1;
  }

  function switchSession(id, title) {
    let session = state.sessions.get(id);

    if (!session) {
      session = createSession(id, title);
      state.sessions.set(id, session);
    }

    if (title && title !== session.title) {
      session.title = title;
      session.updatedAt = Date.now();
      scheduleSave(session);
    }

    state.currentConversationId = id;
    state.currentSession = session;
    collect();
    renderPanel();
  }

  function monitorRoute() {
    setInterval(() => {
      const provider = activeProvider();
      if (!provider) {
        return;
      }

      const id = provider.getConversationId();
      if (id !== state.currentConversationId) {
        switchSession(id, provider.getConversationTitle());
      }
    }, ROUTE_CHECK_MS);
  }

  function monitorDom() {
    let timer = 0;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(collect, 250);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function monitorScroll() {
    let timer = 0;
    window.addEventListener("scroll", () => {
      clearTimeout(timer);
      timer = setTimeout(collect, 300);
    }, { capture: true, passive: true });
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(STORAGE_NAME, 1);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SESSION_STORE)) {
          database.createObjectStore(SESSION_STORE, { keyPath: "id" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function serializeSession(session) {
    return {
      ...session,
      messageMap: Array.from(session.messageMap.entries()),
      visibleMap: []
    };
  }

  function hydrateSession(record) {
    const session = createSession(record.id, record.title);
    session.platform = record.platform || "copilot";
    const records = Array.isArray(record.messages) ? record.messages : [];
    const messageMap = new Map();

    records.forEach((message) => {
      const content = String(message.content || "").trim();
      if (!content || !Number.isFinite(Number(message.index))) {
        return;
      }

      const normalized = createMessage(
        Number(message.index),
        message.role === "assistant" ? "assistant" : "user",
        content
      );
      messageMap.set(normalized.key, normalized);
    });

    session.messages = Array.from(messageMap.values()).sort(sortMessages);
    session.messageMap = messageMap;
    session.createdAt = record.createdAt || session.createdAt;
    session.updatedAt = record.updatedAt || session.updatedAt;
    calculateCoverage(session);
    return session;
  }

  function scheduleSave(session) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveSession(session).catch((error) => {
        console.warn("[AI Conversation Navigator] save failed", error);
      });
    }, SAVE_DELAY_MS);
  }

  async function saveSession(session) {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(SESSION_STORE, "readwrite");
      transaction.objectStore(SESSION_STORE).put(serializeSession(session));

      transaction.oncomplete = () => {
        database.close();
        resolve();
      };

      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
    });
  }

  async function deleteSession(id) {
    state.sessions.delete(id);

    if (state.currentConversationId === id) {
      state.currentConversationId = null;
      state.currentSession = null;
    }

    const database = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(SESSION_STORE, "readwrite");
      transaction.objectStore(SESSION_STORE).delete(id);

      transaction.oncomplete = () => {
        database.close();
        resolve();
      };

      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
    });
  }

  async function loadSessions() {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(SESSION_STORE, "readonly");
      const request = transaction.objectStore(SESSION_STORE).getAll();

      request.onsuccess = () => {
        database.close();
        request.result
          .map(hydrateSession)
          .forEach((session) => state.sessions.set(session.id, session));
        resolve();
      };

      request.onerror = () => {
        database.close();
        reject(request.error);
      };
    });
  }

  function buildOutline(session) {
    return session.messages
      .filter((message) => message.role === "user")
      .sort(sortMessages)
      .map((message) => ({
        index: message.index,
        title: message.content.slice(0, 60).replace(/\s+/g, " ").trim()
      }));
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
      .replaceAll("'", "&#39;");
  }

  function ensurePanel() {
    if (panel) {
      return;
    }

    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "collapsed";
    panel.innerHTML = `
      <div class="acn-panel">
        <div class="acn-header">
          <span class="acn-label">Navigator</span>
          <button class="acn-toggle" type="button">Show</button>
        </div>
        <div class="acn-body"></div>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483000;
        font: 12px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #24292f;
      }
      #${PANEL_ID} .acn-panel {
        width: min(360px, calc(100vw - 36px));
        max-height: min(72vh, 640px);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background: #fff;
        border: 1px solid #d0d7de;
        border-radius: 10px;
        box-shadow: 0 10px 30px rgba(9, 30, 66, .18);
      }
      #${PANEL_ID}.collapsed .acn-body {
        display: none;
      }
      #${PANEL_ID} .acn-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 10px;
        background: #f6f8fa;
        border-bottom: 1px solid #d0d7de;
      }
      #${PANEL_ID}.collapsed .acn-header {
        border-bottom: 0;
      }
      #${PANEL_ID} button {
        border: 1px solid #d0d7de;
        border-radius: 6px;
        background: #fff;
        color: #24292f;
        cursor: pointer;
        padding: 4px 8px;
      }
      #${PANEL_ID} button:hover {
        background: #f3f4f6;
      }
      #${PANEL_ID} .acn-label {
        font-weight: 650;
      }
      #${PANEL_ID} .acn-body {
        overflow: auto;
        padding: 10px;
      }
      #${PANEL_ID} .acn-section {
        margin-bottom: 14px;
      }
      #${PANEL_ID} h3 {
        margin: 0 0 6px;
        font-size: 12px;
        text-transform: uppercase;
        color: #57606a;
      }
      #${PANEL_ID} .acn-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      #${PANEL_ID} p {
        margin: 0 0 8px;
      }
      #${PANEL_ID} .acn-outline {
        max-height: 220px;
        overflow: auto;
        border: 1px solid #eaeef2;
        border-radius: 6px;
      }
      #${PANEL_ID} .acn-outline-item {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        width: 100%;
        gap: 6px;
        text-align: left;
        border: 0;
        border-bottom: 1px solid #eaeef2;
        border-radius: 0;
        overflow: hidden;
      }
      #${PANEL_ID} .acn-outline-item:last-child {
        border-bottom: 0;
      }
      #${PANEL_ID} .acn-outline-no,
      #${PANEL_ID} .acn-outline-state {
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 11px;
        white-space: nowrap;
      }
      #${PANEL_ID} .acn-outline-title {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      #${PANEL_ID} .acn-outline-item[data-status=loaded] .acn-outline-state {
        color: #1877b2;
      }
      #${PANEL_ID} .acn-outline-item[data-status=unloaded] .acn-outline-state {
        color: #b45309;
      }
      #${PANEL_ID} .acn-outline-item[data-status=unloaded] {
        opacity: .8;
      }
      [data-acn-sequence]::before {
        content: "#" attr(data-acn-sequence);
        display: inline-block;
        margin-right: 6px;
        padding: 1px 5px;
        border: 1px solid #91caff;
        border-radius: 4px;
        background: #e6f4ff;
        color: #0958d9;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 11px;
        font-weight: 650;
        line-height: 16px;
        vertical-align: baseline;
      }
      #${PANEL_ID} .acn-session {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 5px;
      }
      #${PANEL_ID} .acn-session-title {
        flex: 1;
        text-align: left;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      #${PANEL_ID} .empty {
        color: #57606a;
      }
    `;

    panel.appendChild(style);
    document.documentElement.appendChild(panel);

    panel.querySelector(".acn-toggle").addEventListener("click", () => {
      panel.classList.toggle("collapsed");
      panel.querySelector(".acn-toggle").textContent = panel.classList.contains("collapsed")
        ? "Show"
        : "Hide";
      renderPanel();
    });

    panel.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) {
        return;
      }

      const action = button.dataset.action;

      if (action === "export") {
        exportMarkdown();
      } else if (action === "autoscroll") {
        await toggleAutoScroll();
      } else if (action === "save" && state.currentSession) {
        await saveSession(state.currentSession);
        renderPanel();
      } else if (action === "goto") {
        scrollToMessage(Number(button.dataset.index));
      } else if (action === "select") {
        const session = state.sessions.get(button.dataset.id);
        if (session) {
          state.currentConversationId = session.id;
          state.currentSession = session;
          renderPanel();
        }
      } else if (action === "delete") {
        await deleteSession(button.dataset.id);
        renderPanel();
      }
    });
  }

  function renderPanel() {
    if (!panel) {
      return;
    }

    const session = state.currentSession;
    const body = panel.querySelector(".acn-body");

    if (!session) {
      body.innerHTML = `<p class="empty">No supported conversation detected.</p>`;
      return;
    }

    const outline = buildOutline(session);
    const missing = session.coverage.missingRanges
      .slice(0, 5)
      .map((range) => range[0] === range[1] ? `${range[0]}` : `${range[0]}-${range[1]}`);
    const sessions = Array.from(state.sessions.values())
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 10);
    const previousBodyScrollTop = body.scrollTop;
    const previousOutline = body.querySelector(".acn-outline");
    const previousOutlineScrollTop = previousOutline ? previousOutline.scrollTop : 0;

    body.innerHTML = `
      <div class="acn-section">
        <h3>Session</h3>
        <div class="acn-title">${escapeHtml(session.title)}</div>
        <p>ID: <code>${escapeHtml(session.id)}</code></p>
      </div>
      <div class="acn-section">
        <h3>Coverage</h3>
        <p>
          Messages: ${session.messages.length} /
          Max index: ${Math.max(0, session.coverage.maxIndex)} /
          Progress: ${session.coverage.progress}%
        </p>
        <p>
          ${missing.length ? `Missing: ${escapeHtml(missing.join(", "))}` : "Coverage complete"}
        </p>
      </div>
      <div class="acn-section">
        <h3>Actions</h3>
        <div class="acn-actions">
          <button type="button" data-action="export">Export MD</button>
          <button type="button" data-action="autoscroll">${state.autoScrolling ? "Stop scroll" : "Auto scroll"}</button>
          <button type="button" data-action="save">Save now</button>
        </div>
      </div>
      <div class="acn-section">
        <h3>Outline</h3>
        ${outline.length ? `<div class="acn-outline">${outline.map((item) => `
          <button class="acn-outline-item" type="button" data-action="goto" data-index="${item.index}" data-status="unloaded">
            <span class="acn-outline-no">#${String(item.index + 1).padStart(3, "0")}</span>
            <span class="acn-outline-title">${escapeHtml(item.title || "(empty)")}</span>
            <span class="acn-outline-state">Unloaded</span>
          </button>
        `).join("")}</div>` : `<p class="empty">No user messages yet.</p>`}
      </div>
      <div class="acn-section">
        <h3>Recent sessions</h3>
        ${sessions.length ? sessions.map((item) => `
          <div class="acn-session">
            <button class="acn-session-title" type="button" data-action="select" data-id="${escapeHtml(item.id)}">
              ${escapeHtml(item.title)}
            </button>
            <button type="button" data-action="delete" data-id="${escapeHtml(item.id)}">✕</button>
          </div>
        `).join("") : `<p class="empty">No saved sessions.</p>`}
      </div>
    `;

    const nextOutline = body.querySelector(".acn-outline");
    if (nextOutline) {
      nextOutline.scrollTop = previousOutlineScrollTop;
    }
    body.scrollTop = previousBodyScrollTop;
    updateJumpStates();
  }

  function updateJumpStates() {
    if (!panel) {
      return;
    }

    const provider = activeProvider();
    const mountedIndexes = provider ? provider.getMountedIndexes() : new Set();

    panel.querySelectorAll(".acn-outline-item[data-index]").forEach((button) => {
      const index = Number(button.dataset.index);
      const loaded = mountedIndexes.has(index);
      button.dataset.status = loaded ? "loaded" : "unloaded";

      const state = button.querySelector(".acn-outline-state");
      if (state) {
        state.textContent = loaded ? "Ready" : "Unloaded";
      }
    });
  }

  function decorateMessageNodes() {
    const nodes = document.querySelectorAll(
      '[data-testid="m365-chat-llm-web-ui-chat-message"]'
    );

    nodes.forEach((node, nodeIndex) => {
      const rawIndex = node.getAttribute("data-message-index");
      const parsedIndex = Number(rawIndex);
      const index = Number.isFinite(parsedIndex) ? parsedIndex : nodeIndex;
      const sequence = String(index + 1).padStart(3, "0");

      node.querySelectorAll('[data-testid="chatInput"], [data-testid="chatOutput"], [data-testid="markdown-reply"]')
        .forEach((contentNode) => {
          contentNode.dataset.acnSequence = sequence;
        });
    });
  }

  function findScrollContainers() {
    const candidates = Array.from(document.querySelectorAll("body *"))
      .filter((element) => {
        const style = getComputedStyle(element);
        return ["auto", "scroll"].includes(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 80 &&
          element.clientWidth > 100 &&
          element.clientHeight > 100;
      });

    const documentElement = document.scrollingElement;
    if (documentElement && documentElement.scrollHeight > documentElement.clientHeight + 80) {
      candidates.push(documentElement);
    }

    candidates.sort((left, right) =>
      (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight)
    );
    return candidates;
  }

  function delay(duration) {
    return new Promise((resolve) => setTimeout(resolve, duration));
  }

  async function toggleAutoScroll() {
    if (state.autoScrolling) {
      state.autoScrolling = false;
      renderPanel();
      return;
    }

    const containers = findScrollContainers();
    if (!containers.length) {
      console.warn("[AI Conversation Navigator] no scroll container found");
      return;
    }

    const container = containers[0];
    const step = Math.max(160, Math.round(container.clientHeight * SCROLL_STEP_RATIO));
    state.autoScrolling = true;
    renderPanel();

    try {
      container.scrollTop = 0;
      await delay(SCROLL_STEP_MS);
      collect();

      while (
        state.autoScrolling &&
        container.scrollTop + container.clientHeight < container.scrollHeight - 2
      ) {
        container.scrollTop = Math.min(
          container.scrollHeight,
          container.scrollTop + step
        );
        await delay(SCROLL_STEP_MS);
        collect();
      }
    } finally {
      state.autoScrolling = false;
      renderPanel();
    }
  }

  function scrollToMessage(index) {
    const node = document.querySelector(
      `[data-testid="m365-chat-llm-web-ui-chat-message"][data-message-index="${index}"]`
    );

    if (!node) {
      console.warn("[AI Conversation Navigator] message not mounted", index);
      return;
    }

    node.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }

  function exportMarkdown() {
    const session = state.currentSession;
    if (!session) {
      return;
    }

    const messages = [...session.messages]
      .filter((message) => message.content && message.content.trim())
      .sort(sortMessages);
    const markdown = [
      "---",
      `platform: ${session.platform}`,
      `title: "${session.title.replace(/"/g, '\\"')}"`,
      `exported_at: ${new Date().toISOString()}`,
      "---",
      ""
    ];

    messages.forEach((message) => {
      markdown.push(
        `## ${String(message.index + 1).padStart(3, "0")} ${message.role === "user" ? "User" : "Assistant"}`
      );
      markdown.push("");
      markdown.push(message.content);
      markdown.push("");
    });

    const blob = new Blob([markdown.join("\n")], {
      type: "text/markdown;charset=utf-8"
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${session.title.replace(/[\\/:*?"<>|]/g, "_") || "conversation"}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function start() {
    ensurePanel();
    renderPanel();

    try {
      await loadSessions();
    } catch (error) {
      console.warn("[AI Conversation Navigator] load failed", error);
    }

    state.ready = true;
    monitorRoute();
    monitorDom();
    monitorScroll();

    const provider = activeProvider();
    if (provider) {
      switchSession(provider.getConversationId(), provider.getConversationTitle());
    } else {
      renderPanel();
    }
  }

  window.__AI_CONVERSATION_NAVIGATOR__ = {
    state,
    collect,
    exportMarkdown,
    toggleAutoScroll,
    calculateCoverage
  };

  start();
})();
