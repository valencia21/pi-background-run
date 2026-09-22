# pi-background-run

Run genuinely asynchronous shell commands as detached background jobs so your pi
agent session stays unblocked and its context stays clean. Output lands on disk —
the full log plus a trailing exit marker — so nothing large enters the conversation;
the command returns immediately. Each job chooses whether completion wakes the
live agent always, only on failure, or never. Human toast and widget updates remain
enabled for every policy.

Built as a [pi](https://github.com/earendil-works/pi-coding-agent) extension. No
shell runner and no external daemon — the extension spawns the job in-process,
detects completion via the child `exit` event, and conditionally calls
`pi.sendUserMessage` when the job's wake policy requests a model turn. The log
file is self-describing (full output + a trailing
`__BGRUN_EXIT__=N` marker), so exit codes survive pi restarting. Two small pieces
exist beyond the spawn: a 30s timer that only re-checks jobs whose live child handle
is gone (reconstructed from a restart, or adopted from another session), and a
`.last-clean` marker that throttles the **global** orphan sweep (the
session-scoped sweep is unthrottled).

## Install

```bash
pi install npm:pi-background-run
```

The scoped alias `@stablekernel/pi-background-run` is the same package (permanent
namespace claim, published in lockstep). Prefer the unscoped name; the alias is
not deprecated, so both stay installable and receive every release.

Restart pi after install so the extension loads.

## Tools registered

| Tool | Purpose |
| ------ | --------- |
| `job` | Unified compact interface with `run`, `status`, `tail`, `grep`, `cancel`, and `clean` actions. This is the recommended normal prompt surface. Cancellation sends SIGTERM to the detached process group and suppresses a completion wake. |
| `bgrun` | Compatibility tool for launching a detached command. Optional `name` gives the job a short human-readable label. `wake` selects `never`, `failure`, or `always` model-turn delivery. Returns `started: <job-id>` immediately. |
| `bgstatus` | Show job status. With an id: any job's state + exit code. Without: this session's running jobs (finished jobs hidden by default — pass `includeDone: true` or set `showCompletedJobs`). Other sessions' *running* jobs are listed only when `adoptForeignJobs` is enabled; finished foreign logs from the shared dir can also appear when finished jobs are included. |
| `bgtail` | Read the newest lines of a job's log (default 40; it reads the log's **last 2 MB** — widen with `bytes`, max 64 MiB), **condensed for context**: ANSI escapes stripped, repeated lines collapsed, long lines and total size capped. First read = full last-N tail; repeat reads return **only lines appended since your last read** (delta tailing) — polling a running job never re-pays for lines already seen. Pass `raw: true` for the unprocessed last-N window (still advances the bookmark). |
| `bggrep` | Regex search over the **last 2 MB** of a job's log (`bytes` widens the window, max 64 MiB): line-numbered matches, optional `context` lines, each line pre-truncated to 10 000 chars before matching, results capped (~50 matches, ~8KB) and condensed. Resolves the job id to the configured jobs dir itself — no log path to reconstruct. `ctx_execute_file` can read the same file (it takes an absolute path; only your Read-deny rules apply), but it needs that path. Matching runs under a wall-clock budget ([Bounded matching](#bounded-matching)). With no `pattern`, a generic failure-signature default is used (override it — convenience, not guarantee). |
| `bgclean` | Remove old job logs. **Default scope: this session's jobs only** — other sessions' logs are untouched — and it also drops stale per-project digest markers (`.bgrun-used-*`, `.digest-nudge-*`) in the session's jobs dir (markers are not session data). Pass `all: true` to sweep every shared jobs dir — under the project-local default that is the project's dir plus the machine-global one, while an explicit absolute `jobsDir` is swept alone — and do the same marker sweep across them. Retention: `cleanupDays` config (7 days); `days` must be a positive number (`days: 0` is rejected rather than purging everything). Never removes a running job's log. |

The five `bg*` tools remain registered so saved transcripts and existing integrations keep working. A dynamic tool manager can hide them and expose only `job` without losing compatibility.

## Completion wake policy

Every job accepts `wake: "never" | "failure" | "always"`:

- `never` keeps model context quiet; completion still updates the toast/widget and persists status/logs.
- `failure` wakes only for a non-zero exit or spawn failure.
- `always` preserves the original behavior and wakes on every completion.

