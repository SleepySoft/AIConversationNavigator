const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { IDBFactory } = require("fake-indexeddb");

function createRenderer() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://m365.cloud.microsoft/chat",
    runScripts: "outside-only"
  });
  const bundle = readFileSync(path.join(__dirname, "../dist/preview-renderer.js"), "utf8");
  dom.window.eval(bundle);
  const adapter = readFileSync(path.join(__dirname, "../dist/providers/copilot-markdown.js"), "utf8");
  dom.window.eval(adapter);
  return {
    dom,
    renderer: dom.window.__ACN_PREVIEW_RENDERER__,
    copilot: dom.window.__ACN_CONTENT_ADAPTERS__.copilot
  };
}

async function waitFor(condition, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      assert.fail(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("bundles local KaTeX fonts for the extension", () => {
  const manifest = require("../manifest.json");
  const css = readFileSync(path.join(__dirname, "../dist/katex.css"), "utf8");
  assert.ok(manifest.content_scripts[0].css.includes("dist/katex.css"));
  assert.ok(manifest.web_accessible_resources[0].resources.includes("dist/fonts/*"));
  assert.doesNotMatch(css, /\.woff(?!2)|\.ttf/);
  const fontNames = Array.from(css.matchAll(/dist\/fonts\/([^)]*?)\.(?:woff2|woff|ttf)/g),
    (match) => match[0].slice("dist/".length));
  assert.ok(fontNames.length > 0);
  for (const font of fontNames) {
    assert.ok(existsSync(path.join(__dirname, "../dist", font)));
  }
});

test("renders Markdown structure and both Copilot math delimiter styles", () => {
  const { dom, renderer } = createRenderer();
  const html = renderer.renderMarkdown([
    "# Result",
    "",
    "- first item",
    "- second item with $x^2$ and \\(y^2\\)",
    "",
    "\\[\\frac{a}{b}\\]",
    "",
    "$$\\sqrt{2}$$",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |"
  ].join("\n"));
  const root = dom.window.document.createElement("div");
  root.innerHTML = html;
  assert.equal(root.querySelector("h1")?.textContent, "Result");
  assert.equal(root.querySelectorAll("li").length, 2);
  assert.equal(root.querySelectorAll("table td").length, 2);
  assert.ok(root.querySelectorAll(".katex").length >= 4, html);
  assert.ok(root.querySelectorAll(".katex-display").length >= 2, html);
  dom.window.close();
});

test("keeps code literal and escapes raw HTML", () => {
  const { dom, renderer } = createRenderer();
  const html = renderer.renderMarkdown([
    "`$x$` and `\\[x\\]`",
    "",
    "```text",
    "$$not math$$ and \\[y\\]",
    "```",
    "",
    "<script>alert(1)</script>",
    "",
    "[unsafe](javascript:alert(1))",
    "",
    "$\\href{javascript:alert(1)}{unsafe}$"
  ].join("\n"));
  const root = dom.window.document.createElement("div");
  root.innerHTML = html;
  assert.equal(root.querySelectorAll(".katex").length, 1);
  assert.match(root.textContent, /\$\$not math\$\$/);
  assert.equal(root.querySelector("script"), null);
  assert.equal(root.querySelector('a[href^="javascript:"]'), null);
  dom.window.close();
});

test("recovers rendered Copilot structure and MathML TeX annotation", () => {
  const { dom, renderer, copilot } = createRenderer();
  const reply = dom.window.document.createElement("div");
  reply.innerHTML = `<h2>Answer</h2><p>Text <strong>bold</strong> and
    <math alttext="x^2"><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math>.</p>
    <pre><code>const x = 2;</code></pre>`;
  const recovered = copilot.extractAssistantContent(reply).content;
  assert.match(recovered, /^## Answer/);
  assert.match(recovered, /\*\*bold\*\*/);
  assert.match(recovered, /\$x\^2\$/);
  assert.match(recovered, /```/);
  assert.ok(renderer.renderMarkdown(recovered).includes('class="katex"'));
  dom.window.close();
});

test("converts MathML without a TeX annotation", () => {
  const { dom, renderer, copilot } = createRenderer();
  const reply = dom.window.document.createElement("div");
  reply.innerHTML = `<p>Ratio: <math><mfrac><mi>a</mi><mi>b</mi></mfrac></math></p>`;
  const recovered = copilot.extractAssistantContent(reply).content;
  assert.match(recovered, /\\frac\{a\}\{b\}/);
  assert.ok(renderer.renderMarkdown(recovered).includes('class="katex"'));
  dom.window.close();
});

test("keeps block MathML as a display equation", () => {
  const { dom, renderer, copilot } = createRenderer();
  const reply = dom.window.document.createElement("div");
  reply.innerHTML = `<p>Before</p><math display="block"><mfrac><mi>a</mi><mi>b</mi></mfrac></math><p>After</p>`;
  const recovered = copilot.extractAssistantContent(reply).content;
  assert.match(recovered, /\$\$\n\\frac/);
  const root = dom.window.document.createElement("div");
  root.innerHTML = renderer.renderMarkdown(recovered);
  assert.ok(root.querySelector(".katex-display"));
  dom.window.close();
});

test("extracts one equation from a KaTeX wrapper with duplicate visual text", () => {
  const { dom, copilot } = createRenderer();
  const reply = dom.window.document.createElement("div");
  reply.innerHTML = `<span class="katex-display"><span class="katex">
    <span class="katex-mathml"><math><semantics><mrow><mi>S</mi><mo>=</mo><mi>r</mi></mrow>
      <annotation encoding="application/x-tex">S=rD+P</annotation>
    </semantics></math></span>
    <span class="katex-html" aria-hidden="true">𝐒 = 𝐫 𝐃 + 𝐏</span>
  </span></span>`;
  const markdown = copilot.extractAssistantContent(reply).content;
  assert.match(markdown, /^\$\$\nS=rD\+P\n\$\$$/);
  assert.equal((markdown.match(/S=rD\+P/g) || []).length, 1);
  dom.window.close();
});

test("preserves literal Copilot math delimiters in rich text", () => {
  const { dom, renderer, copilot } = createRenderer();
  const reply = dom.window.document.createElement("div");
  reply.innerHTML = `<p>Inline \\(x^2\\) and block \\[a+b\\].</p>`;
  const recovered = copilot.extractAssistantContent(reply).content;
  const html = renderer.renderMarkdown(recovered);
  const root = dom.window.document.createElement("div");
  root.innerHTML = html;
  assert.equal(root.querySelectorAll(".katex").length, 2, recovered);
  dom.window.close();
});

test("marks plain Copilot DOM as text and recognizes a mislabeled cache", () => {
  const { dom, copilot } = createRenderer();
  const reply = dom.window.document.createElement("div");
  reply.textContent = "Plain Text\nA → B\n\n主体\t资产\n银行\t贷款";
  const extracted = copilot.extractAssistantContent(reply);
  assert.equal(extracted.format, "text");
  assert.ok(copilot.looksLikeTextCache(extracted.content));
  assert.equal(copilot.looksLikeTextCache("```text\nPlain Text\nA → B\n```"), false);
  dom.window.close();
});

test("formats lossy Copilot text caches without changing their stored text", () => {
  const { dom, renderer, copilot } = createRenderer();
  const legacy = [
    "一、先给结论",
    "",
    "主体\t资产\t负债",
    "银行\t贷款 100\t存款 100",
    "企业\t存款 100\t贷款 100",
    "",
    "Plain Text",
    "A → B → C",
    "",
    "实际利率",
    "≈",
    "名义利率",
    "−",
    "通胀率",
    "=",
    "−",
    "3",
    "%",
    "实际利率≈名义利率−通胀率=−3%"
  ].join("\n");
  const prepared = copilot.prepareLegacyPreview(legacy);
  const root = dom.window.document.createElement("div");
  root.innerHTML = renderer.renderMarkdown(prepared);
  assert.equal(root.querySelector("h3")?.textContent, "一、先给结论");
  assert.equal(root.querySelectorAll("table tr").length, 3);
  assert.equal(root.querySelector("pre")?.textContent.trim(), "A → B → C");
  assert.ok(root.querySelector(".katex-display"));
  assert.ok(legacy.includes("Plain Text"));
  assert.ok(!legacy.includes("```"));
  dom.window.close();
});

test("cached preview displays rendered Markdown and equations", async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div data-testid="m365-chat-llm-web-ui-chat-message" data-message-index="0">
      <div data-testid="chatInput">Explain $x^2$</div>
      <div data-testid="markdown-reply">
        <h2>Answer</h2>
        <p>Formula: <math alttext="x^2"><semantics><mi>x</mi>
          <annotation encoding="application/x-tex">x^2</annotation>
        </semantics></math></p>
      </div>
    </div>
  </body></html>`, {
    url: "https://m365.cloud.microsoft/chat/conversation/example",
    runScripts: "outside-only"
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; }
  });
  dom.window.indexedDB = new IDBFactory();
  dom.window.eval(readFileSync(path.join(__dirname, "../dist/preview-renderer.js"), "utf8"));
  dom.window.eval(readFileSync(path.join(__dirname, "../dist/providers/copilot-markdown.js"), "utf8"));
  dom.window.eval(readFileSync(path.join(__dirname, "../src/navigator.user.js"), "utf8"));
  await waitFor(() => dom.window.document.querySelector('[data-action="preview"]'),
    "preview button exists");
  const button = dom.window.document.querySelector('[data-action="preview"]');
  assert.equal(button.disabled, false);
  button.click();
  const preview = dom.window.document.querySelector(".acn-preview");
  assert.equal(preview.hidden, false);
  assert.equal(preview.querySelectorAll(".acn-preview-content h2").length, 1);
  assert.ok(preview.querySelector(".acn-preview-content .katex"));
  const cached = dom.window.__AI_CONVERSATION_NAVIGATOR__.state.currentSession
    .messageMap.get("0|assistant");
  cached.content = "Plain Text\n".repeat(100);
  cached.format = "text";
  dom.window.__AI_CONVERSATION_NAVIGATOR__.collect();
  assert.equal(cached.format, "markdown");
  assert.match(cached.content, /## Answer/);
  cached.content = "Plain Text\n".repeat(100);
  cached.format = "markdown";
  dom.window.__AI_CONVERSATION_NAVIGATOR__.collect();
  assert.match(cached.content, /## Answer/);
  dom.window.close();
});

test("records an image-only user turn together with its assistant reply", async () => {
  const dom = new JSDOM(`<!doctype html><html><head>
    <title>const titleFromPreviousConversation = true;</title>
  </head><body>
    <div data-testid="m365-chat-llm-web-ui-chat-message" data-message-index="0">
      <div data-testid="chatQuestion">
        <div role="article">
          <div role="button" aria-label="image.png">
            <img alt="image.png" src="data:image/png;base64,AA==">
          </div>
          <div data-testid="chatOutput"><br aria-hidden="true"></div>
        </div>
      </div>
      <div data-testid="markdown-reply"><p>I can see the image.</p></div>
    </div>
  </body></html>`, {
    url: "https://m365.cloud.microsoft/chat/conversation/image-only",
    runScripts: "outside-only"
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; }
  });
  dom.window.indexedDB = new IDBFactory();
  dom.window.eval(readFileSync(path.join(__dirname, "../dist/preview-renderer.js"), "utf8"));
  dom.window.eval(readFileSync(path.join(__dirname, "../dist/providers/copilot-markdown.js"), "utf8"));
  dom.window.eval(readFileSync(path.join(__dirname, "../src/navigator.user.js"), "utf8"));
  await waitFor(() => dom.window.__AI_CONVERSATION_NAVIGATOR__.state.currentSession,
    "image conversation session becomes ready");

  const navigator = dom.window.__AI_CONVERSATION_NAVIGATOR__;
  const session = navigator.state.currentSession;
  assert.equal(session.messageMap.get("0|user")?.content, "[Image: image.png]");
  assert.equal(session.messageMap.get("0|assistant")?.content, "I can see the image.");
  assert.equal(session.coverage.progress, 100);
  assert.equal(session.title, "Image: image.png");
  assert.equal(dom.window.document.querySelector(".acn-section .acn-title")?.textContent,
    "Image: image.png");
  assert.equal(dom.window.document.querySelector(".acn-outline-title")?.textContent,
    "[Image: image.png]");
  assert.equal(dom.window.document.querySelector('[data-action="preview"]')?.disabled, false);
  dom.window.close();
});

test("exports legacy Copilot replies as prepared Markdown text", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://m365.cloud.microsoft/chat/conversation/legacy",
    runScripts: "outside-only"
  });
  dom.window.indexedDB = new IDBFactory();
  dom.window.eval(readFileSync(path.join(__dirname, "../dist/preview-renderer.js"), "utf8"));
  dom.window.eval(readFileSync(path.join(__dirname, "../dist/providers/copilot-markdown.js"), "utf8"));
  dom.window.eval(readFileSync(path.join(__dirname, "../src/navigator.user.js"), "utf8"));
  await waitFor(() => dom.window.__AI_CONVERSATION_NAVIGATOR__.state.currentSession,
    "legacy conversation session becomes ready");

  const session = dom.window.__AI_CONVERSATION_NAVIGATOR__.state.currentSession;
  const legacy = "主体\t资产\n银行\t贷款\n\nPlain Text\nA → B";
  session.messages = [
    { index: 0, role: "user", content: "Question", format: "text", key: "0|user" },
    { index: 0, role: "assistant", content: legacy, format: "markdown", key: "0|assistant" }
  ];
  let exportedBlob;
  dom.window.URL.createObjectURL = (blob) => {
    exportedBlob = blob;
    return "blob:preview-test";
  };
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  dom.window.__AI_CONVERSATION_NAVIGATOR__.exportMarkdown();
  const reader = new dom.window.FileReader();
  const exported = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(exportedBlob);
  });
  assert.match(exported, /\| 主体 \| 资产 \|/);
  assert.match(exported, /```text\nA → B\n```/);
  assert.equal(session.messages[1].content, legacy);
  dom.window.close();
});


function createChatGPTAdapter() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://chatgpt.com/c/example",
    runScripts: "outside-only"
  });
  const bundle = readFileSync(path.join(__dirname, "../dist/providers/chatgpt-markdown.js"), "utf8");
  dom.window.eval(bundle);
  return {
    dom,
    chatgpt: dom.window.__ACN_CONTENT_ADAPTERS__.chatgpt
  };
}

test("converts ChatGPT DIL response content and strips action chrome", () => {
  const { dom, chatgpt } = createChatGPTAdapter();
  const response = dom.window.document.createElement("div");
  response.innerHTML = `<div data-response-body="msg-1">
    <div data-markdown-text-style="assistant-message">
      <p data-d-component="text">PS5 可以输出声音。<span><strong>没有 3.5mm 接口。</strong></span></p>
      <h2 data-d-component="title"><strong>一、方案</strong></h2>
      <div data-d-component="table"><div data-d-table-viewport="true"><table><tbody>
        <tr><th>方案</th><th>设备</th></tr>
        <tr><td>A</td><td>B</td></tr>
      </tbody></table></div></div>
      <button type="button">Copy</button>
    </div>
  </div>`;
  const extracted = chatgpt.extractAssistantContent(response);
  assert.equal(extracted.format, "markdown");
  assert.match(extracted.content, /\*\*没有 3\.5mm 接口。\*\*/);
  assert.match(extracted.content, /## \*\*一、方案\*\*/);
  assert.match(extracted.content, /\| 方案 \| 设备 \|/);
  assert.doesNotMatch(extracted.content, /Copy/);
  dom.window.close();
});

test("collects a ChatGPT conversation with turn indexes and exports chatgpt platform", async () => {
  const dom = new JSDOM(`<!doctype html><html><head><title>测试对话</title></head><body>
    <div class="thread-scroll-container">
      <div data-talvt-turn-state="complete">
        <div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="u-1">
          <div data-user-message-bubble="true"><div>问题一</div></div>
          <div aria-label="复制消息"></div>
        </div>
        <div data-chatgpt-search-unit-key="fallback-turn-0:2:assistant" data-chatgpt-search-message-ids="a-1">
          <h4 data-conversation-role="assistant">ChatGPT 说：</h4>
          <div data-response-body="a-1">
            <div data-markdown-text-style="assistant-message">
              <p data-d-component="text">答案一</p>
            </div>
          </div>
        </div>
      </div>
      <div data-talvt-turn-state="complete">
        <div data-chatgpt-search-unit-key="fallback-turn-1:0:user" data-chatgpt-search-message-ids="u-2">
          <div data-user-message-bubble="true"><div>问题二</div></div>
        </div>
        <div data-chatgpt-search-unit-key="fallback-turn-1:2:assistant" data-chatgpt-search-message-ids="a-2">
          <h4 data-conversation-role="assistant">ChatGPT 说：</h4>
          <div data-response-body="a-2">
            <div data-markdown-text-style="assistant-message">
              <p data-d-component="text">答案二</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </body></html>`, {
    url: "https://chatgpt.com/c/6af7af36-example",
    runScripts: "outside-only"
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; }
  });
  dom.window.indexedDB = new IDBFactory();
  dom.window.eval(readFileSync(path.join(__dirname, "../dist/preview-renderer.js"), "utf8"));
  dom.window.eval(readFileSync(path.join(__dirname, "../dist/providers/chatgpt-markdown.js"), "utf8"));
  dom.window.eval(readFileSync(path.join(__dirname, "../src/navigator.user.js"), "utf8"));
  await waitFor(() => dom.window.__AI_CONVERSATION_NAVIGATOR__.state.currentSession,
    "chatgpt session becomes ready");

  const navigator = dom.window.__AI_CONVERSATION_NAVIGATOR__;
  const session = navigator.state.currentSession;
  assert.equal(session.platform, "chatgpt");
  assert.equal(session.title, "测试对话");
  assert.equal(session.messageMap.get("0|user")?.content, "问题一");
  assert.equal(session.messageMap.get("0|assistant")?.content, "答案一");
  assert.equal(session.messageMap.get("1|user")?.content, "问题二");
  assert.equal(session.messageMap.get("1|assistant")?.content, "答案二");
  assert.equal(session.coverage.progress, 100);
  assert.equal(dom.window.document.querySelectorAll(".acn-outline-item").length, 2);

  let exportedBlob;
  dom.window.URL.createObjectURL = (blob) => {
    exportedBlob = blob;
    return "blob:chatgpt-test";
  };
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  navigator.exportMarkdown();
  const reader = new dom.window.FileReader();
  const exported = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(exportedBlob);
  });
  assert.match(exported, /platform: chatgpt/);
  assert.match(exported, /## 001 User\n\n问题一/);
  assert.match(exported, /## 002 Assistant\n\n答案二/);
  dom.window.close();
});


test("records a ChatGPT image-only user turn via its attachment block", async () => {
  const dom = new JSDOM(`<!doctype html><html><head><title>附件对话</title></head><body>
    <div data-talvt-turn-state="complete">
      <div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="u-img">
        <div class="group/user-message flex flex-col items-end gap-2">
          <div>
            <button type="button" aria-label="用户附件">
              <img alt="用户附件" src="blob:fake">
            </button>
          </div>
          <div aria-label="复制消息"></div>
        </div>
      </div>
      <div data-chatgpt-search-unit-key="fallback-turn-0:2:assistant" data-chatgpt-search-message-ids="a-img">
        <div data-response-body="a-img">
          <div data-markdown-text-style="assistant-message">
            <p data-d-component="text">看到了截图。</p>
          </div>
        </div>
      </div>
    </div>
  </body></html>`, {
    url: "https://chatgpt.com/c/image-only",
    runScripts: "outside-only"
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; }
  });
  dom.window.indexedDB = new IDBFactory();
  dom.window.eval(readFileSync(path.join(__dirname, "../dist/preview-renderer.js"), "utf8"));
  dom.window.eval(readFileSync(path.join(__dirname, "../dist/providers/chatgpt-markdown.js"), "utf8"));
  dom.window.eval(readFileSync(path.join(__dirname, "../src/navigator.user.js"), "utf8"));
  await waitFor(() => dom.window.__AI_CONVERSATION_NAVIGATOR__.state.currentSession,
    "image conversation session becomes ready");

  const session = dom.window.__AI_CONVERSATION_NAVIGATOR__.state.currentSession;
  assert.equal(session.messageMap.get("0|user")?.content, "[Image: 用户附件]");
  assert.equal(session.messageMap.get("0|assistant")?.content, "看到了截图。");
  assert.equal(session.coverage.progress, 100);
  dom.window.close();
});
