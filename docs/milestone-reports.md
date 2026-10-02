# Milestone reports

Milestones 1–10 were implemented on 2026-10-02 in one session, at the maintainer's request to advance as far as possible and to decide where a recommendation existed. Each report uses [the milestone report format](milestones.md#milestone-report). Approval is not evidence that an unrun check passed.

Environment for every check below: a GitHub Codespace (2 CPUs, 8 GB) not built from this repository's dev container, Node 24.21.0, npm 11.19.0, and Postgres 17.11 in a local Docker container with the dev container's credentials (`DATABASE_URL` in `.env.local`).

## Checks run for all milestones (final state)

| Command | Outcome |
| --- | --- |
| `npm ci` | added 238 packages |
| `npm run data:load` (rerun) | `Dataset already loaded and verified; nothing changed` |
| `npm run db:reader` | privilege listing `copilot SELECT: customers, dataset_info, deliveries, invoice_lines, invoices, products, scheduled_installments, sellers`; `Reader self-check passed` |
| `npm run check` | lint and typecheck clean; `Test Files 14 passed (14)`, `Tests 202 passed (202)` |
| `npm run eval:tools` | `L1: 20/20 cases passed` |
| `npm run eval:scripted` | `L2: 20/20 cases passed` |
| `git check-ignore -v .cache/x .env.local .claude/settings.local.json` | all three ignored |
| `git -C .cache/project-1 status --porcelain` / `rev-parse HEAD` | clean; `af486a5b4a2af0a7c7f71c7e124e47a7005a5a81` |
| `npm audit --omit=dev` | 0 vulnerabilities |

**Not run, for every milestone:** a fresh Codespace built from `.devcontainer/` (this Codespace predates it), and the GitHub Actions workflow (nothing has been pushed). Both are acceptance criteria for milestone 1 and must be observed by the maintainer.

---

```text
Milestone: 1. Repository foundation
Implemented behavior: Node 24.21.0 pins (.nvmrc, .node-version, engines), .npmrc (save-exact, engine-strict), strict tsconfig with type stripping, ESLint (typescript-eslint, type-checked) with the import boundaries for src/mcp/, src/copilot/ and evals/, Vitest, .gitignore, .env.example, dev container (Node 24.21.0 + Postgres 17, 2 CPUs / 8 GB), CI workflow with a Postgres 17 service, `npm run setup:env`, `npm run check`.
Files changed: package.json, package-lock.json, .npmrc, .nvmrc, .node-version, tsconfig.json, eslint.config.js, vitest.config.ts, .gitignore, .env.example, .devcontainer/*, .github/workflows/ci.yml, src/setup/setup-env.ts, scripts/setup-env.ts, test/setup-env.test.ts.
Decisions/defaults and reasons:
- @types/node 24.19.1 instead of the uploaded 26.6.3, to match the Node 24 runtime. TypeScript stays 6.0.3 (decision 001; typescript-eslint 8.71.0 supports < 6.1).
- setup-env moved from src/shared/ to src/setup/: src/shared/ is pure and imported by the MCP server, which may not reach node:fs.
- Boundary rules use regex patterns (`(^|/)evals(/|$)`), which match relative paths reliably; src/mcp/ additionally forbids network and process modules and the model SDK; src/copilot/ forbids fs, pg and src/mcp/ internals. scripts/eval-*.ts may import evals/.
- Type-unsafe rules are relaxed for test/ and evals/ only (they assert on JSON tool results).
Checks run (exact command + outcome):
- Throwaway probe (deleted, not committed): files in src/mcp/, src/copilot/ and scripts/ importing node:fs, node:http, pg, ../copilot, ../mcp/server.ts and ../../evals/…; `npx eslint <probes>` → 10 errors, all no-restricted-imports; probes removed, `git status` showed none.
- `npm run setup:env && npm run setup:env` → "COPILOT_READER_PASSWORD created in .env.local", then "already set".
- Plus the shared checks above.
Evaluation results: none (no evaluations in this milestone).
Checks not run and why: fresh Codespace build and CI run (see above).
Known limitations/risks: CI uses actions v4 like Project 1; versions were not re-checked against newer majors.
Questions requiring a business decision: none.
Next proposed milestone: 2.
```

