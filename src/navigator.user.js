// ==UserScript==
// @name         AI Conversation Navigator
// @namespace    https://github.com/local/ai-conversation-navigator
// @version      0.3.1
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
    autoScrolling: false,
    previewIndex: null
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

    getMessageNodes() {
      return Array.from(document.querySelectorAll(
        '[data-testid="m365-chat-llm-web-ui-chat-message"]'
      ));
    }

    getOutermostMatches(node, selector) {
      const matches = Array.from(node.querySelectorAll(selector));
      return matches.filter((match) =>
        !matches.some((other) => other !== match && other.contains(match))
      );
    }

    getStableNodeKey(node) {
      return node.getAttribute("data-message-id") ||
        node.getAttribute("data-activity-id") ||
        node.getAttribute("data-conversation-message-id") ||
        "";
    }

    assignMessageIndexes(session) {
      const nodes = this.getMessageNodes();
      if (!session) {
        return nodes;
      }

      const usersByContent = new Map(
        session.messages
          .filter((message) => message.role === "user")
          .map((message) => [message.content, message.index])
      );
      const stableKeys = session.stableNodeKeys instanceof Map
        ? session.stableNodeKeys
        : new Map();
      const assigned = new Set();
      let nextIndex = session.messages.reduce(
        (max, message) => Math.max(max, message.index + 1),
        0
      );

      nodes.forEach((node) => {
        const rawIndex = node.getAttribute("data-message-index");
        const parsedIndex = rawIndex === null || rawIndex === "" ? NaN : Number(rawIndex);
        const stableKey = this.getStableNodeKey(node);
        let index = null;

        if (Number.isInteger(parsedIndex) && parsedIndex >= 0) {
          index = parsedIndex;
        } else if (stableKey && stableKeys.has(stableKey)) {
          index = stableKeys.get(stableKey);
        }

        if (index === null) {
          const { userNodes } = this.getContentTargets(node);
          const userContent = userNodes.map((userNode) => userNode.innerText.trim()).join("\n\n");
          if (userContent && usersByContent.has(userContent)) {
            index = usersByContent.get(userContent);
          }
        }

        if (index === null || assigned.has(index)) {
          index = nextIndex;
          nextIndex += 1;
        }

        assigned.add(index);
        if (stableKey) {
          stableKeys.set(stableKey, index);
        }
        node.dataset.acnIndex = String(index);
      });

      session.stableNodeKeys = stableKeys;
      return nodes;
    }

    getContentTargets(node) {
      const assistantNodes = this.getOutermostMatches(
        node,
        '[data-testid="markdown-reply"]'
      );
      const userNodes = this.getOutermostMatches(
        node,
        '[data-testid="chatInput"], [data-testid="chatOutput"]'
      ).filter((userNode) => !assistantNodes.some((assistantNode) =>
        userNode.contains(assistantNode) || assistantNode.contains(userNode)
      ));

      return { userNodes, assistantNodes };
    }

    collectVisibleMessages() {
      const nodes = this.assignMessageIndexes(state.currentSession);
      const messages = [];

      nodes.forEach((node, nodeIndex) => {
        const index = Number(node.dataset.acnIndex);
        const { userNodes, assistantNodes } = this.getContentTargets(node);

        const userContent = userNodes
          .map((userNode) => userNode.innerText.trim())
          .filter(Boolean)
          .join("\n\n");
        const assistantContent = assistantNodes
          .map((assistantNode) => assistantNode.innerText.trim())
          .filter(Boolean)
          .join("\n\n");

        if (userContent) {
          messages.push(createMessage(index, "user", userContent));
        }

        if (assistantContent) {
          messages.push(createMessage(index, "assistant", assistantContent));
        }

        node.dataset.acnIndex = String(index);
      });

      return messages;
    }

    getLoadedIndexes() {
      const loadedIndexes = new Set();

      this.assignMessageIndexes(state.currentSession).forEach((node) => {
        loadedIndexes.add(Number(node.dataset.acnIndex));
      });

      return loadedIndexes;
    }

    getCurrentIndex() {
      let currentIndex = null;
      let largestVisibleArea = 0;

      this.assignMessageIndexes(state.currentSession).forEach((node) => {
        const index = Number(node.dataset.acnIndex);
        const rect = node.getBoundingClientRect();

        if (rect.width > 0 && rect.height > 0) {
          const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
          const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
          const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);

          if (visibleArea > largestVisibleArea) {
            largestVisibleArea = visibleArea;
            currentIndex = index;
          }
        }
      });

      return currentIndex;
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
      stableNodeKeys: new Map(),
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
        if (message.role !== "assistant" || message.content.length >= existing.content.length) {
          existing.content = message.content;
          contentChanged = true;
        }
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
    closePreview();
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
    const { stableNodeKeys, ...record } = session;

    return {
      ...record,
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

  function getCacheState(session, index) {
    const user = session.messageMap.get(`${index}|user`);
    const assistant = session.messageMap.get(`${index}|assistant`);
    const hasUser = Boolean(user && user.content && user.content.trim());
    const hasAssistant = Boolean(assistant && assistant.content && assistant.content.trim());

    return {
      user,
      assistant,
      hasUser,
      hasAssistant,
      complete: hasUser && hasAssistant
    };
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
        <div class="acn-resize-handle" data-resize></div>
        <div class="acn-header">
          <span class="acn-label">Navigator</span>
          <button class="acn-toggle" type="button">Show</button>
        </div>
        <div class="acn-body"></div>
      </div>
      <div class="acn-preview" hidden></div>
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
        height: min(72vh, 640px);
        max-width: calc(100vw - 36px);
        max-height: calc(100vh - 36px);
        position: relative;
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
      #${PANEL_ID}.collapsed .acn-panel {
        width: auto !important;
        height: auto !important;
      }
      #${PANEL_ID} .acn-resize-handle {
        position: absolute;
        top: 0;
        left: 0;
        width: 18px;
        height: 18px;
        cursor: nwse-resize;
        touch-action: none;
        z-index: 2;
        background: linear-gradient(135deg, #d0d7de 25%, transparent 25%);
        border-top-left-radius: 10px;
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
        flex: 1;
        min-height: 0;
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
        grid-template-columns: minmax(0, 1fr) 22px 22px 32px;
        align-items: center;
        width: 100%;
        gap: 6px;
        border: 0;
        border-bottom: 1px solid #eaeef2;
        border-radius: 0;
        overflow: hidden;
      }
      #${PANEL_ID} .acn-outline-item:last-child {
        border-bottom: 0;
      }
      #${PANEL_ID} .acn-outline-jump {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: center;
        gap: 6px;
        min-width: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        padding: 6px 8px;
        text-align: left;
      }
      #${PANEL_ID} .acn-outline-no {
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 11px;
        white-space: nowrap;
      }
      #${PANEL_ID} .acn-status-chip {
        border: 1px solid #d0d7de;
        border-radius: 999px;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 10px;
        width: 22px;
        height: 18px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        white-space: nowrap;
      }
      #${PANEL_ID} .acn-outline-item[data-loaded="yes"] .acn-view-chip {
        border-color: #91caff;
        background: #e6f4ff;
        color: #0958d9;
      }
      #${PANEL_ID} .acn-outline-item[data-loaded="no"] .acn-view-chip {
        border-color: #d0d7de;
        background: #f6f8fa;
        color: #57606a;
      }
      #${PANEL_ID} .acn-outline-item[data-cache="cached"] .acn-cache-chip {
        border-color: #b7eb8f;
        background: #f6ffed;
        color: #389e0d;
      }
      #${PANEL_ID} .acn-outline-item[data-cache="partial"] .acn-cache-chip {
        border-color: #ff9c6e;
        background: #fff2e8;
        color: #ad4e00;
      }
      #${PANEL_ID} .acn-outline-item[data-current="true"] {
        background: #ddf4ff;
      }
      #${PANEL_ID} .acn-outline-item[data-current="true"] .acn-outline-jump {
        background: transparent;
      }
      #${PANEL_ID} .acn-outline-preview {
        margin-right: 6px;
        font-size: 11px;
        padding: 2px 6px;
      }
      #${PANEL_ID} .acn-outline-preview:disabled {
        cursor: not-allowed;
        opacity: .55;
      }
      #${PANEL_ID} .acn-outline-title {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
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
      #${PANEL_ID} .acn-preview {
        position: fixed;
        inset: 0;
        z-index: 2147483100;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(9, 30, 66, .45);
      }
      #${PANEL_ID} .acn-preview[hidden] {
        display: none;
      }
      #${PANEL_ID}.collapsed .acn-resize-handle {
        display: none;
      }
      #${PANEL_ID} .acn-preview-card {
        width: min(760px, 94vw);
        max-height: min(84vh, 900px);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid #d0d7de;
        border-radius: 10px;
        background: #fff;
        box-shadow: 0 20px 60px rgba(9,30,66,.28);
      }
      #${PANEL_ID} .acn-preview-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        border-bottom: 1px solid #d0d7de;
        background: #f6f8fa;
      }
      #${PANEL_ID} .acn-preview-body {
        overflow: auto;
        padding: 12px;
      }
      #${PANEL_ID} .acn-preview-turn {
        margin-bottom: 14px;
      }
      #${PANEL_ID} .acn-preview-role {
        margin: 0 0 6px;
        font-weight: 650;
      }
      #${PANEL_ID} .acn-preview-content {
        margin: 0;
        padding: 10px;
        border: 1px solid #eaeef2;
        border-radius: 6px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        background: #fafbfc;
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
      } else if (action === "preview") {
        showPreview(Number(button.dataset.index));
      } else if (action === "close-preview") {
        closePreview();
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

    const resizeHandle = panel.querySelector(".acn-resize-handle");
    resizeHandle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const panelCard = panel.querySelector(".acn-panel");
      const startRect = panelCard.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = startRect.width;
      const startHeight = startRect.height;
      const minWidth = 300;
      const minHeight = 200;
      const maxWidth = Math.max(minWidth, window.innerWidth - 36);
      const maxHeight = Math.max(minHeight, window.innerHeight - 36);

      const onPointerMove = (moveEvent) => {
        panelCard.style.width = `${Math.min(maxWidth, Math.max(minWidth, startWidth + startX - moveEvent.clientX))}px`;
        panelCard.style.height = `${Math.min(maxHeight, Math.max(minHeight, startHeight + startY - moveEvent.clientY))}px`;
      };

      const stopResize = () => {
        resizeHandle.removeEventListener("pointermove", onPointerMove);
        resizeHandle.removeEventListener("pointerup", stopResize);
        resizeHandle.removeEventListener("pointercancel", stopResize);
      };

      resizeHandle.setPointerCapture(event.pointerId);
      resizeHandle.addEventListener("pointermove", onPointerMove);
      resizeHandle.addEventListener("pointerup", stopResize);
      resizeHandle.addEventListener("pointercancel", stopResize);
    });

    panel.querySelector(".acn-preview").addEventListener("click", (event) => {
      if (event.target === panel.querySelector(".acn-preview")) {
        closePreview();
      }
    });

    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closePreview();
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
          <div class="acn-outline-item" data-index="${item.index}" data-loaded="no" data-cache="partial" data-current="false">
            <button class="acn-outline-jump" type="button" data-action="goto" data-index="${item.index}">
              <span class="acn-outline-no">#${String(item.index + 1).padStart(3, "0")}</span>
              <span class="acn-outline-title">${escapeHtml(item.title || "(empty)")}</span>
            </button>
            <span class="acn-status-chip acn-view-chip" title="Loaded and jumpable">–</span>
            <span class="acn-status-chip acn-cache-chip" title="User and Assistant cached">◐</span>
            <button class="acn-outline-preview" type="button" data-action="preview" data-index="${item.index}" disabled title="Preview cached turn" aria-label="Preview cached turn">
              👁
            </button>
          </div>
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
    const session = state.currentSession;
    if (!provider || !session) {
      return;
    }

    const loadedIndexes = provider.getLoadedIndexes();
    const currentIndex = provider.getCurrentIndex();

    panel.querySelectorAll(".acn-outline-item[data-index]").forEach((item) => {
      const index = Number(item.dataset.index);
      const cache = getCacheState(session, index);
      const loaded = loadedIndexes.has(index);

      item.dataset.loaded = loaded ? "yes" : "no";
      item.dataset.cache = cache.complete ? "cached" : "partial";
      item.dataset.current = index === currentIndex ? "true" : "false";
      item.setAttribute("aria-current", index === currentIndex ? "true" : "false");
      item.title = loaded ? "Click to jump" : "Not loaded in DOM; cannot jump";

      const viewChip = item.querySelector(".acn-view-chip");
      const cacheChip = item.querySelector(".acn-cache-chip");
      const previewButton = item.querySelector(".acn-outline-preview");

      if (viewChip) {
        viewChip.textContent = loaded ? "↗" : "–";
        viewChip.title = loaded ? "Loaded in DOM" : "Not loaded in DOM";
        viewChip.setAttribute("aria-label", viewChip.title);
      }
      if (cacheChip) {
        cacheChip.textContent = cache.complete ? "✓" : "◐";
        cacheChip.title = cache.complete ? "User and Assistant cached" : "Assistant not fully cached";
      }
      if (previewButton) {
        previewButton.disabled = !cache.complete;
      }
    });
  }

  function showPreview(index) {
    const session = state.currentSession;
    if (!panel || !session) {
      return;
    }

    const cache = getCacheState(session, index);
    if (!cache.complete) {
      return;
    }

    const sequence = String(index + 1).padStart(3, "0");
    const preview = panel.querySelector(".acn-preview");
    state.previewIndex = index;
    preview.innerHTML = `
      <div class="acn-preview-card" role="dialog" aria-modal="true">
        <div class="acn-preview-header">
          <div>
            <strong>#${sequence} Cached preview</strong>
            <div class="acn-title">${escapeHtml(session.title)}</div>
          </div>
          <button type="button" data-action="close-preview">Close</button>
        </div>
        <div class="acn-preview-body">
          <div class="acn-preview-turn">
            <p class="acn-preview-role">#${sequence} User</p>
            <pre class="acn-preview-content">${escapeHtml(cache.user.content)}</pre>
          </div>
          <div class="acn-preview-turn">
            <p class="acn-preview-role">#${sequence} Assistant</p>
            <pre class="acn-preview-content">${escapeHtml(cache.assistant.content)}</pre>
          </div>
        </div>
      </div>
    `;
    preview.hidden = false;
    preview.querySelector("button[data-action=\"close-preview\"]").focus();
  }

  function closePreview() {
    if (!panel) {
      return;
    }

    const preview = panel.querySelector(".acn-preview");
    preview.hidden = true;
    preview.innerHTML = "";
    state.previewIndex = null;
  }

  function decorateMessageNodes() {
    const provider = activeProvider();
    if (!provider) {
      return;
    }

    const nodes = provider.assignMessageIndexes(state.currentSession);

    nodes.forEach((node) => {
      const index = Number(node.dataset.acnIndex);
      const sequence = String(index + 1).padStart(3, "0");
      const { userNodes, assistantNodes } = provider.getContentTargets(node);

      node.querySelectorAll("[data-acn-sequence]").forEach((contentNode) => {
        delete contentNode.dataset.acnSequence;
      });

      node.dataset.acnIndex = String(index);

      userNodes.forEach((contentNode, contentNodeIndex) => {
        if (contentNodeIndex > 0) {
          return;
        }
        contentNode.dataset.acnSequence = sequence;
      });
      assistantNodes.forEach((contentNode, contentNodeIndex) => {
        if (contentNodeIndex > 0) {
          return;
        }
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
      `[data-testid="m365-chat-llm-web-ui-chat-message"][data-acn-index="${index}"]`
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
