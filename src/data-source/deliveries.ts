/**
 * The generated delivery files and the order they are applied in: the closed-month deliveries in
 * name order (`YYYY-MM.json`), then the pending delivery last. The rejected demo delivery is never
 * loaded. Loading stops at the first delivery that is not applied.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface DeliveryFile {
  /** `deliveries/2023-01.json` or `pending/2026-09.json`, relative to the feed directory. */
  name: string;
  file: string;
  pending: boolean;
}

/** What Project 1's `ingestDelivery` returns, reduced to the fields the loader reads. */
export type IngestOutcome =
  | { kind: "applied"; replayed: boolean; body: { deliveryId: string } }
  | { kind: "rejected"; replayed: boolean; body: { deliveryId: string | null } }
  | { kind: "delivery-id-reused"; deliveryId: string };

export type Ingest = (payload: unknown) => Promise<IngestOutcome>;

export class DeliveryNotAppliedError extends Error {
  constructor(name: string, kind: string) {
    super(`Delivery ${name} was not applied (${kind}); loading stopped there.`);
    this.name = "DeliveryNotAppliedError";
  }
}

const MONTH_FILE = /^\d{4}-\d{2}\.json$/;

function monthFiles(feedDir: string, folder: "deliveries" | "pending"): DeliveryFile[] {
  const dir = path.join(feedDir, folder);
  return readdirSync(dir)
    .filter((name) => MONTH_FILE.test(name))
    .sort()
    .map((name) => ({ name: `${folder}/${name}`, file: path.join(dir, name), pending: folder === "pending" }));
}

/** Closed-month deliveries in name order, then the pending one. */
export function listDeliveryFiles(feedDir: string): DeliveryFile[] {
  const closed = monthFiles(feedDir, "deliveries");
  const pending = monthFiles(feedDir, "pending");
  if (pending.length !== 1) throw new Error(`Expected exactly one pending delivery, found ${pending.length}`);
  return [...closed, ...pending];
}

export interface ApplyResult {
  applied: number;
  /** Deliveries already stored by an earlier, interrupted run. */
  replayed: number;
  deliveryIds: string[];
}

/** Applies the files one at a time, in the given order; throws at the first one not applied. */
export async function applyDeliveries(files: readonly DeliveryFile[], ingest: Ingest): Promise<ApplyResult> {
  const result: ApplyResult = { applied: 0, replayed: 0, deliveryIds: [] };
  for (const delivery of files) {
    const payload: unknown = JSON.parse(readFileSync(delivery.file, "utf8"));
    const outcome = await ingest(payload);
    if (outcome.kind !== "applied") throw new DeliveryNotAppliedError(delivery.name, outcome.kind);
    if (outcome.replayed) result.replayed += 1;
    else result.applied += 1;
    result.deliveryIds.push(outcome.body.deliveryId);
  }
  return result;
}
