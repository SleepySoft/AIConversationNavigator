// Older Copilot caches were captured with innerText. Prepare their preview
// and Markdown export without changing the stored text.

function plainEquationToLatex(value) {
  const equation = value.trim().normalize("NFKC")
    .replaceAll("−", "-");
  if (equation.length > 100 ||
    !/[=≈<>]/.test(equation) ||
    !/^[\p{Script=Han}A-Za-z0-9\s=≈<>+*/().,%×-]+$/u.test(equation)) {
    return null;
  }
  return equation
    .replace(/[\p{Script=Han}]+/gu, (text) => `\\text{${text}}`)
    .replaceAll("≈", "\\approx ")
    .replaceAll("×", "\\times ")
    .replaceAll("%", "\\%");
}

function formatLegacyBlock(block) {
  const lines = block.split("\n");
  const codeLanguages = { "Plain Text": "text", Markdown: "markdown" };
  if (codeLanguages[lines[0]] && lines.length > 1) {
    const body = lines.slice(1).join("\n");
    const longestFence = Math.max(0, ...Array.from(body.matchAll(/`+/g), ([match]) => match.length));
    const fence = "`".repeat(Math.max(3, longestFence + 1));
    return `${fence}${codeLanguages[lines[0]]}\n${body}\n${fence}`;
  }

  const cells = lines.map((line) => line.split("\t").map((cell) => cell.trim()));
  if (lines.length >= 2 && cells.every((row) =>
    row.length >= 2 && row.length === cells[0].length)) {
    const row = (values) => `| ${values.map((value) => value.replaceAll("|", "\\|")).join(" | ")} |`;
    return [row(cells[0]), row(cells[0].map(() => "---")),
      ...cells.slice(1).map(row)].join("\n");
  }

  const last = lines.at(-1).trim();
  const fragments = lines.slice(0, -1).map((line) => line.trim());
  if (fragments.length >= 3 &&
    fragments.every((line) => line.length <= 16) &&
    fragments.some((line) => /^[=≈<>+×−-]$/.test(line))) {
    const latex = plainEquationToLatex(last);
    if (latex) {
      return `$$\n${latex}\n$$`;
    }
  }

  if (lines.length === 1) {
    const latex = plainEquationToLatex(last);
    if (latex) {
      return `$$\n${latex}\n$$`;
    }
    if (/^[一二三四五六七八九十]+、\S/.test(last)) {
      return `### ${last}`;
    }
  }

  if (lines.length >= 3 && lines.every((line) => line.length <= 100) &&
    lines.slice(0, -1).every((line) => /[；;]$/.test(line.trim()))) {
    return lines.map((line) => `- ${line.trim()}`).join("\n");
  }
  return block;
}

export function prepareLegacyPreview(content) {
  return String(content || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n(?=(?:Plain Text|Markdown)\n)/g, "\n\n")
    .split(/\n{2,}/)
    .map(formatLegacyBlock)
    .join("\n\n");
}