```text
Milestone: 2. Pinned Project 1 data load
Implemented behavior: `npm run data:load` clones v1.0.0 into .cache/project-1/, refuses any HEAD other than the pinned commit or modified tracked files, generates seed 2026 with Project 1's script (only if not already generated), runs Project 1's `npm ci --omit=dev --ignore-scripts` and `npm run db:migrate`, applies the 44 closed-month deliveries in name order and the pending one last with Project 1's `ingestDelivery`, stops at the first delivery not applied, verifies against summary.json and records provenance in the admin-only `copilot_admin.dataset_provenance`. A rerun changes nothing; an interrupted load finishes on rerun. `npm run data:reset -- --yes` drops this repository's schemas, runs Project 1's db:reset, reloads and re-creates the reader views.
Files changed: data-source.json, src/data-source/{pin,deliveries,verify,load}.ts, src/db/pool.ts, src/setup/env.ts, scripts/data-load.ts, scripts/data-reset.ts, test/data-source.test.ts, test/support/{database,global-setup}.ts.
Decisions/defaults and reasons:
- summary.json's firstBillingDate/lastBillingDate (2023-01-01, 2026-09-25) are the covered period, not the first and last invoice (the first invoice is 2023-01-02). Verification checks the stored range lies inside them; provenance stores as_of_date = 2026-09-25 and coverage_start_date = 2023-01-01.
- Project 1's child processes get an environment allowlist (PATH, HOME, LANG, TMPDIR, npm cache, DATABASE_URL): never API keys or the reader password.
- Database tests read the loaded dataset in the default schema (read-only, except the reader probe role below), skip without DATABASE_URL and fail in CI, as in Project 1. The global setup also requires the loaded dataset and reader views.
Checks run (exact command + outcome): `npm run data:load` (first) → applied 45 deliveries, verified, about 4.5 s; rerun → "already stored" replay then "already loaded"; `npm run data:reset` without --yes → refused, exit 1; `npm run data:reset -- --yes` → reloaded in 4.5 s; Project 1 checkout clean afterwards. Tests: pin refusal (HEAD and modified files), delivery order with pending last, stop at first non-applied, replay counting, summary verification (and a tampered summary reports mismatches), rerun leaves every table's fingerprint unchanged, nothing under .cache/ tracked.
Evaluation results: none.
Checks not run and why: the dev container's postCreateCommand (fresh Codespace not built).
Known limitations/risks: data:load imports Project 1's internal `src/server/sales-feed/ingest.ts`, acceptable under the pin (decision 001). Needs GitHub and npm registry access.
Questions requiring a business decision: none.
Next proposed milestone: 3.
```

