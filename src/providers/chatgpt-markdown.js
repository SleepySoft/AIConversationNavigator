import { createMarkdownExtractor } from "./markdown-shared.js";

const { extractAssistantContent: extractMarkdown } = createMarkdownExtractor("ChatGPT");

// ChatGPT renders the response body inside a marked Markdown root; action
// buttons and reasoning toggles live outside it. The copyable DIL content is
// semantic HTML (data-d-component text/title/table/...), so the shared
// Turndown setup covers it once interactive chrome is removed.
function resolveContentRoot(element) {
  const marked = element.querySelector?.('[data-markdown-text-style="assistant-message"]');
  if (marked) {
    return marked;
  }
  const dil = element.querySelector?.("[data-dil-response]");
  return dil || element;
}

function extractAssistantContent(element) {
  const root = resolveContentRoot(element);
  const clone = root.cloneNode(true);
  clone.querySelectorAll("button").forEach((button) => button.remove());
  return extractMarkdown(clone);
}

window.__ACN_CONTENT_ADAPTERS__ ||= {};
window.__ACN_CONTENT_ADAPTERS__.chatgpt = {
  extractAssistantContent
};
