import { createMarkdownExtractor } from "./markdown-shared.js";
import { prepareLegacyPreview } from "./copilot-legacy.js";

const { extractAssistantContent } = createMarkdownExtractor("Copilot");

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