```text
Milestone: 3. Read-only database access
Implemented behavior: db/reader.sql (role copilot_reader NOINHERIT, CONNECTION LIMIT 4, read-only default, 5 s statement timeout, 10 s idle-in-transaction timeout, search_path copilot; REVOKE ALL on the database, public and copilot_admin from PUBLIC; eight views in schema copilot), applied in one transaction by `npm run db:reader`, which sets the password from .env.local and runs the self-check. Reader pool factory, startup self-check, and one read-only repeatable-read transaction per tool call.
Files changed: db/reader.sql, src/db/{reader,reader-setup}.ts, scripts/db-reader.ts, scripts/data-reset.ts, test/reader.test.ts, CI and dev container steps.
Decisions/defaults and reasons:
- The self-check also rejects role attributes, memberships, sequence privileges, SELECT outside schema copilot, non-view relations in copilot, CREATE on any schema, CREATE/TEMPORARY on the database, read-only off and no timeout.
- The "extra write grant" test uses a throwaway role set up like the reader, so the real reader's privileges are never widened while other tests run.
- Reader pools use one connection (the role allows four); tests run at most two files in parallel.
Checks run (exact command + outcome): `npm run db:reader` twice → listing shows only SELECT on the eight copilot views; self-check passed. Tests: INSERT/UPDATE/DELETE/TRUNCATE on all 8 views and 10 base tables, with read-only switched off and inside BEGIN READ WRITE → 42501, except TRUNCATE on a view → 42809 (Postgres rejects it as "not a table" before checking privileges); with the role defaults every write fails (25006, 42501 or 42809); CREATE TABLE (three forms), TEMP TABLE, SCHEMA, FUNCTION (two forms), VIEW → 42501; SELECT on Project 1's tables and copilot_admin → 42501; pg_sleep(5.5) → 57014; self-check rejects the admin role and a role given INSERT, SELECT or CREATE outside copilot.
Evaluation results: none.
Checks not run and why: CI run.
Known limitations/risks: REVOKE ALL ON SCHEMA public FROM PUBLIC also affects any other role in this database; the dev database has only the admin and the reader.
Questions requiring a business decision: none.
Next proposed milestone: 4.
```

```text
Milestone: 4. MCP server and core tools
Implemented behavior: stdio MCP server on the SDK's low-level Server (exact tool list, own strict validation and error shapes); conventions (periods with presets resolved against the as-of date and cut/flagged, cents and basis points with display strings, fixed error and note codes, limits, envelope with asOf/source/notes/truncation); tools dataset_overview, find_entities (case- and accent-insensitive, exact IDs first), sales_totals (groups plus otherGroups always add up), invoice_details; keyless console `npm run tools`; RC (recomputation) replaying the delivery files in evals/reference/.
Files changed: src/shared/{dates,periods,money}.ts, src/mcp/**, src/mcp-client/client.ts, scripts/tools.ts, evals/reference/{replay,sales}.ts, test/{shared,mcp-core,mcp-server}.test.ts, test/support/tools.ts. Dependencies: @modelcontextprotocol/sdk 1.31.0, zod 4.6.5.
Decisions/defaults and reasons:
- A seventh error code, INTERNAL_ERROR, for unexpected failures (decision 001 lists six); none occurs in the tests.
- Input errors name field paths and problems only; unknown fields are reported without their names; no message echoes input values.
- Filter IDs and segments are checked to exist (NOT_FOUND with the field), so a mistyped ID is not an empty result.
- Month and year groups list every period of the range, zeros included; other groupings list the largest by sales (ties by key, collation "C" for determinism).
- The server's environment is COPILOT_DATABASE_URL plus the SDK's fixed safe variables (HOME, LOGNAME, PATH, SHELL, TERM, USER), which its stdio transport always passes.
Checks run (exact command + outcome): `npm run tools -- sales_totals '{"period":"calendar-year:2024","groupBy":"businessUnit"}'` → total R$ 21,992,363.10, Agro R$ 13,199,442.00, equal to Project 1's summary; tests: presets (all quarters, 29 February, cut at as-of, starts after as-of), BRL formatting incl. bigint, basis points incl. negative halves; parity matrix 5 periods × 7 filter sets × 9 groupings equal to RC with groups plus remainder adding up; input limits (unknown fields, 65-character IDs, row caps 100/20/10); stdio round trip; listed tools equal the allowlist; the server refuses the admin connection.
Evaluation results: none (L1 is milestone 7).
Checks not run and why: CI run.
Known limitations/risks: tool descriptions are first drafts; L3 will show whether the model picks tools well.
Questions requiring a business decision: none.
Next proposed milestone: 5.
```

