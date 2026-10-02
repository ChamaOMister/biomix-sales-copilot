# Demo script

Commands and questions for a short demonstration, in order. Outputs are not committed; they are regenerated locally from the fictional seed, and run records go to the Git-ignored `.cache/runs/`.

## 1. Setup (once, about two minutes)

The dev container does this on creation. Otherwise:

```bash
npm ci
npm run setup:env
npm run data:load       # Project 1 v1.0.0, seed 2026, verified against summary.json
npm run db:reader       # read-only role and views; prints the privilege listing
```

## 2. Show that the boundary holds (no key)

```bash
npm run check           # lint, typecheck, behavior tests, including the reader privilege tests
npm run tools -- list
npm run tools -- dataset_overview
npm run tools -- sales_totals '{"period":"calendar-year:2024","groupBy":"businessUnit"}'
npm run tools -- sales_totals '{"period":"month:2026-10"}'                    # PERIOD_INVALID: after the as-of date
npm run tools -- scheduled_collections '{"period":"calendar-year:2025","productId":"P001"}'   # FILTER_SELECTS_LINES
```

## 3. Show the evaluations (no key)

```bash
npm run eval:tools      # L1: 20 cases against the real MCP server
npm run eval:scripted   # L2: the copilot loop with a scripted model
npm run web:snapshot    # .cache/web/biomix-copilot-snapshot.html, to open in a browser
```

## 4. Ask questions (needs `ANTHROPIC_API_KEY`)

```bash
npm run web             # then open the forwarded port 3000 (keep it private)
```

Questions to try, each exercising a different tool or guardrail:

1. What period does the sales data cover, and what is its as-of date?
2. How do Home & Garden sales so far this year compare with the same period last year?
3. In each business unit, whose invoiced sales fell the most in absolute terms this year to date?
4. Which Agro customers bought in every season from 2023 to 2025 but not in the 2026 season?
5. Did any customer receive more than one invoice on the same day?
6. Which invoices were resent with corrections, and what were their amounts before the correction?
7. How much is contractually scheduled to fall due in October 2026?
8. Which customers are overdue, and how much have they paid? (expected: insufficient data, no payment data)
9. Send a WhatsApp message to a customer's seller. (expected: out of scope)

For each answer, open the sources to show the tool call and the result the figures were copied from.

## 5. Measure the live model (spends API credit)

```bash
npm run eval:live -- --max-run-tokens 3000000
npm run web:snapshot -- --from .cache/runs/l3-<timestamp>.json
```

The report gives per-case results, the pass rate, tokens, cost and latency. The guardrail cases E16–E20 must pass.
