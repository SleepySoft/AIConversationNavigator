import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { MathMLToLaTeX } from "mathml-to-latex";

// Shared DOM-to-Markdown extraction for provider adapters. Each provider
// builds its own Turndown instance so per-site quirks stay local, while the
// math handling and the rich-content heuristic stay identical.
export function createMarkdownExtractor(label) {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*"
  });
  turndown.use(gfm);

  // Rendered HTML sometimes leaves TeX delimiters in text nodes.
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

  turndown.addRule("acnMath", {
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

  const richContentSelector = [
    "h1,h2,h3,h4,h5,h6,p,ul,ol,pre,code,table,blockquote,a,strong,em",
    "math,.katex,[data-latex],[data-tex],[data-d-component]"
  ].join(",");

  function extractAssistantContent(element) {
    const plainText = () => (element.innerText || element.textContent || "").trim();
    if (!element.querySelector(richContentSelector)) {
      return { content: plainText(), format: "text" };
    }
    try {
      const content = turndown.turndown(element).trim();
      return content
        ? { content, format: "markdown" }
        : { content: plainText(), format: "text" };
    } catch (error) {
      console.warn(`[AI Conversation Navigator] ${label} Markdown conversion failed`, error);
      return { content: plainText(), format: "text" };
    }
  }

  return { extractAssistantContent };
}
