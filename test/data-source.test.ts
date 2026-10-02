import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type pg from "pg";
import { applyDeliveries, DeliveryNotAppliedError, listDeliveryFiles, type IngestOutcome } from "../src/data-source/deliveries.ts";
import { feedDir, loadDataset } from "../src/data-source/load.ts";
import { DEFAULT_CHECKOUT_DIR, PinMismatchError, readPin, REPOSITORY_ROOT, verifyCheckout } from "../src/data-source/pin.ts";
import { readSummary, verifyDataset } from "../src/data-source/verify.ts";
import { adminPool, DATABASE_URL, describeDatabase, fingerprint } from "./support/database.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "data-source-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

describe("pinned checkout", () => {
  test("data-source.json pins the Project 1 release", () => {
    expect(readPin()).toEqual({
      repository: "https://github.com/ChamaOMister/biomix-use-cases",
      tag: "v1.0.0",
      commit: "af486a5b4a2af0a7c7f71c7e124e47a7005a5a81",
      seed: 2026,
    });
  });

  test("a checkout whose HEAD differs from the pin is refused", () => {
    git(dir, "init", "--quiet");
    writeFileSync(path.join(dir, "file.txt"), "content\n");
    git(dir, "add", "file.txt");
    git(dir, "commit", "--quiet", "-m", "one");
    const head = git(dir, "rev-parse", "HEAD");
    expect(() => verifyCheckout(dir, head)).not.toThrow();
    expect(() => verifyCheckout(dir, "af486a5b4a2af0a7c7f71c7e124e47a7005a5a81")).toThrow(PinMismatchError);
  });

  test("a checkout with modified tracked files is refused", () => {
    git(dir, "init", "--quiet");
    writeFileSync(path.join(dir, "file.txt"), "content\n");
    git(dir, "add", "file.txt");
    git(dir, "commit", "--quiet", "-m", "one");
    const head = git(dir, "rev-parse", "HEAD");
    writeFileSync(path.join(dir, "file.txt"), "changed\n");
    expect(() => verifyCheckout(dir, head)).toThrow(/modified/);
  });

  test("nothing under .cache/ is tracked, and the cache is ignored", () => {
    expect(git(REPOSITORY_ROOT, "ls-files", ".cache")).toBe("");
    expect(git(REPOSITORY_ROOT, "check-ignore", ".cache/project-1/data/generated/feed/summary.json")).not.toBe("");
  });
});

describe("delivery order", () => {
  function writeFeed(): string {
    const feed = path.join(dir, "feed");
    for (const folder of ["deliveries", "pending", "demo"]) mkdirSync(path.join(feed, folder), { recursive: true });
    for (const name of ["2023-10", "2023-02", "2024-01", "2023-01"]) {
      writeFileSync(path.join(feed, "deliveries", `${name}.json`), JSON.stringify({ deliveryId: name }));
    }
    writeFileSync(path.join(feed, "pending", "2026-09.json"), JSON.stringify({ deliveryId: "pending" }));
    writeFileSync(path.join(feed, "demo", "2026-09-rejected.json"), JSON.stringify({ deliveryId: "demo" }));
    return feed;
  }

  const applied = (deliveryId: string): IngestOutcome => ({ kind: "applied", replayed: false, body: { deliveryId } });

  test("deliveries are applied in name order with the pending delivery last; the demo is never loaded", async () => {
    const seen: string[] = [];
    const result = await applyDeliveries(listDeliveryFiles(writeFeed()), (payload) => {
      const id = (payload as { deliveryId: string }).deliveryId;
      seen.push(id);
      return Promise.resolve(applied(id));
    });
    expect(seen).toEqual(["2023-01", "2023-02", "2023-10", "2024-01", "pending"]);
    expect(result).toEqual({ applied: 5, replayed: 0, deliveryIds: seen });
  });

  test("loading stops at the first delivery that is not applied", async () => {
    const seen: string[] = [];
    const run = applyDeliveries(listDeliveryFiles(writeFeed()), (payload) => {
      const id = (payload as { deliveryId: string }).deliveryId;
      seen.push(id);
      return Promise.resolve(
        id === "2023-02" ? { kind: "rejected", replayed: false, body: { deliveryId: id } } : applied(id),
      );
    });
    await expect(run).rejects.toThrow(DeliveryNotAppliedError);
    await expect(run).rejects.toThrow("deliveries/2023-02.json");
    expect(seen).toEqual(["2023-01", "2023-02"]);
  });

  test("replayed deliveries from an interrupted load count as replayed", async () => {
    const result = await applyDeliveries(listDeliveryFiles(writeFeed()), (payload) => {
      const id = (payload as { deliveryId: string }).deliveryId;
      return Promise.resolve({ kind: "applied", replayed: id < "2023-10", body: { deliveryId: id } });
    });
    expect(result.replayed).toBe(2);
    expect(result.applied).toBe(3);
  });

  test("a feed without exactly one pending delivery is refused", () => {
    const feed = writeFeed();
    writeFileSync(path.join(feed, "pending", "2026-10.json"), "{}");
    expect(() => listDeliveryFiles(feed)).toThrow(/exactly one pending/);
  });
});

describeDatabase("loaded dataset", () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = adminPool();
  });
  afterAll(() => pool.end());

  const summary = () => readSummary(path.join(feedDir(DEFAULT_CHECKOUT_DIR), "summary.json"));

  test("stored counts, per-unit and per-year totals equal summary.json, and installments sum to lines", async () => {
    expect(await verifyDataset(pool, summary())).toEqual([]);
  });

  test("verification reports a mismatch", async () => {
    const tampered = { ...summary(), invoices: summary().invoices + 1 };
    tampered.byUnitAndYear = tampered.byUnitAndYear.map((row, index) => (index === 0 ? { ...row, actualCents: row.actualCents + 1 } : row));
    const problems = await verifyDataset(pool, tampered);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^invoices: stored/);
  });

  test("a rerun of data:load changes nothing", async () => {
    const before = await fingerprint(pool);
    const result = await loadDataset({ pin: readPin(), databaseUrl: DATABASE_URL });
    expect(result.status).toBe("already-loaded");
    expect(result.provenance).toMatchObject({ sourceCommit: readPin().commit, seed: 2026, asOfDate: "2026-09-25" });
    expect(await fingerprint(pool)).toEqual(before);
  });
});
