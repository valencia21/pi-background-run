---
name: digest-config
description: Set up the pi-bgrun digest scorecard for this project. Use when the user asks to configure a digest, enable digest heuristics, or when a pi-bgrun nudge points at this skill. Samples the project's real job logs, picks a shipped preset (go-test, jest, pytest, junit-xml) or drafts a custom digest command, validates it against green AND red logs, then writes the digest section into .pi/pi-bgrun.json.
---

# Configure a project digest scorecard

Goal: a `digest` section in `<project>/.pi/pi-bgrun.json` whose command turns a
job log into a short pass/fail scorecard, appended to every background `job` wake as
`digest (<label>): ...`. The scorecard must be reliable on both green and red
logs — a wrong scorecard is worse than none. Most projects run more than one
kind of job (unit tests, a build, e2e); configure one entry per job type rather
than one command that guesses.

Config shapes — a single object (legacy) or an ordered **list** of entries; if
both `preset` and `command` are set within one entry, the preset wins:

```json
{ "digest": { "preset": "go-test" } }
```

```json
{ "digest": { "command": "grep -E 'FAIL|ok  ' \"$1\" | head -5" } }
```

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

Prefer a `type` on each entry: it is matched exactly (case-insensitive) against
the `type:` the agent passes to `job` action `run`, so it does not depend on job names or
command lines staying stable. When you configure a `type`, tell the agent to
pass it: `job(action: "run", command: …, name: …, type: "test")`. If a job's `type`/name
selects no entry, pi-bgrun logs a one-line diagnostic naming the job and the
configured types — check it when a scorecard is expected but absent.

Selection (exactly one entry, or none):

1. Entries with a `type` are checked **first**, in config order, and match only
   a job declaring that exact type that also satisfies the entry's `match` if
   it has one. First type match wins.
2. Otherwise the entries **without** a `type` are scanned in config order:
   `match.name` / `match.command` globs and no-`match` defaults.
3. No match → no digest.

- `type` and `match` compose (AND): with both present, only a job of that type
  that also satisfies the glob matches.
- `match.name` / `match.command` are **globs** tested against the job's
  `name` and command line; both present → both must match. They are
  **case-insensitive and whole-string** (`*` any run, `?` one character;
  write `*text*` for a substring; `\` escapes the next character).
- An entry with no `match` (or an empty `match`) matches every job — put it
  **last** as the default. Include one so jobs you did not anticipate still
  get a scorecard.
- `label` sets the wake tag; without it a type entry uses its `type` string, a
  glob entry uses the matched `match.name`, else the preset id (or `command`).
- An invalid `match` (non-string), an invalid `type`, or an entry with no valid
  `preset`/`command` is dropped silently; an empty/all-invalid list counts as
  unconfigured.

Shipped presets: `go-test` (package ok/FAIL counts + failing test names),
`jest` (Tests/Test Suites summary + failed test names), `pytest` (final
passed/failed/error summary line + FAILED test ids), `junit-xml`
(`<failure>`/`<error>` counts + failing testcase names). Each preset also
carries a `suggestedType` (all `test`) — use it as the `type` when scaffolding
an entry, e.g. `{ "type": "test", "preset": "go-test" }`. The suggestion is
advisory; a preset entry with no `type` still applies to every job.

## Procedure

1. **Find done-job logs.** Locate the project's jobsDir from the config
   layering: in a project root it defaults to `<project>/.pi-bgrun/jobs`;
   otherwise to the machine-global `~/.pi-bgrun/jobs`. An explicit `jobsDir`
   (any config layer) or `PI_BGRUN_DIR` overrides it; `PI_BGRUN_GLOBAL_DIR`
   retargets the machine-global base. The resolved path is printed as
   `log: <path>` by `job` action `run` and `job` action `status` — read it back there if
   unsure. List the `*.log` files of finished jobs.
2. **Sample the formats across job types.** Group the logs by job type using
   each job's `name` and command line (from `job` action `status`); most projects have at
   least a test job and a build job. Pick 2-3 logs per type — at least one
   green and one red run each — and inspect them with `ctx_execute_file`
   (context-mode sandbox, so only your printed summary enters context).
   Identify the runner / output format for each type, and name the type with a
   short token (`test`, `build`, `lint`, `e2e`).
3. **Try a preset first, per type.** Run each shipped preset's command against
   a sample log (`sh -c '<preset command>' sh <logpath>`). Preset commands are
   data in the package's `extension/digestPresets.ts`. Clean scorecard on green
   AND red samples → use that preset for that type, seeding the entry's
   `type` from the preset's `suggestedType` (all shipped presets suggest
   `test`). Repeat for each type.
4. **Draft custom commands** for types no preset fits. Use awk/sed/grep/jq; the
   command receives the log path as `$1` and MUST end in `head -N` so output is
   bounded. Keep it to a count line plus failed-item names.
5. **Validate each entry on green AND red.** Run every drafted command against
   every sample for its type. Each must produce a correct scorecard on both: no
   phantom failures on green logs, no missing failures on red ones. If a type
   has no reliable command, omit that entry (or leave the digest unconfigured)
   rather than shipping a wrong scorecard — say why.
6. **Write the config, one `type` entry per job type.** Merge the entries into
   `<project>/.pi/pi-bgrun.json`, preserving any existing keys, giving each
   entry the `type` you identified in step 2, and putting the no-`match`
   default entry **last**. Use `match.name` / `match.command` globs only for
   jobs that will not pass a `type`. Create the file if absent. Tell the user
   (or the agent driving `job`) which `type:` value to pass for each job.
7. **Smoke-test each entry.** Start a real `job` action `run` of each configured type
   (e.g. the test command AND the build command), passing the matching
   `type:`, and check that its wake carries a correct `digest (<label>):` block
   for the right entry. If a block is empty, wrong, or comes from the wrong
   entry, fix the command / type / ordering and repeat step 7.
