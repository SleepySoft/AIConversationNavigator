import MarkdownIt from "markdown-it";
import texmath from "markdown-it-texmath";
import katex from "katex";

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

function renderMarkdown(source) {
  const content = String(source || "");
  try {
    return markdown.render(content);
  } catch (error) {
    console.warn("[AI Conversation Navigator] Markdown rendering failed", error);
    return `<p>${markdown.utils.escapeHtml(content)}</p>`;
  }
}

window.__ACN_PREVIEW_RENDERER__ = { renderMarkdown };
