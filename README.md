# biomix-sales-copilot

A sales investigation copilot. It answers questions about invoiced sales and scheduled collections by calling a fixed set of read-only tools, served by an MCP server over Postgres, and it cites the tool result behind every figure. SQL and TypeScript do all the arithmetic; the language model never does. The copilot never writes data, contacts third parties or sends messages.

**[See the live demo answers](https://chamaomister.github.io/biomix-sales-copilot/)**: twenty investigation questions answered by Claude Opus 5.5, each with the tool calls and results behind every figure, and each graded against the evaluation answer key (latest run: 20 of 20 passed).

**All data is fictional and synthetic.** It comes from the seeded generator of Project 1, [biomix-use-cases](https://github.com/ChamaOMister/biomix-use-cases) v1.0.0, and is regenerated locally. No dataset is committed. Scheduled collections are contractual installments, not payments; the data has no actual payments.

This is Project 2 of a portfolio. Project 1 cleaned and reported the sales data; Project 3, an n8n follow-up agent, is a separate repository and out of scope here. The design is in [decision 001](docs/decision-001-project-2.md), and the work is split into [milestones](docs/milestones.md).

```text
question ──► copilot loop (TypeScript) ──► Claude (Messages API), given the tool definitions
                 │  ▲
       tool call │  │ result rN (structured JSON)
                 ▼  │
            MCP client ──stdio──► MCP server ──► Postgres (copilot_reader role, read-only views)

final answer (JSON with {{rN.path}} placeholders) ──► validation ──► rendered answer + sources
```

## Quick start (GitHub Codespaces)

1. Create a Codespace on this repository. The dev container (Node 24.21.0, Postgres 17, 2 CPUs and 8 GB) runs `npm ci`, `npm run setup:env`, `npm run data:load` and `npm run db:reader`. If a step fails, rerun it; each is safe to repeat.
2. Run the checks: `npm run check`, `npm run eval:tools` and `npm run eval:scripted`. None needs an API key.
3. Look at real tool results without a key: `npm run tools -- sales_totals '{"period":"calendar-year:2025","groupBy":"businessUnit"}'`.
4. To ask questions in plain English, add an Anthropic API key (below), then run `npm run ask -- "How do Agro sales so far this year compare with the same period last year?"` or `npm run web`.

Outside Codespaces, use the same dev container in VS Code, or provide Node 24.21.0 and a Postgres 17 database, then set `DATABASE_URL` (see `.env.example`) and run the same commands.

## Commands

| Command | What it does | Needs |
| --- | --- | --- |
| `npm run setup:env` | Writes a random `copilot_reader` password to the Git-ignored `.env.local`, once; never prints it | — |
| `npm run data:load` | Clones Project 1 v1.0.0 into `.cache/project-1/`, verifies the pinned commit, generates seed 2026 and loads it with Project 1's own migrations and ingestion, then verifies it against `summary.json`. A rerun changes nothing | `DATABASE_URL` |
| `npm run data:reset -- --yes` | Deletes the loaded dataset and loads it again | `DATABASE_URL` |
| `npm run db:reader` | Creates or updates the read-only role and the `copilot` views, then runs the reader self-check | `DATABASE_URL`, `.env.local` |
| `npm run tools -- list` / `-- <tool> '<json>'` | Keyless tool console: starts the MCP server over stdio and prints one real result | reader |
| `npm run ask -- "<question>"` | Asks the copilot one question with the live model | API key |
| `npm run web` | Local web page at `http://127.0.0.1:3000`: questions (live mode) and the tool console (always) | reader; key for questions |
| `npm run web:snapshot` | Writes a self-contained HTML page of answers to `.cache/web/` (L2 by default, or `-- --from <L3 run>`) | reader |
| `npm run eval:tools` | L1: each evaluation case's reference tool plan against the real MCP server | reader |
| `npm run eval:scripted` | L2: the full copilot loop with a scripted model | reader |
| `npm run eval:live` | L3: the full copilot with the live model, graded deterministically. Spends API credit | API key |
| `npm run check` | Lint, typecheck and behavior tests | database |

Run records, transcripts and reports go to the Git-ignored `.cache/runs/`.

## The tools

The MCP server exposes a fixed list of read-only tools: no free-form SQL, file, write, messaging or web tool. Every result carries the dataset's as-of date (2026-09-25 for seed 2026), the source commit and seed, fixed note codes, and truncation information. Money comes as integer cents plus a formatted `R$ 1,234.56` string; percentages as integer basis points plus a formatted string.

| Tool | Answers |
| --- | --- |
| `dataset_overview` | What data exists and as of when |
| `find_entities` | Customer, product or seller IDs from a name |
| `sales_totals` | Invoiced sales, grouped by month, year, unit, seller, customer, product, schedule or segment |
| `compare_periods` | Change between two periods, such as year to date against the same dates last year |
| `customer_activity` | One customer's purchases per month or year, with gaps shown |
| `recurring_window_gaps` | Customers who missed a season or promotion window they used to buy in |
| `same_day_invoices` | Several invoices to one customer on one day |
| `invoice_details` | Invoices with lines and scheduled installments |
| `resent_invoices` | Invoices replaced by a corrected version in a later delivery |
| `scheduled_collections` | Project 1's collections view: installments of the invoices billed in a period |
| `installments_due` | Contractual installments falling due in a period |

## Safety boundaries

- **Read-only by privilege.** The MCP server connects as `copilot_reader`, which can only `SELECT` the views in schema `copilot`; tests show every write and DDL form fails, even after switching off read-only mode. The server refuses to start unless a self-check confirms this.
- **Numbers come from tools.** The model's final answer is JSON with placeholders such as `{{r2.totals.salesBrl}}`. Validation rejects unresolved placeholders, digits outside placeholders and spelled-out quantities; one retry is allowed, then the status is `format_error`. Every answer lists its sources.
- **Bounded.** At most 8 tool calls, 10 model requests and a token ceiling per question; going over ends with status `incomplete`, never a guessed answer.
- **The answer key stays in `evals/`.** The MCP server and the copilot never import it; tests check the import graph, the server's environment and every tool output.
- **No payment data.** Scheduled installments are never described as paid, received, outstanding or overdue.

## Evaluations

Twenty cases (E01–E20) run at three levels, with expected values computed at run time from Project 1's answer key and an independent TypeScript recomputation, never committed as literals:

- **L1** (CI): each case's reference tool calls return the expected values.
- **L2** (CI): the copilot loop with a scripted model passes the same deterministic grading as L3.
- **L3** (on demand): the live model answers each question. The guardrail cases E16–E20 (payments, dates after the as-of date, product collections, messaging, the answer key) must pass every run, and at least 85% of the other fifteen must pass in a full run (at most two misses); otherwise `npm run eval:live` exits with code 1 and nothing is published.

## API key and cost

The live model is Anthropic's `claude-opus-5-5` at effort `medium` by default (`COPILOT_MODEL`, `COPILOT_EFFORT`; `claude-sonnet-5-5` and `claude-haiku-4-5` are cheaper options). Server-side refusal fallbacks are on by default; set `COPILOT_FALLBACKS=off` to turn them off.

- Store the key as a Codespaces secret named `ANTHROPIC_API_KEY`, as a user secret with access to this repository only. Outside Codespaces, export it or put it in `.env.local`. Never commit it.
- Use a key dedicated to this project in an Anthropic Console workspace with a monthly spend limit. API usage is billed separately from any Claude subscription.
- Only the model client receives the key; the MCP server's environment excludes it, logs record error types and request IDs only, and a test checks that a canary key never reaches output or run files.
- Measured cost with Opus 5.5 at effort `medium`: about $0.89 for a full L3 run of 20 questions (two runs on 2026-10-02), so about $0.02–0.13 per question; prompt caching serves most input tokens. Decision 001 estimated $4–6. `npm run eval:live` stops at `--max-run-tokens` (default 3,000,000) and reports measured tokens and cost.

Without a key, `npm run ask` and `npm run eval:live` exit with code 3 and say so; everything else works.

## Web interface

`npm run web` serves a single page from Node's built-in HTTP server (no framework) on `127.0.0.1:3000`. It has no authentication: keep the Codespaces port **private**, because a public port would let anyone spend the API key. For readers who should not need to deploy anything, `npm run web:snapshot` writes a self-contained HTML page of questions, answers and the tool results behind them; CI attaches it to each run as the `biomix-copilot-snapshot.html` artifact.

## Publishing the demo

The public demo is the answer snapshot of a live (L3) run, served by GitHub Pages. The manual **Publish demo** workflow (Actions → Publish demo → Run workflow) loads the data, runs `npm run eval:live` with the `ANTHROPIC_API_KEY` Actions secret, renders the snapshot with each answer's grading result and deploys it. A guardrail failure, a pass rate below the threshold or a missing key deploys nothing, and nothing generated is committed. Each run spends API credit (about $0.90 measured).

One-time setup: add `ANTHROPIC_API_KEY` under Settings → Secrets and variables → Actions, and set Settings → Pages → Source to "GitHub Actions".

## Limits

- The data is one fictional company, seed 2026, as of 2026-09-25. Questions about later dates get `insufficient_data`.
- No actual payments exist, so nothing about overdue or received amounts can be answered.
- Corrected invoices keep only their latest version; earlier amounts are not stored.
- A purchasing gap is a fact about invoices, not evidence of churn or its cause.
- The digit and word checks on answers are best effort, not proof that the model did no arithmetic.
- The web interface is for local use; there is no production hosting or authentication.

## Layout

```text
.devcontainer/      Node 24.21.0 and Postgres 17
data-source.json    Project 1 pin: repository, tag, commit, seed
db/reader.sql       read-only role and views
scripts/            entry points for the npm commands
src/shared/         dates, periods, windows, money and basis points (pure)
src/data-source/    pinned checkout, load and verification
src/db/             pools, the reader connection and its self-check
src/mcp/            MCP server and tools: no file system, no network except the database
src/mcp-client/     starts the MCP server over stdio with an environment allowlist
src/copilot/        loop, model clients, prompt, validation and rendering: no file system, no database
src/web/            local web server, page and snapshot renderer
evals/              cases, answer-key loader, recomputation reference, graders: the only reader of the answer key
test/               behavior tests (Vitest)
.cache/             Git-ignored: Project 1 checkout, generated data, run records
```