Omitting `wake` uses `defaultWake` from layered configuration (`PI_BGRUN_WAKE`
overrides it). The package default remains `always` for backward compatibility;
users who want opt-in model turns can set `"defaultWake": "never"`. Per-job
policy is persisted in transcript entries and displayed by `job(action: "status")`
(or compatibility tool `bgstatus`) after a session reload.

Use `always` for deployment/eval monitors whose completion requires immediate
follow-up, `failure` for long checks whose successful completion needs no model
turn, and `never` for independent work. Foreground execution remains the default
for routine focused commands; do not choose background execution from command
category alone.

## Slash commands

Human-facing mirrors of the read/clean tools, usable directly in the TUI
without asking the agent (registered via `pi.registerCommand` — a separate
registration from the agent tools above, which is why tools alone never show
up as `/` commands):

| Command | Purpose |
| --- | --- |
| `/bgstatus [id] [done]` | One job's status by id, or the session listing (`done`/`all` includes finished jobs). |
| `/bgtail <id> [lines]` | Tail a job's log (condensed, same as the tool). |
| `/bgclean [days] [all]` | Remove old logs — session-scoped by default; `all` sweeps every session's. |

`/bgrun` is deliberately not a command — starting jobs (and reacting to their
wake messages) is the agent's workflow.

## Roadmap / not provided

