import MarkdownIt from "markdown-it";
import texmath from "markdown-it-texmath";
import katex from "katex";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { MathMLToLaTeX } from "mathml-to-latex";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
}).use(texmath, {
  engine: katex,
  delimiters: ["dollars", "brackets", "beg_end"],
  katexOptions: { throwOnError: false, trust: false, maxExpand: 1000 }
});

// texmath handles standalone \[...\] blocks; Copilot also places them inside
// paragraphs, where markdown-it would otherwise treat the slashes as escapes.
markdown.inline.ruler.before("escape", "acn_inline_display_math", (state, silent) => {
  if (state.src.slice(state.pos, state.pos + 2) !== "\\[") {
    return false;
  }
  const end = state.src.indexOf("\\]", state.pos + 2);
  if (end < 0) {
    return false;
  }
  if (!silent) {
    const token = state.push("acn_inline_display_math", "", 0);
    token.content = state.src.slice(state.pos + 2, end).trim();
  }
  state.pos = end + 2;
  return true;
});
markdown.renderer.rules.acn_inline_display_math = (tokens, index) =>
  katex.renderToString(tokens[index].content, {
    displayMode: true,
    throwOnError: false,
    trust: false,
    maxExpand: 1000
  });

const originalLinkOpen = markdown.renderer.rules.link_open ||
  ((tokens, index, options, environment, renderer) =>
    renderer.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return originalLinkOpen(tokens, index, options, environment, renderer);
};

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*"
});
turndown.use(gfm);

// Turndown normally escapes backslashes (and square brackets) in text nodes.
// Keep Copilot's literal TeX delimiters intact for the math parser.
const escapedText = turndown.escape.bind(turndown);
const mathDelimiters = new Map([
  ["\\(", "\uE000"], ["\\)", "\uE001"],
  ["\\[", "\uE002"], ["\\]", "\uE003"]
]);
turndown.escape = (text) => {
  const protectedText = text.replace(/\\[()[\]]/g, (delimiter) => mathDelimiters.get(delimiter));
  let result = escapedText(protectedText);
  for (const [delimiter, marker] of mathDelimiters) {
    result = result.replaceAll(marker, delimiter);
  }
  return result;
};

function mathSource(node) {
  const math = node.matches("math") ? node : node.querySelector("math");
  const annotation = math?.querySelector('annotation[encoding="application/x-tex"]');
  const tex = node.getAttribute("data-latex") ||
    node.getAttribute("data-tex") ||
    annotation?.textContent ||
    math?.getAttribute("alttext");
  if (tex || !math) {
    return tex || null;
  }
  try {
    return MathMLToLaTeX.convert(math.outerHTML) || null;
  } catch {
    return null;
  }
}

turndown.addRule("copilotMath", {
  filter(node) {
    return (node.matches("math, .katex, [data-latex], [data-tex]") &&
      Boolean(mathSource(node)));
  },
  replacement(_content, node) {
    const source = mathSource(node).trim();
    const display = node.matches(".katex-display, .math-display") ||
      Boolean(node.closest(".katex-display, .math-display"));
    return display ? `\n\n$$\n${source}\n$$\n\n` : `$${source}$`;
  }
});

function toMarkdown(element) {
  const plainText = () => (element.innerText || element.textContent || "").trim();
  // Some Copilot replies still contain literal Markdown in plain text nodes.
  if (!element.querySelector(
    "h1,h2,h3,h4,h5,h6,p,ul,ol,pre,code,table,blockquote,a,strong,em,math,.katex,[data-latex],[data-tex]"
  )) {
    return plainText();
  }
  try {
    return turndown.turndown(element).trim() || plainText();
  } catch (error) {
    console.warn("[AI Conversation Navigator] Markdown conversion failed", error);
    return plainText();
  }
}

function renderMarkdown(source) {
  const content = String(source || "");
  try {
    return markdown.render(content);
  } catch (error) {
    console.warn("[AI Conversation Navigator] Markdown rendering failed", error);
    return `<p>${markdown.utils.escapeHtml(content)}</p>`;
  }
}

window.__ACN_PREVIEW_RENDERER__ = { toMarkdown, renderMarkdown };
