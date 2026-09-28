import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postcss from "postcss";
import prefixSelector from "postcss-prefix-selector";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");
const katexDist = path.join(root, "node_modules", "katex", "dist");

await mkdir(output, { recursive: true });
await build({
  entryPoints: [path.join(root, "src", "preview-renderer.js")],
  outfile: path.join(output, "preview-renderer.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  minify: true,
  legalComments: "eof"
});

const css = await readFile(path.join(katexDist, "katex.min.css"), "utf8");
const scoped = await postcss([
  prefixSelector({ prefix: "#ai-conversation-navigator" })
]).process(css, { from: path.join(katexDist, "katex.min.css"), map: false });
scoped.root.walkAtRules("font-face", (rule) => {
  rule.walkDecls("src", (declaration) => {
    const woff2 = declaration.value.split(",")
      .find((source) => source.includes(".woff2"));
    if (!woff2) {
      throw new Error(`Missing WOFF2 source in ${rule.toString()}`);
    }
    declaration.value = woff2.trim();
  });
});
const cssWithFontUrls = scoped.root.toString().replaceAll(
  "url(fonts/",
  "url(chrome-extension://__MSG_@@extension_id__/dist/fonts/"
);
await writeFile(path.join(output, "katex.css"), cssWithFontUrls);
const fontOutput = path.join(output, "fonts");
await mkdir(fontOutput, { recursive: true });
for (const font of await readdir(path.join(katexDist, "fonts"))) {
  if (font.endsWith(".woff2")) {
    await cp(path.join(katexDist, "fonts", font), path.join(fontOutput, font));
  }
}
for (const font of await readdir(fontOutput)) {
  if (font.endsWith(".woff") || font.endsWith(".ttf")) {
    await unlink(path.join(fontOutput, font));
  }
}

const licenses = [
  ["katex", "LICENSE"],
  ["markdown-it", "LICENSE"],
  ["markdown-it-texmath", "license.txt"],
  ["turndown", "LICENSE"],
  ["turndown-plugin-gfm", "LICENSE"],
  ["mathml-to-latex", "LICENSE.md"]
];
await mkdir(path.join(output, "licenses"), { recursive: true });
for (const [name, file] of licenses) {
  await cp(path.join(root, "node_modules", name, file),
    path.join(output, "licenses", `${name}.txt`));
}