- Deprecated: the machine-global jobs dir (`PI_BGRUN_GLOBAL_DIR`, `~/.pi-bgrun/jobs`) — see [deprecation](#deprecated-machine-global-jobs-dir). Supported until a future major.
- A separate `bgkill` tool is not provided; use `job(action: "cancel", id: "<job-id>")`.
- `bgwait` is not implemented; the wake mechanism makes blocking on a job unnecessary in the normal flow.

## How it works

```text
agent calls job(action: "run", command: "gh run watch …", name: "deploy-monitor", wake: "always")
  → extension resolves log path: <jobsDir>/<slug>-<ts>-<pid>.log (default <project>/.pi-bgrun/jobs/ in a repo, else ~/.pi-bgrun/jobs/)
  → spawn('sh', ['-c', <wrapper>, 'bgrun', '<cmd>'],
          { stdio: ['ignore', logFd, logFd], detached: true }).unref()
       <wrapper> = the output-ceiling pipeline (see "Log size ceiling"), or the
       uncapped one-liner 'sh -c "$1"; ec=$?; printf "\\n__BGRUN_EXIT__=%d\\n" "$ec"; exit "$ec"'
       when the ceiling is disabled (maxLogBytes: 0)
  → records job in-memory + appends a bgrun-job entry to the session
  → returns "started: <job-id>"

child 'exit' event fires:
  → extension records exit code, appends a done entry
  → when the per-job wake policy matches the outcome, pi.sendUserMessage(wake)
     triggers a turn when idle or queues a follow-up when busy
  → ctx.ui.notify(...)  — toast for the human, regardless of wake policy
  → ctx.ui.setWidget("bgrun", ...)  — updates/clears the live status widget
```

The child writes the log directly via its own stdout fd (no pipe to pi), so the job
survives pi crashing and the log completes on disk. The trailing
`__BGRUN_EXIT__=N` marker makes the log self-describing — `bgstatus` recovers the
exit code even after a restart.

## Reading results without flooding context

Two-tier read model — the log file itself stays on disk, capped (see
[log size ceiling](#log-size-ceiling)), for deep analysis; only bounded digests
ever enter the conversation:

- **Quick peek:** `bgtail <id>` — condensed newest lines (ANSI stripped, repeats
  collapsed, ~2KB/line and ~8KB caps). The first read is the last-40-lines tail; each later
  read returns only what was appended since, so repeated polling is nearly
  free. The wake message itself already carries the exit code and the log's
  last line, so many turns need no follow-up read at all.
- **Pattern search:** `bggrep <id> [pattern] [context]` — line-numbered matches,
  capped and condensed (~50 matches, ~2KB/line, ~8KB); takes the job id, so
  there is no log path to reconstruct. Searches the **last 2 MB** by default —
  pass `bytes` to widen (max 64 MiB), or use `ctx_execute_file` on the path for
  whole-file code-based analysis. Pass your own pattern when you know the log's
  format. A **wider window costs latency and memory, not context**: the returned
  matches stay capped either way.
- **Whole-log analysis:** `ctx_execute_file` on the job's log path (reachable
  when logs are project-local) to extract only failure lines. Never `cat` or
  `Read` a full bgrun log. The sandbox keeps the file's bytes out of context —
  only your script's **stdout** enters it — so print aggregates and capped
  slices (`fails.slice(0, 40)`), never the content. With a 64 MiB-ceiling log,
  an unsliced `console.log(FILE_CONTENT)` is the one way this path becomes the
  dump it exists to avoid; use `bgtail`/`bggrep` first, and this third.

**Why `bggrep` instead of `bash grep` on the log?** A bash grep's output is
uncapped — a retry-storm log can dump thousands of matching lines straight
into context, and safety depends on remembering `| head` on every call.
`bggrep` is bounded by design (last 2 MB of the log by default — `bytes` widens
it, max 64 MiB — per-line 10 000-char pre-truncation before matching, ~50
matches, ~8KB), takes the job id instead of
a reconstructed log path (no shell-quoting of the regex), resolves the job id to the
configured jobs dir itself (no path to reconstruct), and reports match counts,
line numbers, and skip markers. Plain `grep` is fine only for a one-off search you know is tiny.

### Bounded matching

`bggrep` takes a **caller-supplied regex**, and a pathological one (for example
`(a+)+$`) can backtrack exponentially. V8 has no regex step limit and cannot
interrupt a regex running on the main thread, so the match loop runs in a
worker with a wall-clock budget (default `2000ms`, override with
`PI_BGRUN_GREP_TIMEOUT_MS`). If the budget is exceeded the worker is terminated
and `bggrep` returns an error — **a runaway pattern fails, it never hangs the
session.** Normal patterns and logs finish far inside the budget; worker
startup adds a few tens of milliseconds per call.

### Log size ceiling

stdout+stderr used to go straight to the log file with no write bound, so a
runaway job (`yes`, a spew loop, a pathological build) could fill the disk and
take the machine down. Job logs are now capped (`maxLogBytes` / `PI_BGRUN_MAX_LOG_BYTES`,
default **64 MiB**, `0` = unlimited):

- The cap keeps the **first** N bytes. There is no portable in-tree way to keep
  the tail — a ring buffer needs a helper binary, and rewriting the file breaks
  the readers that depend on the exit marker staying last. A job past 64 MiB is
  almost always a runaway, so the head is the useful part.
- The ceiling lives **inside the detached process tree**, so it still holds
  after pi exits or crashes — it is not a pi-side watchdog.
- The job is **not** killed, and its real exit code is preserved: bytes past the
  cap are drained and discarded instead of SIGPIPE'ing the producer into `141`.
- It is **not silent**. The log carries
  `__BGRUN_TRUNC__ output truncated: kept the first <N> bytes` on the line
  before the exit marker, and the marker line itself carries the flag
  (`__BGRUN_EXIT__=0 truncated=67108864`). Both are reserved `__BGRUN_*__` lines
  that content readers filter exactly like the exit marker, and readers classify
  the notice by that **marker flag**, never by matching text — a command that
  echoes a notice-shaped line cannot make its own log look capped, and cannot
  get its own output discounted as wrapper bookkeeping either. If the ceiling
  could not be installed at all (`mkfifo` unavailable, so the job ran uncapped)
  the log says that too — `__BGRUN_NOCAP__ log ceiling unavailable`, with
  `nocap=1` in the marker — so "uncapped" is never indistinguishable from
  "output was that small". Every surface the agent reads is labelled: the wake's
  Stats line gains `log truncated at 64 MiB`,
  `bgtail` and `bggrep` append a note and report `truncatedAtBytes` in their
  details, and a configured digest scorecard is **skipped** rather than run
  against a log that lost its end — summaries and failure lists live at the end,
  so its numbers would be confidently wrong. Treat a skipped digest on a capped
  job as "unknown", not "no failures".
- Reading a capped log stays readable-whole: the widest `bytes` window is the
  ceiling **plus 4 KiB** (not the ceiling itself, which a capped log always
  exceeds by its notices and marker), so `bytes: 67108864` still spans the whole
  kept log. Windows are additionally limited to their last 500 000 lines —
  materializing a 64 MiB window of one-character lines would cost gigabytes of
  strings — and when that line bound trims a window, `bgtail`/`bggrep` say so in
  the same labelled way instead of silently answering from a subset.
- Maintainer rationale — why a fifo, why the *first* bytes, which alternatives
  were measured and rejected: [`docs/log-size-ceiling.md`](docs/log-size-ceiling.md).
- Cost: a capped job runs through one copier process (`perl` where available,
  else `dd`/`head`) reading the job through a fifo, plus a bounded drain wait —
  a few tens of milliseconds of job startup, no steady-state overhead. The
  copier is also what drains the stream past the cap, so the producer is never
  SIGPIPE'd.
- Configure `maxLogBytes: 0` for the previous uncapped behavior, e.g. when the
  whole log must survive for `ctx_execute_file`.

## Configuration

The jobs dir defaults to `<project>/.pi-bgrun/jobs` when the session cwd is
inside a recognizable project root (`.git` or `.pi`, found by walking up from
the cwd); otherwise it falls back to `~/.pi-bgrun/jobs`. **Warning:** a
`jobsDir` (or a `PI_BGRUN_GLOBAL_DIR` target) equal to your home directory is
dangerous — cleanup removes matching `*.log` files directly there. The home
directory itself is never treated as a project root — pi's global `~/.pi/agent`
dir would otherwise make every cwd under `$HOME` resolve to `$HOME` (a symlinked
is still recognized). Override via `jobsDir` / `PI_BGRUN_DIR`. Within a project,
the dir is shared by every pi session working in that checkout — that sharing
enables cross-session job lookup, session-restart reconstruction, and
per-project cleanup. By default each session only *tracks its own jobs*: the
widget and `bgstatus` listings show this session's running jobs, and finished
jobs are hidden (ask for them explicitly with `bgstatus includeDone: true`).
Jobs started by other sessions can still be inspected by id, but they don't
clutter your widget.

Configuration is layered (later wins): **defaults ← user config file ← project
config file (trusted projects only) ← environment variables**.

- User: `~/.pi/agent/pi-bgrun.json`
- Project: `<project>/.pi/pi-bgrun.json`

The project file is per-contributor state, not shared policy: it is read only for
a trusted project, it changes what every `bgrun` job in that checkout does, and a
digest entry runs a shell command at wake time. This repo therefore gitignores
its own; [`docs/dogfooding.md`](docs/dogfooding.md) has the setup its maintainers
run locally (completed jobs visible, a scorecard on `bun test` runs).

```json
{
  "adoptForeignJobs": false,
  "showCompletedJobs": false,
  "defaultWake": "always",
  "cleanupDays": 7,
  "maxLogBytes": 67108864,
  "globalAutoClean": true,
  "jobsDir": "/some/other/dir"
}
```

### Project-local logs (default in repos)

Inside a recognizable project root, job logs land at `<project>/.pi-bgrun/jobs`
by default. The root is found by walking up from the session cwd, so a session
started in a subdirectory still resolves project-locally. An explicit
**relative** `jobsDir` (from any config layer, or `PI_BGRUN_DIR`) still
resolves against the project root — e.g. `"jobsDir": "var/bgrun-logs"` writes
to `<project>/var/bgrun-logs`.

Benefits:

- Logs sit inside the project sandbox, so project-confined analysis tools
  (e.g. context-mode's `ctx_execute_file` / `ctx_index`) can process whole logs
  without pulling raw bytes into the context window.
- Each checkout/worktree gets its own logs — no cross-project clutter in a
  machine-global dir.
- The dir is auto-added to the repo's `.git/info/exclude` (local-only — the
  tracked `.gitignore` is never touched), so logs never pollute `git status`.
  This happens on the first `bgrun`; at session start it also happens for
  **trusted** projects only, so merely opening pi in an untrusted repo neither
  edits `.git/info/exclude` nor creates the dir. Works in linked worktrees too
  (writes to the common git dir, resolved via the worktree's `commondir` file).

**Upgrading from a pre-project-local version:** in a repo the default jobs dir
is now `<project>/.pi-bgrun/jobs`, not `~/.pi-bgrun/jobs`. Keep the old
behavior with an absolute `jobsDir`/`PI_BGRUN_DIR`. Old global logs aren't
moved, but under the project-local default the orphan sweep and `bgclean all`
still reach them — both cover your project's dir **and** the machine-global
one. An explicit absolute `jobsDir` is swept alone, exactly as before. Jobs are
no longer discoverable across projects through a single shared dir — unless you
opt into a shared absolute `jobsDir`.

Rules and migration notes:

- Absolute `jobsDir` values behave exactly as in older versions: used as-is,
  never treated as project-local, and swept alone (the orphan sweep and
  `bgclean all` do not also touch `~/.pi-bgrun/jobs`). Set
  `"jobsDir": "~/.pi-bgrun/jobs"` (or any absolute path) to keep using the
  machine-global dir inside a repo.
- If the cwd has no `.git`/`.pi` at or above it, the default falls back to
  `~/.pi-bgrun/jobs`; a relative override also falls back to the global dir
  rather than scattering logs across arbitrary directories.
- Tools resolve a job's log from the session's job record first, so jobs
  started before a config change stay readable after it.
- Existing logs in the old global dir are not migrated (they're ephemeral,
  `cleanupDays`-retained). They are still reclaimed automatically: the orphan
  sweep and `bgclean all` both cover `~/.pi-bgrun/jobs` in addition to the
  current project's dir.

### Deprecated: machine-global jobs dir

**Project-scoped logs are the model.** A single shared `~/.pi-bgrun/jobs` was
the old default; it is now **deprecated** and is no longer what any of the docs
lead with. Retirement is staged — nothing breaks today:

- `PI_BGRUN_GLOBAL_DIR` and the `~/.pi-bgrun/jobs` **default are deprecated**;
  they will be removed in a future major.
- **Supported for now:** an existing absolute `jobsDir` / `PI_BGRUN_DIR` keeps
  working exactly as before, and a cwd with no project root still falls back to
  `~/.pi-bgrun/jobs` (there is nowhere project-scoped to put it, and the
  alternative — scattering logs into an arbitrary cwd — is worse).

Why project-scoped won:

- **Each checkout owns its logs** — no cross-project clutter, no ambiguous
  `bgstatus` scope, and `bgclean` can't reach into another project's runs.
- **Reachable by project-sandboxed analysis** (`ctx_execute_file`,
  `ctx_index`): logs live inside the workspace, so whole-log analysis no longer
  needs a path outside it.
- **Disposable with the workspace** — delete the checkout, lose its logs.

What changes for you, if you set a global dir on purpose:

1. Drop the absolute `jobsDir` / `PI_BGRUN_DIR` from your config to get
   `<project>/.pi-bgrun/jobs`.
2. Planned sharing across projects is what you lose: jobs started in one
   checkout are no longer visible to a session in another, and
   `adoptForeignJobs` only adopts within the same jobs dir. If you need that,
   keep the absolute dir — it is supported, merely no longer the recommended
   default — and say so upstream if it is load-bearing for you.
3. Old logs in `~/.pi-bgrun/jobs` keep being swept (the orphan sweep and
   `bgclean all` cover both dirs under the project-local default). Delete the
   dir by hand once its logs are past retention.

Environment variables (same knobs, handy for one-off overrides):

| Variable | Default | Description |
| --- | --- | --- |
| `PI_BGRUN_DIR` | `<project>/.pi-bgrun/jobs` in repos; else `~/.pi-bgrun/jobs` | Override where job logs are stored. An absolute path is used as-is; a **relative** path resolves against the project root (see [project-local logs](#project-local-logs-default-in-repos)), falling back to `~/.pi-bgrun/jobs` when there is no project root. |
| `PI_BGRUN_GLOBAL_DIR` | `~/.pi-bgrun/jobs` | **Deprecated.** Overrides the machine-global jobs base — the fallback used only when the cwd has no project root (see [deprecation](#deprecated-machine-global-jobs-dir)). A leading `~` or `~/` is expanded to the home dir; `~user` is not. |
| `PI_BGRUN_FOREIGN_JOBS` | `false` | Adopt other sessions' running jobs into this session's widget and job list. Adopted jobs are polled so they leave the widget when they finish. |
| `PI_BGRUN_SHOW_COMPLETED` | `false` | Include finished jobs in `bgstatus` listings by default. |
| `PI_BGRUN_WAKE` | `always` | Default model-turn completion policy when a job omits `wake`: `never`, `failure`, or `always`. Per-job `wake` takes precedence. Toast/widget updates are unaffected. |
| `PI_BGRUN_CLEANUP_DAYS` | `7` | Log retention for cleanup sweeps and the `bgclean` default. |
| `PI_BGRUN_MAX_LOG_BYTES` | `67108864` (64 MiB) | Byte ceiling for a job's log (stdout+stderr). `0` disables it (unlimited). See [Log size ceiling](#log-size-ceiling). |
| `PI_BGRUN_GLOBAL_AUTO_CLEAN` | `true` | Set `0`/`false` to disable the automatic orphan sweep (see below). |
| `PI_BGRUN_GREP_TIMEOUT_MS` | `2000` | Wall-clock budget for a `bggrep` match. A caller-supplied regex that exceeds it is aborted (its worker terminated) and reported as an error instead of hanging — see [Bounded matching](#bounded-matching). |
| `PI_BGRUN_USER_CONFIG` | `~/.pi/agent/pi-bgrun.json` | Override the user-level config file path (see [Configuration](#configuration)). |

### Digest scorecard (opt-in)

When a job's wake policy requests a model turn, its message leads with universal
facts — exit code, duration, and the command's own log line count (the internal
exit marker is excluded). A project can additionally opt into a **digest
scorecard**: a one-line pass/fail summary extracted from the log and appended
to that wake.

#### Job identity: name, type, command

Every `bgrun` job carries three identifiers, and the digest selector reads all
three:

| Field | Required | Normalized | Drives |
| --- | --- | --- | --- |
| `command` | yes | used as-is (`sh -c`) | what runs; the `match.command` target |
| `name` | no | trimmed, blank → none, ≤80 chars | display label + job-id/log slug; the `match.name` target |
| `type` | no | trimmed, lowercased, blank → none, ≤40 chars | digest routing only; the first-class selector |

`name` names the job (and its log file); `type` never affects the id or the
widget, but is echoed in `bgstatus <id>` and `bgrun`'s `started:` line — its
main job is selecting the scorecard. Selection tries `type`
entries first (exact, case-insensitive), then falls back to `match.name` /
`match.command` globs. The config `type` is capped to the same 40 characters
as the job `type`, so an over-long type still matches.

#### Setting it up

Three ways, easiest first — pick the first one you're comfortable with:

1. **Ask your agent (recommended).** Say: *"Set up the pi-bgrun digest for
   this project."* The `digest-config` skill ships with this package and does
   the whole job: it samples your project's real job logs, tries the shipped
   presets against them, drafts a custom command if none fits, validates the
   result on both a green and a red log, and writes the config. It sees your
   actual output format, which is exactly what a good digest depends on —
   and you never have to read a log yourself. The one-shot toast some
   projects see on session start ("no digest configured") — once per project
   that has run a bgrun job — is pointing at this same skill.
2. **One-line preset if you know your stack.** Create
   `<project>/.pi/pi-bgrun.json` (or merge into an existing one):

   ```json
   { "digest": { "preset": "go-test" } }
   ```

   | Preset | What it summarizes | Suggested `type` |
   | --- | --- | --- |
   | `go-test` | Go test output: package ok/FAIL counts + failing test names | `test` |
   | `jest` | Jest output: Tests/Test Suites summary + failed test names | `test` |
   | `pytest` | pytest output: final passed/failed/error summary line + FAILED test ids | `test` |
   | `junit-xml` | JUnit XML: `<failure>`/`<error>` counts + failing testcase names | `test` |

   All shipped presets are test runners, so they all suggest the conventional
   type `test`. The suggestion is documentation, not behavior: you still write
   the `type` on the entry yourself, and a preset entry with no `type` applies
   to every job as before.

3. **Custom command.** For formats the presets don't cover:

   ```json
   { "digest": { "command": "grep -E 'FAIL|ok  ' \"$1\" | head -5" } }
   ```

   The command receives the job's log path as `$1` and its stdout is appended
   to the wake. Worked example — a log containing:

   ```text
   PASS src/auth.test.ts (2.1s)
   FAIL src/api.test.ts
   Tests: 12 passed, 1 failed, 13 total
   ```

   plus the command `grep -E '^(PASS|FAIL|Tests:)' "$1" | head -5`, wakes with:

   ```text
   digest (command): FAIL src/api.test.ts
   Tests: 12 passed, 1 failed, 13 total
   ```

   Rules of thumb: quote `"$1"`, end the pipeline in `head -N` so output is
   bounded, and — this is the important one — **check the command against a
   green and a red log before committing to it**. A scorecard that says "all
   passing" on a failing log is worse than no scorecard. The `digest-config`
   skill does this validation for you; if you'd rather hand-tune a command
   yourself, you can also ask your agent to validate a specific command
   against specific job logs.

#### Multiple scorecards (one per job type)

`digest` can also be an ordered **list** of scorecards. Give each a `type` and
pass the matching `type:` when you start the job — the most reliable selector,
because it does not depend on the agent naming every job consistently:

```json
{
  "digest": [
    { "type": "test",  "preset": "go-test" },
    { "type": "build", "label": "build",
      "command": "grep -E '^error' \"$1\" | head -5" },
    { "match": { "command": "*cargo*" }, "label": "cargo", "preset": "go-test" },
    { "preset": "go-test" }
  ]
}
```

Start jobs with the matching type:

```text
bgrun(command: "go test ./...", name: "unit-tests", type: "test")
```

`type` is an optional `bgrun` parameter. The vocabulary is defined by the
`type` fields of the project's digest config in `.pi/pi-bgrun.json`; when the
project's digest config defines types, prefer passing the matching one. If a
job's `type` (or name/command) selects no entry, pi-bgrun logs a one-line
diagnostic naming the job and the configured types — so a mismatched type is
visible instead of silently scorecard-less.

Selection order (exactly one entry, or none):

1. **Type entries first.** An entry declaring a `type` matches ONLY a job that
declared that same type — exact and case-insensitive (`"test"` matches
`"Test"`) — and must ALSO satisfy the entry's `match` if it has one. All type
entries are checked first, in config order, regardless of where they sit
relative to match entries. First type match wins.
2. **Match/default fallback.** If no type entry matched — including when the
job has no type — the entries *without* a `type` are scanned in config order:
`match.name` / `match.command` globs and no-`match` defaults, first match
wins. Put a no-`match` default **last** so jobs you didn't anticipate still get
a scorecard.
3. No match → no digest.

- `type` and `match` compose (AND): with both present the entry matches only a
  job of that type that also satisfies the glob. Use `match` alone for jobs
  that won't pass a `type`.
- `match.name` and `match.command` are **globs** tested against the job's
  `name` and command line. Both present → both must match. Matching is
  **case-insensitive and whole-string** — `*` matches any run, `?` exactly one
  character, everything else is literal, and `\` escapes the next character
  (`\*` is a literal star) — so `"*unit*"` matches `"unit-tests-run3"` while a
  bare `"unit-tests"` matches only exactly that.
- `label` sets the wake tag: `digest (<label>): …`. Precedence: `label` →
  (type entry) the type string → (matched glob entry) `match.name` → the
  entry's preset id (else `command`). So a bare `{ "preset": "go-test" }`
  wakes as `digest (go-test):`.
- First match wins; exactly one digest block is appended per wake.

The legacy single-object form still works unchanged — `{ "digest": { "preset":
"go-test" } }` is a one-entry list with no matchers.

Opt in per project via `<project>/.pi/pi-bgrun.json` (read only for trusted
projects). If both `preset` and `command` are set within one entry, the preset
wins. An empty list (or one where every entry is invalid) counts as *not
configured*.

#### Guarantees

- **Exit code always leads.** The digest is appended after the universal
  stats, labeled `digest (<label>):` — `label` follows the precedence above
  (entry `label` → type string → `match.name` → preset id / `command`). It
  never overrides or reorders the exit code, duration, or line count.
- **Capped and timed.** Digest output is capped at ~500 chars, and buffering
  stops once that cap is reached — a command that prints unbounded output
  cannot balloon the wake. The digest command gets a 5s timeout plus a 250ms
  SIGTERM→SIGKILL grace (≈5.25s worst case), during which the wake waits.
- **Silent-fail.** A digest command that errors, times out, or prints nothing
  simply contributes nothing — it never breaks a wake.
- **No config, no behavior.** Absent or invalid config contributes nothing;
  without a `digest` section the wake is unchanged.

A configured wake reads like this:

```text
✅ Background job "tests" `abc123` finished (exit 1).
Command: go test ./...
Stats: 42.3s, 1204 lines
Last output: FAIL example.com/api/handlers
digest (go-test): 7 ok / 1 FAIL: TestResolveNotFound
Review the result now: call `bgtail` ...
```

Shell safety: the command comes from trust-gated config and runs with your
own privileges — the same trust boundary as the `jobsDir` setting.

A user-level default digest works too: set `digest` in
`~/.pi/agent/pi-bgrun.json` (path overridable via `PI_BGRUN_USER_CONFIG`), and
any project without its own digest inherits it. The project `digest` section
overrides the user-level one **wholesale** (no per-key merge).

### Log cleanup

Cleanup follows the same principle as everything else: **one session should
not delete another session's artifacts.**

- **Session-scoped auto-sweep (default)** runs at `session_start` and
  `session_shutdown` and removes only *this session's* finished logs older
  than `cleanupDays`. Cheap and unthrottled.
- **Orphan sweep (default on; opt out with `globalAutoClean: false` /
  `PI_BGRUN_GLOBAL_AUTO_CLEAN=0`)** — also sweeps every shared jobs dir at
  session boundaries — the machine-global `~/.pi-bgrun/jobs` plus the current
  project's dir — removing *finished* logs (exit marker, or dead pid) older
  than `cleanupDays`. This is what keeps orphans from sessions that
  crashed or will never be resumed from accumulating: a week-old finished log
  is garbage under the same retention its owning session would apply itself.
  Under the project-local default it covers the current project's dir plus the
  machine-global one; an explicit absolute `jobsDir` is swept alone. Throttled
  to once per `cleanupDays` via a `.last-clean` marker so restart-heavy
  workflows don't re-sweep on every launch. Running jobs are pid-protected, so
  live sessions are never affected.
- **Manual**: `bgclean` cleans this session's old logs; `bgclean` with
  `all: true` sweeps every session's logs across the shared dirs immediately
  (and refreshes the markers).

- Running jobs are never swept while their pid is alive.

**The jobs dir is only *auto*-swept when it is recognizably ours.** `bgrun`
writes a `.bgrun-jobs` ownership marker into the dir on first use; the
automatic global sweep refuses to delete `*.log` files in a dir without it, so
a stray `PI_BGRUN_DIR` (or a config pointing at an unrelated directory) can't
be quietly emptied a week later. Manual `bgclean all` is an explicit
instruction, so it bypasses the gate and always works.

The dir also carries small bookkeeping files. The digest markers
(`.bgrun-used-*`, `.digest-nudge-*`) and stale `.tmp-*.log` staging files are
swept at `cleanupDays`; `.bgrun-jobs` and `.last-clean` persist until removed
by hand:

| File | Purpose |
| --- | --- |
| `.bgrun-jobs` | Ownership marker — gates the *automatic* global sweep. |
| `.last-clean` | Throttles the global sweep to once per `cleanupDays`. |
| `.bgrun-used-<hash>` | Per-project evidence that bgrun has run here (digest nudge). |
| `.digest-nudge-<hash>` | Per-project: the one-shot digest nudge was already shown. |

## Releasing

Version numbers and the changelog are derived from commit messages via
[release-please](https://github.com/googleapis/release-please), so the prefix on a
squash-merged PR title is load-bearing:

| Prefix | Release |
| --- | --- |
| `fix:` / `feat:` / `deps:` | yes — patch / minor / patch |
| `feat!:` / `fix!:` / `BREAKING CHANGE:` | yes — minor (pre-1.0) |
| `refactor:` `docs:` `test:` `ci:` `build:` `chore:` `style:` | no |
| no prefix, e.g. `Address review findings (#11)` | no |

An unprefixed commit is ignored outright: no changelog entry, and it cannot trigger
a release on its own. `pr-title.yml` enforces the format on every PR
(`bun run lint:pr-title` locally).

**PRs are squash-merged, and that is structural rather than stylistic:** the squash
collapses the PR to a single commit whose subject is the *title*, which is the
message release-please parses. That is why the title — not the branch commits — is
what CI validates, and why work-in-progress commit messages never surface. Rebase
and merge-commit methods would put branch subjects on `main` and break that mapping,
so repository settings must disable both ([`docs/releasing.md`](docs/releasing.md)
lists the exact toggles).

Every merge to `main` updates a single open **Release PR** holding the `package.json`
bump and `CHANGELOG.md` entry. Nothing is published until that PR is merged —
ordinary merges only update it.

Process, the required repository settings, and the two manual steps per release:
[`docs/releasing.md`](docs/releasing.md).

## Status

Early / pre-release.
