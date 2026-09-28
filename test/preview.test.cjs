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
  return { dom, renderer: dom.window.__ACN_PREVIEW_RENDERER__ };
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
  const { dom, renderer } = createRenderer();
  const reply = dom.window.document.createElement("div");
  reply.innerHTML = `<h2>Answer</h2><p>Text <strong>bold</strong> and
    <math alttext="x^2"><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math>.</p>
    <pre><code>const x = 2;</code></pre>`;
  const recovered = renderer.toMarkdown(reply);
  assert.match(recovered, /^## Answer/);
  assert.match(recovered, /\*\*bold\*\*/);
  assert.match(recovered, /\$x\^2\$/);
  assert.match(recovered, /```/);
  assert.ok(renderer.renderMarkdown(recovered).includes('class="katex"'));
  dom.window.close();
});

test("converts MathML without a TeX annotation", () => {
  const { dom, renderer } = createRenderer();
  const reply = dom.window.document.createElement("div");
  reply.innerHTML = `<p>Ratio: <math><mfrac><mi>a</mi><mi>b</mi></mfrac></math></p>`;
  const recovered = renderer.toMarkdown(reply);
  assert.match(recovered, /\\frac\{a\}\{b\}/);
  assert.ok(renderer.renderMarkdown(recovered).includes('class="katex"'));
  dom.window.close();
});

test("preserves literal Copilot math delimiters in rich text", () => {
  const { dom, renderer } = createRenderer();
  const reply = dom.window.document.createElement("div");
  reply.innerHTML = `<p>Inline \\(x^2\\) and block \\[a+b\\].</p>`;
  const recovered = renderer.toMarkdown(reply);
  const html = renderer.renderMarkdown(recovered);
  const root = dom.window.document.createElement("div");
  root.innerHTML = html;
  assert.equal(root.querySelectorAll(".katex").length, 2, recovered);
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
  dom.window.eval(readFileSync(path.join(__dirname, "../src/navigator.user.js"), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const button = dom.window.document.querySelector('[data-action="preview"]');
  assert.ok(button, "preview button exists");
  assert.equal(button.disabled, false);
  button.click();
  const preview = dom.window.document.querySelector(".acn-preview");
  assert.equal(preview.hidden, false);
  assert.equal(preview.querySelectorAll(".acn-preview-content h2").length, 1);
  assert.ok(preview.querySelector(".acn-preview-content .katex"));
  dom.window.close();
});
