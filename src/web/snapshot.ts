/**
 * A self-contained HTML snapshot of copilot answers (from an L2 scripted run or an L3 live run),
 * for reading without deploying anything. Pure: every value is escaped; no script runs. The status
 * filters work with CSS alone (radio inputs and :has).
 */
import type { AnswerSegment } from "../copilot/answer.ts";
import { formatInteger } from "../shared/money.ts";

export interface SnapshotEntry {
  id: string;
  title: string;
  question: string;
  status: string;
  answer: string | null;
  /** The answer split into text and cited values; when present, each figure links to its source. */
  segments?: AnswerSegment[] | null;
  limitations: { code: string; description: string }[];
  toolCalls: { id: string; tool: string; input: unknown; isError: boolean; value: unknown; cited: boolean }[];
  /** The deterministic grading result, when the snapshot comes from a graded run. */
  passed?: boolean;
  durationMs?: number;
  costUsd?: string | null;
}

export interface SnapshotInput {
  level: "L2" | "L3";
  model: string;
  generatedAt: string;
  dataset: { asOf: string; repository: string; tag: string; commit: string; seed: number } | null;
  entries: SnapshotEntry[];
  /** Where the source code lives, linked from the page header. */
  codeUrl?: string;
  /** Run totals from an L3 report. */
  run?: { costUsd: string | null; medianLatencyMs: number | null };
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  answered: "Answered",
  insufficient_data: "Insufficient data",
  out_of_scope: "Out of scope",
  incomplete: "Incomplete",
  format_error: "Format error",
};
type Group = "answered" | "declined" | "problem";
const groupOf = (status: string): Group => (status === "answered" ? "answered" : status === "insufficient_data" || status === "out_of_scope" ? "declined" : "problem");

