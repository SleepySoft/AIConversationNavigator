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

// DIL wraps every table cell's text in a paragraph. Turndown would keep the
// paragraph line breaks inside the cell and split the Markdown table row, so
// flatten paragraphs (and stray block wrappers) inside cells to inline text.
function flattenTableCells(root) {
  const doc = root.ownerDocument;
  root.querySelectorAll("th, td").forEach((cell) => {
    cell.querySelectorAll("p, ul, ol").forEach((block) => {
      if (block.previousSibling) {
        block.before(doc.createTextNode(" "));
      }
      while (block.firstChild) {
        block.parentNode.insertBefore(block.firstChild, block);
      }
      block.remove();
    });
    cell.querySelectorAll("br").forEach((br) => br.replaceWith(doc.createTextNode(" ")));
  });
}

function extractAssistantContent(element) {
  const root = resolveContentRoot(element);
  const clone = root.cloneNode(true);
  clone.querySelectorAll("button").forEach((button) => button.remove());
  flattenTableCells(clone);
  return extractMarkdown(clone);
}

// Older captures kept the paragraph breaks inside table cells. A valid GFM
// table is a run of lines that all start with "|" and ends at a blank line,
// so any non-table line immediately following a table row marks a broken
// capture that should be recollected.
function looksLikeTextCache(content) {
  let inCodeFence = false;
  let inTable = false;
  for (const line of String(content || "").split(/\r?\n/)) {
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) {
      inCodeFence = !inCodeFence;
      inTable = false;
      continue;
    }
    if (inCodeFence) {
      continue;
    }
    if (/^\s*\|/.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable && line.trim() !== "") {
      return true;
    }
    if (line.trim() === "") {
      inTable = false;
    }
  }
  return false;
}

window.__ACN_CONTENT_ADAPTERS__ ||= {};
window.__ACN_CONTENT_ADAPTERS__.chatgpt = {
  extractAssistantContent,
  looksLikeTextCache
};
