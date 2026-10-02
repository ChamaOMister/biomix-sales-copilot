# biomix-sales-copilot

**Status: planning done, awaiting milestone 1.** No application code yet. The plan is in [decision 001](docs/decision-001-project-2.md) and [the milestones](docs/milestones.md).

A sales investigation copilot. It answers questions about invoiced sales and scheduled collections by calling a fixed set of read-only tools, served by an MCP server over a Postgres database. It cites the tool results behind every figure. SQL and TypeScript do all the arithmetic; the language model never does. The copilot never writes data, contacts third parties or sends messages.

**All data is fictional and synthetic.** It comes from the seeded generator of Project 1, [biomix-use-cases](https://github.com/ChamaOMister/biomix-use-cases) v1.0.0, and is regenerated locally. No dataset is committed. Scheduled collections are contractual installments, not payments; the data has no actual payments.

This is Project 2 of a portfolio. Project 1 cleaned and reported the sales data; Project 3, an n8n follow-up agent, is a separate repository and out of scope here.

Development proceeds in reviewed milestones. The maintainer owns business decisions and acceptance; Claude Code assists with implementation, and Codex with review.
