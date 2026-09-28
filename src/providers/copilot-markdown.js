import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { MathMLToLaTeX } from "mathml-to-latex";
import { prepareLegacyPreview } from "./copilot-legacy.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*"
});
turndown.use(gfm);

// Copilot sometimes leaves TeX delimiters in text nodes inside rendered HTML.
// Turndown would escape those delimiters unless they are protected here.
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
    const math = node.matches("math") ? node : node.querySelector("math");
    const display = node.matches(".katex-display, .math-display") ||
      Boolean(node.closest(".katex-display, .math-display")) ||
      math?.getAttribute("display") === "block";
    return display ? `\n\n$$\n${source}\n$$\n\n` : `$${source}$`;
  }
});

function extractAssistantContent(element) {
  const plainText = () => (element.innerText || element.textContent || "").trim();
  if (!element.querySelector(
    "h1,h2,h3,h4,h5,h6,p,ul,ol,pre,code,table,blockquote,a,strong,em,math,.katex,[data-latex],[data-tex]"
  )) {
    return { content: plainText(), format: "text" };
  }
  try {
    const content = turndown.turndown(element).trim();
    return content
      ? { content, format: "markdown" }
      : { content: plainText(), format: "text" };
  } catch (error) {
    console.warn("[AI Conversation Navigator] Copilot Markdown conversion failed", error);
    return { content: plainText(), format: "text" };
  }
}

function looksLikeTextCache(content) {
  let inCodeFence = false;
  let tabularLines = 0;
  for (const line of String(content || "").split(/\r?\n/)) {
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }
    if (line === "Plain Text" || line === "Markdown") {
      return true;
    }
    if (line.includes("\t")) {
      tabularLines += 1;
    }
  }
  return tabularLines >= 2;
}

window.__ACN_CONTENT_ADAPTERS__ ||= {};
window.__ACN_CONTENT_ADAPTERS__.copilot = {
  extractAssistantContent,
  looksLikeTextCache,
  prepareLegacyPreview
};
