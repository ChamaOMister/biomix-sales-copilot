/**
 * The pinned Project 1 checkout (decision 001, section 1): a shallow clone of the pinned tag in
 * the Git-ignored `.cache/project-1/`, accepted only when `HEAD` is the pinned commit and the
 * working tree is unmodified. Tags can move; the commit cannot.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface DataSourcePin {
  repository: string;
  tag: string;
  commit: string;
  seed: number;
}

export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const DEFAULT_CHECKOUT_DIR = path.join(REPOSITORY_ROOT, ".cache", "project-1");

export class PinMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinMismatchError";
  }
}

export function readPin(file: string = path.join(REPOSITORY_ROOT, "data-source.json")): DataSourcePin {
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<DataSourcePin>;
  const { repository, tag, commit, seed } = value;
  if (
    typeof repository !== "string" || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repository) ||
    typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag) ||
    typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit) ||
    typeof seed !== "number" || !Number.isSafeInteger(seed) || seed < 0
  ) {
    throw new Error("data-source.json must hold repository, tag, a full commit SHA and a seed");
  }
  return { repository, tag, commit, seed };
}

function git(args: readonly string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Refuses a checkout whose HEAD is not the pinned commit, or whose tracked files were changed. */
export function verifyCheckout(dir: string, commit: string): void {
  const head = git(["-C", dir, "rev-parse", "HEAD"]);
  if (head !== commit) {
    throw new PinMismatchError(`The checkout in ${path.basename(dir)} is at ${head}, not the pinned commit ${commit}.`);
  }
  const status = git(["-C", dir, "status", "--porcelain", "--untracked-files=no"]);
  if (status !== "") {
    throw new PinMismatchError(`The checkout in ${path.basename(dir)} has modified files; Project 1 must stay unmodified.`);
  }
}

/** Clones the pinned tag if the checkout is missing, then verifies it. Returns whether it cloned. */
export function ensureCheckout(pin: DataSourcePin, dir: string = DEFAULT_CHECKOUT_DIR): { cloned: boolean } {
  let cloned = false;
  if (!existsSync(path.join(dir, ".git"))) {
    git(["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", pin.tag, pin.repository, dir]);
    cloned = true;
  }
  verifyCheckout(dir, pin.commit);
  return { cloned };
}
