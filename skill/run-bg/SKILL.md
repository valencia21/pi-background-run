---
name: run-bg
description: Use for genuinely asynchronous shell work such as deployment or CI monitoring,
  long evals, sustained observability, or commands that must continue while the agent does
  other work. Choose whether completion wakes the model; do not use merely because a command
  is a test, build, lint, query, or external request.
---

# Run in Background (pi-bgrun)

Run genuinely asynchronous commands detached through the unified `job` tool. Output goes
to a bounded log while the session stays unblocked. Human toast/widget updates always
happen; `wake` controls whether completion also injects a model turn. Never poll through
model turns.

## When to use

- Deployment, CI, or merge-queue monitoring that must trigger follow-up work.
- Long evals, sustained observability, installs, or integration suites that must run while other work continues.
- Independent long-running work whose output should stay on disk.

## When not to use

- Do not select `job` merely because a command is a test, build, lint, database query, or external request.
- Default to foreground `bash` for routine and focused checks. Reassess after a fast or fail-fast result.
- For verbose but quick commands, redirect raw output to a file and print a bounded summary.
- Interactive commands (prompts, REPL, SSH): background jobs detach from the terminal.

## Operations

| Action | Call |
|---|---|
| Start | `job(action: "run", command: "gh run watch …", name: "deploy-monitor", wake: "always")` |
| Status | `job(action: "status", id: "<job-id>")`; omit `id` to list this session; use `includeDone: true` for completed jobs |
| Tail | `job(action: "tail", id: "<job-id>", lines: 40)` — first read returns the tail; repeats return only appended lines |
| Grep | `job(action: "grep", id: "<job-id>", pattern: "failure", context: 2)` — bounded, line-numbered matches |
| Cancel | `job(action: "cancel", id: "<job-id>")` — sends SIGTERM to the detached process group and suppresses a completion wake |
| Clean | `job(action: "clean", days: 7)`; add `all: true` to include every session |

The legacy `bgrun`, `bgstatus`, `bgtail`, `bggrep`, and `bgclean` names remain registered
for old transcripts, but normal sessions expose only `job`.

## Workflow

1. **Start** with a short `name` and intentional wake policy:
   - `wake: "always"` when continuation depends on completion;
   - `wake: "failure"` when success needs no model turn;
   - `wake: "never"` for independent work.
   When the project's digest config defines `type` entries, pass the matching `type`.
   For a domain workflow with structured state, optionally pass `kind`, `runId`,
   `statePath`, and `summaryPath`; these affect status presentation only. Use
   `kind: "maos.eval"` for MAOS eval workers. Unknown kinds stay generic.
   Record the returned id and continue other work.
2. **On wake**, trust the exit status first. A configured `digest (<label>):` block is a
   short project-specific scorecard and often answers what failed.
3. **Inspect only when needed**:
   - use `action: "status"` for state;
   - use `action: "tail"` for a positional peek;
   - use `action: "grep"` with an explicit pattern for targeted evidence.
4. **Cancel explicitly** with `action: "cancel"`; never reconstruct the pid and hand-roll
   a kill command.

## Reading results without flooding context

- `tail` strips ANSI and wrapper markers, collapses repeats, truncates long lines, and caps
  total returned output. Repeat reads use delta tailing.
- `grep` searches the last 2 MiB by default, pre-truncates each line, caps matches/output,
  and runs caller regexes under a wall-clock budget. Increase `bytes` only when needed.
- Never `cat`, `Read`, `bash cat`, or `bash grep` a full job log. Prefer `tail`, then
  `grep`. For a whole project-local log, use a sandboxed file-analysis tool that prints
  only bounded aggregates—not raw content.
- A log that hit `maxLogBytes` keeps its first bytes and reports truncation. Missing tail
  output and digest results are then unknown; do not interpret them as success.

## Restart and scope

- A detached process and its log survive Pi restart, but its live wake handler does not.
  Recover state with `job(action: "status", id: "<job-id>")`.
- Each session tracks its own jobs by default. `adoptForeignJobs` can surface running jobs
  from other sessions; `includeDone: true` can list finished logs.
- Logs default to `<project>/.pi-bgrun/jobs` and are excluded through `.git/info/exclude`.
  The machine-global `~/.pi-bgrun/jobs` path is a deprecated fallback outside projects.
- Cleanup is session-scoped unless `all: true`; running jobs are never removed.

## Rules

- Call `job`; never hand-roll `nohup … &`.
- One run produces one id and one bounded log.
- Give every run a recognizable `name`.
- Choose `wake` deliberately.
- Continue useful work after launch; do not poll through turns.
- Treat logs as sensitive and return only the evidence required for the task.