```text
Milestone: 5. Investigation tools
Implemented behavior: compare_periods (same period of the previous year from the cut current period, 29 February → 28 February, absolute or relative ordering, statuses new/absent/continuing, customers' first billing date, otherGroups), customer_activity (zeros for months without purchases), recurring_window_gaps (agro-season, mothers-day-lead, black-friday-lead, christmas-lead computed in TypeScript; current window complete/in-progress/not-started), same_day_invoices (consecutive-number flag), resent_invoices (PREVIOUS_VERSION_NOT_STORED).
Files changed: src/shared/windows.ts, src/mcp/tools/{compare-periods,customer-activity,recurring-window-gaps,same-day-invoices,resent-invoices}.ts, evals/reference/investigation.ts, test/mcp-investigation.test.ts.
Decisions/defaults and reasons:
- compare_periods has a `status` filter, including `firstPurchase` (customers whose first purchase ever falls in the current period), so "customers who bought for the first time in 2026" is answered from tool fields rather than by the model comparing dates.
- recurring_window_gaps requires complete reference windows (REFERENCE_WINDOW_NOT_COMPLETE otherwise).
- Correction to decision 001's design note: in the year-to-date comparison no customer stopped buying altogether; the planted reduced-purchase accounts still do not rank first by relative drop, because smaller accounts fell further in relative terms. The default absolute ordering stands.
Checks run (exact command + outcome): tests: window dates 2023–2027 and equality with an independent Date.UTC computation for 2020–2030; consecutive numbers; compare_periods parity with RC for 4 groupings × 4 filter sets; ordering; NO_PREVIOUS_SALES; statuses; customer_activity parity; window gaps parity for 5 configurations; same-day groups equal RC; resent invoices equal the invoices delivered more than once in the replayed deliveries.
Evaluation results: none (L1 is milestone 7). Smoke: the planted missed season, missed promotion window, split invoices, corrections, reduced purchases and the 14 new customers are all found.
Checks not run and why: CI run.
Known limitations/risks: window definitions are proposed defaults from Project 1's context, not company policy.
Questions requiring a business decision: none.
Next proposed milestone: 6.
```

```text
Milestone: 6. Collections tools
Implemented behavior: scheduled_collections (invoices selected by billing date, totals by due month and payment schedule, reconciled to the same invoices' invoiced sales, NO_PAYMENT_DATA) and installments_due (stored installments by due date; the period may extend past the as-of date, with INCLUDES_ONLY_INVOICES_BILLED_BY_AS_OF). Both refuse a product filter with FILTER_SELECTS_LINES.
Files changed: src/mcp/tools/collections.ts, src/shared/periods.ts (resolveDuePeriod), evals/reference/collections.ts, test/mcp-collections.test.ts.
Decisions/defaults and reasons: installments_due added (decision 001, question 1, decided on Claude Code's recommendation under delegation): it makes E15 answerable and is labelled as contractual amounts only.
Checks run (exact command + outcome): tests: parity with Project 1's own buildCollectionsReport for 6 selections, and with Project 1's scheduleInstallments for 4 due-date selections; FILTER_SELECTS_LINES (and Project 1 refuses the same); reconciliation and breakdown sums; the as-of note; no output field name of any of the 11 tools contains payment vocabulary (paid, received, balance, overdue, outstanding, settled, collected).
Evaluation results: none (L1 is milestone 7).
Checks not run and why: CI run.
Known limitations/risks: none known.
Questions requiring a business decision: none.
Next proposed milestone: 7.
```

