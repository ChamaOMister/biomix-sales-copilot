/** Everything a case may consult to build its question and expected values: AK and RC. */
import path from "node:path";
import { loadAnswerKey, type AnswerKey } from "./answer-key.ts";
import { loadReplayedDataset, type RefDataset } from "./reference/replay.ts";

export interface EvalContext {
  ak: AnswerKey;
  ref: RefDataset;
  checkoutDir: string;
}

export const defaultAnswerKeyPath = (checkoutDir: string): string =>
  path.join(checkoutDir, "data", "generated", "evaluation", "answer-key.json");

export async function loadEvalContext(answerKeyPath: string, checkoutDir: string): Promise<EvalContext> {
  return { ak: loadAnswerKey(answerKeyPath), ref: await loadReplayedDataset(checkoutDir), checkoutDir };
}
