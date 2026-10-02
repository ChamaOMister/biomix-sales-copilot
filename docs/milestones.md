# Milestones

Milestones 1–10 were implemented in one session on 2026-10-02 at the maintainer's request to advance as far as possible; their reports are in [the milestone reports](milestone-reports.md), and each still awaits review. Work on one milestone at a time. Each milestone ends with the [report](#milestone-report) and a review (Codex, when available). The next milestone starts only after the maintainer approves. The design behind these milestones is in [decision 001](decision-001-project-2.md).

"Tests" below are behavior tests the milestone adds. A milestone that adds none says so. Database tests use `DATABASE_URL`: they are skipped with a warning when it is missing, except in CI, where a missing database fails the run (as in Project 1).

## 0. Planning (done)

- **Scope:** `docs/decision-001-project-2.md`, this file, `CLAUDE.md` and `README.md`. No application code.
- **Tests:** none; documents only.
- **Acceptance:** the maintainer approves or edits decision 001 and answers its blocking questions (provider and key, UI, language, due-date view).

## 1. Repository foundation (implemented, awaiting review)

- **Scope:**
  - `package.json` (engines Node 24, scripts), lockfile, `.npmrc` (`save-exact`, `engine-strict`), `.nvmrc` and `.node-version` (24.21.0).
  - Strict `tsconfig.json`. ESLint with typescript-eslint, including the import-boundary rules for `src/mcp/`, `src/copilot/` and `evals/`. Vitest.
  - `.gitignore` (`.cache/`, `.env*` except `.env.example`, `node_modules/`) and `.env.example`.
  - Dev container: Node 24.21.0 and Postgres 17 through Docker Compose, 2 CPUs and 8 GB.
  - CI: lint, typecheck and tests, with a Postgres 17 service.
  - `npm run setup:env`, which writes a random reader-role password to `.env.local`.
  - `npm run check`.
- **Tests:** `setup:env` creates the value when it is missing, keeps an existing one, and never prints it. These are the first behavior tests.
- **Acceptance:**
  - A fresh Codespace builds, and `npm ci && npm run check` passes there and in CI.
  - `git check-ignore` confirms that `.cache/` and `.env.local` are ignored.
  - The ESLint boundary rule rejects a deliberate forbidden import in a throwaway check, which is not committed.

## 2. Pinned Project 1 data load (implemented, awaiting review)

- **Scope:**
  - `data-source.json` (repository URL, tag `v1.0.0`, commit `af486a5b4a2af0a7c7f71c7e124e47a7005a5a81`, seed 2026).
  - `npm run data:load`: clone the tag into `.cache/project-1/` and verify the commit; run `npm ci --omit=dev --ignore-scripts` there; generate seed 2026; run Project 1's migrations; apply 44 closed-month deliveries plus the pending one with Project 1's `ingestDelivery`; record provenance; verify.
  - `npm run data:reset -- --yes`.
  - The dev container's setup runs `data:load`, and a failure can be fixed by rerunning it.
- **Tests:**
  - A checkout whose `HEAD` differs from the pin is refused.
  - Deliveries are applied in name order, with the pending delivery last; loading stops at the first delivery that is not applied.
  - A rerun changes nothing.
  - Stored counts and per-unit, per-year totals equal `summary.json`, and every invoice's installments sum to its lines.
  - Nothing under `.cache/` is tracked by Git.
- **Acceptance:**
  - In a fresh Codespace, one command loads seed 2026, and the counts match Project 1's documented figures.
  - `git status` in the Project 1 checkout is clean afterwards, so Project 1 was not modified.

## 3. Read-only database access (implemented, awaiting review)

- **Scope:** `db/reader.sql` (role `copilot_reader`, schema `copilot`, views), `npm run db:reader`, and a reader connection factory with the startup self-check.
- **Tests,** connected as `copilot_reader`:
  - INSERT, UPDATE, DELETE and TRUNCATE on every view and base table fail with `42501`.
  - CREATE TABLE, TEMP TABLE, SCHEMA and FUNCTION fail.
  - A write fails after `SET default_transaction_read_only = off` and inside `BEGIN READ WRITE`.
  - SELECT on `public.*` fails.
  - A statement over the timeout is cancelled (`57014`).
  - The self-check rejects the admin role and a reader given an extra write grant.
- **Acceptance:** the tests pass in CI. A privilege listing shows only SELECT on `copilot` views for the reader.

## 4. MCP server and core tools (implemented, awaiting review)

- **Scope:**
  - A stdio MCP server built on the shared conventions: period presets, cents and basis points with display strings, error codes and limits.
  - Tools `dataset_overview`, `find_entities`, `sales_totals` and `invoice_details`.
  - The keyless tool console, `npm run tools`.
- **Tests:**
  - Pure: period presets (quarters, 29 February, cut at the as-of date), BRL formatting, and basis-point rounding, including negative halves.
  - On the loaded seed: SQL results equal the TypeScript reference for a matrix of filters, and groups plus the remainder add up to totals.
  - Input limits: unknown fields, oversized IDs and row caps.
  - An MCP round trip through the SDK client over stdio.
  - The listed tools equal the fixed allowlist.