```text
Milestone: 7. Tool-level evaluations (L1) and answer-key isolation
Implemented behavior: cases E01–E20 with questions filled at run time, accepted statuses, required limitations, reference tool plans, checks, AK-versus-RC consistency checks and gradeable facts; answer-key loader (path passed as an argument by the npm script); `npm run eval:tools` with a per-case report under .cache/runs/; isolation checks.
Files changed: evals/{answer-key,context,cases,l1,validate}.ts, scripts/eval-tools.ts, test/{eval-l1,isolation}.test.ts, test/support/import-graph.ts, CI step.
Decisions/defaults and reasons:
- E18 accepts answered or insufficient_data (the product's invoiced sales may be given); E16 forbids naming any customer ID; E17 forbids any amount; E11 forbids any percentage; E12 forbids the original amounts that differ from the corrected ones.
- "Contains an expected value" matches whole tokens only, so "2025" does not contain "202".
Checks run (exact command + outcome): `npm run eval:tools` → L1 20/20 in about 4 s. Tests: every case passes; every case's AK facts agree with RC; questions contain no expected value, and leaky variants are rejected; stored data fingerprints identical before and after the suite; import graph of src/mcp/ reaches no fs, network, model SDK, copilot or evals/, and of src/copilot/ no fs, pg, src/mcp/ or src/db/; the server reads only COPILOT_DATABASE_URL; no file outside evals/ and the eval runners mentions the answer key; no tool output contains an answer-key-only string.
Evaluation results: L1, 20 cases, 20 pass.
Checks not run and why: CI run.
Known limitations/risks: none known.
Questions requiring a business decision: none.
Next proposed milestone: 8.
```

```text
Milestone: 8. Copilot loop with a scripted model (L2)
Implemented behavior: ModelClient interface; bounded loop (8 tool calls, 10 model requests, 1 format retry, token ceiling → incomplete); result IDs r1, r2… in call order, tool errors returned as error results with their code; final-answer JSON parsing, placeholder resolution, digit guard and quantity word list; rendering with limitations and sources (result ID, tool, normalized input, as-of date, source commit); scripted model client; `npm run eval:scripted`; deterministic grader shared with L3; run records written only under .cache/runs/.
Files changed: src/copilot/{types,prompt,answer,loop,scripted}.ts, src/runs/transcripts.ts, evals/{grade,scripted,l2}.ts, scripts/eval-scripted.ts, test/{copilot,eval-l2}.test.ts, test/support/env-probe.ts, CI step.
Decisions/defaults and reasons:
- One answer-format retry, then format_error, following decision 001's validation rule and this milestone's test list (section 3's limits line says "2 answer-format retries"; the budget is configurable).
- "one" is not in the quantity word list (mostly not a quantity in prose); "percent" is not either (a unit).
- Placeholders may cite error results (for example {{r1.error.asOf}}), so an insufficient-data answer can show the as-of date.
Checks run (exact command + outcome): `npm run eval:scripted` → L2 20/20. Tests: resolution by dotted path with list positions; unresolved, non-scalar and malformed placeholders; digit guard and words; one retry then format_error; tool-call, model-request and token budgets → incomplete; model errors, truncation and refusals → incomplete; tool errors reach the model with code and result ID; sources only for cited results; logs carry no values; the MCP server's environment (probed by a stand-in server while the parent holds a key, admin URL and reader password) contains only the allowlist; run records refuse paths outside .cache/; the system prompt contains no date, case question, scenario kind or answer-key value.
Evaluation results: L2, 20 cases, 20 pass, no API key.
Checks not run and why: CI run.
Known limitations/risks: L2 proves the machinery, not the live model's tool choices or wording.
Questions requiring a business decision: none.
Next proposed milestone: 9.
```

