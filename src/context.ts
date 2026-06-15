import fs from "node:fs/promises";
import path from "node:path";
import { run } from "./shell.js";

const ignored = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage"]);
const extensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".py",
  ".java",
  ".kt",
  ".go",
  ".rs",
  ".css",
  ".html",
  ".yml",
  ".yaml"
]);

export async function collectRepoContext(repoDir: string, prompt: string): Promise<string> {
  const files = await listFiles(repoDir);
  const keywords = prompt
    .toLowerCase()
    .split(/[^a-z0-9_가-힣-]+/i)
    .filter((word) => word.length >= 3);
  const scored = files
    .map((file) => ({
      file,
      score: keywords.reduce((sum, word) => sum + (file.toLowerCase().includes(word) ? 3 : 0), 0)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const selected = scored.length ? scored : files.slice(0, 8).map((file) => ({ file, score: 0 }));
  const chunks: string[] = [];
  for (const item of selected) {
    const full = path.join(repoDir, item.file);
    const stat = await fs.stat(full);
    if (stat.size > 24_000) continue;
    const content = await fs.readFile(full, "utf8").catch(() => "");
    if (!content) continue;
    chunks.push(`--- ${item.file} ---\n${content.slice(0, 8_000)}`);
  }

  const tree = await run("git", ["ls-files"], repoDir).catch(() => ({ stdout: files.join("\n") }));
  return `FILES\n${tree.stdout.slice(0, 6000)}\n\nSELECTED FILE CONTENT\n${chunks.join("\n\n")}`;
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await walk(full);
      } else if (extensions.has(path.extname(entry.name))) {
        out.push(rel);
      }
    }
  }
  await walk(root);
  return out;
}
