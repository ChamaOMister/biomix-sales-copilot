/** A small static import graph over this repository's TypeScript files, for the isolation checks. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SPECIFIER = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

export function specifiersOf(file: string): string[] {
  const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...source.matchAll(SPECIFIER)].map((match) => (match[1] ?? match[2] ?? match[3])!);
}

export interface ImportGraph {
  /** Repository files reached, relative to the root. */
  files: string[];
  /** Bare and built-in specifiers imported by those files. */
  packages: string[];
}

export function filesUnder(root: string, dir: string): string[] {
  const absolute = path.join(root, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap((name) => {
    const child = path.join(dir, name);
    return statSync(path.join(root, child)).isDirectory() ? filesUnder(root, child) : child.endsWith(".ts") ? [child] : [];
  });
}

/** Every file and package reachable from the entry files through static and dynamic string imports. */
export function importGraph(root: string, entries: readonly string[]): ImportGraph {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of specifiersOf(path.join(root, file))) {
      if (specifier.startsWith(".")) queue.push(path.normalize(path.join(path.dirname(file), specifier)));
      else packages.add(specifier);
    }
  }
  return { files: [...files].sort(), packages: [...packages].sort() };
}