const STYLE = `
:root{color-scheme:light;--bg:#f5f7f4;--panel:#fff;--ink:#1e2c25;--muted:#66726a;--line:#e4e9e3;--green:#26734d;--green-soft:#e5f2e9;--amber:#8f5b00;--amber-soft:#fbf0d9;--red:#b03a2e;--red-soft:#fbe7e4;--code:#f4f6f3;--mark:#e9f4dc;--mark-line:#8fbd5a;--side:#173b2b;--shadow:0 8px 28px #23352a0d}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0f1411;--panel:#161d19;--ink:#e6ece7;--muted:#9aa79f;--line:#26302a;--green:#7cc79b;--green-soft:#1b3125;--amber:#e3b45c;--amber-soft:#352a14;--red:#f08b7d;--red-soft:#3a1d19;--code:#111714;--mark:#22361e;--mark-line:#76a946;--side:#0d241a;--shadow:none}}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:16px}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--green)}
.sidebar{position:fixed;inset:0 auto 0 0;width:264px;background:var(--side);color:#fff;padding:26px 16px;display:flex;flex-direction:column;gap:18px}
.brand{display:flex;align-items:center;gap:11px;padding:0 8px;font-weight:750;font-size:17px}
.brand-mark{height:34px;width:34px;border-radius:11px;background:#b6dc70;color:#173b2b;display:grid;place-items:center;font-size:19px}
.brand small{display:block;color:#9bb5a5;font-weight:450;font-size:11px}
.side-label{padding:0 10px;color:#9bb5a5;text-transform:uppercase;font-size:10px;letter-spacing:1.5px;font-weight:700}
.nav{display:grid;gap:2px;overflow:auto;margin:-8px -6px 0;padding:0 6px}
.nav a{display:grid;grid-template-columns:8px 30px minmax(0,1fr);align-items:center;gap:9px;padding:7px 10px;border-radius:9px;color:#c4d4ca;text-decoration:none;font-size:12px}
.nav a:hover,.nav a:focus-visible{background:#ffffff17;color:#fff}
.nav b{font-weight:650;color:#e9f1ec;font-variant-numeric:tabular-nums}.nav span:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dot{width:8px;height:8px;border-radius:50%;background:#7fae8f}.dot.fail{background:#f08b7d}.dot.declined{background:#e3b45c}
.side-note{margin-top:auto;padding:13px 12px;border:1px solid #ffffff1b;background:#ffffff0a;border-radius:12px;color:#b8cbbf;font-size:11px;line-height:1.5}.side-note b{display:block;color:#fff;font-size:12px;margin-bottom:4px}
main{margin-left:264px;padding:26px 36px 56px;max-width:1180px}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:26px}
.crumb{color:var(--muted);font-size:12px}.crumb b{color:var(--ink)}
.top-right{display:flex;align-items:center;gap:10px}
.tag{padding:7px 11px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--muted);font-size:12px;white-space:nowrap}
.button{padding:8px 13px;border-radius:9px;background:var(--green);color:#fff;text-decoration:none;font-weight:650;font-size:12px;white-space:nowrap}
@media (prefers-color-scheme:dark){.button{color:#0f1411}}
.eyebrow{color:var(--green);font-weight:750;text-transform:uppercase;letter-spacing:1.4px;font-size:10px}
h1{font-size:30px;line-height:1.2;margin:6px 0 8px;letter-spacing:-.8px}
.lead{color:var(--muted);margin:0;max-width:760px}
.card{background:var(--panel);border:1px solid var(--line);box-shadow:var(--shadow);border-radius:14px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:22px 0 14px}
.kpi{padding:16px 18px}.kpi-head{color:var(--muted);font-size:12px;font-weight:600}
.kpi-value{font-size:26px;font-weight:760;letter-spacing:-.7px;margin:8px 0 2px;font-variant-numeric:tabular-nums}.kpi-foot{font-size:11px;color:var(--muted)}
.guide{padding:16px 18px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;font-size:12px;color:var(--muted)}
.guide b{display:block;color:var(--ink);font-size:13px;margin-bottom:3px}
.chips{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:26px 0 14px}
.chips .label{font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.8px;margin-right:4px}
.chips input{position:absolute;opacity:0;pointer-events:none}
.chips label{padding:6px 12px;border:1px solid var(--line);border-radius:20px;background:var(--panel);cursor:pointer;font-size:12px;font-weight:600;color:var(--muted)}
.chips label span{font-variant-numeric:tabular-nums;margin-left:4px;opacity:.75}
.chips input:checked+label{background:var(--green);border-color:var(--green);color:#fff}
@media (prefers-color-scheme:dark){.chips input:checked+label{color:#0f1411}}
.chips input:focus-visible+label{outline:2px solid var(--green);outline-offset:2px}
body:has(#f-answered:checked) .case:not([data-group="answered"]),body:has(#f-declined:checked) .case:not([data-group="declined"]),body:has(#f-problem:checked) .case:not([data-group="problem"]),body:has(#f-failed:checked) .case:not([data-grade="fail"]){display:none}
.case{padding:20px 22px;margin-bottom:14px}
.case-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}
.case-id{font-size:11px;font-weight:750;color:var(--green);background:var(--green-soft);border-radius:7px;padding:3px 7px;font-variant-numeric:tabular-nums}
.case h2{font-size:16px;margin:0;letter-spacing:-.2px;flex:1 1 260px}
.pill{display:inline-flex;align-items:center;gap:5px;border-radius:20px;padding:3px 9px;font-size:11px;font-weight:650;white-space:nowrap}
.pill.answered{background:var(--green-soft);color:var(--green)}.pill.declined{background:var(--amber-soft);color:var(--amber)}.pill.problem{background:var(--red-soft);color:var(--red)}
.pill.pass{border:1px solid var(--green);color:var(--green)}.pill.fail{border:1px solid var(--red);color:var(--red)}
.question{margin:14px 0 0;padding:10px 14px;border-left:3px solid var(--mark-line);background:var(--code);border-radius:0 9px 9px 0;font-style:italic}
.answer{margin-top:14px;font-size:14.5px}.answer p{margin:0 0 10px}.answer ul{margin:0 0 10px;padding-left:20px}.answer li{margin:3px 0}
.cite{color:inherit;text-decoration:none;white-space:nowrap;background:var(--mark);border-bottom:1.5px solid var(--mark-line);border-radius:3px;padding:0 2px;font-variant-numeric:tabular-nums}
.cite:hover,.cite:focus-visible{background:var(--mark-line);color:#10200f}
.section-label{font-size:10px;text-transform:uppercase;letter-spacing:.9px;color:var(--muted);font-weight:700;margin:16px 0 6px}
.limits{margin:0;padding:10px 14px 10px 30px;background:var(--amber-soft);border-radius:9px;font-size:12.5px}.limits li{margin:2px 0}
.sources{border:1px solid var(--line);border-radius:10px;overflow:hidden}
.sources details{border-top:1px solid var(--line)}.sources details:first-child{border-top:0}
.sources details:target{outline:2px solid var(--mark-line);outline-offset:-2px}
.sources summary{cursor:pointer;padding:9px 12px;display:flex;flex-wrap:wrap;align-items:center;gap:6px 9px;font-size:12px}
.sources summary:hover{background:var(--code)}
.rid{font-weight:750;color:var(--green);font-variant-numeric:tabular-nums}.tool{font-weight:650}
.args{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);overflow-wrap:anywhere;flex:1 1 200px}
.small{font-size:10px;font-weight:650;border-radius:5px;padding:1px 6px;background:var(--code);color:var(--muted)}.small.err{background:var(--red-soft);color:var(--red)}
pre{margin:0;background:var(--code);border-top:1px solid var(--line);padding:12px;overflow:auto;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:360px}
.case-foot{margin-top:12px;font-size:11px;color:var(--muted)}
footer{padding:22px 2px;color:var(--muted);font-size:11px}
@media (max-width:1050px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.guide{grid-template-columns:1fr}}
@media (max-width:760px){.sidebar{position:static;width:auto;padding:14px 16px;gap:10px}.side-label,.side-note,.nav span:last-child{display:none}.nav{display:flex;overflow-x:auto;margin:0;padding:0 0 4px}.nav a{display:flex;gap:6px;padding:6px 9px}main{margin:0;padding:20px 16px 40px}.topbar{flex-wrap:wrap}.top-right{flex-wrap:wrap}.button{white-space:normal}h1{font-size:25px}.kpis{gap:9px}.kpi{padding:13px}.kpi-value{font-size:21px}.case{padding:16px}}
`;