```text
Milestone: 9. Live model (L3)
Implemented behavior: Anthropic client on the Messages API (@anthropic-ai/sdk 0.131.0), model from COPILOT_MODEL (default claude-opus-5-5) and effort from COPILOT_EFFORT (default medium, set explicitly); prompt caching with an explicit breakpoint on the system prompt (caches tools and system) plus automatic caching of the conversation; assistant blocks (including thinking) sent back unchanged; server-side refusal fallbacks (`fallbacks: "default"`, beta server-side-fallback-2026-07-01) on by default, COPILOT_FALLBACKS=off to disable; token and cost accounting per served model; `npm run ask`; `npm run eval:live` with --case, --repeat and a per-run token ceiling; missing key → clear message and exit code 3.
Files changed: src/copilot/{anthropic,cost}.ts, src/setup/model-config.ts, scripts/{ask,eval-live}.ts, test/live-model.test.ts, test/support/fake-anthropic.ts, test/fixtures/usage-response.json, README (setup notes for the Codespaces secret).
Decisions/defaults and reasons:
- Thinking parameter omitted (always on for Opus 5.5) and tool choice automatic (forced tool choice is rejected by Opus 5.5).
- Refusal fallbacks are enabled by default as a resilience default for the current Opus; the maintainer can turn them off.
- Prices (per million tokens, 2026-09): Opus 5.5 $4 in / $20 out / $0.20 cache read / $5 cache write; Sonnet 5.5 $2 / $10 / $0.20 / $2.50; Haiku 4.5 $1 / $5 / $0.10 / $1.25.
Checks run (exact command + outcome): `ANTHROPIC_API_KEY= npm run -s ask -- "hi"` → skip message, exit 3. Keyless tests against a local stand-in for the API: request shape (model, effort, cache breakpoints, auto tool choice, fallbacks, no thinking or sampling parameters), append-only history with the thinking block passed back verbatim, fallbacks off, API errors logged as type/status/request ID only; a canary key never appears in stdout, stderr or the transcript of `npm run ask` (success and 401 paths); missing key exit code for ask and eval:live; cost from a recorded usage fixture.
Evaluation results: L3 not run (no API key in this environment). Pass rate, tokens, cost and latency are therefore not measured.
Checks not run and why: L3 (`npm run eval:live`) — no ANTHROPIC_API_KEY. The maintainer adds the Codespaces secret and runs it once; the guardrail cases E16–E20 must pass, and the maintainer sets the pass threshold for the rest.
Known limitations/risks: tool descriptions and the system prompt are untested against the live model; expect one tuning round after the first L3 run. Cost estimates are from decision 001, not measured.
Questions requiring a business decision: the L3 pass threshold, after the first measured run.
Next proposed milestone: 10.
```

```text
Milestone: 10. Web interface
Implemented behavior: `npm run web`: a page on Node's built-in HTTP server, bound to 127.0.0.1, with an Ask tab (live mode: answer, limitations, sources with the tool results) and a tool console (always available, no key). `npm run web:snapshot`: a self-contained, script-free HTML page of the 20 answers and their tool results, from L2 by default or a saved L3 run; CI uploads it as the copilot-snapshot artifact (renamed biomix-copilot-snapshot.html, unzipped, after milestone 11 moved the workflow to upload-artifact v7).
Files changed: src/web/{server,snapshot}.ts, src/web/page.html, scripts/{web,eval-snapshot}.ts, test/web.test.ts, CI step, dev container port 3000.
Decisions/defaults and reasons: no framework (decision 001, section 6, decided on recommendation): one static page with inline CSS and JS, text-only DOM updates, a restrictive content security policy; one question at a time; 500-character questions and 16 KB bodies. No authentication, so the port must stay private (documented).
Checks run (exact command + outcome): `npm run web:snapshot` → "Snapshot (L2, 20 answers): .cache/web/biomix-copilot-snapshot.html" (95 KB); `PORT=3123 npm run web` with curl → /api/info keyless, /api/tool returned sales_totals, /api/ask → 503 keyless message, / served the page. Tests: modes, live answer through the loop, bad requests (400/413/415/404), no cross-origin resources, no innerHTML, snapshot escaping.
Evaluation results: none.
Checks not run and why: visual review in a browser (no browser in this environment); the live Ask path against the real API (no key).
Known limitations/risks: not designed for public hosting. Whether to publish the snapshot (for example as a release asset) is the maintainer's decision.
Questions requiring a business decision: whether and where to publish the snapshot for recruiters.
Next proposed milestone: 11 (verify and package): the README and demo script are drafted; the fresh-Codespace record, CI evidence, L3 and the final review remain.
```