- **Acceptance:** the parity tests pass, and the console prints a real tool result without any API key.

## 5. Investigation tools (implemented, awaiting review)

- **Scope:** `compare_periods`, `customer_activity`, `recurring_window_gaps`, `same_day_invoices` and `resent_invoices`.
- **Tests:**
  - Same period of the previous year, including 29 February. `NO_PREVIOUS_SALES`. Absolute versus relative ordering.
  - Named window dates for each year (Mother's Day, Black Friday), and the current window's status.
  - Consecutive invoice numbers.
  - Resent-invoice detection compared with the replayed deliveries.
  - Parity with the evaluation reference implementation.
- **Acceptance:** the tests pass in CI.

## 6. Collections tools (implemented, awaiting review)

- **Scope:** `scheduled_collections`, plus `installments_due` (the due-date view, added on Claude Code's recommendation under the maintainer's delegation; see decision 001, section 8).
- **Tests:**
  - Parity with Project 1's pure collections module.
  - The product filter is refused with `FILTER_SELECTS_LINES`.
  - Installments reconcile to invoiced sales, and breakdowns sum to totals.
  - The as-of note is set when a due-date period ends after the as-of date.
  - Output field names contain no payment vocabulary (paid, received, balance, overdue).
- **Acceptance:** the tests pass in CI.

## 7. Tool-level evaluations (L1) and answer-key isolation (implemented, awaiting review)

- **Scope:**
  - In `evals/`: cases E01–E20, the answer-key loader, the recomputation reference, a reference tool plan per case, and the runner `npm run eval:tools` with a per-case report.
  - The isolation checks from decision 001, section 4.
- **Tests:**
  - Every case passes, and each case's answer-key facts agree with the recomputation.
  - A case is rejected if its question contains an expected value.
  - The isolation checks: import graph, environment allowlist, answer-key strings in tool outputs, system prompt contents.
- **Acceptance:** `npm run eval:tools` passes in CI and the report lists every case.

## 8. Copilot loop with a scripted model (L2) (implemented, awaiting review)

- **Scope:**
  - The `ModelClient` interface and the bounded loop.
  - The MCP client over stdio, result IDs and the answer schema.
  - Placeholder validation and rendering with sources, and budgets and statuses.
  - The scripted model client, `npm run eval:scripted`, and `npm run ask` (which needs a real model from milestone 9).
- **Tests:**
  - Placeholder resolution, the digit guard, and one retry followed by `format_error`.
  - A budget exhausted ends as `incomplete`.
  - Tool errors reach the model as error results.
  - The statuses and the sources list are correct.
  - The MCP server's environment contains only the allowlist.
  - Transcripts are written only under `.cache/`.
- **Acceptance:** L2 passes in CI with no API key.

## 9. Live model (L3) (implemented; L3 not run: no API key)

- **Scope:**
  - The Anthropic model client, configured by `COPILOT_MODEL` and effort.
  - Prompt caching of the static prefix.
  - Token and cost accounting, a per-run token ceiling, and `npm run eval:live`.
  - Setup notes for the Codespaces secret.
- **Tests** (keyless):
  - A canary key never appears in stdout, stderr or run files.
  - A missing key gives a clear skip message and a distinct exit code.
  - Cost is computed correctly from a recorded usage fixture.
- **Acceptance:**
  - The maintainer adds the secret and runs L3 once.
  - The report gives per-case results, pass rate, tokens, cost and latency; the guardrail cases E16–E20 pass; the maintainer sets the pass threshold.
  - If no key is available, the milestone records L3 as not run.

## 10. Web interface (implemented, awaiting review)

- **Scope:**
  - Build an HTML web interface for the copilot so recruiters can view the result without deploying the repository. No framework: Node's built-in HTTP server and one static page (decision 001, section 6).
  - `npm run web`: a local page bound to 127.0.0.1 that asks the copilot (live mode, with a key) and runs single tools (always).
  - `npm run web:snapshot`: a self-contained HTML page of answers and the tool results behind them, from an L2 or L3 run. CI attaches it as an artifact.
- **Tests:** the API's modes, limits and errors; the live path through the copilot loop with a scripted model; the page loads nothing from other origins; the snapshot escapes every value.
- **Acceptance:**
  - The web UI connects to the copilot and displays responses.

## 11. Verify and package

- **Scope:**
  - README setup, commands and limits.
  - A fresh-Codespace verification record.
  - A demo script of commands and questions. Its outputs are not committed without maintainer approval.
  - Final review. A release only if the maintainer asks for one.
- **Tests:** none new. The full `npm run check`, L1 and L2 must pass.
- **Acceptance:** the maintainer's review, with actual evidence and unresolved risks recorded.

## Milestone report

```text
Milestone:
Implemented behavior:
Files changed:
Decisions/defaults and reasons:
Checks run (exact command + outcome):
Evaluation results (level, cases, pass/fail, cost if L3):
Checks not run and why:
Known limitations/risks:
Questions requiring a business decision (if any):
Next proposed milestone:
```

Approval is not evidence that an unrun check passed. Keep review feedback small enough to address in one change.
