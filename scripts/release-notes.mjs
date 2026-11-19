// Extracts one version's section from CHANGELOG.md to use as a GitHub Release body.
// Usage: node scripts/release-notes.mjs <version>   (e.g. 0.5.1)
// CHANGELOG.md stays the single source of truth: the release body is derived, never hand-copied.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/.. -> project root
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: node scripts/release-notes.mjs <version>   e.g. 0.5.1");
  process.exit(2);
}

const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split("\n");

// Headings look like "## 0.5.1（2026-11-17）" (full-width paren). Match the
// version token literally so dots are not treated as regex wildcards.
const start = lines.findIndex((line) => line.startsWith(`## ${version}（`) || line.startsWith(`## ${version} (`));
if (start === -1) {
  console.error(`release-notes: no "## ${version}" section in CHANGELOG.md`);
  process.exit(1);
}

// Stop at the next level-2 heading; the oldest version runs to EOF.
let end = start + 1;
while (end < lines.length && !lines[end].startsWith("## ")) end++;

// Trim blank lines at the tail so the body has exactly one trailing newline.
const body = lines.slice(start, end).join("\n").replace(/\n+$/, "");
process.stdout.write(`${body}\n`);