const oneLine = (text: string) => text.replace(/\s+/g, " ");

function inlineAnswer(entry: SnapshotEntry): string {
  if (!entry.segments) return escapeHtml(entry.answer ?? "");
  return entry.segments
    .map((segment) =>
      "resultId" in segment
        ? `<a class="cite" href="#${escapeHtml(`${entry.id}-${segment.resultId}`)}" title="${escapeHtml(`From ${segment.resultId} (${segment.tool}): ${segment.path}`)}">${escapeHtml(oneLine(segment.text))}</a>`
        : escapeHtml(segment.text),
    )
    .join("");
}

/** Paragraphs from blank lines, bullet lists from lines starting with "- ". Input is escaped HTML. */
function blocks(html: string): string {
  return html
    .split(/\n\s*\n/)
    .map((block) => {
      let out = "";
      let list: string[] = [];
      let para: string[] = [];
      const flushList = () => {
        if (list.length) out += `<ul>${list.map((item) => `<li>${item}</li>`).join("")}</ul>`;
        list = [];
      };
      const flushPara = () => {
        if (para.length) out += `<p>${para.join("<br>")}</p>`;
        para = [];
      };
      for (const line of block.split("\n").filter((text) => text.trim() !== "")) {
        const item = /^\s*[-•*]\s+(.*)$/.exec(line);
        if (item) {
          flushPara();
          list.push(item[1]!);
        } else {
          flushList();
          para.push(line);
        }
      }
      flushPara();
      flushList();
      return out;
    })
    .join("");
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
/** "$0.8943" → "$0.89" for a headline figure; anything else unchanged. */
const cents = (usd: string) => (/^\$\d+\.\d{3,}$/.test(usd) ? `$${Number(usd.slice(1)).toFixed(2)}` : usd);

function entryHtml(entry: SnapshotEntry): string {
  const group = groupOf(entry.status);
  const grade =
    entry.passed === undefined ? "" : entry.passed ? `<span class="pill pass">✓ passed the checks</span>` : `<span class="pill fail">✗ failed the checks</span>`;
  const limitations = entry.limitations.length
    ? `<div class="section-label">Limitations stated</div><ul class="limits">${entry.limitations.map((item) => `<li>${escapeHtml(item.description)}</li>`).join("")}</ul>`
    : "";
  const calls = entry.toolCalls.length
    ? `<div class="section-label">Sources · ${formatInteger(entry.toolCalls.length)} read-only tool ${entry.toolCalls.length === 1 ? "call" : "calls"}</div><div class="sources">${entry.toolCalls
        .map(
          (call) =>
            `<details id="${escapeHtml(`${entry.id}-${call.id}`)}"><summary><span class="rid">${escapeHtml(call.id)}</span><span class="tool">${escapeHtml(call.tool)}</span><span class="args">${escapeHtml(JSON.stringify(call.input))}</span>${call.isError ? `<span class="small err">error</span>` : ""}<span class="small">${call.cited ? "cited" : "not cited"}</span></summary><pre>${escapeHtml(JSON.stringify(call.value, null, 2))}</pre></details>`,
        )
        .join("")}</div>`
    : `<div class="section-label">Sources</div><p class="case-foot">No tool was called.</p>`;
  const metrics = [
    entry.durationMs === undefined ? null : seconds(entry.durationMs),
    entry.costUsd ? `${escapeHtml(entry.costUsd)} in API usage` : null,
  ].filter((item) => item !== null);
  return `<article class="card case" id="${escapeHtml(entry.id)}" data-group="${group}"${entry.passed === undefined ? "" : ` data-grade="${entry.passed ? "pass" : "fail"}"`}>
<header class="case-head"><span class="case-id">${escapeHtml(entry.id)}</span><h2>${escapeHtml(entry.title)}</h2><span class="pill ${group}">${escapeHtml(STATUS_LABELS[entry.status] ?? entry.status)}</span>${grade}</header>
<p class="question">${escapeHtml(entry.question)}</p>
${entry.answer === null ? "" : `<div class="answer">${blocks(inlineAnswer(entry))}</div>`}
${limitations}${calls}${metrics.length ? `<div class="case-foot">${metrics.join(" · ")}</div>` : ""}</article>`;
}

/** "anthropic:claude-opus-5-5:medium" → "claude-opus-5-5, effort medium". */
function modelLabel(model: string): string {
  const parts = /^[a-z]+:([^:]+):([a-z]+)$/.exec(model);
  return parts ? `${parts[1]}, effort ${parts[2]}` : model;
}

export function renderSnapshot(input: SnapshotInput): string {
  const entries = input.entries;
  const graded = entries.filter((entry) => entry.passed !== undefined);
  const passedCount = graded.filter((entry) => entry.passed).length;
  const failedCount = graded.length - passedCount;
  const count = (group: Group) => entries.filter((entry) => groupOf(entry.status) === group).length;
  const toolCalls = entries.reduce((sum, entry) => sum + entry.toolCalls.length, 0);
  const how =
    input.level === "L2"
      ? "Answers come from a scripted model (evaluation level L2): it replays a fixed tool plan and a fixed answer written with placeholders, so every figure below was filled in from the real tool results. It shows the tools, validation and rendering, not a live model's choices."
      : `Answers come from the live model ${escapeHtml(modelLabel(input.model))} (evaluation level L3), one attempt per question.`;
  const grading = graded.length
    ? ` ${formatInteger(passedCount)} of ${formatInteger(graded.length)} answers passed the deterministic checks against the evaluation answer key.`
    : "";
  const dataset = input.dataset
    ? `Data as of ${escapeHtml(input.dataset.asOf)}, generated by Project 1 ${escapeHtml(input.dataset.tag)} (commit ${escapeHtml(input.dataset.commit.slice(0, 12))}, seed ${input.dataset.seed}).`
    : "";
  const code = input.codeUrl ? `<a class="button" href="${escapeHtml(input.codeUrl)}">Source code, tests and evaluations ↗</a>` : "";

  const kpis = [
    graded.length
      ? { head: "Passed the checks", value: `${formatInteger(passedCount)} / ${formatInteger(graded.length)}`, foot: "graded against the evaluation answer key" }
      : { head: "Questions", value: formatInteger(entries.length), foot: "investigation questions" },
    { head: "Tool calls", value: formatInteger(toolCalls), foot: "read-only MCP tools over Postgres" },
    { head: "Declined", value: formatInteger(count("declined")), foot: "out of scope, or not answerable from the data" },
    input.run?.costUsd
      ? { head: "Run cost", value: cents(input.run.costUsd), foot: `${modelLabel(input.model)}${input.run.medianLatencyMs === null ? "" : ` · median ${seconds(input.run.medianLatencyMs)}`}` }
      : { head: "Model", value: input.level === "L2" ? "Scripted" : "Live", foot: input.level === "L2" ? "no API calls (evaluation level L2)" : modelLabel(input.model) },
  ];

  const chip = (id: string, label: string, n: number, checked = false) =>
    `<input type="radio" name="filter" id="f-${id}"${checked ? " checked" : ""}><label for="f-${id}">${label}<span>${formatInteger(n)}</span></label>`;
  const chips = [
    chip("all", "All", entries.length, true),
    count("answered") ? chip("answered", "Answered", count("answered")) : "",
    count("declined") ? chip("declined", "Declined", count("declined")) : "",
    count("problem") ? chip("problem", "Incomplete or format error", count("problem")) : "",
    failedCount ? chip("failed", "Failed the checks", failedCount) : "",
  ].join("");

  const nav = entries
    .map((entry) => {
      const dot = entry.passed === false ? "fail" : groupOf(entry.status) === "declined" ? "declined" : "";
      return `<a href="#${escapeHtml(entry.id)}"><span class="dot ${dot}"></span><b>${escapeHtml(entry.id)}</b><span>${escapeHtml(entry.title)}</span></a>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Answers from a sales investigation copilot, with the read-only tool results behind every figure. Synthetic data.">
<title>Biomix Sales Copilot</title><style>${STYLE}</style></head>
<body>
<aside class="sidebar">
<div class="brand"><span class="brand-mark">✳</span><div>biomix copilot<small>sales investigation</small></div></div>
<div class="side-label">Questions</div>
<nav class="nav" aria-label="Questions">${nav}</nav>
<div class="side-note"><b>Synthetic data</b>${input.dataset ? `As of ${escapeHtml(input.dataset.asOf)}. ` : ""}A fictional company generated by a seeded generator. Scheduled installments are contractual amounts, not payments.</div>
</aside>
<main>
<div class="topbar"><div class="crumb">Portfolio&nbsp; / &nbsp;Project 2&nbsp; / &nbsp;<b>Answer snapshot</b></div><div class="top-right">${input.dataset ? `<span class="tag">Data as of ${escapeHtml(input.dataset.asOf)}</span>` : ""}${code}</div></div>
<section><div class="eyebrow">Answer snapshot · evaluation level ${input.level}</div>
<h1>Sales investigation copilot</h1>
<p class="lead">A copilot that answers questions about invoiced sales and scheduled collections by calling a fixed set of read-only tools, and cites the tool result behind every figure. SQL and TypeScript do the arithmetic; the language model never does.</p></section>
<section class="kpis" aria-label="Summary">${kpis.map((kpi) => `<article class="card kpi"><div class="kpi-head">${escapeHtml(kpi.head)}</div><div class="kpi-value">${escapeHtml(kpi.value)}</div><div class="kpi-foot">${escapeHtml(kpi.foot)}</div></article>`).join("")}</section>
<section class="card guide" aria-label="How to read this page">
<div><b>Highlighted figures come from tools</b>Code copied each one from a tool result; the model only chose which field to cite. Hover a figure to see the field, or select it to jump to the source.</div>
<div><b>Every answer is checked</b>${graded.length ? "Each answer was graded deterministically against the evaluation answer key, which the copilot never sees." : "Answers are validated before display: a figure that does not come from a tool result is rejected."}</div>
<div><b>Declining is a correct answer</b>Questions about payments, dates after the data, messaging or the answer key are declined or answered with the stated limits.</div>
</section>
<div class="chips" role="group" aria-label="Filter answers"><span class="label">Show</span>${chips}</div>
${entries.map(entryHtml).join("\n")}
<footer>${how}${grading} ${dataset} Generated ${escapeHtml(input.generatedAt)}. All data is synthetic and fictional.</footer>
</main>
</body></html>
`;
}
