/**
 * pi-bgrun — Phase 0 spike smoke tests.
 *
 * These don't require a real pi runtime. We extract the core logic by importing
 * the module's internals via a test harness that fakes the ExtensionAPI:
 *   - fakePi.sendUserMessage captures wake messages
 *   - fakeCtx.isIdle() simulates the agent's idle state (true by default —
 *     bgrun returns immediately so by the time the child exits the agent has
 *     finished its turn)
 *   - we drive a real child_process.spawn through the bgrun tool's execute()
 *   - assert exit handling, log marker, bgtail, bgstatus
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  DIGEST_PRESETS,
  DIGEST_PRESET_IDS,
  digestNoMatchWarning,
  entryMatchesJob,
  resolveDigest,
  selectDigestEntry,
} from "./digestPresets.ts";
import {
  DIGEST_NUDGE_TEXT,
  digestNudgeMarkerPath,
  jobUsageMarkerPath,
} from "./index.ts";
import type {
  EntryRenderer,
  ExtensionAPI,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

function markJobsDir(dir: string): void {
  writeFileSync(join(dir, ".bgrun-jobs"), "");
}

// All test temp files live under one per-run root so cleanup and git hygiene
// stay trivial — nothing is written into the repo or the real $HOME.
const TEST_TMP_ROOT = mkdtempSync(join(tmpdir(), "pi-bgrun-tests-"));
const mkTmp = (prefix: string) => mkdtempSync(join(TEST_TMP_ROOT, prefix));
// node:test's `after` runs under both node and bun, unlike process.on("exit"),
// which bun's test runner never fires — that leak left a pi-bgrun-tests-*
// dir behind on every bun run.
after(() => {
  try {
    rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// Isolate the machine-global jobs dir for the whole file so tests never read
// from or delete the real ~/.pi-bgrun/jobs. A fake HOME is enough: the extension
// resolves home through its own HOME-first homeDir(), because Bun's
// os.homedir() ignores $HOME. PI_BGRUN_GLOBAL_DIR is left unset so a stray real
// one cannot point tests out of the sandbox.
// The extension resolves home HOME-first (Bun's os.homedir() ignores $HOME), so
// assertions must use the same rule production does — otherwise a suite that
// pins HOME compares against the developer's real home.
const homeDir = () => process.env.HOME || homedir();
const TEST_FAKE_HOME = mkTmp("pi-bgrun-home-");
process.env.HOME = TEST_FAKE_HOME;
delete process.env.PI_BGRUN_GLOBAL_DIR;
const TEST_GLOBAL_JOBS_DIR = join(TEST_FAKE_HOME, ".pi-bgrun", "jobs");

// Isolate the user config too: a real ~/.pi/agent/pi-bgrun.json could carry
// adoptForeignJobs / digest / globalAutoClean settings that change results.
// Tests that need their own user config override this and restore it here.
const TEST_USER_CONFIG = join(TEST_TMP_ROOT, "no-user-config.json");
process.env.PI_BGRUN_USER_CONFIG = TEST_USER_CONFIG;

// Drop every artifact a test created in the machine-global dir without
// unsetting the env var (globalJobsDir() resolves it per call). Keeps
// `.last-clean` and stray logs from leaking across tests.
function resetGlobalJobsDir(): void {
  rmSync(TEST_GLOBAL_JOBS_DIR, { recursive: true, force: true });
  mkdirSync(TEST_GLOBAL_JOBS_DIR, { recursive: true });
}

interface CapturedWake {
  text: string;
  options?: Record<string, unknown>;
}

interface CapturedEntry {
  type: string;
  customType?: string;
  data?: Record<string, any>;
}

// The slice of ExtensionAPI the extension under test actually calls. Typing the
// fake against these REAL signatures means a host-API change (e.g.
// registerCommand's options shape, or an event rename) fails tsc here instead of
// silently passing because the fake was `any`.
type UsedExtensionAPI = Pick<
  ExtensionAPI,
  | "on"
  | "registerTool"
  | "registerCommand"
  | "registerEntryRenderer"
  | "sendUserMessage"
  | "appendEntry"
>;

// Tools as the tests consume them: real metadata types from ToolDefinition, but
// a loose result shape so assertions can read `.content[0].text` without having
// to narrow the TextContent | ImageContent union at ~90 call sites.
type FakeTool = Pick<
  ToolDefinition<any, any, any>,
  "name" | "label" | "description" | "parameters" | "promptSnippet"
> & {
  execute(
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: FakeContext,
  ): Promise<{
    content: { type: string; text: string }[];
    details: any;
    isError?: boolean;
  }>;
};

interface FakeUIContext {
  notify(text: string, kind?: string): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, lines: string[] | undefined): void;
}

interface FakeContext {
  isIdle(): boolean;
  hasUI: boolean;
  ui: FakeUIContext;
  sessionManager: { getEntries(): CapturedEntry[] };
  [key: string]: unknown;
}

interface FakeCommand {
  description?: string;
  handler: (args: string, ctx: FakeContext) => Promise<void> | void;
}

type FakeHandler = (event: any, ctx: FakeContext) => Promise<any> | any;

type FakeRenderer = (
  entry: { data?: Record<string, any> },
  opts: { expanded?: boolean },
  theme: unknown,
) => unknown;

interface FakePiHandles {
  pi: ExtensionAPI;
  wakes: CapturedWake[];
  entries: CapturedEntry[];
  tools: Map<string, FakeTool>;
  commands: Map<string, FakeCommand>;
  entryRenderers: Map<string, FakeRenderer>;
  ctx: FakeContext;
  handlers: Map<string, FakeHandler[]>;
  fireSessionStart: () => Promise<void>;
  fireSessionShutdown: () => Promise<void>;
}

function makeFakePi(
  opts: {
    idle?: boolean;
    priorEntries?: CapturedEntry[];
    ctxFields?: Record<string, unknown>;
  } = {},
): FakePiHandles {
  const wakes: CapturedWake[] = [];
  const entries: CapturedEntry[] = opts.priorEntries
    ? [...opts.priorEntries]
    : [];
  const tools = new Map<string, FakeTool>();
  const commands = new Map<string, FakeCommand>();
  const entryRenderers = new Map<string, FakeRenderer>();
  const handlers = new Map<string, FakeHandler[]>();
  const idle = opts.idle ?? true;
  const ctx = {
    isIdle: () => idle,
    hasUI: false,
    ui: { notify() {}, setWidget() {}, setStatus() {} },
    sessionManager: { getEntries: () => entries },
    ...(opts.ctxFields as Record<string, unknown> | undefined),
  } as unknown as FakeContext;

  // Typed against the real ExtensionAPI members the extension uses — the
  // compile-time drift guard. `as ExtensionAPI` below is the unavoidable seam
  // (the fake is deliberately partial); the *shapes* here are the real ones.
  const used: UsedExtensionAPI = {
    sendUserMessage(content, options) {
      wakes.push({
        text: content as string,
        options: options as Record<string, unknown> | undefined,
      });
    },
    appendEntry(customType, data) {
      entries.push({
        type: "custom",
        customType,
        data: data as Record<string, any> | undefined,
      });
    },
    registerEntryRenderer(customType: string, renderer: EntryRenderer<any>) {
      entryRenderers.set(customType, renderer as unknown as FakeRenderer);
    },
    registerTool(def) {
      tools.set(def.name, def as unknown as FakeTool);
    },
    registerCommand(name, options) {
      commands.set(name, options as unknown as FakeCommand);
    },
    on(event: string, handler: unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler as FakeHandler);
      handlers.set(event, list);
    },
  };
  const pi = used as ExtensionAPI;

  const fireSessionStart = async () => {
    const event = { reason: "startup" } as unknown as SessionStartEvent;
    for (const h of handlers.get("session_start") ?? []) {
      await h(event, ctx);
    }
  };
  const fireSessionShutdown = async () => {
    const event = { reason: "shutdown" } as unknown as SessionShutdownEvent;
    for (const h of handlers.get("session_shutdown") ?? []) {
      await h(event, ctx);
    }
  };
  return {
    pi,
    wakes,
    entries,
    tools,
    commands,
    entryRenderers,
    ctx,
    handlers,
    fireSessionStart,
    fireSessionShutdown,
  };
}

async function loadExtension(fakePi: ExtensionAPI): Promise<void> {
  const url = pathToFileURL(join(process.cwd(), "extension/index.ts")).href;
  const mod = await import(url);
  mod.default(fakePi);
}

async function loadModule(): Promise<any> {
  const url = pathToFileURL(join(process.cwd(), "extension/index.ts")).href;
  return await import(url);
}

async function withEnv<T>(
  name: string,
  value: string | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

async function withJobsDir<T>(
  fn: (dir: string, h: ReturnType<typeof makeFakePi>) => Promise<T> | T,
  opts?: Parameters<typeof makeFakePi>[0],
): Promise<T> {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  try {
    const h = makeFakePi(opts);
    await loadExtension(h.pi);
    return await fn(dir, h);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}

// Default below Bun's 5s test timeout so a stuck wait rejects with a clear
// message instead of racing the harness kill (a flake-masking failure mode).
function waitForLogExit(
  logPath: string,
  timeoutMs = 4000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (readFileSync(logPath, "utf8").includes("__BGRUN_EXIT__="))
          return resolve();
      } catch {
        // The child may not have created/renamed the final log yet.
      }
      if (Date.now() - start > timeoutMs)
        return reject(new Error(`timed out waiting for ${logPath} to finish`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function waitForWakes(
  wakes: CapturedWake[],
  count: number,
  // Under bun's 5s per-test timeout so this fires first with a clearer error,
  // but above the ~55ms these tests normally take, leaving CI-load headroom.
  timeoutMs = 4000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (wakes.length >= count) return resolve();
      if (Date.now() - start > timeoutMs)
        return reject(
          new Error(
            `timed out waiting for ${count} wakes, got ${wakes.length}`,
          ),
        );
      setTimeout(tick, 50);
    };
    tick();
  });
}

test("job: unified tool dispatches run, status, tail, and grep", async () => {
  await withJobsDir(async (_dir, { tools, ctx }) => {
    const job = tools.get("job")!;
    assert.ok(job, "unified job tool is registered");
    for (const legacy of ["bgrun", "bgtail", "bggrep", "bgstatus", "bgclean"]) {
      assert.ok(tools.has(legacy), `${legacy} remains registered for compatibility`);
    }

    const started = await job.execute(
      "job-run",
      { action: "run", command: "printf 'needle\\n'", wake: "never" },
      undefined,
      undefined,
      ctx,
    );
    const id = started.details.id as string;
    assert.ok(id);
    await waitForLogExit(started.details.logPath);

    const status = await job.execute(
      "job-status",
      { action: "status", id },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(status.details.state, "done");
    assert.equal(status.details.exitCode, 0);

    const tail = await job.execute(
      "job-tail",
      { action: "tail", id },
      undefined,
      undefined,
      ctx,
    );
    assert.match(tail.content[0].text, /needle/);

    const grep = await job.execute(
      "job-grep",
      { action: "grep", id, pattern: "needle" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(grep.details.matches, 1);
  });
});

test("job: cancel terminates a running process without a completion wake", async () => {
  await withJobsDir(async (_dir, { tools, ctx, wakes }) => {
    const job = tools.get("job")!;
    const started = await job.execute(
      "job-run-cancel",
      { action: "run", command: "sleep 30", wake: "always" },
      undefined,
      undefined,
      ctx,
    );
    const id = started.details.id as string;
    const cancelled = await job.execute(
      "job-cancel",
      { action: "cancel", id },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(cancelled.details.state, "cancelling");

    const startedAt = Date.now();
    while (Date.now() - startedAt < 4000) {
      const status = await job.execute(
        "job-cancel-status",
        { action: "status", id },
        undefined,
        undefined,
        ctx,
      );
      if (status.details.state === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const final = await job.execute(
      "job-cancel-final",
      { action: "status", id },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(final.details.state, "done");
    assert.equal(wakes.length, 0);
  });
});

test("bgrun: exit marker survives commands with # and explicit exit codes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const mod: any = await loadModule();

    await bgrun.execute(
      "call-hash",
      { command: "echo hi #" },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 1);
    const hashId = wakes[0].text.match(/`([^`]+)`/)?.[1];
    assert.ok(hashId, "got hash job id");
    const hashLog = readFileSync(join(dir, `${hashId}.log`), "utf8");
    assert.match(hashLog, /__BGRUN_EXIT__=0/);

    await bgrun.execute(
      "call-exit3",
      { command: "exit 3" },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 2);
    assert.match(wakes[1].text, /finished \(exit 3\)/);
    const exit3Id = wakes[1].text.match(/`([^`]+)`/)?.[1];
    assert.ok(exit3Id, "got exit3 job id");
    assert.equal(
      mod.parseExitFromLogPath(join(dir, `${exit3Id}.log`)),
      3,
      "marker recoverable after restart",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgrun: successful command writes log + exit marker and wakes with ✅", async () => {
  await withJobsDir(async (dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;

    const res = await bgrun.execute(
      "call-1",
      { command: "echo hello world" },
      undefined,
      undefined,
      ctx,
    );
    const started = res.content[0].text as string;
    assert.match(started, /^started: /);
    const id = (started.match(/^started: ([^\n]+)/) || [])[1];
    assert.ok(id, "got a job id");

    await waitForWakes(wakes, 1);
    // When idle, sendUserMessage is called with no options.
    assert.equal(wakes[0].options, undefined);
    const wake = wakes[0].text;
    assert.match(wake, /✅/);
    assert.match(wake, /exit 0/);
    assert.match(wake, /hello world/);
    assert.match(wake, new RegExp(id));

    const logPath = join(dir, `${id}.log`);
    assert.ok(existsSync(logPath), "log file exists");
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /hello world/);
    assert.match(log, /__BGRUN_EXIT__=0/);
  });
});

test("bgrun: wake never keeps model context quiet while persisting completion", async () => {
  await withJobsDir(async (dir, h) => {
    const { wakes, entries, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const res = await bgrun.execute(
      "call-never",
      { command: "echo quiet-success", wake: "never" },
      undefined,
      undefined,
      ctx,
    );
    const text = res.content[0].text as string;
    const id = text.match(/^started: ([^\n]+)/)![1];
    assert.match(text, /wake: never/);
    assert.match(text, /without waking the agent/);
    await waitForLogExit(join(dir, `${id}.log`));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(wakes.length, 0);
    const records = entries.filter((entry) => entry.data?.id === id);
    assert.equal(records.length, 2, "running + done entries persisted");
    assert.ok(records.every((entry) => entry.data?.wake === "never"));
  });
});

test("bgrun: wake failure ignores success and wakes on non-zero exit", async () => {
  await withJobsDir(async (dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const success = await bgrun.execute(
      "call-failure-success",
      { command: "echo pass", wake: "failure" },
      undefined,
      undefined,
      ctx,
    );
    const successId = (success.content[0].text as string).match(
      /^started: ([^\n]+)/,
    )![1];
    await waitForLogExit(join(dir, `${successId}.log`));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(wakes.length, 0);

    await bgrun.execute(
      "call-failure-error",
      { command: "echo failed; exit 9", wake: "failure" },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 1);
    assert.match(wakes[0].text, /exit 9/);
  });
});

test("bgrun: failing command wakes with ❌ and the non-zero exit code", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;

    await bgrun.execute(
      "call-2",
      { command: "echo failing now; exit 7" },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 1);
    const wake = wakes[0].text;
    assert.match(wake, /❌/);
    assert.match(wake, /exit 7/);
  });
});

test("bgrun: when agent is busy, wake is queued as followUp", async () => {
  await withJobsDir(
    async (_dir, h) => {
      const { wakes, tools, ctx } = h;
      const bgrun = tools.get("bgrun")!;

      await bgrun.execute(
        "call-busy",
        { command: "echo while-busy" },
        undefined,
        undefined,
        ctx,
      );
      await waitForWakes(wakes, 1);
      assert.equal(wakes[0].options?.deliverAs, "followUp");
    },
    { idle: false },
  );
});

test("bgtail: returns last N lines, strips the exit marker", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;

    const res = await bgrun.execute(
      "call-3",
      { command: "printf 'line1\\nline2\\nline3\\n'" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    const tail = await bgtail.execute(
      "call-3",
      { id, lines: 2 },
      undefined,
      undefined,
      ctx,
    );
    const text = tail.content[0].text as string;
    assert.ok(!text.includes("__BGRUN_EXIT__"), "marker stripped");
    assert.match(text, /line2\nline3$|^line3$/);
  });
});

test("bgtail: condenses output — strips ANSI, collapses repeats, caps long lines", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;

    // 1 ANSI-colored line, 5 identical spinner lines, 1 huge line
    const esc = "\u001b"; // literal ESC byte, safe to pass through a shell arg
    const payload =
      `printf "${esc}[32mOK green${esc}[0m\nwait\nwait\nwait\nwait\nwait\nline3\n"; ` +
      "echo \"$(printf 'x%.0s' $(seq 1 5000))\"";
    const res = await bgrun.execute(
      "call-c1",
      { command: payload },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    const tail = await bgtail.execute(
      "call-c1",
      { id, lines: 40 },
      undefined,
      undefined,
      ctx,
    );
    const text = tail.content[0].text as string;
    assert.ok(!text.includes("\u001b"), "ANSI escapes stripped");
    assert.ok(text.includes("OK green"), "text after stripping survives");
    assert.match(
      text,
      /wait {2}\[x5\]/,
      "5 identical lines collapsed to one with count",
    );
    assert.ok(!text.includes("x".repeat(4000)), "5000-char line capped");
    assert.match(text, /\u2026\[\+3\d{3} chars\]/, "truncation marker present");
    assert.match(text, /\(\d+ ANSI escape/, "notes mention ANSI stripping");
    assert.match(
      text,
      /1 repeated-line run collapsed/,
      "notes mention run collapse",
    );
    assert.ok((tail.details as any).condensed === true);
  });
});

test("bgtail: raw=true skips condensing", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;

    const esc = "\u001b";
    const res = await bgrun.execute(
      "call-c2",
      { command: `printf "${esc}[31mraw-red${esc}[0m\nwait\nwait\nwait\n"` },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    const tail = await bgtail.execute(
      "call-c2",
      { id, raw: true },
      undefined,
      undefined,
      ctx,
    );
    const text = tail.content[0].text as string;
    assert.ok(text.includes("\u001b[31m"), "raw keeps ANSI escapes");
    assert.ok(
      text.includes("wait\nwait\nwait"),
      "raw keeps repeated lines uncollapsed",
    );
    assert.ok((tail.details as any).condensed === false);
  });
});

test("bgtail: total cap kicks in on large output with guidance note", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;

    // ~200 distinct lines x ~500 chars = ~100KB, well past the 8KB total cap
    const cmd =
      "for i in $(seq 1 200); do echo \"line-$i $(printf 'y%.0s' $(seq 1 500))\"; done";
    const res = await bgrun.execute(
      "call-c3",
      { command: cmd },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    const tail = await bgtail.execute(
      "call-c3",
      { id, lines: 200 },
      undefined,
      undefined,
      ctx,
    );
    const text = tail.content[0].text as string;
    assert.ok(text.length < 10_000, "result capped well below raw size");
    assert.match(
      text,
      /output capped at 8000 chars — 200 raw lines total/,
      "cap note names the raw line count and suggests escalation paths",
    );
    assert.ok((tail.details as any).condenserNotes, "notes in details too");
  });
});

test("bgstatus: shows running then done with exit code", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bgstatus = tools.get("bgstatus")!;

    const res = await bgrun.execute(
      "call-4",
      { command: "sleep 0.2; echo done" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];

    // While running, status should say running.
    const running = await bgstatus.execute(
      "call-4",
      { id },
      undefined,
      undefined,
      ctx,
    );
    assert.match(running.content[0].text as string, /running/);

    await waitForWakes(wakes, 1);
    const done = await bgstatus.execute(
      "call-4",
      { id },
      undefined,
      undefined,
      ctx,
    );
    assert.match(done.content[0].text as string, /done/);
    assert.match(done.content[0].text as string, /exit=0/);
  });
});

test("bgstatus: list-all after 'restart' hides finished logs by default, notes them instead", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  try {
    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const res = await bgrun.execute(
      "call-5",
      { command: "echo persisted" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];

    // Wait for completion by polling the log marker.
    const logPath = join(dir, `${id}.log`);
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        try {
          if (readFileSync(logPath, "utf8").includes("__BGRUN_EXIT__=0"))
            return resolve();
        } catch {}
        if (Date.now() - start > 5000)
          return reject(new Error("log marker never appeared"));
        setTimeout(tick, 50);
      };
      tick();
    });

    // Fresh instance — no in-memory records. Default listing must NOT spam the
    // finished job; it gets a one-line count note instead.
    const { pi: pi2, tools: tools2 } = makeFakePi();
    await loadExtension(pi2);
    const bgstatus2 = tools2.get("bgstatus")!;
    const list = await bgstatus2.execute(
      "call-5",
      {},
      undefined,
      undefined,
      ctx,
    );
    const text = list.content[0].text as string;
    assert.ok(!new RegExp(id).test(text), "finished job hidden by default");
    assert.match(text, /\(1 more job log\(s\) on disk/);

    // includeDone reveals it with the exit code recovered from the log.
    const full = await bgstatus2.execute(
      "call-5b",
      { includeDone: true },
      undefined,
      undefined,
      ctx,
    );
    const fullText = full.content[0].text as string;
    assert.match(fullText, new RegExp(id));
    assert.match(fullText, /exit=0/);
    assert.match(fullText, /\(from log\)/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgstatus: showCompletedJobs config (env) lists finished jobs by default", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  process.env.PI_BGRUN_SHOW_COMPLETED = "1";
  try {
    const { pi, wakes, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const bgstatus = tools.get("bgstatus")!;

    const res = await bgrun.execute(
      "call-sd1",
      { command: "echo shown-done", name: "done-job" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    const list = await bgstatus.execute(
      "call-sd2",
      {},
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      list.content[0].text as string,
      new RegExp(`${id} — done-job: done exit=0`),
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_SHOW_COMPLETED;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgrun: rejects empty command", async () => {
  const { pi, tools, ctx } = makeFakePi();
  await loadExtension(pi);
  const bgrun = tools.get("bgrun")!;
  await assert.rejects(
    () => bgrun.execute("call-6", { command: "" }, undefined, undefined, ctx),
    /command is required/,
  );
});

// ── Phase 1 tests ────────────────────────────────────────────────────────────

test("bgrun: appends bgrun-job entries (running then done)", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, entries, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;

    await bgrun.execute(
      "call-e1",
      { command: "echo entry-test" },
      undefined,
      undefined,
      ctx,
    );
    // One running entry appended at start.
    const runningEntries = entries.filter((e) => e.data?.state === "running");
    assert.equal(runningEntries.length, 1, "running entry appended at start");
    assert.equal(runningEntries[0]?.data?.cmd, "echo entry-test");

    await waitForWakes(wakes, 1);
    // One done entry appended on exit.
    const doneEntries = entries.filter((e) => e.data?.state === "done");
    assert.equal(doneEntries.length, 1, "done entry appended on exit");
    assert.equal(doneEntries[0]?.data?.exitCode, 0);
  });
});

test("session_start: reconstructs in-memory Map from bgrun-job entries", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  try {
    // First instance: run a job, capture its entries.
    const { pi: pi1, wakes, entries, tools: tools1, ctx: ctx1 } = makeFakePi();
    await loadExtension(pi1);
    const bgrun1 = tools1.get("bgrun")!;
    const res = await bgrun1.execute(
      "call-r1",
      { command: "echo reconstruct-me" },
      undefined,
      undefined,
      ctx1,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    // Second instance: simulate a restart. Load fresh, passing the prior entries,
    // then fire session_start to trigger reconstruction.
    const {
      pi: pi2,
      tools: tools2,
      ctx: ctx2,
      fireSessionStart,
    } = makeFakePi({ priorEntries: entries });
    await loadExtension(pi2);
    await fireSessionStart();

    // Now bgstatus should find the job in the in-memory Map (not just dir scan).
    const bgstatus2 = tools2.get("bgstatus")!;
    const status = await bgstatus2.execute(
      "call-r2",
      { id },
      undefined,
      undefined,
      ctx2,
    );
    const text = status.content[0].text as string;
    assert.match(text, /done.*exit=0/);
    // Verify it came from the in-memory Map (not "from log" marker).
    assert.ok(
      !text.includes("from log"),
      "reconstructed from entries, not dir scan",
    );
    assert.ok(
      !text.includes("recovered from log"),
      "reconstructed from entries, not log recovery",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── name (human-readable label) tests ───────────────────────────────────────

test("bgrun: name flows into job id, response, entry, wake, and status", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, entries, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;

    const res = await bgrun.execute(
      "call-n1",
      { command: "echo named job", name: "unit-tests" },
      undefined,
      undefined,
      ctx,
    );
    const text = res.content[0].text as string;
    const id = (text.match(/^started: ([^\n]+)/) || [])[1];
    // Slug derives from the name, not the command.
    assert.ok(
      id.startsWith("unit-tests-"),
      `id should start with 'unit-tests-': ${id}`,
    );
    // Response includes the name.
    assert.match(text, /name: unit-tests/);
    // Details include the name.
    assert.equal((res.details as any).name, "unit-tests");

    await waitForWakes(wakes, 1);
    const wake = wakes[0].text;
    // Wake includes the name.
    assert.match(wake, /"unit-tests"/);

    // Persisted entries carry the name.
    const withName = entries.filter((e) => e.data?.name === "unit-tests");
    assert.equal(withName.length, 2, "running + done entries carry name");
  });
});

test("bgrun: name is optional — behavior unchanged without it", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;

    const res = await bgrun.execute(
      "call-n2",
      { command: "echo unnamed job" },
      undefined,
      undefined,
      ctx,
    );
    const text = res.content[0].text as string;
    // No 'name:' line in the response.
    assert.ok(!/^ {2}name:/m.test(text), "no name line when name omitted");
    const id = (text.match(/^started: ([^\n]+)/) || [])[1];
    assert.ok(
      id.startsWith("echo-unnamed-job-"),
      `slug falls back to command: ${id}`,
    );

    await waitForWakes(wakes, 1);
    assert.ok(
      !wakes[0].text.includes('"'),
      "wake has no name quote when unnamed",
    );
  });
});

test("bgrun: blank name is ignored, over-long name is truncated", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;

    // Blank name treated as absent.
    const res1 = await bgrun.execute(
      "call-n3",
      { command: "echo blank", name: "   " },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(
      !/^ {2}name:/m.test(res1.content[0].text as string),
      "blank name ignored",
    );

    // Over-long name truncated to 80 chars.
    const longName = "x".repeat(200);
    const res2 = await bgrun.execute(
      "call-n4",
      { command: "echo long", name: longName },
      undefined,
      undefined,
      ctx,
    );
    const text2 = res2.content[0].text as string;
    const nameLine = (text2.match(/^ {2}name: (.+)$/m) || [])[1];
    assert.equal(nameLine.length, 80, "name truncated to 80 chars");

    await waitForWakes(wakes, 2);
  });
});

test("bgrun: name survives session_start reconstruction", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  try {
    // First instance: run a named job, capture entries.
    const { pi: pi1, wakes, entries, tools: tools1, ctx: ctx1 } = makeFakePi();
    await loadExtension(pi1);
    const bgrun1 = tools1.get("bgrun")!;
    const res = await bgrun1.execute(
      "call-n5",
      { command: "echo named-restart", name: "rebuild" },
      undefined,
      undefined,
      ctx1,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    // Second instance: reconstruct from entries, name should be restored.
    const {
      pi: pi2,
      tools: tools2,
      ctx: ctx2,
      fireSessionStart,
    } = makeFakePi({ priorEntries: entries });
    await loadExtension(pi2);
    await fireSessionStart();

    const bgstatus2 = tools2.get("bgstatus")!;
    const status = await bgstatus2.execute(
      "call-n6",
      { id },
      undefined,
      undefined,
      ctx2,
    );
    const text = status.content[0].text as string;
    assert.match(text, /name: rebuild/);
    assert.ok(
      !text.includes("recovered from log"),
      "reconstructed from entries, not log",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgstatus: list shows name after job id", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bgstatus = tools.get("bgstatus")!;

    await bgrun.execute(
      "call-n7",
      { command: "sleep 0.1; echo listed", name: "nightly" },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 1);

    const list = await bgstatus.execute(
      "call-n8",
      { includeDone: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(list.content[0].text as string, /— nightly: done exit=0/);
    // Without includeDone, finished jobs are hidden by default.
    const runningOnly = await bgstatus.execute(
      "call-n8b",
      {},
      undefined,
      undefined,
      ctx,
    );
    assert.ok(
      !/— nightly: done/.test(runningOnly.content[0].text as string),
      "done job hidden without includeDone",
    );
  });
});

test("session_start: foreign jobs are NOT adopted by default (opt-in only)", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  try {
    // A running foreign job (no exit marker, live pid — this test process).
    const foreignId = `other-session-job-${Date.now()}-${process.pid}`;
    writeFileSync(join(dir, `${foreignId}.log`), "someone else's job\n");

    const { pi, tools, ctx, fireSessionStart } = makeFakePi();
    ctx.hasUI = true;
    const widgetCalls: (string[] | undefined)[] = [];
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) =>
      widgetCalls.push(lines);

    await loadExtension(pi);
    await fireSessionStart();

    // Widget never shows the foreign job.
    const shown = widgetCalls.find((l) => Array.isArray(l));
    assert.equal(
      shown,
      undefined,
      "no widget content for foreign jobs by default",
    );

    // List-all gives a count note, not the job itself.
    const bgstatus = tools.get("bgstatus")!;
    const list = await bgstatus.execute(
      "call-f1",
      {},
      undefined,
      undefined,
      ctx,
    );
    const text = list.content[0].text as string;
    assert.ok(!text.includes(foreignId), "foreign job not listed by default");
    assert.match(text, /\(1 more job log\(s\) on disk/);

    // Single-id lookup still works — that's the explicit escape hatch.
    const one = await bgstatus.execute(
      "call-f2",
      { id: foreignId },
      undefined,
      undefined,
      ctx,
    );
    assert.match(one.content[0].text as string, /: running/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start: adopts running jobs from the jobs dir (other session's job) into the widget", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  process.env.PI_BGRUN_FOREIGN_JOBS = "1";
  try {
    // A log with no exit marker whose pid is alive (this test process's own pid).
    const adoptedId = `kafka-bootstrap-${Date.now()}-${process.pid}`;
    writeFileSync(join(dir, `${adoptedId}.log`), "job still going\n");

    const { pi, tools, ctx, fireSessionStart } = makeFakePi();
    ctx.hasUI = true;
    const widgetCalls: (string[] | undefined)[] = [];
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) =>
      widgetCalls.push(lines);

    await loadExtension(pi);
    await fireSessionStart();

    // Widget should now show the adopted job.
    const shown = widgetCalls.find((l) => Array.isArray(l)) ?? [];
    const flat = (shown as string[]).join("\n");
    assert.match(flat, /bgrun: 1 running/);
    assert.match(flat, new RegExp(adoptedId.slice(0, 20)));
    assert.match(flat, /\(adopted\)/);
    assert.match(flat, /since \d{2}:\d{2}:\d{2}/);

    // bgstatus single-id should also see it as running (in-memory now).
    const bgstatus = tools.get("bgstatus")!;
    const res = await bgstatus.execute(
      "call-a1",
      { id: adoptedId },
      undefined,
      undefined,
      ctx,
    );
    assert.match(res.content[0].text as string, /: running/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_FOREIGN_JOBS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adopted job leaves the widget once its log shows the exit marker (revalidation)", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  process.env.PI_BGRUN_FOREIGN_JOBS = "1";
  try {
    // Foreign running job (live pid = this process, no marker).
    const adoptedId = `foreign-finish-${Date.now()}-${process.pid}`;
    const logPath = join(dir, `${adoptedId}.log`);
    writeFileSync(logPath, "job still going\n");

    const { pi, tools, ctx, fireSessionStart } = makeFakePi();
    ctx.hasUI = true;
    const widgetCalls: (string[] | undefined)[] = [];
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) =>
      widgetCalls.push(lines);

    await loadExtension(pi);
    await fireSessionStart();
    assert.ok(
      widgetCalls.some((l) => Array.isArray(l)),
      "widget shown after adoption",
    );

    // The foreign job finishes: marker appears in the log.
    writeFileSync(logPath, "job still going\n__BGRUN_EXIT__=0\n");

    // Any bgstatus call revalidates adopted jobs and refreshes the widget.
    const bgstatus = tools.get("bgstatus")!;
    const list = await bgstatus.execute(
      "call-a2",
      {},
      undefined,
      undefined,
      ctx,
    );
    const text = list.content[0].text as string;
    assert.ok(
      !/: running/.test(text),
      "adopted job no longer listed as running",
    );
    assert.match(
      text,
      /\(1 more job log\(s\) on disk/,
      "finished adopted job folded into the disk note",
    );
    assert.ok(
      widgetCalls.some((l) => l === undefined),
      "widget cleared after adopted job finished",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_FOREIGN_JOBS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start: does NOT adopt finished or dead-pid jobs", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  process.env.PI_BGRUN_FOREIGN_JOBS = "1";
  try {
    // Finished (exit marker present).
    writeFileSync(
      join(dir, `done-job-${Date.now()}-${process.pid}.log`),
      "out\n__BGRUN_EXIT__=0\n",
    );
    // No marker but pid is certainly dead (pid 1 is launchd — alive, so use a likely-dead high pid).
    // Use pid 1-style trick instead: a dead pid we spawn and reap.
    const { spawnSync } = await import("node:child_process");
    const dead = spawnSync("sh", ["-c", "exit 0"]);
    assert.equal(dead.status, 0);
    // Write log with a pid that no longer exists: use the reaped child's pid if captured, else 999999.
    const deadPid = dead.pid ?? 999999;
    writeFileSync(
      join(dir, `dead-job-${Date.now()}-${deadPid}.log`),
      "partial\n",
    );

    const { pi, ctx, fireSessionStart } = makeFakePi();
    ctx.hasUI = true;
    let widgetShown = false;
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) => {
      if (lines) widgetShown = true;
    };

    await loadExtension(pi);
    await fireSessionStart();
    assert.equal(widgetShown, false, "no widget for finished/dead jobs");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_FOREIGN_JOBS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start: with foreign adoption OFF, finished foreign logs are not adopted", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  try {
    writeFileSync(
      join(dir, `done-job-${Date.now()}-${process.pid}.log`),
      "out\n__BGRUN_EXIT__=0\n",
    );
    const { pi, ctx, fireSessionStart } = makeFakePi();
    ctx.hasUI = true;
    let widgetShown = false;
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) => {
      if (lines) widgetShown = true;
    };
    await loadExtension(pi);
    await fireSessionStart();
    assert.equal(widgetShown, false, "no adoption when disabled");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgrun: job id encodes the CHILD's pid, not pi's own pid", async () => {
  await withJobsDir(async (dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;

    const res = await bgrun.execute(
      "call-pid",
      { command: "echo pidcheck" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    const idPid = Number(id.split("-").pop());
    assert.ok(idPid > 0, `id ends with child pid: ${id}`);
    assert.notEqual(idPid, process.pid, "id must NOT carry pi's own pid");
    // Log file named after the id, no .tmp- leftovers.
    assert.ok(existsSync(join(dir, `${id}.log`)), "log at final id-named path");
    assert.equal(
      readdirSync(dir).filter((f) => f.startsWith(".tmp-")).length,
      0,
      "no temp log leftovers",
    );

    await waitForWakes(wakes, 1);
  });
});

test("bgclean all: a live pid protects a log whose exit marker is NOT terminal", async () => {
  // Regression: a running job's own output can contain a line like
  // "__BGRUN_EXIT__=0" (a test grepping this extension). A non-terminal marker
  // is not completion evidence, so pid liveness must win, or the sweep deletes
  // a live job's log.
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  markJobsDir(dir);
  try {
    // Foreign log whose id-pid is THIS process (alive). The marker is followed
    // by more output, so it is NOT the terminal line.
    const livePath = join(dir, `live-job-1000000000-${process.pid}.log`);
    writeFileSync(
      livePath,
      "still running\n__BGRUN_EXIT__=0\nmore output follows\n",
    );
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const fs = await import("node:fs");
    fs.utimesSync(livePath, oldTime, oldTime);

    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgclean = tools.get("bgclean")!;

    const result = await bgclean.execute(
      "call-live-marker",
      { days: 7, all: true },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(
      existsSync(livePath),
      "live-pid log kept despite a spurious exit marker",
    );
    assert.ok(
      result.details.skippedRunning >= 1,
      "live log counted as skipped-running",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start adoption: skips finished jobs even with a live id-pid", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  process.env.PI_BGRUN_FOREIGN_JOBS = "1";
  try {
    // Finished job (exit marker) whose id-pid is this process (alive).
    writeFileSync(
      join(dir, `done-job-${Date.now()}-${process.pid}.log`),
      "out\n__BGRUN_EXIT__=0\n",
    );
    const { pi, ctx, fireSessionStart } = makeFakePi();
    ctx.hasUI = true;
    let widgetShown = false;
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) => {
      if (lines) widgetShown = true;
    };
    await loadExtension(pi);
    await fireSessionStart();
    assert.equal(
      widgetShown,
      false,
      "finished job not adopted even though id-pid is alive",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_FOREIGN_JOBS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start: reconstructed 'running' job that finished while pi was down is cleared, not zombified", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  try {
    // A job from 5 days ago whose transcript entry never got a done entry
    // (pi wasn't running when it exited), whose log is long gone and whose
    // pid is definitely dead.
    const zombieId = `cd-old-project-make-test-${Date.now()}-99999999`;
    const logPath = join(dir, `${zombieId}.log`); // never created
    const priorEntries = [
      {
        type: "custom",
        customType: "bgrun-job",
        data: {
          id: zombieId,
          pid: 99999999,
          cmd: "cd /old/project && make test",
          name: undefined,
          started: Date.now() - 5 * 24 * 60 * 60 * 1000,
          logPath,
          state: "running",
        },
      },
    ];
    const { pi, entries, tools, ctx, fireSessionStart } = makeFakePi({
      priorEntries,
    });
    ctx.hasUI = true;
    const widgetCalls: (string[] | undefined)[] = [];
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) =>
      widgetCalls.push(lines);

    await loadExtension(pi);
    await fireSessionStart();

    // Revalidation runs before the widget ever renders — the zombie is
    // cleared immediately instead of showing as "running" forever.
    assert.ok(
      !widgetCalls.some((l) => Array.isArray(l)),
      "reconstructed zombie never shown in the widget",
    );

    // A done entry is appended so future resumes reconstruct it as done.
    const doneEntry = entries.find(
      (e) =>
        e.customType === "bgrun-job" &&
        e.data?.id === zombieId &&
        e.data?.state === "done",
    );
    assert.ok(doneEntry, "done entry appended for the recovered job");

    // Single-id lookup reports done, not running.
    const bgstatus = tools.get("bgstatus")!;
    const res = await bgstatus.execute(
      "call-z1",
      { id: zombieId },
      undefined,
      undefined,
      ctx,
    );
    assert.match(res.content[0].text as string, /: done/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start: done entries with missing exitCode (signal kills) reconstruct as done", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  try {
    // Jobs killed by a signal persist state:"done" with exitCode: undefined —
    // reconstruction must honor the state field, not just the exit code.
    const killedId = `nightly-watch-${Date.now()}-${process.pid}`;
    const logPath = join(dir, `${killedId}.log`);
    writeFileSync(logPath, "partial output\n"); // no marker — killed before it
    const priorEntries = [
      {
        type: "custom",
        customType: "bgrun-job",
        data: {
          id: killedId,
          pid: process.pid, // alive — liveness alone must not resurrect it as running
          cmd: "npm run watch",
          name: "nightly-watch",
          started: Date.now() - 60_000,
          logPath,
          state: "done",
          exitCode: undefined,
          exitedAt: Date.now() - 30_000,
        },
      },
    ];
    const { pi, tools, ctx, fireSessionStart } = makeFakePi({ priorEntries });
    ctx.hasUI = true;
    const widgetCalls: (string[] | undefined)[] = [];
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) =>
      widgetCalls.push(lines);

    await loadExtension(pi);
    await fireSessionStart();

    assert.ok(
      !widgetCalls.some((l) => Array.isArray(l)),
      "signal-killed job with a done entry is not resurrected as running",
    );
    const bgstatus = tools.get("bgstatus")!;
    const res = await bgstatus.execute(
      "call-z2",
      { id: killedId },
      undefined,
      undefined,
      ctx,
    );
    assert.match(res.content[0].text as string, /: done/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-clean: session boundaries sweep this session's old logs AND week-old foreign orphans by default", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  markJobsDir(dir);
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
  try {
    const fs = await import("node:fs");
    const backdate = (path: string) => {
      const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(path, oldTime, oldTime);
    };

    // This session's old done job (from the transcript) with a backdated log.
    const mineId = `my-old-job-${Date.now()}-99999999`;
    const myLog = join(dir, `${mineId}.log`);
    fs.writeFileSync(myLog, "mine\n__BGRUN_EXIT__=0\n");
    backdate(myLog);

    // A foreign session's week-old FINISHED log — an orphan; swept by default.
    const orphanLog = join(dir, "foreign-old-job-1000000000-99998.log");
    fs.writeFileSync(orphanLog, "foreign\n__BGRUN_EXIT__=0\n");
    backdate(orphanLog);

    // A foreign session's RECENT finished log — within retention, kept.
    const recentForeignLog = join(
      dir,
      `foreign-recent-${Math.floor(Date.now() / 1000)}-99997.log`,
    );
    fs.writeFileSync(recentForeignLog, "recent foreign\n__BGRUN_EXIT__=0\n");

    // A foreign session's week-old RUNNING log (no marker, live pid) — running
    // jobs are pid-protected even when old.
    const runningForeignLog = join(
      dir,
      `foreign-running-${Math.floor(Date.now() / 1000)}-${process.pid}.log`,
    );
    fs.writeFileSync(runningForeignLog, "still going\n");
    backdate(runningForeignLog);

    const priorEntries = [
      {
        type: "custom",
        customType: "bgrun-job",
        data: {
          id: mineId,
          pid: 99999999,
          cmd: "echo mine",
          name: undefined,
          started: Date.now() - 30 * 24 * 60 * 60 * 1000,
          logPath: myLog,
          state: "done",
          exitCode: 0,
          exitedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
        },
      },
    ];
    const { pi, fireSessionStart } = makeFakePi({ priorEntries });
    await loadExtension(pi);
    await fireSessionStart();

    assert.ok(!fs.existsSync(myLog), "this session's old log swept");
    assert.ok(
      !fs.existsSync(orphanLog),
      "week-old finished foreign orphan swept by default",
    );
    assert.ok(
      fs.existsSync(recentForeignLog),
      "recent foreign log kept (within retention)",
    );
    assert.ok(
      fs.existsSync(runningForeignLog),
      "old but RUNNING foreign log kept (pid-protected)",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-clean: globalAutoClean=false opts out — foreign orphans untouched, own old logs still swept", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  markJobsDir(dir);
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN = "0";
  try {
    const fs = await import("node:fs");
    const backdate = (path: string) => {
      const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(path, oldTime, oldTime);
    };

    const mineId = `my-old-job-${Date.now()}-99999999`;
    const myLog = join(dir, `${mineId}.log`);
    fs.writeFileSync(myLog, "mine\n__BGRUN_EXIT__=0\n");
    backdate(myLog);

    const orphanLog = join(dir, "foreign-old-job-1000000000-99998.log");
    fs.writeFileSync(orphanLog, "foreign\n__BGRUN_EXIT__=0\n");
    backdate(orphanLog);

    const priorEntries = [
      {
        type: "custom",
        customType: "bgrun-job",
        data: {
          id: mineId,
          pid: 99999999,
          cmd: "echo mine",
          name: undefined,
          started: Date.now() - 30 * 24 * 60 * 60 * 1000,
          logPath: myLog,
          state: "done",
          exitCode: 0,
          exitedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
        },
      },
    ];
    const { pi, fireSessionStart } = makeFakePi({ priorEntries });
    await loadExtension(pi);
    await fireSessionStart();

    assert.ok(!fs.existsSync(myLog), "this session's old log still swept");
    assert.ok(
      fs.existsSync(orphanLog),
      "foreign orphan untouched when globalAutoClean is off",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-clean: trusted project at session start creates the local jobs dir and git exclude", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  delete process.env.PI_BGRUN_DIR;
  delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    const { pi, fireSessionStart } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => true },
    });
    await loadExtension(pi);
    await fireSessionStart();

    const exclude = join(proj, ".git", "info", "exclude");
    assert.ok(existsSync(exclude), "exclude file created at session start");
    assert.match(readFileSync(exclude, "utf8"), /^\.pi-bgrun\/jobs\/$/m);
    assert.ok(
      existsSync(join(proj, ".pi-bgrun", "jobs", ".last-clean")),
      "orphan-sweep throttle marker written in the local jobs dir",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
    rmSync(proj, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("auto-clean: untrusted project at session start writes nothing into the repo", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  delete process.env.PI_BGRUN_DIR;
  delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    const { pi, fireSessionStart } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => false },
    });
    await loadExtension(pi);
    await fireSessionStart();

    assert.ok(
      !existsSync(join(proj, ".git", "info", "exclude")),
      "no .git/info/exclude write in an untrusted repo",
    );
    assert.ok(
      !existsSync(join(proj, ".pi-bgrun")),
      "no project-local jobs dir created in an untrusted repo",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
    rmSync(proj, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("auto-clean: untrusted project keeps stale usage/digest markers (J1)", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  delete process.env.PI_BGRUN_DIR;
  delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    const jobsDir = join(proj, ".pi-bgrun", "jobs");
    mkdirSync(jobsDir, { recursive: true });
    const marker = join(jobsDir, ".bgrun-used-deadbeef");
    writeFileSync(marker, "used");
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(marker, oldTime, oldTime);

    const { pi, fireSessionStart } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => false },
    });
    await loadExtension(pi);
    await fireSessionStart();

    assert.ok(
      existsSync(marker),
      "a stale marker is not deleted in an untrusted repo",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
    rmSync(proj, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("auto-clean: untrusted project keeps an existing old finished log (J5.1)", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  delete process.env.PI_BGRUN_DIR;
  delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    const jobsDir = join(proj, ".pi-bgrun", "jobs");
    mkdirSync(jobsDir, { recursive: true });
    const oldLog = join(jobsDir, "old-done-1000000000-99999.log");
    writeFileSync(oldLog, "done\n__BGRUN_EXIT__=0\n");
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(oldLog, oldTime, oldTime);

    const { pi, fireSessionStart } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => false },
    });
    await loadExtension(pi);
    await fireSessionStart();

    assert.ok(
      existsSync(oldLog),
      "an existing old finished log is not swept in an untrusted repo",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
    rmSync(proj, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("auto-clean: .last-clean throttles per dir under the project-local default (J5.2)", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  delete process.env.PI_BGRUN_DIR;
  delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const projJobs = join(proj, ".pi-bgrun", "jobs");
    mkdirSync(projJobs, { recursive: true });
    // The automatic sweep only touches a dir carrying our ownership marker.
    markJobsDir(projJobs);
    const projOld = join(projJobs, "old-proj-1000000000-99999.log");
    writeFileSync(projOld, "done\n__BGRUN_EXIT__=0\n");
    utimesSync(projOld, oldTime, oldTime);
    // Fresh throttle marker in the machine-global dir, plus an old log there.
    mkdirSync(TEST_GLOBAL_JOBS_DIR, { recursive: true });
    writeFileSync(
      join(TEST_GLOBAL_JOBS_DIR, ".last-clean"),
      String(Date.now()),
    );
    const globalOld = join(
      TEST_GLOBAL_JOBS_DIR,
      "old-global-1000000000-99998.log",
    );
    writeFileSync(globalOld, "done\n__BGRUN_EXIT__=0\n");
    utimesSync(globalOld, oldTime, oldTime);

    const { pi, fireSessionStart } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => true },
    });
    await loadExtension(pi);
    await fireSessionStart();

    assert.ok(
      !existsSync(projOld),
      "project dir lacks a marker so its old log is swept",
    );
    assert.ok(
      existsSync(globalOld),
      "global dir's fresh marker throttles its own sweep",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
    rmSync(proj, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("auto-clean: untrusted project aliased by a global symlink writes nothing (J6)", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  const savedGlobal = process.env.PI_BGRUN_GLOBAL_DIR;
  delete process.env.PI_BGRUN_DIR;
  delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    const projJobs = join(proj, ".pi-bgrun", "jobs");
    mkdirSync(projJobs, { recursive: true });
    const alias = join(TEST_TMP_ROOT, "global-alias");
    symlinkSync(projJobs, alias);
    process.env.PI_BGRUN_GLOBAL_DIR = alias;

    const { pi, fireSessionStart } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => false },
    });
    await loadExtension(pi);
    await fireSessionStart();

    assert.ok(
      !existsSync(join(proj, ".git", "info", "exclude")),
      "no .git/info/exclude write in an untrusted repo",
    );
    assert.ok(
      !existsSync(join(projJobs, ".last-clean")),
      "no .last-clean written via the aliased global path",
    );
  } finally {
    if (savedGlobal === undefined) delete process.env.PI_BGRUN_GLOBAL_DIR;
    else process.env.PI_BGRUN_GLOBAL_DIR = savedGlobal;
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
    rmSync(proj, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("auto-clean: global orphan sweep is throttled via .last-clean; manual bgclean all always runs", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  markJobsDir(dir);
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN; // default: on
  try {
    const fs = await import("node:fs");
    const backdate = (path: string) => {
      const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(path, oldTime, oldTime);
    };

    // Old foreign log A + first session_start (no marker yet) → global sweep
    // runs, A removed.
    const logA = join(dir, "old-a-1000000000-99999.log");
    fs.writeFileSync(logA, "old a\n__BGRUN_EXIT__=0\n");
    backdate(logA);
    {
      const { pi, fireSessionStart } = makeFakePi();
      await loadExtension(pi);
      await fireSessionStart();
    }
    assert.ok(!fs.existsSync(logA), "first global sweep removed old log A");
    assert.ok(
      fs.existsSync(join(dir, ".last-clean")),
      "throttle marker written",
    );

    // Old foreign log B + second session_start while marker is fresh →
    // throttled, B kept.
    const logB = join(dir, "old-b-1000000000-99998.log");
    fs.writeFileSync(logB, "old b\n__BGRUN_EXIT__=0\n");
    backdate(logB);
    {
      const { pi, fireSessionStart } = makeFakePi();
      await loadExtension(pi);
      await fireSessionStart();
    }
    assert.ok(
      fs.existsSync(logB),
      "second global sweep throttled — old log B kept",
    );

    // Manual `bgclean all` ignores the throttle and removes B.
    const { pi: pi3, tools: tools3, ctx: ctx3 } = makeFakePi();
    await loadExtension(pi3);
    const bgclean = tools3.get("bgclean")!;
    const result = await bgclean.execute(
      "call-t1",
      { all: true },
      undefined,
      undefined,
      ctx3,
    );
    assert.match(
      result.content[0].text as string,
      /removed 1 job log\(s\) \(all sessions\)/,
    );
    assert.ok(!fs.existsSync(logB), "manual bgclean all removed log B");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgclean: default scope is this session's logs; all: true sweeps everything", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  markJobsDir(dir);
  // Isolate bgclean's scoping from the global orphan auto-sweep (default on)
  // so the foreign log survives session_start for bgclean to (not) act on.
  process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN = "0";
  try {
    const fs = await import("node:fs");
    const backdate = (path: string) => {
      const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(path, oldTime, oldTime);
    };

    const mkEntry = (
      id: string,
      logPath: string,
      extra: Record<string, unknown> = {},
    ) => ({
      type: "custom",
      customType: "bgrun-job",
      data: {
        id,
        pid: 99999999,
        cmd: `echo ${id}`,
        name: undefined,
        started: Date.now() - 60_000,
        logPath,
        state: "done",
        exitCode: 0,
        exitedAt: Date.now() - 30_000,
        ...extra,
      },
    });

    // This session's recent done job (fresh log — kept).
    const recentId = `recent-job-${Date.now()}-99999998`;
    const recentLog = join(dir, `${recentId}.log`);
    fs.writeFileSync(recentLog, "recent\n__BGRUN_EXIT__=0\n");

    // This session's old done job (backdated log — removed by default scope).
    const oldId = `old-session-job-${Date.now()}-99999997`;
    const oldLog = join(dir, `${oldId}.log`);
    fs.writeFileSync(oldLog, "old session job\n__BGRUN_EXIT__=0\n");
    backdate(oldLog);

    // A foreign session's old log — untouched by default, removed with all.
    const foreignLog = join(dir, "foreign-old-job-1000000000-99996.log");
    fs.writeFileSync(foreignLog, "foreign\n__BGRUN_EXIT__=0\n");
    backdate(foreignLog);

    const priorEntries = [
      mkEntry(recentId, recentLog),
      mkEntry(oldId, oldLog, {
        started: Date.now() - 30 * 24 * 60 * 60 * 1000,
        exitedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
      }),
    ];
    const { pi, tools, ctx, fireSessionStart } = makeFakePi({ priorEntries });
    await loadExtension(pi);
    await fireSessionStart(); // reconstruct + session-scoped auto-sweep runs here too

    const bgclean = tools.get("bgclean")!;

    // Default: this session only.
    const scoped = await bgclean.execute(
      "call-c2",
      { days: 7 },
      undefined,
      undefined,
      ctx,
    );
    assert.match(scoped.content[0].text as string, /\(this session\)/);
    assert.ok(!fs.existsSync(oldLog), "this session's old log removed");
    assert.ok(fs.existsSync(recentLog), "this session's recent log kept");
    assert.ok(
      fs.existsSync(foreignLog),
      "foreign log untouched by session-scoped bgclean",
    );

    // all: true sweeps the shared dir.
    const global = await bgclean.execute(
      "call-c3",
      { days: 7, all: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(global.content[0].text as string, /\(all sessions\)/);
    assert.ok(!fs.existsSync(foreignLog), "foreign log removed by bgclean all");
    assert.ok(fs.existsSync(recentLog), "recent log still kept");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgclean all: sweeps stale per-project digest markers, keeps fresh ones", async () => {
  await withJobsDir(async (dir, h) => {
    const fs = await import("node:fs");
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const staleMarkers = [".bgrun-used-abc123", ".digest-nudge-def456"];
    const freshMarker = ".bgrun-used-fresh0";
    for (const name of [...staleMarkers, freshMarker]) {
      const p = join(dir, name);
      fs.writeFileSync(p, "1");
      if (staleMarkers.includes(name)) fs.utimesSync(p, old, old);
    }
    // A backdated finished log so the sweep also has a normal job to remove.
    const logPath = join(dir, "job-1-1.log");
    fs.writeFileSync(logPath, "out\n__BGRUN_EXIT__=0\n");
    fs.utimesSync(logPath, old, old);

    const { tools, ctx } = h;
    const bgclean = tools.get("bgclean")!;
    await bgclean.execute(
      "call-mk",
      { days: 1, all: true },
      undefined,
      undefined,
      ctx,
    );

    for (const name of staleMarkers) {
      assert.ok(!existsSync(join(dir, name)), `stale marker swept: ${name}`);
    }
    assert.ok(existsSync(join(dir, freshMarker)), "fresh marker kept");

    // A session-scoped sweep (no `all`) also drops stale markers: they are not
    // session data, so the default bgclean still cleans them.
    const stale2 = join(dir, ".digest-nudge-stale2");
    fs.writeFileSync(stale2, "1");
    fs.utimesSync(stale2, old, old);
    await bgclean.execute("call-mk2", { days: 1 }, undefined, undefined, ctx);
    assert.ok(
      !existsSync(stale2),
      "session-scoped sweep also drops stale markers",
    );
  });
});

test("bgclean: rejects non-positive days", async () => {
  const { pi, tools, ctx } = makeFakePi();
  await loadExtension(pi);
  const bgclean = tools.get("bgclean")!;
  await assert.rejects(
    () => bgclean.execute("call-c3", { days: -1 }, undefined, undefined, ctx),
    /positive number/,
  );
  // days: 0 would set the cutoff to now and purge every finished log.
  await assert.rejects(
    () => bgclean.execute("call-c3z", { days: 0 }, undefined, undefined, ctx),
    /positive number/,
  );
});

test("bgclean: does not remove a running job's log", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const bgclean = tools.get("bgclean")!;

    // Start a long-running job (10s) so it's still running when we clean.
    const res = await bgrun.execute(
      "call-c4",
      { command: "sleep 10" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    const logPath = join(dir, `${id}.log`);

    // Backdate the log's mtime to make it look old — but the job is still running
    // (pid is in the in-memory Map), so bgclean should skip it.
    const fs = await import("node:fs");
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // Wait a moment for the log file to exist, then backdate.
    await new Promise((r) => setTimeout(r, 100));
    fs.utimesSync(logPath, oldTime, oldTime);

    const result = await bgclean.execute(
      "call-c5",
      { days: 7 },
      undefined,
      undefined,
      ctx,
    );
    const text = result.content[0].text as string;
    assert.match(text, /skipped 1 running/);
    assert.ok(fs.existsSync(logPath), "running job's log not removed");

    // Kill the orphaned sleep so it doesn't linger (best-effort: it may have exited already).
    try {
      process.kill((res.details as any).pid);
    } catch {
      // already gone — fine
    }
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slash commands: /bgstatus, /bgtail, /bgclean registered and share the tool logic", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
  try {
    const { pi, wakes, tools, commands, ctx } = makeFakePi();
    ctx.hasUI = true;
    const notes: { text: string; kind: string }[] = [];
    ctx.ui.notify = (text: string, kind: string) => notes.push({ text, kind });

    await loadExtension(pi);

    // All three human-facing commands are registered (/bgrun is agent-only).
    assert.ok(commands.has("bgstatus"), "/bgstatus registered");
    assert.ok(commands.has("bgtail"), "/bgtail registered");
    assert.ok(commands.has("bgclean"), "/bgclean registered");
    assert.ok(!commands.has("bgrun"), "/bgrun deliberately not a command");

    // Run a real job to completion so there's something to inspect.
    const bgrun = tools.get("bgrun")!;
    const res = await bgrun.execute(
      "call-cmd1",
      { command: "echo cmd-mirror", name: "mirror-job" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    // /bgstatus <id> → single-job status via notify.
    await commands.get("bgstatus")!.handler(id, ctx);
    assert.ok(
      notes.some((n) => n.text.includes(id) && /: done/.test(n.text)),
      "/bgstatus <id> notifies job status",
    );

    // /bgstatus done → listing includes the finished job.
    await commands.get("bgstatus")!.handler("done", ctx);
    assert.ok(
      notes.some((n) => /mirror-job: done exit=0/.test(n.text)),
      "/bgstatus done lists finished jobs",
    );

    // /bgtail <id> <lines> → condensed tail via notify.
    await commands.get("bgtail")!.handler(`${id} 5`, ctx);
    assert.ok(
      notes.some((n) => n.text.includes("cmd-mirror")),
      "/bgtail notifies the log tail",
    );

    // /bgtail with no args → usage error.
    await commands.get("bgtail")!.handler("", ctx);
    assert.ok(
      notes.some((n) => n.kind === "error" && /Usage: \/bgtail/.test(n.text)),
      "/bgtail without id shows usage",
    );

    // /bgclean (no args) → session-scoped summary via notify.
    await commands.get("bgclean")!.handler("", ctx);
    assert.ok(
      notes.some((n) => /removed 0 job log\(s\) \(this session\)/.test(n.text)),
      "/bgclean notifies the session-scoped summary",
    );

    // /bgclean 7 all → global scope.
    await commands.get("bgclean")!.handler("7 all", ctx);
    assert.ok(
      notes.some((n) => /\(all sessions\)/.test(n.text)),
      "/bgclean all notifies the global summary",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatSince: same-day shows time only; older days include the date", async () => {
  const mod: any = await loadModule();
  assert.equal(typeof mod.formatSince, "function");

  const now = new Date("2026-09-09T10:00:00").getTime();
  const sameDay = new Date("2026-09-09T06:30:12").getTime();
  const prevDay = new Date("2026-09-04T15:05:40").getTime();
  const prevMonth = new Date("2026-08-12T23:59:59").getTime();
  const prevYear = new Date("2025-12-30T08:00:00").getTime();

  // Same calendar day → time only (unchanged display).
  assert.equal(mod.formatSince(sameDay, now), "06:30:12");

  // Different day, same year → date + time.
  const prevDayStr = mod.formatSince(prevDay, now);
  assert.match(prevDayStr, /Sep 4/);
  assert.match(prevDayStr, /15:05:40/);

  const prevMonthStr = mod.formatSince(prevMonth, now);
  assert.match(prevMonthStr, /Aug 12/);
  assert.match(prevMonthStr, /23:59:59/);

  // Different year → date includes the year.
  const prevYearStr = mod.formatSince(prevYear, now);
  assert.match(prevYearStr, /2025/);
  assert.match(prevYearStr, /Dec 30/);
  assert.match(prevYearStr, /08:00:00/);
});

// ── Project-local jobs dir ──────────────────────────────────────────────────

test("resolveJobsDirPath: relative resolves against a project root; absolute and no-root fall back", async () => {
  const mod: any = await loadModule();
  const proj = mkTmp("pi-bgrun-proj-");
  const scratch = mkTmp("pi-bgrun-scratch-");
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });

    // absolute → used as-is, never flagged project-local (older configs keep
    // working unchanged — the migration guarantee)
    const absPath = join(proj, "abs-jobs");
    const abs = mod.resolveJobsDirPath(absPath, { cwd: proj });
    assert.equal(abs.dir, absPath);
    assert.equal(abs.projectLocal, false);

    // relative + project root → resolved against the root, flagged project-local
    const rel = mod.resolveJobsDirPath(".pi-bgrun/jobs", { cwd: proj });
    assert.equal(rel.dir, join(proj, ".pi-bgrun", "jobs"));
    assert.equal(rel.projectLocal, true);

    // unset + project root → project-local default
    const none = mod.resolveJobsDirPath(undefined, { cwd: proj });
    assert.equal(none.dir, join(proj, ".pi-bgrun", "jobs"));
    assert.equal(none.projectLocal, true);

    // unset + cwd that is not a project → global fallback
    const noProj = mod.resolveJobsDirPath(undefined, { cwd: scratch });
    assert.equal(noProj.dir, TEST_GLOBAL_JOBS_DIR);
    assert.equal(noProj.projectLocal, false);

    // relative + cwd that is not a project → global fallback, never cwd-relative
    const fb = mod.resolveJobsDirPath(".pi-bgrun/jobs", { cwd: scratch });
    assert.equal(fb.dir, TEST_GLOBAL_JOBS_DIR);
    assert.equal(fb.projectLocal, false);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("resolveJobsDirPath: finds an enclosing project root from a subdirectory; .pi counts; worktree .git file counts", async () => {
  const mod: any = await loadModule();
  const proj = mkTmp("pi-bgrun-proj-");
  const piOnly = mkTmp("pi-bgrun-pionly-");
  const worktree = mkTmp("pi-bgrun-wt-");
  try {
    // .git dir at the root; session cwd is a nested subdirectory
    mkdirSync(join(proj, ".git"), { recursive: true });
    const sub = join(proj, "packages", "foo");
    mkdirSync(sub, { recursive: true });
    const nested = mod.resolveJobsDirPath(undefined, { cwd: sub });
    assert.equal(nested.dir, join(proj, ".pi-bgrun", "jobs"));
    assert.equal(nested.projectLocal, true);

    // a RELATIVE override resolves against the enclosing root too
    const nestedRel = mod.resolveJobsDirPath("var/logs", { cwd: sub });
    assert.equal(nestedRel.dir, join(proj, "var", "logs"));
    assert.equal(nestedRel.projectLocal, true);

    // a project detected by .pi alone (no .git) still defaults locally
    mkdirSync(join(piOnly, ".pi"), { recursive: true });
    const piDetected = mod.resolveJobsDirPath(undefined, { cwd: piOnly });
    assert.equal(piDetected.dir, join(piOnly, ".pi-bgrun", "jobs"));
    assert.equal(piDetected.projectLocal, true);

    // linked worktree: .git is a FILE pointing at the real git dir
    writeFileSync(join(worktree, ".git"), "gitdir: /tmp/elsewhere\n");
    const wt = mod.resolveJobsDirPath(undefined, { cwd: worktree });
    assert.equal(wt.dir, join(worktree, ".pi-bgrun", "jobs"));
    assert.equal(wt.projectLocal, true);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(piOnly, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("resolveJobsDirPath: the user's home dir is never treated as a project root", async () => {
  const mod: any = await loadModule();
  // Hermetic: inject a fake home rather than touching the real ~/.pi. A `.pi`
  // at the fake home is exactly the case the guard exists for (pi's global
  // agent dir must not make every cwd under home project-local).
  const home = mkTmp("pi-bgrun-home-");
  try {
    mkdirSync(join(home, ".pi"), { recursive: true });
    const r = mod.resolveJobsDirPath(undefined, {
      cwd: join(home, "scratch"),
      home,
    });
    assert.equal(r.dir, TEST_GLOBAL_JOBS_DIR);
    assert.equal(r.projectLocal, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveJobsDirPath: a symlinked home is still recognized as the home dir", async () => {
  const mod: any = await loadModule();
  const realHome = mkTmp("pi-bgrun-realhome-");
  const linkParent = mkTmp("pi-bgrun-link-");
  try {
    mkdirSync(join(realHome, ".pi"), { recursive: true });
    const link = join(linkParent, "home-link");
    symlinkSync(realHome, link);
    const r = mod.resolveJobsDirPath(undefined, {
      cwd: join(realHome, "scratch"),
      home: link,
    });
    assert.equal(r.dir, TEST_GLOBAL_JOBS_DIR);
    assert.equal(r.projectLocal, false);
  } finally {
    rmSync(realHome, { recursive: true, force: true });
    rmSync(linkParent, { recursive: true, force: true });
  }
});

test("resolveJobsDirPath: a cwd reached via a symlink to the home dir is still not project-local", async () => {
  const mod: any = await loadModule();
  const home = mkTmp("pi-bgrun-home-");
  const linkParent = mkTmp("pi-bgrun-link-");
  try {
    mkdirSync(join(home, ".pi"), { recursive: true });
    const link = join(linkParent, "home-link");
    symlinkSync(home, link);
    // home is passed as the REAL home; only the cwd is symlinked.
    const r = mod.resolveJobsDirPath(undefined, {
      cwd: join(link, "scratch"),
      home,
    });
    assert.equal(r.dir, TEST_GLOBAL_JOBS_DIR);
    assert.equal(r.projectLocal, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(linkParent, { recursive: true, force: true });
  }
});

test("resolveJobsDirPath: expands a leading ~ to the home dir (not project-local)", async () => {
  const mod: any = await loadModule();
  const scratch = mkTmp("pi-bgrun-scratch-");
  try {
    const r = mod.resolveJobsDirPath("~/.pi-bgrun/jobs", { cwd: scratch });
    assert.equal(r.dir, join(homeDir(), ".pi-bgrun", "jobs"));
    assert.equal(r.projectLocal, false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("resolveJobsDirPath: expands only a leading ~ (or ~/) — ~user and embedded ~ are literal", async () => {
  const mod: any = await loadModule();
  const proj = mkTmp("pi-bgrun-proj-");
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    // Bare ~ → home dir (absolute, not project-local).
    const bare = mod.resolveJobsDirPath("~", { cwd: proj });
    assert.equal(bare.dir, homeDir());
    assert.equal(bare.projectLocal, false);
    // ~/x → join(home, "x").
    const sub = mod.resolveJobsDirPath("~/x", { cwd: proj });
    assert.equal(sub.dir, join(homeDir(), "x"));
    assert.equal(sub.projectLocal, false);
    // ~user/x is NOT expanded — treated as a relative path under the root.
    const user = mod.resolveJobsDirPath("~user/x", { cwd: proj });
    assert.equal(user.dir, join(proj, "~user/x"));
    assert.equal(user.projectLocal, true);
    // A tilde that is not leading is untouched.
    const embedded = mod.resolveJobsDirPath("x/~", { cwd: proj });
    assert.equal(embedded.dir, join(proj, "x/~"));
    assert.equal(embedded.projectLocal, true);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("resolveJobsDirPath: PI_BGRUN_GLOBAL_DIR is tilde-expanded", async () => {
  const mod: any = await loadModule();
  const scratch = mkTmp("pi-bgrun-scratch-");
  try {
    await withEnv("PI_BGRUN_GLOBAL_DIR", "~/.pi-bgrun/jobs", () => {
      const r = mod.resolveJobsDirPath(undefined, { cwd: scratch });
      assert.equal(r.dir, join(homeDir(), ".pi-bgrun", "jobs"));
      assert.equal(r.projectLocal, false);
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("resolveJobsDirPath: without PI_BGRUN_GLOBAL_DIR the global default is ~/.pi-bgrun/jobs", async () => {
  const mod: any = await loadModule();
  const scratch = mkTmp("pi-bgrun-scratch-");
  try {
    await withEnv("PI_BGRUN_GLOBAL_DIR", undefined, () => {
      const r = mod.resolveJobsDirPath(undefined, { cwd: scratch });
      assert.equal(r.dir, join(homeDir(), ".pi-bgrun", "jobs"));
      assert.equal(r.projectLocal, false);
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("bgrun: falls back to the machine-global jobs dir when cwd is not a project root", async () => {
  const scratch = mkTmp("pi-bgrun-scratch-");
  delete process.env.PI_BGRUN_DIR;
  try {
    const { pi, wakes, tools, ctx } = makeFakePi({
      ctxFields: { cwd: scratch },
    });
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    const res = await bgrun.execute(
      "call-globalfb",
      { command: "echo global-fallback" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    assert.ok(id, "got a job id");
    await waitForWakes(wakes, 1);

    const logPath = join(TEST_GLOBAL_JOBS_DIR, `${id}.log`);
    assert.ok(existsSync(logPath), "log written to the machine-global dir");
    assert.match(readFileSync(logPath, "utf8"), /global-fallback/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(scratch, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("bgclean all: under the project-local default, sweeps BOTH the project dir and the machine-global dir", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  delete process.env.PI_BGRUN_DIR;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    const projJobs = join(proj, ".pi-bgrun", "jobs");
    mkdirSync(projJobs, { recursive: true });
    const fs = await import("node:fs");
    const backdate = (path: string) => {
      const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(path, oldTime, oldTime);
    };
    const projLog = join(projJobs, "proj-old-1000000000-99990.log");
    fs.writeFileSync(projLog, "proj\n__BGRUN_EXIT__=0\n");
    backdate(projLog);
    const globalLog = join(
      TEST_GLOBAL_JOBS_DIR,
      "global-old-1000000000-99991.log",
    );
    fs.writeFileSync(globalLog, "global\n__BGRUN_EXIT__=0\n");
    backdate(globalLog);

    const { pi, tools, ctx } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => true },
    });
    await loadExtension(pi);
    const bgclean = tools.get("bgclean")!;
    const result = await bgclean.execute(
      "call-bgclean-both",
      { days: 7, all: true },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(!fs.existsSync(projLog), "project-dir old log removed");
    assert.ok(!fs.existsSync(globalLog), "machine-global old log removed");
    assert.ok(result.details.removed >= 2, "both removals counted");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(proj, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("bgclean all: an explicit absolute jobsDir is swept alone (machine-global dir untouched)", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  try {
    const fs = await import("node:fs");
    const backdate = (path: string) => {
      const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(path, oldTime, oldTime);
    };
    const absLog = join(dir, "abs-old-1000000000-99992.log");
    fs.writeFileSync(absLog, "abs\n__BGRUN_EXIT__=0\n");
    backdate(absLog);
    const globalLog = join(
      TEST_GLOBAL_JOBS_DIR,
      "global-old-1000000000-99993.log",
    );
    fs.writeFileSync(globalLog, "global\n__BGRUN_EXIT__=0\n");
    backdate(globalLog);

    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgclean = tools.get("bgclean")!;
    await bgclean.execute(
      "call-bgclean-abs",
      { days: 7, all: true },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(!fs.existsSync(absLog), "absolute-dir old log removed");
    assert.ok(
      fs.existsSync(globalLog),
      "machine-global log kept — absolute jobsDir is isolated",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("bgclean all: pid-protects a running job in the machine-global dir", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  delete process.env.PI_BGRUN_DIR;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    const fs = await import("node:fs");
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const runningLog = join(
      TEST_GLOBAL_JOBS_DIR,
      `global-running-${Math.floor(Date.now() / 1000)}-${process.pid}.log`,
    );
    fs.writeFileSync(runningLog, "still going\n");
    fs.utimesSync(runningLog, oldTime, oldTime);

    const { pi, tools, ctx } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => true },
    });
    await loadExtension(pi);
    const bgclean = tools.get("bgclean")!;
    const result = await bgclean.execute(
      "call-global-run",
      { days: 7, all: true },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(fs.existsSync(runningLog), "running global log kept");
    assert.equal(result.details.skippedRunning, 1, "running pid skipped");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(proj, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("bgclean all: does not create a project-local jobs dir (or dirty git) when there is nothing to clean", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  delete process.env.PI_BGRUN_DIR;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    const { pi, tools, ctx } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => true },
    });
    await loadExtension(pi);
    const bgclean = tools.get("bgclean")!;
    await bgclean.execute(
      "call-nojobs",
      { days: 7, all: true },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(
      !existsSync(join(proj, ".pi-bgrun")),
      "bgclean all must not create the project-local jobs dir",
    );
    assert.ok(
      !existsSync(join(proj, ".git", "info", "exclude")),
      "no git-exclude edit when there is no dir to stamp",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(proj, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("bgclean all: adds git-exclusion for an existing local jobs dir even with no old logs", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  delete process.env.PI_BGRUN_DIR;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".pi-bgrun", "jobs"), { recursive: true });
    const { pi, tools, ctx } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => true },
    });
    await loadExtension(pi);
    const bgclean = tools.get("bgclean")!;
    await bgclean.execute(
      "call-empty-dir",
      { days: 7, all: true },
      undefined,
      undefined,
      ctx,
    );
    const exclude = join(proj, ".git", "info", "exclude");
    assert.ok(existsSync(exclude), "exclude added for an existing jobs dir");
    assert.match(readFileSync(exclude, "utf8"), /^\.pi-bgrun\/jobs\/$/m);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(proj, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("bgclean all: never writes .git/info/exclude into the repo holding the global dir", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  const globalRepo = mkTmp("pi-bgrun-global-repo-");
  delete process.env.PI_BGRUN_DIR;
  const savedGlobal = process.env.PI_BGRUN_GLOBAL_DIR;
  const fs = await import("node:fs");
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".pi-bgrun", "jobs"), { recursive: true });
    // The global jobs dir sits inside its own git repo, like $HOME under a
    // dotfiles repo — the sweep must not edit THAT repo's exclude file.
    mkdirSync(join(globalRepo, ".git"), { recursive: true });
    const globalJobs = join(globalRepo, ".pi-bgrun", "jobs");
    mkdirSync(globalJobs, { recursive: true });
    process.env.PI_BGRUN_GLOBAL_DIR = globalJobs;
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const log = join(globalJobs, "foreign-old-1000000000-999992.log");
    fs.writeFileSync(log, "global\n__BGRUN_EXIT__=0\n");
    fs.utimesSync(log, oldTime, oldTime);

    const { pi, tools, ctx } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => true },
    });
    await loadExtension(pi);
    const bgclean = tools.get("bgclean")!;
    await bgclean.execute(
      "call-global-exclude",
      { days: 7, all: true },
      undefined,
      undefined,
      ctx,
    );

    assert.ok(!fs.existsSync(log), "old global log swept");
    assert.ok(
      !existsSync(join(globalRepo, ".git", "info", "exclude")),
      "the global dir's repo must not get a jobs-dir exclude",
    );
    const exclude = join(proj, ".git", "info", "exclude");
    assert.ok(existsSync(exclude), "project-local dir is still excluded");
    assert.match(readFileSync(exclude, "utf8"), /^\.pi-bgrun\/jobs\/$/m);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    if (savedGlobal === undefined) delete process.env.PI_BGRUN_GLOBAL_DIR;
    else process.env.PI_BGRUN_GLOBAL_DIR = savedGlobal;
    rmSync(proj, { recursive: true, force: true });
    rmSync(globalRepo, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("bgclean all: an EPERM pid reads as alive, so an unfinished old log is kept", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  const realKill = process.kill;
  try {
    const fs = await import("node:fs");
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const log = join(dir, "eperm-old-1000000000-999999.log");
    fs.writeFileSync(log, "no exit marker\n");
    fs.utimesSync(log, oldTime, oldTime);

    // Simulate a live-but-unsignalable process: process.kill throws EPERM.
    process.kill = (() => {
      const err: NodeJS.ErrnoException = new Error("EPERM");
      err.code = "EPERM";
      throw err;
    }) as typeof process.kill;

    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgclean = tools.get("bgclean")!;
    const result = await bgclean.execute(
      "call-eperm",
      { days: 7, all: true },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(fs.existsSync(log), "EPERM pid treated as alive → log kept");
    assert.ok(result.details.skippedRunning >= 1, "counted as skipped-running");
  } finally {
    process.kill = realKill;
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("bgclean all: project-local dir aliasing the global dir is visited once, not double-counted", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  delete process.env.PI_BGRUN_DIR;
  const savedGlobal = process.env.PI_BGRUN_GLOBAL_DIR;
  const fs = await import("node:fs");
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    const projJobs = join(proj, ".pi-bgrun", "jobs");
    mkdirSync(projJobs, { recursive: true });
    // Point the machine-global dir at the same physical dir as the project's.
    process.env.PI_BGRUN_GLOBAL_DIR = projJobs;
    // A FRESH log: the first pass would KEEP it, so with dedup the dir is
    // visited once (kept === 1) and without dedup twice (kept === 2). An old
    // log would be removed on the first pass and mask the double-visit.
    const log = join(projJobs, "alias-fresh-1000000000-999994.log");
    fs.writeFileSync(log, "alias\n__BGRUN_EXIT__=0\n");

    const { pi, tools, ctx } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => true },
    });
    await loadExtension(pi);
    const bgclean = tools.get("bgclean")!;
    const result = await bgclean.execute(
      "call-alias",
      { days: 7, all: true },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(fs.existsSync(log), "fresh aliased log kept");
    assert.equal(result.details.kept, 1, "dir visited exactly once");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    if (savedGlobal === undefined) delete process.env.PI_BGRUN_GLOBAL_DIR;
    else process.env.PI_BGRUN_GLOBAL_DIR = savedGlobal;
    rmSync(proj, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("bgclean all: a symlinked global dir aliasing the project dir is visited once", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  delete process.env.PI_BGRUN_DIR;
  const savedGlobal = process.env.PI_BGRUN_GLOBAL_DIR;
  const fs = await import("node:fs");
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    const projJobs = join(proj, ".pi-bgrun", "jobs");
    mkdirSync(projJobs, { recursive: true });
    // The global dir is a SYMLINK to the project's jobs dir. String equality
    // would miss this, so this exercises the safeRealpath dedup branch.
    const alias = join(proj, "global-alias");
    symlinkSync(projJobs, alias, "dir");
    process.env.PI_BGRUN_GLOBAL_DIR = alias;
    const log = join(projJobs, "alias-symlink-fresh-1000000000-999993.log");
    fs.writeFileSync(log, "alias\n__BGRUN_EXIT__=0\n");

    const { pi, tools, ctx } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => true },
    });
    await loadExtension(pi);
    const bgclean = tools.get("bgclean")!;
    const result = await bgclean.execute(
      "call-alias-link",
      { days: 7, all: true },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(fs.existsSync(log), "fresh aliased log kept");
    assert.equal(result.details.kept, 1, "symlinked dir visited exactly once");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    if (savedGlobal === undefined) delete process.env.PI_BGRUN_GLOBAL_DIR;
    else process.env.PI_BGRUN_GLOBAL_DIR = savedGlobal;
    rmSync(proj, { recursive: true, force: true });
    resetGlobalJobsDir();
  }
});

test("ensureGitExcluded: appends the jobs dir pattern to .git/info/exclude once per dir", async () => {
  const mod: any = await loadModule();
  const repo = mkTmp("pi-bgrun-repo-");
  try {
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    mod.ensureGitExcluded(join(repo, ".pi-bgrun", "jobs"));
    mod.ensureGitExcluded(join(repo, ".pi-bgrun", "jobs"));
    // a second, different jobs dir under the same repo adds its own pattern
    mod.ensureGitExcluded(join(repo, ".pi-bgrun", "other"));
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /# pi-bgrun job logs/);
    assert.equal(
      exclude.split("\n").filter((l) => l.trim() === ".pi-bgrun/jobs/").length,
      1,
      "pattern appears exactly once",
    );
    assert.ok(exclude.split("\n").includes(".pi-bgrun/other/"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ensureGitExcluded: linked worktree (.git file) writes to the pointed git dir", async () => {
  const mod: any = await loadModule();
  const wt = mkTmp("pi-bgrun-wt-");
  const gd = mkTmp("pi-bgrun-gitdir-");
  try {
    writeFileSync(join(wt, ".git"), `gitdir: ${gd}\n`);
    mod.ensureGitExcluded(join(wt, ".pi-bgrun", "jobs"));
    const exclude = readFileSync(join(gd, "info", "exclude"), "utf8");
    assert.match(exclude, /^\.pi-bgrun\/jobs\/$/m);
    // nothing was created inside the worktree's own .git (it's a file)
    assert.ok(!existsSync(join(wt, ".git", "info")));
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(gd, { recursive: true, force: true });
  }
});

test("ensureGitExcluded: linked worktree (.git file) writes to commondir exclude", async () => {
  const mod: any = await loadModule();
  const wt = mkdtempSync(join(tmpdir(), "pi-bgrun-wt-"));
  const common = mkdtempSync(join(tmpdir(), "pi-bgrun-common-"));
  const wtGitDir = join(common, "worktrees", "wt1");
  try {
    mkdirSync(join(common, "info"), { recursive: true });
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGitDir}\n`);
    writeFileSync(join(wtGitDir, "commondir"), "../..\n");
    mod.ensureGitExcluded(join(wt, ".pi-bgrun", "jobs"));
    const exclude = readFileSync(join(common, "info", "exclude"), "utf8");
    assert.match(exclude, /^\.pi-bgrun\/jobs\/$/m);
    assert.ok(!existsSync(join(wtGitDir, "info", "exclude")));
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(common, { recursive: true, force: true });
  }
});

test("ensureGitExcluded: gitdir pointer with spaces in the path", async () => {
  const mod: any = await loadModule();
  const wt = mkTmp("pi-bgrun-wt-");
  const gd = join(TEST_TMP_ROOT, "pi-bgrun git dir with spaces");
  mkdirSync(gd, { recursive: true });
  try {
    writeFileSync(join(wt, ".git"), `gitdir: ${gd}\n`);
    assert.equal(mod.ensureGitExcluded(join(wt, ".pi-bgrun", "jobs")), true);
    const exclude = readFileSync(join(gd, "info", "exclude"), "utf8");
    assert.match(exclude, /^\.pi-bgrun\/jobs\/$/m);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(gd, { recursive: true, force: true });
  }
});

test("ensureGitExcluded: retries after a transient failure — memoizes only on success", async () => {
  const mod: any = await loadModule();
  const repo = mkTmp("pi-bgrun-repo-");
  try {
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    // Block the exclude path with a directory → the append fails (EISDIR)
    mkdirSync(join(repo, ".git", "info", "exclude"));
    const jobsDir = join(repo, ".pi-bgrun", "jobs");
    assert.equal(mod.ensureGitExcluded(jobsDir), false);

    // Unblock: the next call must retry (failure was not memoized) and succeed
    rmSync(join(repo, ".git", "info", "exclude"), { recursive: true });
    assert.equal(mod.ensureGitExcluded(jobsDir), true);
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /^\.pi-bgrun\/jobs\/$/m);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("bgrun: defaults to project-local logs in a project with no jobsDir override", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  delete process.env.PI_BGRUN_DIR;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    const { pi, wakes, tools, ctx } = makeFakePi({
      ctxFields: { cwd: proj },
    });
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    const res = await bgrun.execute(
      "call-def1",
      { command: "echo default-local" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    assert.ok(id, "got a job id");
    await waitForWakes(wakes, 1);

    const logPath = join(proj, ".pi-bgrun", "jobs", `${id}.log`);
    assert.ok(existsSync(logPath), "log written inside the project by default");
    assert.match(readFileSync(logPath, "utf8"), /default-local/);

    const exclude = join(proj, ".git", "info", "exclude");
    assert.ok(
      existsSync(exclude),
      "exclude file created for default local dir",
    );
    assert.match(readFileSync(exclude, "utf8"), /^\.pi-bgrun\/jobs\/$/m);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(proj, { recursive: true, force: true });
  }
});

test("bgrun: relative jobsDir in project config → project-local log + auto git-exclude", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  delete process.env.PI_BGRUN_DIR;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".pi"), { recursive: true });
    writeFileSync(
      join(proj, ".pi", "pi-bgrun.json"),
      JSON.stringify({ jobsDir: ".pi-bgrun/jobs" }),
    );
    const { pi, wakes, tools, ctx } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => true },
    });
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    const res = await bgrun.execute(
      "call-1",
      { command: "echo project-local" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    assert.ok(id, "got a job id");

    await waitForWakes(wakes, 1);

    const logPath = join(proj, ".pi-bgrun", "jobs", `${id}.log`);
    assert.ok(existsSync(logPath), "log written inside the project");
    assert.match(readFileSync(logPath, "utf8"), /project-local/);

    const exclude = join(proj, ".git", "info", "exclude");
    assert.ok(existsSync(exclude), "exclude file created");
    assert.match(readFileSync(exclude, "utf8"), /^\.pi-bgrun\/jobs\/$/m);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(proj, { recursive: true, force: true });
  }
});

test("bgtail: prefers the session record's logPath when the jobsDir config changes", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  delete process.env.PI_BGRUN_DIR;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".pi"), { recursive: true });
    writeFileSync(
      join(proj, ".pi", "pi-bgrun.json"),
      JSON.stringify({ jobsDir: ".pi-bgrun/jobs" }),
    );
    const { pi, wakes, tools, ctx } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => true },
    });
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;

    const res = await bgrun.execute(
      "call-1",
      { command: "echo migrated-log" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    assert.ok(id, "got a job id");
    await waitForWakes(wakes, 1);

    // A ctx with no project config/trust now resolves the jobs dir to the
    // GLOBAL default — only the session record's logPath can still find the
    // log (the mid-upgrade config-change scenario).
    const plainCtx = { ...ctx, cwd: undefined, isProjectTrusted: undefined };
    const tail = await bgtail.execute(
      "call-2",
      { id, lines: 10 },
      undefined,
      undefined,
      plainCtx,
    );
    assert.equal(tail.details.notFound, false);
    assert.match(tail.content[0].text as string, /migrated-log/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(proj, { recursive: true, force: true });
  }
});

// ── bggrep ──────────────────────────────────────────────────────────────────

test("bggrep: line-numbered matches; explicit pattern wins; default pattern; no-match case", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bggrep = tools.get("bggrep")!;

    const res = await bgrun.execute(
      "c1",
      { command: "printf 'alpha\\nerror: boom BANANA\\nomega\\n'" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    assert.ok(id, "got a job id");
    await waitForWakes(wakes, 1);

    // explicit pattern → only matching lines, with line numbers
    const g = await bggrep.execute(
      "c2",
      { id, pattern: "BANANA" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(g.details.matches, 1);
    assert.equal(g.details.notFound, false);
    assert.match(g.content[0].text as string, /L2: error: boom BANANA/);
    assert.doesNotMatch(g.content[0].text as string, /alpha|omega/);

    // default pattern (no pattern passed) catches the failure signature
    const g2 = await bggrep.execute("c3", { id }, undefined, undefined, ctx);
    assert.equal(g2.details.matches, 1);
    assert.match(g2.content[0].text as string, /1 match for \//);
    assert.equal(
      g2.details.pattern,
      "--- FAIL:|^FAIL\\b|^panic:|fatal error:|AssertionError|Error:|error:|make: \\*\\*\\*.*Error|✗|✖",
    );

    // a log with no failure signatures → clean no-match (not an error)
    const res2 = await bgrun.execute(
      "c4",
      { command: "echo all clear, nothing to see" },
      undefined,
      undefined,
      ctx,
    );
    const id2 = ((res2.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    await waitForWakes(wakes, 2);
    const g3 = await bggrep.execute(
      "c5",
      { id: id2 },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(g3.details.matches, 0);
    assert.equal(g3.isError, undefined);
    assert.match(g3.content[0].text as string, /— none/);
  });
});

test("bggrep: context lines with gap markers between distant matches", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bggrep = tools.get("bggrep")!;

    const res = await bgrun.execute(
      "c1",
      {
        command:
          "printf 'l1\\nMATCH one\\nl3\\nl4\\nl5\\nl6\\nl7\\nMATCH two\\nl9\\n'",
      },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    assert.ok(id, "got a job id");
    await waitForWakes(wakes, 1);

    const g = await bggrep.execute(
      "c2",
      { id, pattern: "MATCH", context: 1 },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(g.details.matches, 2);
    const text = g.content[0].text as string;
    assert.match(text, /L2: MATCH one/);
    assert.match(text, /L1: l1/); // context before
    assert.match(text, /L8: MATCH two/);
    assert.match(text, /L9: l9/); // context after
    assert.match(text, /…\[3 lines skipped\]…/); // l4-l6 between the windows
  });
});

test("bggrep: invalid pattern errors clearly", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bggrep = tools.get("bggrep")!;
    const res = await bgrun.execute(
      "c1",
      { command: "echo hi" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    await waitForWakes(wakes, 1);
    await assert.rejects(
      bggrep.execute(
        "c2",
        { id, pattern: "([unclosed" },
        undefined,
        undefined,
        ctx,
      ),
      /bggrep: invalid pattern/,
    );
  });
});

test("bggrep: caps at 50 matches with a not-shown note", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bggrep = tools.get("bggrep")!;
    const res = await bgrun.execute(
      "c1",
      { command: 'for i in $(seq 1 60); do echo "boom $i"; done' },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    await waitForWakes(wakes, 1);
    const g = await bggrep.execute(
      "c2",
      { id, pattern: "boom" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(g.details.matches, 60);
    assert.equal(g.details.capped, true);
    assert.match(
      g.content[0].text as string,
      /showing first 50; 10 more not shown/,
    );
    assert.match(g.content[0].text as string, /L50: boom 50/);
    assert.doesNotMatch(g.content[0].text as string, /L51: boom 51/);
  });
});

test("bggrep: prefers the session record's logPath when the jobsDir config changes", async () => {
  const proj = mkTmp("pi-bgrun-proj-");
  delete process.env.PI_BGRUN_DIR;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".pi"), { recursive: true });
    writeFileSync(
      join(proj, ".pi", "pi-bgrun.json"),
      JSON.stringify({ jobsDir: ".pi-bgrun/jobs" }),
    );
    const { pi, wakes, tools, ctx } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => true },
    });
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const bggrep = tools.get("bggrep")!;
    const res = await bgrun.execute(
      "c1",
      { command: "echo pattern-target-line" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    await waitForWakes(wakes, 1);

    const plainCtx = { ...ctx, cwd: undefined, isProjectTrusted: undefined };
    const g = await bggrep.execute(
      "c2",
      { id, pattern: "pattern-target" },
      undefined,
      undefined,
      plainCtx,
    );
    assert.equal(g.details.notFound, false);
    assert.equal(g.details.matches, 1);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(proj, { recursive: true, force: true });
  }
});

// ── bgtail delta tailing ────────────────────────────────────────────────────

test("bgtail: delta tailing — first read full tail, then only new lines, then none", async () => {
  await withJobsDir(async (dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;
    const res = await bgrun.execute(
      "c1",
      { command: "echo first line" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    assert.ok(id, "got a job id");
    await waitForWakes(wakes, 1);
    const logPath = join(dir, `${id}.log`);

    // First read: full tail, no delta header
    const t1 = await bgtail.execute("c2", { id }, undefined, undefined, ctx);
    assert.match(t1.content[0].text as string, /first line/);
    assert.equal(t1.details.newLines, undefined);
    assert.doesNotMatch(
      t1.content[0].text as string,
      /new lines since last read/,
    );

    // Log grows: only the new lines come back, with a +N header
    appendFileSync(logPath, "appended-A\nappended-B\n");
    const t2 = await bgtail.execute("c3", { id }, undefined, undefined, ctx);
    const text2 = t2.content[0].text as string;
    assert.match(text2, /\+2 new lines since last read/);
    assert.match(text2, /appended-A/);
    assert.match(text2, /appended-B/);
    assert.doesNotMatch(text2, /first line/);
    assert.equal(t2.details.newLines, 2);

    // Nothing new: a tiny no-new-lines response (cheap polling)
    const t3 = await bgtail.execute("c4", { id }, undefined, undefined, ctx);
    assert.match(t3.content[0].text as string, /no new lines since last read/);
    assert.equal(t3.details.linesShown, 0);
  });
});

test("bgtail: raw:true keeps the verbatim window but still advances the bookmark", async () => {
  await withJobsDir(async (dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;
    const res = await bgrun.execute(
      "c1",
      { command: "echo baseline" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    await waitForWakes(wakes, 1);
    const logPath = join(dir, `${id}.log`);

    appendFileSync(logPath, "post-raw line\n");
    const r = await bgtail.execute(
      "c2",
      { id, lines: 3, raw: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(r.content[0].text as string, /post-raw line/);
    assert.equal(r.details.condensed, false);

    // The raw read advanced the bookmark → the next condensed read is empty
    const t = await bgtail.execute("c3", { id }, undefined, undefined, ctx);
    assert.match(t.content[0].text as string, /no new lines since last read/);
  });
});

test("bgtail: a shrunken log resets to a full tail with a note", async () => {
  await withJobsDir(async (dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;
    const res = await bgrun.execute(
      "c1",
      { command: "echo long original content line" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    await waitForWakes(wakes, 1);
    const logPath = join(dir, `${id}.log`);

    // First read sets the bookmark; then the log is replaced by a shorter one
    await bgtail.execute("c2", { id }, undefined, undefined, ctx);
    writeFileSync(logPath, "tiny replacement\n");
    const t = await bgtail.execute("c3", { id }, undefined, undefined, ctx);
    const text = t.content[0].text as string;
    assert.match(text, /log shrank since last read — showing full tail/);
    assert.match(text, /tiny replacement/);
  });
});

test("bgtail: a replaced log with the same line count resets to a full tail", async () => {
  await withJobsDir(async (dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;
    const res = await bgrun.execute(
      "c1",
      { command: "printf 'aaaa\\nbbbb\\ncccc\\n'" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    await waitForWakes(wakes, 1);
    const logPath = join(dir, `${id}.log`);

    // First read sets the bookmark (3 content lines, first line "aaaa")
    await bgtail.execute("c2", { id }, undefined, undefined, ctx);
    // Replacement: SAME line count, LARGER byte size (so the shrink checks
    // cannot fire), different first line — only the first-line detector
    // (append-only logs never mutate line 0) can catch this.
    writeFileSync(
      logPath,
      "xxxxxxxxxxxxxxxxxx\nyyyyyyyyyyyyyyyyyy\nzzzzzzzzzzzzzzzzzz\n",
    );
    const t = await bgtail.execute("c3", { id }, undefined, undefined, ctx);
    const text = t.content[0].text as string;
    assert.match(text, /log was replaced since last read — showing full tail/);
    assert.match(text, /xxxxxxxxxxxxxxxxxx/);
  });
});

test("bggrep and bgtail normalize CRLF logs", async () => {
  await withJobsDir(async (dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;
    const bggrep = tools.get("bggrep")!;
    const res = await bgrun.execute(
      "c1",
      { command: "echo something" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    await waitForWakes(wakes, 1);
    const logPath = join(dir, `${id}.log`);

    writeFileSync(logPath, "alpha\r\nerror: boom\r\nomega\r\n");
    // A $-anchored pattern must match despite the CRLF source
    const g = await bggrep.execute(
      "c2",
      { id, pattern: "boom$" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(g.content[0].text as string, /L2: error: boom/);
    // And no stray \r leaks into either tool's output
    assert.ok(!(g.content[0].text as string).includes("\r"));
    const t = await bgtail.execute("c3", { id }, undefined, undefined, ctx);
    assert.ok(!(t.content[0].text as string).includes("\r"));
    assert.match(t.content[0].text as string, /error: boom/);
  });
});

test("bggrep: empty log reports zero lines, and a missing log is notFound", async () => {
  await withJobsDir(async (dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bggrep = tools.get("bggrep")!;
    const res = await bgrun.execute(
      "c1",
      { command: "echo x" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    await waitForWakes(wakes, 1);

    writeFileSync(join(dir, `${id}.log`), "");
    const g = await bggrep.execute(
      "c2",
      { id, pattern: "Error:" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      g.content[0].text as string,
      /0 matches for \/Error:\/ in 0 lines — none/,
    );

    const missing = await bggrep.execute(
      "c3",
      { id: "no-such-job-123", pattern: "x" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(missing.isError, true);
    assert.equal(missing.details.notFound, true);
  });
});

test("bggrep: context windows combine with the 50-match cap", async () => {
  await withJobsDir(async (dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bggrep = tools.get("bggrep")!;
    const res = await bgrun.execute(
      "c1",
      { command: "echo x" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    await waitForWakes(wakes, 1);

    // 240 lines, a hit every 4th line → 60 matches (cap 50); with context: 1
    // each window is [i-1, i+1] and consecutive windows leave a 1-line gap.
    const lines: string[] = [];
    for (let i = 1; i <= 240; i++) {
      lines.push(i % 4 === 0 ? `hit ${i}` : `filler ${i}`);
    }
    writeFileSync(join(dir, `${id}.log`), lines.join("\n") + "\n");
    const r = await bggrep.execute(
      "c2",
      { id, pattern: "^hit", context: 1 },
      undefined,
      undefined,
      ctx,
    );
    const text = r.content[0].text as string;
    assert.equal(r.details.matches, 60);
    assert.equal(r.details.capped, true);
    assert.match(text, /showing first 50; 10 more not shown/);
    assert.match(text, /L4: hit 4/);
    assert.match(text, /…\[1 line skipped\]…/);
  });
});

test("bgtail and bggrep clamp nonsensical numeric params", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;
    const bggrep = tools.get("bggrep")!;
    const res = await bgrun.execute(
      "c1",
      { command: "printf 'one\\ntwo\\nthree\\nfour\\nfive\\n'" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(/^started: ([^\n]+)/) ||
      [])[1];
    await waitForWakes(wakes, 1);

    // lines: 0 must not mean "everything" (slice(-0) pitfall) — clamps to 1
    const t = await bgtail.execute(
      "c2",
      { id, lines: 0 },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(t.details.linesShown, 1);
    assert.match(t.content[0].text as string, /five/);
    assert.ok(!(t.content[0].text as string).includes("four"));

    // negative context must not drop the match lines themselves — clamps to 0
    const g = await bggrep.execute(
      "c3",
      { id, pattern: "^three", context: -1 },
      undefined,
      undefined,
      ctx,
    );
    assert.match(g.content[0].text as string, /L3: three/);
  });
});

// ── universal stats in the wake message (digest foundation) ──────────────

test("formatDuration: one decimal in seconds under a minute, m:ss above", async () => {
  const mod: any = await loadModule();
  assert.equal(typeof mod.formatDuration, "function");
  assert.equal(mod.formatDuration(0), "0.0s");
  assert.equal(mod.formatDuration(42_300), "42.3s");
  assert.equal(mod.formatDuration(59_000), "59.0s");
  assert.equal(mod.formatDuration(60_000), "1:00");
  assert.equal(mod.formatDuration(307_000), "5:07");
  assert.equal(mod.formatDuration(3_600_000), "60:00");
});

test("wake message: Stats line (duration + line count) sits between Command: and Last output: on a green run", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;

    await bgrun.execute(
      "call-stats1",
      { command: "echo hello world" },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 1);
    const wake = wakes[0].text;
    // Stats carries the command's OWN line count — the appended exit marker,
    // its blank separator and (when capped) the truncation notice are excluded.
    // The duration is asserted by SHAPE only: it depends on machine speed and on
    // how many processes the wrapper spawns, so pinning "0.0s" pins the host.
    assert.match(wake, /Stats: \d+\.\d+s, 1 lines/);
    const cmdIdx = wake.indexOf("Command: ");
    const statsIdx = wake.indexOf("Stats: ");
    const lastIdx = wake.indexOf("Last output: ");
    assert.ok(
      cmdIdx !== -1 && cmdIdx < statsIdx && statsIdx < lastIdx,
      "Stats line sits between Command: and Last output:",
    );
  });
});
test("redactForSlug: credential values never reach a filename or status line", async () => {
  const mod: any = await loadModule();
  // Every credential SHAPE a shell command commonly carries. Each entry is
  // [command, substring that must NOT survive]. Regression guard for the
  // original too-narrow regex, which only caught `key: value` / `key=value`
  // with a short hard-coded key list and missed all of these.
  const leaks: [string, string][] = [
    // Header arguments (quoted, bare, `=`-joined). The X-Request-Id cases are
    // deliberately NOT secret-named, so ONLY the -H/--header rules can redact
    // them (otherwise the auth/assignment rules mask a broken header branch).
    ["curl -H 'X-Request-Id: abc123' https://x", "abc123"],
    ["curl --header 'X-Request-Id: abc123' https://x", "abc123"],
    ['curl --header="X-Request-Id: abc123" https://x', "abc123"],
    ["curl -H 'Authorization: Bearer abc123' https://x", "abc123"],
    ["curl --header 'Authorization: Basic abc123' https://x", "abc123"],
    ['curl --header="X-Session: abc123" https://x', "abc123"],
    // Auth scheme + credential in a bare (non-header) value.
    ["deploy Authorization: Bearer abc123", "abc123"],
    ["auth: Bearer abc123", "abc123"],
    // Underscore-prefixed env keys (no \b between `_` and the key word).
    ["GITHUB_TOKEN=ghp_abc123 git push", "ghp_abc123"],
    ["AWS_SECRET_ACCESS_KEY=abc123 aws s3 cp a b", "abc123"],
    ["NPM_TOKEN=npm_zzz npm publish", "npm_zzz"],
    ["env DB_PASSWORD=hunter2 ./run", "hunter2"],
    ["MYSQL_PWD=hunter2 mysql -u root", "hunter2"],
    // JSON (quotes around key and value).
    ['curl --data {"password":"hunter2"} https://x', "hunter2"],
    // Flag with a space (not `=`) and the `=` form.
    ["curl --api-key abc123 https://x", "abc123"],
    ["curl --api-key=abc123 https://x", "abc123"],
    ["mysql --password secret db", "secret"],
    ["deploy --token abc123", "abc123"],
    ["run --client-secret shhh", "shhh"],
    // URL userinfo and curl user:pass forms.
    ["git clone https://oauth2:glpat-abc@gitlab.com/x/y", "glpat-abc"],
    ["curl -u user:pass https://x", "user:pass"],
    ["curl --user user:pass https://x", "user:pass"],
  ];
  for (const [command, secret] of leaks) {
    const out = mod.redactForSlug(command);
    assert.ok(
      !out.includes(secret),
      `secret ${JSON.stringify(secret)} leaked: ${JSON.stringify(command)} -> ${JSON.stringify(out)}`,
    );
    assert.match(out, /REDACTED/, `redaction marker missing for ${command}`);
  }
  // Non-secret commands must be left ALONE — over-redaction mangles a slug.
  // `-h` (help) must NOT be treated as the case-sensitive `-H` header flag.
  for (const command of [
    "make test-short",
    "grep -h pattern file",
    "mkdir -p src/lib",
    "sort -u names.txt",
    "npm run build -- --watch",
    "timeout=30 node app.js",
    "author=AUTHOR_NAME deploy",
  ]) {
    assert.equal(
      mod.redactForSlug(command),
      command,
      `non-secret command was altered: ${command}`,
    );
  }
});

test("bgstatus: read-only — checking status does not append transcript entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  markJobsDir(dir);
  try {
    const id = `read-only-job-${Math.floor(Date.now() / 1000)}-${process.pid}`;
    const logPath = join(dir, `${id}.log`);
    // No exit marker yet — session_start sees a live pid (this process) and
    // keeps the reconstructed job as running.
    writeFileSync(logPath, "working…\n");

    const priorEntries = [
      {
        type: "custom",
        customType: "bgrun-job",
        data: {
          id,
          pid: process.pid,
          cmd: "sleep 999",
          name: undefined,
          started: Date.now(),
          logPath,
          state: "running",
        },
      },
    ];
    const { pi, entries, tools, ctx, fireSessionStart } = makeFakePi({
      priorEntries,
    });
    await loadExtension(pi);
    await fireSessionStart();

    const afterStart = entries.length;

    // The job finishes while pi is still up: marker lands in the log.
    writeFileSync(logPath, "working…\n\n__BGRUN_EXIT__=0\n");

    const bgstatus = tools.get("bgstatus")!;
    const res = await bgstatus.execute(
      "call-ro",
      { includeDone: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      res.content[0].text as string,
      /done exit=0/,
      "revalidation still reports the accurate done state",
    );
    assert.equal(
      entries.length,
      afterStart,
      "no transcript entry appended by a status check",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wake message: Stats line also present on a red (non-zero exit) run", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;

    await bgrun.execute(
      "call-stats2",
      { command: "echo failing; exit 7" },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 1);
    assert.match(wakes[0].text, /Stats: \d+\.\ds, \d+ lines/);
    assert.match(wakes[0].text, /exit 7/);
  });
});

test("wake message: missing log file — Stats shows duration only, wake still sent", async () => {
  await withJobsDir(async (dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;

    // Unlink the log while the job runs; at exit the file is gone.
    const res = await bgrun.execute(
      "call-stats3",
      { command: "sleep 0.3; echo late" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    rmSync(join(dir, `${id}.log`), { force: true });

    await waitForWakes(wakes, 1);
    const wake = wakes[0].text;
    assert.match(wake, /✅/);
    assert.match(wake, /Stats: \d+\.\ds$/m, "duration only, no lines");
    assert.ok(!wake.includes(" lines"), "unreadable log contributes nothing");
  });
});

// ── digest config + shipped presets (opt-in) ─────────────────────────────

function writeJson(filePath: string, obj: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(obj));
}

test("resolveConfig: digest resolves from a trusted project config", async () => {
  const mod: any = await loadModule();
  const proj = mkTmp("pi-bgrun-proj-");
  process.env.PI_BGRUN_USER_CONFIG = join(mkTmp("pi-bgrun-home-"), "user.json"); // does not exist
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: { preset: "go-test" },
    });
    const cfg = mod.resolveConfig({
      cwd: proj,
      isProjectTrusted: () => true,
    });
    // The legacy object form normalizes to a single entry with no matchers.
    assert.deepEqual(cfg.digest, [{ preset: "go-test" }]);
  } finally {
    process.env.PI_BGRUN_USER_CONFIG = TEST_USER_CONFIG;
    rmSync(proj, { recursive: true, force: true });
  }
});

test("resolveConfig: digest absent everywhere → undefined", async () => {
  const mod: any = await loadModule();
  process.env.PI_BGRUN_USER_CONFIG = join(mkTmp("pi-bgrun-home-"), "user.json");
  try {
    const cfg = mod.resolveConfig({});
    assert.equal(cfg.digest, undefined);
  } finally {
    process.env.PI_BGRUN_USER_CONFIG = TEST_USER_CONFIG;
  }
});

test("resolveConfig: untrusted project → no digest even when the project config has one", async () => {
  const mod: any = await loadModule();
  const proj = mkTmp("pi-bgrun-proj-");
  process.env.PI_BGRUN_USER_CONFIG = join(mkTmp("pi-bgrun-home-"), "user.json");
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: { preset: "go-test" },
    });
    // No isProjectTrusted on ctx at all.
    assert.equal(mod.resolveConfig({ cwd: proj }).digest, undefined);
    // Explicitly untrusted.
    assert.equal(
      mod.resolveConfig({ cwd: proj, isProjectTrusted: () => false }).digest,
      undefined,
    );
  } finally {
    process.env.PI_BGRUN_USER_CONFIG = TEST_USER_CONFIG;
    rmSync(proj, { recursive: true, force: true });
  }
});

test("resolveConfig: reads the project config from the resolved project root, not the session subdirectory", async () => {
  const mod: any = await loadModule();
  const proj = mkTmp("pi-bgrun-proj-");
  try {
    await withEnv("PI_BGRUN_DIR", undefined, () => {
      mkdirSync(join(proj, ".git"), { recursive: true });
      writeJson(join(proj, ".pi", "pi-bgrun.json"), {
        jobsDir: "var/bgrun-logs",
      });
      const sub = join(proj, "packages", "foo");
      mkdirSync(sub, { recursive: true });
      const cfg = mod.resolveConfig({
        cwd: sub,
        isProjectTrusted: () => true,
      });
      assert.equal(cfg.jobsDir, join(proj, "var", "bgrun-logs"));
      assert.equal(cfg.jobsDirProjectLocal, true);
    });
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("resolveConfig: layering — project digest replaces user digest wholesale; user used when project has none", async () => {
  const mod: any = await loadModule();
  const home = mkTmp("pi-bgrun-home-");
  const proj = mkTmp("pi-bgrun-proj-");
  process.env.PI_BGRUN_USER_CONFIG = join(home, "user.json");
  try {
    writeJson(join(home, "user.json"), {
      digest: { command: 'grep . "$1" | head -5' },
    });
    // No project digest → user digest stands.
    let cfg = mod.resolveConfig({ cwd: proj, isProjectTrusted: () => true });
    assert.deepEqual(cfg.digest, [{ command: 'grep . "$1" | head -5' }]);
    // Project digest → replaces the user's digest object entirely (per-key
    // merge on the digest object is a later question; keep it simple now).
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: { preset: "jest" },
    });
    cfg = mod.resolveConfig({ cwd: proj, isProjectTrusted: () => true });
    assert.deepEqual(cfg.digest, [{ preset: "jest" }]);
  } finally {
    process.env.PI_BGRUN_USER_CONFIG = TEST_USER_CONFIG;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("resolveConfig: invalid digest values dropped, valid ones kept (best-effort)", async () => {
  const mod: any = await loadModule();
  const proj = mkTmp("pi-bgrun-proj-");
  process.env.PI_BGRUN_USER_CONFIG = join(mkTmp("pi-bgrun-home-"), "user.json");
  try {
    // Both invalid → no digest at all.
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: { preset: "nonsense", command: 42 },
    });
    let cfg = mod.resolveConfig({ cwd: proj, isProjectTrusted: () => true });
    assert.equal(cfg.digest, undefined);
    // Invalid preset dropped, valid command kept.
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: { preset: "nonsense", command: 'grep x "$1" | head -3' },
    });
    cfg = mod.resolveConfig({ cwd: proj, isProjectTrusted: () => true });
    assert.deepEqual(cfg.digest, [{ command: 'grep x "$1" | head -3' }]);
    // Whitespace-only command is not a command.
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: { command: "   " },
    });
    cfg = mod.resolveConfig({ cwd: proj, isProjectTrusted: () => true });
    assert.equal(cfg.digest, undefined);
    // An array of non-entry scalars has no usable entries → undefined.
    writeJson(join(proj, ".pi", "pi-bgrun.json"), { digest: ["go-test"] });
    cfg = mod.resolveConfig({ cwd: proj, isProjectTrusted: () => true });
    assert.equal(cfg.digest, undefined);
    // A present-but-unusable section (wrong type) is unconfigured, not a crash.
    for (const bad of ["go-test", 42, true]) {
      writeJson(join(proj, ".pi", "pi-bgrun.json"), { digest: bad });
      cfg = mod.resolveConfig({ cwd: proj, isProjectTrusted: () => true });
      assert.equal(
        cfg.digest,
        undefined,
        `digest ${JSON.stringify(bad)} is ignored`,
      );
    }
    // Empty array and all-invalid arrays normalize to undefined (the nudge
    // checks `cfg.digest` truthiness).
    writeJson(join(proj, ".pi", "pi-bgrun.json"), { digest: [] });
    cfg = mod.resolveConfig({ cwd: proj, isProjectTrusted: () => true });
    assert.equal(cfg.digest, undefined);
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [{ preset: "nonsense" }, { command: 42 }, { match: {} }],
    });
    cfg = mod.resolveConfig({ cwd: proj, isProjectTrusted: () => true });
    assert.equal(cfg.digest, undefined);
  } finally {
    process.env.PI_BGRUN_USER_CONFIG = TEST_USER_CONFIG;
    rmSync(proj, { recursive: true, force: true });
  }
});

test("resolveConfig: digest label is trimmed and capped at 60", async () => {
  const mod: any = await loadModule();
  const proj = mkTmp("pi-bgrun-proj-");
  process.env.PI_BGRUN_USER_CONFIG = join(mkTmp("pi-bgrun-home-"), "user.json");
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [
        { label: "  spaced  ", command: "echo a" },
        { label: "x".repeat(100), command: "echo b" },
        { label: "   ", command: "echo c" },
      ],
    });
    const cfg = mod.resolveConfig({ cwd: proj, isProjectTrusted: () => true });
    assert.deepEqual(cfg.digest, [
      // leading/trailing whitespace trimmed.
      { label: "spaced", command: "echo a" },
      // over-long label capped at 60.
      { label: "x".repeat(60), command: "echo b" },
      // blank label dropped, entry kept.
      { command: "echo c" },
    ]);
  } finally {
    process.env.PI_BGRUN_USER_CONFIG = TEST_USER_CONFIG;
    rmSync(proj, { recursive: true, force: true });
  }
});

test("resolveConfig: digest type normalized; invalid type drops entry; match kept on a type entry", async () => {
  const mod: any = await loadModule();
  const proj = mkTmp("pi-bgrun-proj-");
  process.env.PI_BGRUN_USER_CONFIG = join(mkTmp("pi-bgrun-home-"), "user.json");
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [
        { type: "TEST", label: "t", command: "echo t" },
        { type: "test", match: { name: "x" }, command: "echo both" },
        { type: "z".repeat(45), command: "echo long" },
        { type: 42, command: "echo bad" },
        { type: "   ", command: "echo blank" },
        { command: "echo default" },
      ],
    });
    const cfg = mod.resolveConfig({
      cwd: proj,
      isProjectTrusted: () => true,
    });
    assert.deepEqual(cfg.digest, [
      // type lowercased, kept.
      { type: "test", label: "t", command: "echo t" },
      // match kept — type and match compose (AND).
      { type: "test", match: { name: "x" }, command: "echo both" },
      // over-long type capped to 40 (same cap the job side applies).
      { type: "z".repeat(40), command: "echo long" },
      // invalid + blank type entries dropped.
      { command: "echo default" },
    ]);
  } finally {
    process.env.PI_BGRUN_USER_CONFIG = TEST_USER_CONFIG;
    rmSync(proj, { recursive: true, force: true });
  }
});

test("resolveDigest: preset wins over command; normalization shapes", () => {
  const goTest = DIGEST_PRESETS.find((p) => p.id === "go-test")!;
  // Both configured → preset wins (curated beats hand-rolled).
  assert.equal(
    resolveDigest({ preset: "go-test", command: 'grep x "$1" | head -3' }),
    goTest.command,
  );
  // Command only.
  assert.equal(
    resolveDigest({ command: 'grep x "$1" | head -3' }),
    'grep x "$1" | head -3',
  );
  // Unknown preset (bypassing config validation) falls back to command,
  // else undefined.
  assert.equal(resolveDigest({ preset: "bogus", command: "x" }), "x");
  assert.equal(resolveDigest({ preset: "bogus" }), undefined);
  assert.equal(resolveDigest(undefined), undefined);
  assert.equal(resolveDigest({}), undefined);
});

// ── digest entry matching + selection (pure, multi-scorecard) ──────────────

test("entryMatchesJob: absent/empty match, name, command, and AND semantics", () => {
  const target = { name: "unit-tests", command: "go test ./..." };
  // No matcher / empty matcher → matches every job.
  assert.equal(entryMatchesJob({ preset: "go-test" }, target), true);
  assert.equal(entryMatchesJob({ match: {}, preset: "go-test" }, target), true);
  // Name glob: `*` is any run; a bare pattern is a whole-string match.
  assert.equal(
    entryMatchesJob({ match: { name: "unit-*" }, preset: "go-test" }, target),
    true,
  );
  assert.equal(
    entryMatchesJob({ match: { name: "e2e-*" }, preset: "go-test" }, target),
    false,
  );
  // A name matcher never matches a job that has no name.
  assert.equal(
    entryMatchesJob(
      { match: { name: "unit" }, preset: "go-test" },
      { command: "go test" },
    ),
    false,
  );
  // Command glob: substring needs explicit `*` on both sides.
  assert.equal(
    entryMatchesJob(
      { match: { command: "*cargo build*" }, preset: "go-test" },
      target,
    ),
    false,
  );
  assert.equal(
    entryMatchesJob(
      { match: { command: "*go test*" }, preset: "go-test" },
      target,
    ),
    true,
  );
  // Both present → AND.
  assert.equal(
    entryMatchesJob(
      { match: { name: "*unit*", command: "*go test*" }, preset: "go-test" },
      target,
    ),
    true,
  );
  assert.equal(
    entryMatchesJob(
      { match: { name: "*unit*", command: "*cargo*" }, preset: "go-test" },
      target,
    ),
    false,
  );
  // Glob, not regex: `[` is a literal character, so it matches only a literal
  // `[` — never throws, never a regex class.
  assert.equal(
    entryMatchesJob(
      { match: { name: "[" }, preset: "go-test" },
      { name: "unit-tests", command: "go test" },
    ),
    false,
  );
  assert.equal(
    entryMatchesJob(
      { match: { name: "[" }, preset: "go-test" },
      { name: "[", command: "go test" },
    ),
    true,
  );
});

test("selectDigestEntry: first match wins, default fallback, no match → undefined", () => {
  const goTest = DIGEST_PRESETS.find((p) => p.id === "go-test")!;
  const entries = [
    { match: { name: "unit-tests" }, preset: "go-test" },
    { match: { command: "*cargo build*" }, command: "echo build" },
    { preset: "jest" },
  ];
  // First entry matches by name.
  assert.deepEqual(
    selectDigestEntry(entries, { name: "unit-tests", command: "go test" }),
    { command: goTest.command, label: "unit-tests" },
  );
  // Second entry matches by command; no match.name and no preset → label
  // falls back to "command".
  assert.deepEqual(
    selectDigestEntry(entries, { command: "cargo build --release" }),
    { command: "echo build", label: "command" },
  );
  // Nothing matches the first two → the default entry (no match) wins and
  // labels itself with its preset id.
  assert.deepEqual(selectDigestEntry(entries, { command: "ls" }), {
    command: DIGEST_PRESETS.find((p) => p.id === "jest")!.command,
    label: "jest",
  });
  // No default entry → undefined.
  assert.equal(
    selectDigestEntry([{ match: { name: "x" }, preset: "go-test" }], {
      command: "ls",
    }),
    undefined,
  );
  // Unconfigured → undefined.
  assert.equal(selectDigestEntry(undefined, { command: "ls" }), undefined);
});

test("selectDigestEntry: label precedence (label → match.name → preset id/command)", () => {
  // Explicit label wins.
  assert.deepEqual(
    selectDigestEntry(
      [{ match: { name: "unit" }, label: "unit", command: "echo hi" }],
      { name: "unit", command: "go test" },
    ),
    { command: "echo hi", label: "unit" },
  );
  // No label → matched name.
  assert.deepEqual(
    selectDigestEntry([{ match: { name: "unit" }, command: "echo hi" }], {
      name: "unit",
      command: "go test",
    }),
    { command: "echo hi", label: "unit" },
  );
  // No label / no name matcher / no preset → "command".
  assert.deepEqual(
    selectDigestEntry([{ command: "echo hi" }], { command: "go test" }),
    { command: "echo hi", label: "command" },
  );
  // First-match-wins ordering: a later entry that also matches is ignored.
  assert.deepEqual(
    selectDigestEntry(
      [
        { match: { name: "unit" }, label: "first", command: "echo first" },
        { match: { name: "unit" }, label: "second", command: "echo second" },
      ],
      { name: "unit", command: "go test" },
    ),
    { command: "echo first", label: "first" },
  );
});

test("selectDigestEntry: a glob match.name labels the wake with wildcards stripped", () => {
  assert.deepEqual(
    selectDigestEntry([{ match: { name: "*cargo*" }, command: "echo hi" }], {
      name: "cargo-build",
      command: "cargo build --release",
    }),
    { command: "echo hi", label: "cargo" },
  );
  // A pattern that strips to nothing falls back to the preset id / "command".
  assert.deepEqual(
    selectDigestEntry([{ match: { name: "*" }, command: "echo hi" }], {
      name: "anything",
      command: "anything",
    }),
    { command: "echo hi", label: "command" },
  );
  // Escapes are unwrapped; the now-literal `*` is kept.
  assert.deepEqual(
    selectDigestEntry([{ match: { name: "e2e-\\*" }, command: "echo hi" }], {
      name: "e2e-*",
      command: "go test",
    }),
    { command: "echo hi", label: "e2e-*" },
  );
});

// ── type-first digest selection (job type declared at spawn) ──────────────

test("selectDigestEntry: type-first selection (exact, case-insensitive) + fallback", () => {
  const entries = [
    {
      match: { name: "unit" },
      label: "match-unit",
      command: "echo match-unit",
    },
    { type: "test", command: "echo type-test" },
    { label: "default", command: "echo default" },
  ];
  // A job declaring the type selects the type entry first, even though an
  // earlier match entry also matches.
  assert.deepEqual(
    selectDigestEntry(entries, {
      type: "test",
      name: "unit",
      command: "go test",
    }),
    { command: "echo type-test", label: "test" },
  );
  // Case-insensitive exact match.
  assert.deepEqual(
    selectDigestEntry(entries, { type: "TEST", command: "go test" }),
    { command: "echo type-test", label: "test" },
  );
  // A job type with no entry falls through to the match/default scan.
  assert.deepEqual(
    selectDigestEntry(entries, {
      type: "lint",
      name: "unit",
      command: "go test",
    }),
    { command: "echo match-unit", label: "match-unit" },
  );
  // No type at all: unchanged legacy behavior.
  assert.deepEqual(selectDigestEntry(entries, { command: "ls" }), {
    command: "echo default",
    label: "default",
  });
});

test("selectDigestEntry: type beats match entries regardless of config order", () => {
  const want = { command: "echo typed", label: "typed" };
  const matchFirst = [
    { match: { command: "go test" }, label: "match", command: "echo match" },
    { type: "test", label: "typed", command: "echo typed" },
  ];
  const typeFirst = [
    { type: "test", label: "typed", command: "echo typed" },
    { match: { command: "go test" }, label: "match", command: "echo match" },
  ];
  assert.deepEqual(
    selectDigestEntry(matchFirst, { type: "test", command: "go test" }),
    want,
  );
  assert.deepEqual(
    selectDigestEntry(typeFirst, { type: "test", command: "go test" }),
    want,
  );
});

test("selectDigestEntry: type + match compose (AND) on one entry", () => {
  const entries = [
    { type: "test", match: { name: "unit" }, command: "echo typed" },
  ];
  // Both selectors must match: type "test" AND name "unit".
  assert.deepEqual(
    selectDigestEntry(entries, {
      type: "test",
      name: "unit",
      command: "go test",
    }),
    { command: "echo typed", label: "test" },
  );
  // Type matches but the `match` does not → no selection (match is NOT
  // silently ignored).
  assert.equal(
    selectDigestEntry(entries, {
      type: "test",
      name: "e2e",
      command: "go test",
    }),
    undefined,
  );
  // A type entry with no match still selects on type alone.
  assert.deepEqual(
    selectDigestEntry([{ type: "test", command: "echo typed" }], {
      type: "test",
      name: "anything",
      command: "go test",
    }),
    { command: "echo typed", label: "test" },
  );
});

test("selectDigestEntry: label precedence for type entries (label → type)", () => {
  // Explicit label wins.
  assert.deepEqual(
    selectDigestEntry([{ type: "test", label: "unit", command: "echo hi" }], {
      type: "test",
      command: "go test",
    }),
    { command: "echo hi", label: "unit" },
  );
  // No label → the type string. (A valid type entry always has a non-empty
  // type, so the preset-id/"command" terminal default is unreachable here;
  // normalization guarantees that.)
  assert.deepEqual(
    selectDigestEntry([{ type: "test", command: "echo hi" }], {
      type: "test",
      command: "go test",
    }),
    { command: "echo hi", label: "test" },
  );
});

test("entryMatchesJob: glob is whole-string, case-insensitive, * and ? wildcards", () => {
  const target = { name: "unit-tests-run3", command: "go test ./..." };
  // A noisy name needs an explicit wildcard — a bare pattern is whole-string.
  assert.equal(
    entryMatchesJob(
      { match: { name: "*unit-tests*" }, preset: "go-test" },
      target,
    ),
    true,
  );
  // Case-insensitive.
  assert.equal(
    entryMatchesJob({ match: { name: "*UNIT*" }, preset: "go-test" }, target),
    true,
  );
  assert.equal(
    entryMatchesJob(
      { match: { command: "*GO TEST*" }, preset: "go-test" },
      target,
    ),
    true,
  );
  // A bare pattern matches the whole string only (no implicit substring).
  assert.equal(
    entryMatchesJob(
      { match: { name: "unit-tests" }, preset: "go-test" },
      target,
    ),
    false,
  );
  // `?` is exactly one character.
  assert.equal(
    entryMatchesJob(
      { match: { name: "unit-test?-run3" }, preset: "go-test" },
      target,
    ),
    true,
  );
  // `\` escapes a wildcard so it matches literally.
  assert.equal(
    entryMatchesJob(
      { match: { name: "unit\\*tests" }, preset: "go-test" },
      { name: "unit*tests", command: "go test" },
    ),
    true,
  );
  assert.equal(
    entryMatchesJob(
      { match: { name: "unit\\*tests" }, preset: "go-test" },
      { name: "unitXtests", command: "go test" },
    ),
    false,
  );
  // A non-matching pattern still fails.
  assert.equal(
    entryMatchesJob({ match: { name: "*e2e*" }, preset: "go-test" }, target),
    false,
  );
});

test("digestNoMatchWarning: names the job and the configured types", () => {
  const entries = [
    { type: "test", preset: "go-test" },
    { type: "build", command: "echo b" },
    { match: { name: "e2e" }, command: "echo e" },
  ];
  // Type mismatch — the common case, and the whole point of the diagnostic.
  assert.equal(
    digestNoMatchWarning({ type: "tests", command: "go test" }, entries),
    '[pi-bgrun] digest configured but selected no entry for job type "tests" — configured types: test, build',
  );
  // No type → fall back to the job name.
  assert.equal(
    digestNoMatchWarning({ name: "lint", command: "npm run lint" }, entries),
    '[pi-bgrun] digest configured but selected no entry for job name "lint" — configured types: test, build',
  );
  // No type or name → still a usable message (and no dangling types suffix).
  assert.equal(
    digestNoMatchWarning({ command: "ls" }, []),
    "[pi-bgrun] digest configured but selected no entry for a job with no type or name",
  );
});

// ── preset commands: scorecards against green and red fixture logs ─────────

// Runs a preset command exactly the way the wake path will (Phase 3):
// sh -c <command> digest <logPath>, so the log path arrives as $1.
function runPreset(presetId: string, log: string): string {
  const dir = mkTmp("pi-bgrun-preset-");
  try {
    const logPath = join(dir, "job.log");
    writeFileSync(logPath, log);
    const preset = DIGEST_PRESETS.find((p) => p.id === presetId)!;
    const res = spawnSync("sh", ["-c", preset.command, "digest", logPath], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(
      res.status,
      0,
      `${presetId} command should exit 0 (${res.stderr})`,
    );
    return res.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("preset go-test: green and red scorecards", () => {
  const green = runPreset(
    "go-test",
    [
      "=== RUN TestAlpha",
      "--- PASS: TestAlpha (0.00s)",
      "=== RUN TestBeta",
      "--- PASS: TestBeta (0.00s)",
      "PASS",
      "ok  \texample.com/a\t0.01s",
      "ok  \texample.com/b\t0.02s",
    ].join("\n"),
  );
  assert.match(green, /pass: 2 {2}fail: 0/);
  assert.ok(!green.includes("Beta"), "no failing names on green");

  const red = runPreset(
    "go-test",
    [
      "=== RUN TestAlpha",
      "--- PASS: TestAlpha (0.00s)",
      "=== RUN TestBeta",
      "--- FAIL: TestBeta (0.00s)",
      "    a_test.go:12: boom",
      "FAIL",
      "ok  \texample.com/a\t0.01s",
      "FAIL\texample.com/b\t0.02s",
    ].join("\n"),
  );
  assert.match(red, /pass: 1 {2}fail: 1/);
  assert.match(red, /^TestBeta$/m, "failing test name listed");
  assert.ok(!red.includes("Alpha"), "passing tests not listed");
});

test("preset jest: green and red scorecards", () => {
  const green = runPreset(
    "jest",
    [
      "PASS src/a.test.js",
      "Test Suites: 1 passed, 1 total",
      "Tests:       3 passed, 3 total",
    ].join("\n"),
  );
  assert.match(green, /Tests:\s+3 passed, 3 total/);
  assert.ok(!green.includes("failed"), "no failure mention on green");

  const red = runPreset(
    "jest",
    [
      "FAIL src/b.test.js",
      "  ● b does the thing",
      "",
      "  ✕ b other thing",
      "",
      "Test Suites: 1 failed, 1 passed, 2 total",
      "Tests:       1 failed, 2 passed, 3 total",
    ].join("\n"),
  );
  assert.match(red, /Tests:\s+1 failed, 2 passed, 3 total/);
  assert.match(red, /b does the thing/m, "failed test name listed");
  assert.match(red, /b other thing/m, "verbose-style failure listed");
});

test("preset pytest: green and red scorecards", () => {
  const green = runPreset(
    "pytest",
    [
      "tests/test_a.py ....                                              [100%]",
      "============================== 4 passed in 0.02s ==============================",
    ].join("\n"),
  );
  assert.match(green, /4 passed in 0\.02s/);
  assert.ok(!green.includes("failed"), "no failure mention on green");

  const red = runPreset(
    "pytest",
    [
      "tests/test_a.py F..                                               [ 75%]",
      "tests/test_b.py .E                                               [100%]",
      "=================================== FAILURES ===================================",
      "_________________________________ test_boom __________________________________",
      "E   assert False",
      "========================= 1 failed, 1 error, 3 passed in 0.05s =========================",
      "FAILED tests/test_a.py::test_boom - assert False",
      "ERROR tests/test_b.py::test_err - RuntimeError: boom",
    ].join("\n"),
  );
  assert.match(red, /1 failed, 1 error, 3 passed in 0\.05s/);
  assert.match(red, /tests\/test_a\.py::test_boom/m, "FAILED id listed");
});

test("preset junit-xml: green and red scorecards (real single-line pytest output)", () => {
  // pytest --junitxml emits the whole document on ONE line — the fixture
  // matches that, so the record-based awk is genuinely exercised.
  const green = runPreset(
    "junit-xml",
    '<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="3" time="0.01" timestamp="2024-01-01T00:00:00"><testcase classname="tests.test_a" name="test_ok" time="0.001" /><testcase classname="tests.test_a" name="test_ok2" time="0.002" /></testsuite></testsuites>',
  );
  assert.match(green, /failures: 0 {2}errors: 0/);
  assert.ok(!green.includes("test_ok"), "no testcase names on green");
  assert.ok(!green.includes("pytest"), "testsuite name is not reported");

  const red = runPreset(
    "junit-xml",
    '<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="1" failures="1" skipped="0" tests="3" time="0.01" timestamp="2024-01-01T00:00:00"><testcase classname="tests.test_a" name="test_boom" time="0.001"><failure message="assert False">E   assert False</failure></testcase><testcase classname="tests.test_a" name="test_err" time="0.001"><error message="boom">RuntimeError: boom</error></testcase><testcase classname="tests.test_a" name="test_ok" time="0.001" /></testsuite></testsuites>',
  );
  assert.match(red, /failures: 1 {2}errors: 1/);
  assert.match(red, /^test_boom$/m, "failing testcase name listed");
  assert.match(red, /^test_err$/m, "errored testcase name listed");
  // Regression (carper): with one-line XML the old line-based scan reported the
  // testsuite's own name, "pytest", instead of the failing test.
  assert.ok(!red.includes("pytest"), "testsuite name is not reported");
  assert.ok(!/^test_ok$/m.test(red), "passing testcase not listed");

  // Pretty-printed XML (attributes on their own line) must work too.
  const pretty = runPreset(
    "junit-xml",
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<testsuites name="pytest tests">',
      '  <testsuite name="pytest" tests="1" failures="1" errors="0">',
      "    <testcase",
      '      classname="tests.test_a"',
      '      name="test_boom"',
      '      time="0.001">',
      '      <failure message="assert False">E   assert False</failure>',
      "    </testcase>",
      "  </testsuite>",
      "</testsuites>",
    ].join("\n"),
  );
  assert.match(pretty, /failures: 1 {2}errors: 0/);
  assert.match(
    pretty,
    /^test_boom$/m,
    "pretty-printed XML also names the failure",
  );
  assert.ok(!pretty.includes("pytest"), "no testsuite name leak");
});

test("shipped presets: ids are stable and every command ends in head (bounded output)", () => {
  assert.deepEqual(DIGEST_PRESET_IDS, [
    "go-test",
    "jest",
    "pytest",
    "junit-xml",
  ]);
  for (const preset of DIGEST_PRESETS) {
    assert.match(
      preset.command,
      /\|\s*head -\d+$/,
      `${preset.id} command ends in head -N`,
    );
  }
});

test("shipped presets: README and digest-config skill document every preset id", () => {
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
  const skill = readFileSync(
    join(process.cwd(), "skill", "digest-config", "SKILL.md"),
    "utf8",
  );
  for (const id of DIGEST_PRESET_IDS) {
    assert.ok(readme.includes(id), `README documents ${id}`);
    assert.ok(skill.includes(id), `digest-config skill documents ${id}`);
  }
});

test("shipped presets: suggestedType is advisory metadata, not selection behavior", () => {
  // Every preset suggests a type (all are test runners today) ...
  for (const preset of DIGEST_PRESETS) {
    assert.equal(
      typeof preset.suggestedType,
      "string",
      `${preset.id} carries a suggestedType`,
    );
    assert.ok(
      preset.suggestedType.length > 0,
      `${preset.id} suggestion is non-empty`,
    );
  }
  // ... but a preset entry with no `type` still selects every job (a job with
  // no declared type included), so the suggestion never changes matching.
  const selected = selectDigestEntry([{ preset: "go-test" }], {
    command: "anything at all",
  });
  assert.ok(selected, "bare preset entry still matches a typeless job");
  assert.equal(selected.label, "go-test");
});

// ── wake wiring: digest appended to the wake message (Phase 3) ─────────────

// Isolated env for wake-wiring tests: temp jobsDir + a project dir with a
// `.pi/pi-bgrun.json` + a user config path that does not exist (so only the
// project layer can contribute a digest).
function setupDigestEnv(): { dir: string; proj: string; home: string } {
  const dir = mkTmp("pi-bgrun-test-");
  const proj = mkTmp("pi-bgrun-proj-");
  const home = mkTmp("pi-bgrun-home-");
  process.env.PI_BGRUN_DIR = dir;
  process.env.PI_BGRUN_USER_CONFIG = join(home, "user.json"); // does not exist
  return { dir, proj, home };
}

function teardownDigestEnv(dir: string, proj: string, home: string): void {
  delete process.env.PI_BGRUN_DIR;
  process.env.PI_BGRUN_USER_CONFIG = TEST_USER_CONFIG;
  rmSync(dir, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

// The fake ctx from makeFakePi has no cwd/isProjectTrusted; point it at the
// project so resolveConfig reads its config, with controllable trust.
function trustCtx(ctx: any, proj: string, trusted: boolean): any {
  ctx.cwd = proj;
  ctx.isProjectTrusted = () => trusted;
  return ctx;
}

function digestBlockOf(wake: string): string | null {
  const m = wake.match(/digest \([^)]*\): ([\s\S]*?)\nReview the result/);
  return m ? m[1] : null;
}

test("wake digest: preset scorecard appears on a green log", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: { preset: "go-test" },
    });
    const { pi, wakes, tools, ctx } = makeFakePi();
    trustCtx(ctx, proj, true);
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    await bgrun.execute(
      "call-dg1",
      {
        command:
          "printf 'ok  \\texample.com/a\\t0.01s\\nok  \\texample.com/b\\t0.02s\\n'",
      },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 1);
    const wake = wakes[0].text;
    const digest = digestBlockOf(wake);
    assert.ok(digest, "wake carries a digest block");
    assert.match(digest!, /pass: 2 {2}fail: 0/);
    assert.match(wake, /✅/);
    assert.match(wake, /exit 0/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: preset scorecard appears on a red log", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: { preset: "go-test" },
    });
    const { pi, wakes, tools, ctx } = makeFakePi();
    trustCtx(ctx, proj, true);
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    await bgrun.execute(
      "call-dg2",
      {
        command:
          // printf's format can't start with `--` (parsed as an option), so
          // use %s args; the tab is a literal character in the shell arg.
          "printf '%s\\n' '--- FAIL: TestBeta (0.00s)' 'FAIL\texample.com/b\t0.02s'; exit 1",
      },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 1);
    const wake = wakes[0].text;
    const digest = digestBlockOf(wake);
    assert.ok(digest, "wake carries a digest block");
    assert.match(digest!, /pass: 0 {2}fail: 1/);
    assert.match(digest!, /^TestBeta$/m);
    assert.match(wake, /❌/);
    assert.match(wake, /exit 1/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: custom command output appears (first lines)", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: { command: "sed -n '1,2p' \"$1\"" },
    });
    const { pi, wakes, tools, ctx } = makeFakePi();
    trustCtx(ctx, proj, true);
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    await bgrun.execute(
      "call-dg3",
      { command: "printf 'alpha\\nbeta\\ngamma\\n'" },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 1);
    const digest = digestBlockOf(wakes[0].text);
    assert.ok(digest, "wake carries a digest block");
    assert.equal(digest, "alpha\nbeta");
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: output capped at ~500 chars, first lines win", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: { command: 'cat "$1"' },
    });
    const { pi, wakes, tools, ctx } = makeFakePi();
    trustCtx(ctx, proj, true);
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    // 100 lines ≈ 780 chars of log — well past the 500-char digest budget.
    await bgrun.execute(
      "call-dg4",
      { command: "seq 1 100 | sed 's/^/line /'" },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 1);
    const digest = digestBlockOf(wakes[0].text);
    assert.ok(digest, "wake carries a digest block");
    assert.ok(
      digest!.length <= 500,
      `digest capped at 500 chars, got ${digest!.length}`,
    );
    assert.match(digest!, /^line 1$/m, "first line survives the cap");
    assert.ok(!digest!.includes("line 100"), "tail lines are cut");
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: hanging command times out silently, wake still arrives (~5s bound)", {
  timeout: 20000,
}, async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: { command: "sleep 30" },
    });
    const { pi, wakes, tools, ctx } = makeFakePi();
    trustCtx(ctx, proj, true);
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    const t0 = Date.now();
    await bgrun.execute(
      "call-dg5",
      { command: "echo quick" },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 1, 8000);
    const elapsed = Date.now() - t0;
    const wake = wakes[0].text;
    assert.ok(
      !wake.includes("digest ("),
      "timed-out digest contributes nothing",
    );
    assert.match(wake, /✅/);
    assert.match(wake, /exit 0/);
    assert.ok(
      elapsed < 7000,
      `wake arrived in ${elapsed}ms, within the ~5s digest bound + overhead`,
    );
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: failing digest command → no digest block, wake otherwise unchanged", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: { command: 'grep "NO-SUCH-STRING" "$1"' },
    });
    const { pi, wakes, tools, ctx } = makeFakePi();
    trustCtx(ctx, proj, true);
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    await bgrun.execute(
      "call-dg6",
      { command: "echo hello world" },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 1);
    const wake = wakes[0].text;
    assert.ok(!wake.includes("digest ("), "failing digest contributes nothing");
    assert.match(wake, /✅/);
    assert.match(wake, /exit 0/);
    assert.match(wake, /Last output: hello world/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: a digest that prints then exits non-zero contributes nothing", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: { command: "echo PARTIAL-OUTPUT; exit 1" },
    });
    const { pi, wakes, tools, ctx } = makeFakePi();
    trustCtx(ctx, proj, true);
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    await bgrun.execute(
      "call-dg-fail",
      { command: "echo hello world" },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 1);
    const wake = wakes[0].text;
    // Contract: an erroring digest appends nothing — even if it printed.
    assert.ok(!wake.includes("digest ("), "failed digest contributes nothing");
    assert.ok(!wake.includes("PARTIAL-OUTPUT"), "no partial digest output");
    assert.match(wake, /✅/);
    assert.match(wake, /Last output: hello world/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: no digest configured → wake shape unchanged (regression guard)", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    // No digest section written for proj at all.
    const { pi, wakes, tools, ctx } = makeFakePi();
    trustCtx(ctx, proj, true);
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    await bgrun.execute(
      "call-dg7",
      { command: "echo hello world" },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 1);
    const wake = wakes[0].text;
    const id = wake.match(/`([^`]+)`/)![1];
    const lines = wake.split("\n");
    // Pre-digest shape: exit line, Command, Stats (Phase 1), Last output,
    // Review instruction — exactly five lines, nothing appended.
    assert.equal(lines.length, 5);
    assert.equal(lines[0], `✅ Background job \`${id}\` finished (exit 0).`);
    assert.equal(lines[1], "Command: echo hello world");
    assert.match(lines[2], /^Stats: /);
    assert.equal(lines[3], "Last output: hello world");
    assert.equal(
      lines[4],
      "Review the result now: call `job` with action `tail` and this job id to see the output, summarize pass/fail, and continue the task that depended on it.",
    );
    assert.ok(!wake.includes("digest ("));
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: untrusted project → digest absent even when configured", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: { preset: "go-test" },
    });
    // Explicitly untrusted...
    {
      const { pi, wakes, tools, ctx } = makeFakePi();
      trustCtx(ctx, proj, false);
      await loadExtension(pi);
      const bgrun = tools.get("bgrun")!;
      await bgrun.execute(
        "call-dg8",
        { command: "echo hello world" },
        undefined,
        undefined,
        ctx,
      );
      await waitForWakes(wakes, 1);
      assert.ok(!wakes[0].text.includes("digest ("), "untrusted → no digest");
    }
    // ...and a ctx with no isProjectTrusted at all.
    {
      const { pi, wakes, tools, ctx } = makeFakePi();
      ctx.cwd = proj; // no isProjectTrusted — defaults to untrusted
      await loadExtension(pi);
      const bgrun = tools.get("bgrun")!;
      await bgrun.execute(
        "call-dg9",
        { command: "echo hello world" },
        undefined,
        undefined,
        ctx,
      );
      await waitForWakes(wakes, 1);
      assert.ok(
        !wakes[0].text.includes("digest ("),
        "no trust check → no digest",
      );
    }
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

// ── wake digest: multiple scorecards with per-job matching ────────────────

// Run one bgrun job against the shared digest env and return its wake text.
async function runDigestJob(
  proj: string,
  params: { command: string; name?: string; type?: string },
  id = "call-multi",
): Promise<string> {
  const { pi, wakes, tools, ctx } = makeFakePi();
  trustCtx(ctx, proj, true);
  await loadExtension(pi);
  const bgrun = tools.get("bgrun")!;
  await bgrun.execute(id, params, undefined, undefined, ctx);
  await waitForWakes(wakes, 1);
  return wakes[0].text;
}

// First line of any `digest (<label>): <body>` block.
function digestLineOf(wake: string): string | null {
  const m = wake.match(/^digest \([^)]*\): .*$/m);
  return m ? m[0] : null;
}

test("wake digest: match by job name chooses the matching entry", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [
        { match: { name: "unit-tests" }, preset: "go-test" },
        { label: "default", command: "echo default" },
      ],
    });
    const wake = await runDigestJob(proj, {
      name: "unit-tests",
      command: "printf 'ok  \\texample.com/a\\t0.01s\\n'",
    });
    const line = digestLineOf(wake);
    assert.ok(line, "wake carries a digest line");
    assert.match(
      line!,
      /^digest \(unit-tests\):/,
      "label falls back to match.name",
    );
    assert.match(line!, /pass: 1 {2}fail: 0/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: match by command line chooses the matching entry", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [
        {
          match: { command: "*cargo build*" },
          label: "build",
          command: "echo build-ok",
        },
        { label: "default", command: "echo default" },
      ],
    });
    // Keep the literal selector text in the command, but do not actually run
    // cargo — the command is really spawned, and a real toolchain is slow/flaky
    // on CI.
    const wake = await runDigestJob(proj, {
      command: 'echo "cargo build --release"',
    });
    const line = digestLineOf(wake);
    assert.ok(line, "wake carries a digest line");
    assert.match(line!, /^digest \(build\): build-ok$/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: first match wins when two entries both match", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [
        { label: "first", command: "echo first" },
        { label: "second", command: "echo second" },
      ],
    });
    const wake = await runDigestJob(proj, { command: "echo hi" });
    assert.match(digestLineOf(wake)!, /^digest \(first\): first$/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: default entry used when no matcher matches", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [
        { match: { name: "e2e" }, command: "echo e2e" },
        { label: "fallback", command: "echo fallback" },
      ],
    });
    const wake = await runDigestJob(proj, {
      name: "unit-tests",
      command: "echo hi",
    });
    assert.match(digestLineOf(wake)!, /^digest \(fallback\): fallback$/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: no entry matches and no default → no digest block", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [{ match: { name: "e2e" }, command: "echo e2e" }],
    });
    const wake = await runDigestJob(proj, {
      name: "unit-tests",
      command: "echo hi",
    });
    assert.equal(digestLineOf(wake), null);
    assert.match(wake, /✅/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: non-matching literal entry skipped, later entry used", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [
        // `[` is a literal glob char, not a regex class — it just won't match.
        { match: { name: "[" }, label: "broken", command: "echo broken" },
        { label: "ok", command: "echo ok" },
      ],
    });
    const wake = await runDigestJob(proj, {
      name: "unit-tests",
      command: "echo hi",
    });
    assert.match(digestLineOf(wake)!, /^digest \(ok\): ok$/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: empty array config produces no digest block", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), { digest: [] });
    const wake = await runDigestJob(proj, { command: "echo hi" });
    assert.equal(digestLineOf(wake), null);
    assert.match(wake, /✅/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: type + match compose end-to-end (normalization keeps match)", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [
        {
          type: "test",
          match: { name: "*unit*" },
          label: "unit",
          command: "echo unit",
        },
        { type: "test", label: "any-test", command: "echo any" },
      ],
    });
    // type "test" AND name matches "unit" → first entry.
    let wake = await runDigestJob(proj, {
      type: "test",
      name: "unit-tests",
      command: "echo hi",
    });
    assert.match(digestLineOf(wake)!, /^digest \(unit\): unit$/);
    // type "test" but name does not match → second entry proves `match` is
    // kept (not dropped) on a type entry.
    wake = await runDigestJob(proj, {
      type: "test",
      name: "other",
      command: "echo hi",
    });
    assert.match(digestLineOf(wake)!, /^digest \(any-test\): any$/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: over-long config type matches an over-long job type (shared 40-char cap)", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    const longType = "t".repeat(45);
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [{ type: longType, label: "long", command: "echo long" }],
    });
    const wake = await runDigestJob(proj, {
      type: longType,
      command: "echo hi",
    });
    assert.match(digestLineOf(wake)!, /^digest \(long\): long$/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

// ── wake digest: type-first selection ──────────────────────────────────────

test("wake digest: job type selects the matching type entry (digest (test))", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [
        { type: "test", preset: "go-test" },
        { type: "build", label: "build", command: "echo build-ok" },
      ],
    });
    const wake = await runDigestJob(proj, {
      type: "test",
      command: "printf 'ok  \\texample.com/a\\t0.01s\\n'",
    });
    const line = digestLineOf(wake);
    assert.ok(line, "wake carries a digest line");
    assert.match(
      line!,
      /^digest \(test\):/,
      "label falls back to the type string",
    );
    assert.match(line!, /pass: 1 {2}fail: 0/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

// Split into three tests: each spawns a real job, and bundling three into one
// blew bun's 5s per-test budget on a loaded CI runner.
const CASE_INSENSITIVE_DIGEST = [
  { type: "test", label: "typed-test", command: "echo typed" },
  { match: { command: "*run*" }, label: "match", command: "echo match" },
  { label: "default", command: "echo default" },
];

test("wake digest: type match is case-insensitive", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: CASE_INSENSITIVE_DIGEST,
    });
    const wake = await runDigestJob(proj, {
      type: "TEST",
      command: "echo hi",
    });
    assert.match(digestLineOf(wake)!, /^digest \(typed-test\): typed$/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: unknown type falls through to a match entry", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: CASE_INSENSITIVE_DIGEST,
    });
    // The command must MATCH `*run*` (the entry selector) but must also be
    // cheap to actually spawn — `npm run lint` runs for real and made this
    // test wait on npm startup (~1.6s locally, >5s on CI).
    const wake = await runDigestJob(proj, {
      type: "lint",
      command: "echo run",
    });
    assert.match(digestLineOf(wake)!, /^digest \(match\): match$/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: unknown type with no match uses the default entry", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: CASE_INSENSITIVE_DIGEST,
    });
    const wake = await runDigestJob(proj, { type: "lint", command: "ls" });
    assert.match(digestLineOf(wake)!, /^digest \(default\): default$/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: type entry beats an earlier match entry (type-first order)", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [
        {
          match: { command: "*go test*" },
          label: "match",
          command: "echo match",
        },
        { type: "test", label: "typed", command: "echo typed" },
      ],
    });
    const wake = await runDigestJob(proj, {
      type: "test",
      command: 'echo "go test ./..."',
    });
    assert.match(digestLineOf(wake)!, /^digest \(typed\): typed$/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("wake digest: invalid type entry dropped, other entries still work", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [
        { type: 7, command: "echo broken" },
        { type: "test", label: "typed", command: "echo typed" },
      ],
    });
    const wake = await runDigestJob(proj, { type: "test", command: "echo hi" });
    assert.match(digestLineOf(wake)!, /^digest \(typed\): typed$/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("bgrun: type and wake policy survive entry persistence and reconstruction", async () => {
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, entries, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const res = await bgrun.execute(
      "call-ty1",
      {
        command: "echo typed; exit 1",
        name: "unit-tests",
        type: "Test",
        wake: "failure",
      },
      undefined,
      undefined,
      ctx,
    );
    const started = res.content[0].text as string;
    const id = (started.match(/^started: ([^\n]+)/) || [])[1];
    assert.ok(id, "got a job id");
    assert.match(started, /^ {2}name: unit-tests$/m);
    // Types are lowercase-normalized so selection is an exact compare.
    assert.match(started, /^ {2}type: test$/m);
    assert.match(started, /^ {2}wake: failure$/m);
    assert.equal((res.details as any).type, "test");
    assert.equal((res.details as any).wake, "failure");
    await waitForWakes(wakes, 1);

    // The persisted done entry carries the type.
    const done = entries.filter((e) => e.customType === "bgrun-job").at(-1);
    assert.equal(done?.data?.type, "test");
    assert.equal(done?.data?.wake, "failure");

    // Resume: a fresh instance reconstructs the in-memory map from entries.
    const {
      pi: pi2,
      tools: tools2,
      ctx: ctx2,
      fireSessionStart,
    } = makeFakePi({ priorEntries: entries });
    await loadExtension(pi2);
    await fireSessionStart();
    const bgstatus2 = tools2.get("bgstatus")!;
    const status = await bgstatus2.execute(
      "call-ty2",
      { id },
      undefined,
      undefined,
      ctx2,
    );
    const text = status.content[0].text as string;
    assert.match(
      text,
      /^ {2}type: test$/m,
      "reconstructed record carries the type",
    );
    assert.equal((status.details as any).type, "test");
    assert.match(text, /^ {2}wake: failure$/m);
    assert.equal((status.details as any).wake, "failure");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_shutdown: detached completion is reconciled by the active session without stale callbacks", async () => {
  await withJobsDir(async (dir, h) => {
    const { entries, wakes, tools, ctx, fireSessionShutdown } = h;
    const bgrun = tools.get("bgrun")!;
    const result = await bgrun.execute(
      "reload-race",
      { command: "sleep 0.15; echo after-reload", wake: "always" },
      undefined,
      undefined,
      ctx,
    );
    const id = (result.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    const logPath = join(dir, `${id}.log`);

    await fireSessionShutdown();
    await waitForLogExit(logPath);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(wakes.length, 0, "disposed generation did not wake the agent");
    assert.equal(
      entries.filter((entry) => entry.data?.id === id).length,
      1,
      "disposed generation persisted only the running entry",
    );

    const replacement = makeFakePi({ priorEntries: entries });
    await loadExtension(replacement.pi);
    await replacement.fireSessionStart();
    const records = replacement.entries.filter((entry) => entry.data?.id === id);
    assert.equal(records.length, 2, "active generation reconciled completion once");
    assert.equal(records[1].data?.state, "done");
    assert.equal(records[1].data?.exitCode, 0);
  });
});

test("session_shutdown: sweeps this session's old logs and does not throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, tools, ctx, fireSessionStart, fireSessionShutdown } =
      makeFakePi();
    await loadExtension(pi);
    await fireSessionStart();

    const bgrun = tools.get("bgrun")!;
    const res = await bgrun.execute(
      "call-shutdown",
      { command: "true" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)?.[1];
    assert.ok(id, "got job id");
    await waitForWakes(wakes, 1);
    const logPath = join(dir, `${id}.log`);
    assert.ok(existsSync(logPath), "log exists before shutdown");

    // Backdate so retention (default 7d) considers it old.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(logPath, old, old);

    await fireSessionShutdown();
    assert.ok(!existsSync(logPath), "old log swept on session_shutdown");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgrun: no type → no type line in the started result", async () => {
  await withJobsDir(async (_dir, h) => {
    const { tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const res = await bgrun.execute(
      "call-ty3",
      { command: "echo plain" },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(!(res.content[0].text as string).includes("type:"));
    assert.equal((res.details as any).type, undefined);
  });
});

// ── digest nudge: one-shot session_start toast ────────────────────────────

// Real exported paths — no local mirror to drift from the implementation.
const usageMarker = jobUsageMarkerPath;
const nudgeMarker = digestNudgeMarkerPath;

function writeUsageMarker(jobsDir: string, projectDir: string): void {
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(usageMarker(jobsDir, projectDir), "1");
}

function captureNotify(ctx: any): string[] {
  const messages: string[] = [];
  ctx.hasUI = true;
  ctx.ui.notify = (text: string) => {
    messages.push(text);
  };
  return messages;
}

test("digest nudge: fires on session_start (trusted, no digest, usage marker set) and writes the marker", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeUsageMarker(dir, proj);
    const { pi, ctx, fireSessionStart } = makeFakePi();
    trustCtx(ctx, proj, true);
    const messages = captureNotify(ctx);
    await loadExtension(pi);
    await fireSessionStart();

    assert.deepEqual(messages, [DIGEST_NUDGE_TEXT]);
    assert.ok(existsSync(nudgeMarker(dir, proj)), "marker file created");
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("digest nudge: silent when a digest IS configured (marker untouched)", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: { preset: "go-test" },
    });
    writeUsageMarker(dir, proj);
    const { pi, ctx, fireSessionStart } = makeFakePi();
    trustCtx(ctx, proj, true);
    const messages = captureNotify(ctx);
    await loadExtension(pi);
    await fireSessionStart();

    assert.deepEqual(messages, [], "no toast when a digest is configured");
    assert.ok(!existsSync(nudgeMarker(dir, proj)), "no marker written");
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("digest nudge: silent when the project is untrusted", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeUsageMarker(dir, proj);
    const { pi, ctx, fireSessionStart } = makeFakePi();
    trustCtx(ctx, proj, false);
    const messages = captureNotify(ctx);
    await loadExtension(pi);
    await fireSessionStart();

    assert.deepEqual(messages, [], "untrusted project → no toast");
    assert.ok(!existsSync(nudgeMarker(dir, proj)), "no marker written");
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("digest nudge: silent when the project has no usage marker", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    // No `.bgrun-used-*` marker for this project → no evidence of use.
    const { pi, ctx, fireSessionStart } = makeFakePi();
    trustCtx(ctx, proj, true);
    const messages = captureNotify(ctx);
    await loadExtension(pi);
    await fireSessionStart();

    assert.deepEqual(messages, [], "no done jobs → no toast");
    assert.ok(!existsSync(nudgeMarker(dir, proj)), "no marker written");
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("digest nudge: silent when the marker file already exists", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeUsageMarker(dir, proj);
    writeFileSync(nudgeMarker(dir, proj), "1717000000000");
    const { pi, ctx, fireSessionStart } = makeFakePi();
    trustCtx(ctx, proj, true);
    const messages = captureNotify(ctx);
    await loadExtension(pi);
    await fireSessionStart();

    assert.deepEqual(messages, [], "marker present → stay silent");
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("digest nudge: a throwing ui.notify does not break session_start", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeUsageMarker(dir, proj);
    const { pi, ctx, fireSessionStart } = makeFakePi();
    trustCtx(ctx, proj, true);
    ctx.hasUI = true;
    ctx.ui.notify = () => {
      throw new Error("toast exploded");
    };
    await loadExtension(pi);
    await fireSessionStart(); // must not throw

    // The failed toast counts as "not nudged" — the marker is intentionally
    // not written, so the next session can try again. Session_start is intact.
    assert.ok(!existsSync(nudgeMarker(dir, proj)));
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("digest nudge: marker is per-project — a second project sharing the jobs dir still gets nudged", async () => {
  const { dir, proj, home } = setupDigestEnv();
  const proj2 = mkTmp("pi-bgrun-proj-");
  try {
    writeUsageMarker(dir, proj);
    writeUsageMarker(dir, proj2);

    // First project: nudged, writes its own marker.
    {
      const { pi, ctx, fireSessionStart } = makeFakePi();
      trustCtx(ctx, proj, true);
      const messages = captureNotify(ctx);
      await loadExtension(pi);
      await fireSessionStart();
      assert.deepEqual(messages, [DIGEST_NUDGE_TEXT]);
      assert.ok(existsSync(nudgeMarker(dir, proj)), "project 1 marker written");
    }

    // Second project on the same shared jobs dir is not silenced by project 1.
    {
      const { pi, ctx, fireSessionStart } = makeFakePi();
      trustCtx(ctx, proj2, true);
      const messages = captureNotify(ctx);
      await loadExtension(pi);
      await fireSessionStart();
      assert.deepEqual(
        messages,
        [DIGEST_NUDGE_TEXT],
        "each project gets its own one-shot nudge",
      );
      assert.ok(
        existsSync(nudgeMarker(dir, proj2)),
        "project 2 marker written",
      );
    }
  } finally {
    rmSync(proj2, { recursive: true, force: true });
    teardownDigestEnv(dir, proj, home);
  }
});

test("digest nudge: keys the usage marker by project root, so any cwd in the checkout counts", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    // A real project root plus a nested cwd inside it.
    mkdirSync(join(proj, ".git"), { recursive: true });
    const sub = join(proj, "packages", "foo");
    mkdirSync(sub, { recursive: true });
    writeUsageMarker(dir, proj); // evidence was written at the project root

    const { pi, ctx, fireSessionStart } = makeFakePi();
    trustCtx(ctx, sub, true); // session started in the subdirectory
    const messages = captureNotify(ctx);
    await loadExtension(pi);
    await fireSessionStart();

    assert.deepEqual(messages, [DIGEST_NUDGE_TEXT]);
    assert.ok(
      existsSync(nudgeMarker(dir, proj)),
      "nudge marker keyed by the project root, not the raw cwd",
    );
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("digest nudge: a bgrun in a nested cwd writes the usage marker at the project root, so session_start nudges", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    const sub = join(proj, "packages", "foo");
    mkdirSync(sub, { recursive: true });

    // Spawn a real job from the nested cwd — the marker write must key by the
    // project root, not the raw cwd.
    {
      const { pi, wakes, tools, ctx } = makeFakePi();
      trustCtx(ctx, sub, true);
      await loadExtension(pi);
      const bgrun = tools.get("bgrun")!;
      await bgrun.execute(
        "call-nested",
        { command: "echo nested" },
        undefined,
        undefined,
        ctx,
      );
      await waitForWakes(wakes, 1);
      assert.ok(
        existsSync(usageMarker(dir, proj)),
        "spawn-side marker keyed by the project root",
      );
    }

    // A later session_start at the same nested cwd must fire the nudge.
    const { pi, ctx, fireSessionStart } = makeFakePi();
    trustCtx(ctx, sub, true);
    const messages = captureNotify(ctx);
    await loadExtension(pi);
    await fireSessionStart();
    assert.deepEqual(messages, [DIGEST_NUDGE_TEXT]);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("resolveConfig: project config is honored only when the project is trusted", async () => {
  const mod: any = await loadModule();
  const proj = mkdtempSync(join(tmpdir(), "pi-bgrun-proj-"));
  const userCfg = join(
    mkdtempSync(join(tmpdir(), "pi-bgrun-user-")),
    "none.json",
  );
  try {
    await withEnv("PI_BGRUN_DIR", undefined, () => {
      mkdirSync(join(proj, ".pi"), { recursive: true });
      writeFileSync(
        join(proj, ".pi", "pi-bgrun.json"),
        JSON.stringify({
          cleanupDays: 42,
          adoptForeignJobs: true,
          globalAutoClean: false,
          showCompletedJobs: true,
        }),
      );

      const untrusted = mod.resolveConfig({
        cwd: proj,
        isProjectTrusted: () => false,
        userConfigPath: userCfg,
      });
      assert.equal(untrusted.cleanupDays, 7, "untrusted: default retention");
      assert.equal(
        untrusted.adoptForeignJobs,
        false,
        "untrusted: default adopt",
      );

      const trusted = mod.resolveConfig({
        cwd: proj,
        isProjectTrusted: () => true,
        userConfigPath: userCfg,
      });
      assert.equal(trusted.cleanupDays, 42, "trusted: file retention applied");
      assert.equal(trusted.adoptForeignJobs, true, "trusted: adoptForeignJobs");
      assert.equal(trusted.globalAutoClean, false, "trusted: globalAutoClean");
      assert.equal(
        trusted.showCompletedJobs,
        true,
        "trusted: showCompletedJobs",
      );
    });
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("resolveConfig: user file applies; project file overrides it key-by-key", async () => {
  const mod: any = await loadModule();
  const proj = mkdtempSync(join(tmpdir(), "pi-bgrun-proj-"));
  const userDir = mkdtempSync(join(tmpdir(), "pi-bgrun-user-"));
  const userCfg = join(userDir, "pi-bgrun.json");
  try {
    await withEnv("PI_BGRUN_DIR", undefined, () => {
      writeFileSync(
        userCfg,
        JSON.stringify({ cleanupDays: 5, globalAutoClean: false }),
      );
      mkdirSync(join(proj, ".pi"), { recursive: true });
      writeFileSync(
        join(proj, ".pi", "pi-bgrun.json"),
        JSON.stringify({ cleanupDays: 11 }),
      );

      const trusted = mod.resolveConfig({
        cwd: proj,
        isProjectTrusted: () => true,
        userConfigPath: userCfg,
      });
      assert.equal(
        trusted.cleanupDays,
        11,
        "project overrides the same user key",
      );
      assert.equal(
        trusted.globalAutoClean,
        false,
        "user keys absent from the project file survive",
      );

      // Untrusted project: its file is skipped, the user file still applies.
      const untrusted = mod.resolveConfig({
        cwd: proj,
        isProjectTrusted: () => false,
        userConfigPath: userCfg,
      });
      assert.equal(untrusted.cleanupDays, 5, "untrusted: user value used");
      assert.equal(
        untrusted.globalAutoClean,
        false,
        "untrusted: user value used",
      );
    });
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});

test("resolveConfig: env vars override config files", async () => {
  const mod: any = await loadModule();
  const proj = mkdtempSync(join(tmpdir(), "pi-bgrun-proj-"));
  const userDir = mkdtempSync(join(tmpdir(), "pi-bgrun-user-"));
  const userCfg = join(userDir, "pi-bgrun.json");
  const prevDir = process.env.PI_BGRUN_DIR;
  const prevDays = process.env.PI_BGRUN_CLEANUP_DAYS;
  const prevWake = process.env.PI_BGRUN_WAKE;
  delete process.env.PI_BGRUN_DIR;
  try {
    writeFileSync(
      userCfg,
      JSON.stringify({ cleanupDays: 11, defaultWake: "failure" }),
    );
    process.env.PI_BGRUN_CLEANUP_DAYS = "3";
    process.env.PI_BGRUN_WAKE = "never";

    const cfg = mod.resolveConfig({
      cwd: proj,
      isProjectTrusted: () => true,
      userConfigPath: userCfg,
    });
    assert.equal(cfg.cleanupDays, 3, "env beats both config files");
    assert.equal(cfg.defaultWake, "never", "wake env beats config file");
  } finally {
    if (prevDir !== undefined) process.env.PI_BGRUN_DIR = prevDir;
    if (prevDays === undefined) delete process.env.PI_BGRUN_CLEANUP_DAYS;
    else process.env.PI_BGRUN_CLEANUP_DAYS = prevDays;
    if (prevWake === undefined) delete process.env.PI_BGRUN_WAKE;
    else process.env.PI_BGRUN_WAKE = prevWake;
    rmSync(proj, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});

test("resolveConfig: malformed JSON is ignored with a warning, not a throw", async () => {
  const mod: any = await loadModule();
  const proj = mkdtempSync(join(tmpdir(), "pi-bgrun-proj-"));
  const userDir = mkdtempSync(join(tmpdir(), "pi-bgrun-user-"));
  const userCfg = join(userDir, "pi-bgrun.json");
  const prevDir = process.env.PI_BGRUN_DIR;
  delete process.env.PI_BGRUN_DIR;
  const originalError = console.error;
  const warnings: string[] = [];
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    writeFileSync(userCfg, "{ not json");

    const cfg = mod.resolveConfig({
      cwd: proj,
      isProjectTrusted: () => true,
      userConfigPath: userCfg,
    });
    assert.equal(cfg.cleanupDays, 7, "falls back to defaults");
    assert.ok(
      warnings.some((w) => w.includes("malformed")),
      "a malformed-config warning is emitted",
    );
  } finally {
    console.error = originalError;
    if (prevDir !== undefined) process.env.PI_BGRUN_DIR = prevDir;
    rmSync(proj, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});
test("bgstatus <id>: reports done from the log when the in-memory record lags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  markJobsDir(dir);
  try {
    const id = `lag-job-${Math.floor(Date.now() / 1000)}-${process.pid}`;
    const logPath = join(dir, `${id}.log`);
    writeFileSync(logPath, "working…\n");

    const priorEntries = [
      {
        type: "custom",
        customType: "bgrun-job",
        data: {
          id,
          pid: process.pid,
          cmd: "sleep 999",
          started: Date.now(),
          logPath,
          state: "running",
        },
      },
    ];
    const { pi, tools, ctx, fireSessionStart } = makeFakePi({ priorEntries });
    await loadExtension(pi);
    await fireSessionStart();

    // The job finishes (marker lands) but no child 'exit' event exists for a
    // reconstructed record — by-id must derive done from the log/pid rather
    // than reporting "running" until the next poll tick.
    writeFileSync(logPath, "working…\n\n__BGRUN_EXIT__=0\n");

    const bgstatus = tools.get("bgstatus")!;
    const res = await bgstatus.execute(
      "call-lag",
      { id },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      res.content[0].text as string,
      /done exit=0/,
      "by-id reflects the log, not the stale in-memory record",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("entry renderer: bgrun-job renders running and done/expanded without throwing", async () => {
  const { pi, entryRenderers } = makeFakePi();
  await loadExtension(pi);
  const render = entryRenderers.get("bgrun-job");
  assert.ok(render, "a renderer is registered for bgrun-job");
  // Minimal theme stub: the renderer only calls fg()/bg() for styling.
  const theme = {
    bg: (_key: string, text: string) => text,
    fg: (_key: string, text: string) => text,
  };
  const base = {
    id: "render-job-1",
    cmd: "make test",
    started: Date.now(),
    logPath: "/tmp/render-job-1.log",
  };
  const running = render({ data: { ...base, state: "running" } }, {}, theme);
  assert.ok(running, "running entry renders");
  const done = render(
    { data: { ...base, state: "done", exitCode: 0, exitedAt: Date.now() } },
    { expanded: true },
    theme,
  );
  assert.ok(done, "done + expanded entry renders");
});
test("bggrep: the match budget trips and reports an error (timeout plumbing)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  process.env.PI_BGRUN_GREP_TIMEOUT_MS = "1"; // force the budget to trip
  markJobsDir(dir);
  try {
    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const id = `grep-budget-${Math.floor(Date.now() / 1000)}-${process.pid}`;
    writeFileSync(join(dir, `${id}.log`), "alpha\nbeta\ngamma\n");
    const bggrep = tools.get("bggrep")!;
    const t0 = Date.now();
    const res = await bggrep.execute(
      "c",
      { id, pattern: "(a+)+$" },
      undefined,
      undefined,
      ctx,
    );
    const elapsed = Date.now() - t0;
    assert.equal(res.isError, true, "budget exceeded is an error result");
    assert.match(
      res.content[0].text as string,
      /match budget/,
      "explains the budget was exceeded",
    );
    assert.ok(elapsed < 5_000, `returned within budget (${elapsed}ms)`);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_GREP_TIMEOUT_MS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bggrepTimeoutMs: falls back to the default for missing/invalid values", async () => {
  const mod: any = await loadModule();
  delete process.env.PI_BGRUN_GREP_TIMEOUT_MS;
  assert.equal(mod.bggrepTimeoutMs(), 2_000, "default when unset");
  process.env.PI_BGRUN_GREP_TIMEOUT_MS = "0";
  assert.equal(mod.bggrepTimeoutMs(), 2_000, "non-positive falls back");
  process.env.PI_BGRUN_GREP_TIMEOUT_MS = "nope";
  assert.equal(mod.bggrepTimeoutMs(), 2_000, "non-numeric falls back");
  process.env.PI_BGRUN_GREP_TIMEOUT_MS = "250";
  assert.equal(mod.bggrepTimeoutMs(), 250, "valid override honored");
  delete process.env.PI_BGRUN_GREP_TIMEOUT_MS;
});
test("bgstatus <id>: unknown id errors, and a log-only job recovers as done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  markJobsDir(dir);
  try {
    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgstatus = tools.get("bgstatus")!;

    const missing = await bgstatus.execute(
      "c1",
      { id: "ghost-1-999999" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(missing.isError, true, "unknown id is an error");
    assert.match(
      missing.content[0].text as string,
      /No job found with id/,
      "unknown id explains itself",
    );

    const id = `recovered-${Math.floor(Date.now() / 1000)}-${process.pid}`;
    writeFileSync(
      join(dir, `${id}.log`),
      "did the thing\n\n__BGRUN_EXIT__=0\n",
    );
    const done = await bgstatus.execute(
      "c2",
      { id },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      done.content[0].text as string,
      /done exit=0 \(recovered from log\)/,
      "log-only job recovers as done",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("jobs dir: .tmp-*.log staging files are skipped as jobs and swept when stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  markJobsDir(dir);
  try {
    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const tmp = join(dir, ".tmp-build-1-deadbeef.log");
    writeFileSync(tmp, "half-written");
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(tmp, old, old);

    const list = await tools
      .get("bgstatus")!
      .execute("c1", {}, undefined, undefined, ctx);
    assert.ok(
      !(list.content[0].text as string).includes(".tmp-build-1-deadbeef"),
      "staging file is not listed as a job",
    );

    await tools
      .get("bgclean")!
      .execute("c2", { days: 1, all: true }, undefined, undefined, ctx);
    assert.ok(!existsSync(tmp), "stale staging file is reclaimed");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bggrep: a pathological regex returns within the budget instead of hanging", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  markJobsDir(dir);
  try {
    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const id = `patho-${Math.floor(Date.now() / 1000)}-${process.pid}`;
    // Classic catastrophic-backtracking input for `^(a+)+$` — and the failing
    // character has to sit INSIDE the per-line cap (BGGREP_LINE_CAP = 10 000),
    // or the pre-match truncation removes it and the pattern matches instantly
    // (measured: a 60 000-char line whose `!` lands past the cap matches in 0ms
    // on BOTH engines, which made this test vacuous).
    writeFileSync(
      join(dir, `${id}.log`),
      "a".repeat(9_000) + "!" + "a".repeat(50_000) + "\n",
    );
    const t0 = Date.now();
    const res = await tools
      .get("bggrep")!
      .execute("c", { id, pattern: "^(a+)+$" }, undefined, undefined, ctx);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5_000, `bounded by the budget (${elapsed}ms)`);
    // Engine-dependent by nature: V8 backtracks here and the budget must trip
    // (see the abort-path test for that branch); JSC answers in ~250ms without
    // backtracking. Both are acceptable — hanging is not.
    assert.ok(
      res.isError === true || typeof res.content[0].text === "string",
      "returns a result (no hang, no throw)",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start: a reconstructed done job is not re-persisted on every resume", async () => {
  // Regression: reconstructed done records were re-appended on each resume
  // (exitCode set but donePersisted unset), so the transcript grew a duplicate
  // done card per restart.
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  try {
    const id = `resume-done-${Date.now()}-99999999`;
    const logPath = join(dir, `${id}.log`);
    writeFileSync(logPath, "out\n__BGRUN_EXIT__=0\n");
    const baseEntries: CapturedEntry[] = [
      {
        type: "custom",
        customType: "bgrun-job",
        data: {
          id,
          pid: 99999999,
          cmd: "echo done",
          started: Date.now() - 1000,
          logPath,
          state: "done",
          exitCode: 0,
          exitedAt: Date.now() - 500,
        },
      },
    ];
    const countDone = (entries: CapturedEntry[]) =>
      entries.filter(
        (e) =>
          e.customType === "bgrun-job" &&
          e.data?.id === id &&
          e.data?.state === "done",
      ).length;

    // Resume 1.
    const first = makeFakePi({ priorEntries: baseEntries });
    await loadExtension(first.pi);
    first.ctx.hasUI = true; // drive updateWidget → revalidateStaleJobs
    await first.fireSessionStart();
    assert.equal(
      countDone(first.entries),
      1,
      "first resume must not append a duplicate done entry",
    );

    // Resume 2: fresh extension instance over the transcript resume 1 left.
    const second = makeFakePi({ priorEntries: first.entries });
    await loadExtension(second.pi);
    second.ctx.hasUI = true;
    await second.fireSessionStart();
    assert.equal(
      countDone(second.entries),
      1,
      "second resume must still leave exactly one done entry",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("bgclean all: a TERMINAL exit marker reclaims a finished log despite a reused live pid", async () => {
  // A finished job writes the marker as the LAST line. If its pid is later
  // reused by an unrelated live process, pid liveness alone would keep the log
  // forever — the terminal marker must win.
  const dir = mkTmp("pi-bgrun-test-");
  process.env.PI_BGRUN_DIR = dir;
  markJobsDir(dir);
  try {
    const donePath = join(dir, `done-job-1000000000-${process.pid}.log`);
    writeFileSync(donePath, "finished ok\n__BGRUN_EXIT__=0\n");
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const fs = await import("node:fs");
    fs.utimesSync(donePath, oldTime, oldTime);

    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    await tools
      .get("bgclean")!
      .execute(
        "call-reused-pid",
        { days: 7, all: true },
        undefined,
        undefined,
        ctx,
      );

    assert.ok(
      !existsSync(donePath),
      "terminal-marker log reclaimed even though its pid is alive (reused)",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── log size ceiling (maxLogBytes) ─────────────────────────────────────────
//
// A job that writes well past the caps used below: 200 numbered lines
// (~6.6 KB) plus a non-zero exit code, so the marker and the exit code are
// exercised through the capped pipeline too.

const SPEW_LINES =
  'i=0; while [ $i -lt 200 ]; do echo "line-$i-aaaaaaaaaaaaaaaaaaaaaa"; i=$((i+1)); done; exit 3';

function startedId(res: { content: { text: string }[] }): string {
  return (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
}

test("bgrun: maxLogBytes keeps the first N bytes, notes the truncation, preserves the exit code", async () => {
  await withEnv("PI_BGRUN_MAX_LOG_BYTES", "1000", async () => {
    await withJobsDir(async (dir, h) => {
      const { wakes, tools, ctx } = h;
      const res = await tools.get("bgrun")!.execute(
        "call-cap-sn",
        { command: SPEW_LINES, name: "spew" },
        undefined,
        undefined,
        ctx,
      );
      const id = startedId(res);
      await waitForWakes(wakes, 1);

      const log = readFileSync(join(dir, `${id}.log`), "utf8");
      // The wrapped log fd is written by ONE writer at a time, so the notice
      // starts exactly at the cap: 1000 bytes of command output, then "\n".
      const noticeAt = log.indexOf(
        "\n__BGRUN_TRUNC__ output truncated: kept the first 1000 bytes\n",
      );
      assert.equal(noticeAt, 1000, "notice follows exactly the capped bytes");
      assert.ok(log.startsWith("line-0-"), "the first bytes are kept");
      assert.ok(!log.includes("line-199-"), "output past the cap was dropped");
      // Marker still last, carrying BOTH the real exit code and the truncation
      // flag — the flag is what readers trust, since a command can print any
      // notice text but only the last marker counts.
      const nonBlank = log.split("\n").filter((l) => l.trim().length > 0);
      assert.equal(
        nonBlank[nonBlank.length - 1],
        "__BGRUN_EXIT__=3 truncated=1000",
      );
      assert.match(wakes[0].text, /finished \(exit 3\)/);
    });
  });
});

test("bgrun: the truncation notice is not job output — not counted, not the last line", async () => {
  await withEnv("PI_BGRUN_MAX_LOG_BYTES", "1000", async () => {
    await withJobsDir(async (dir, h) => {
      const { wakes, tools, ctx } = h;
      const res = await tools.get("bgrun")!.execute(
        "call-cap-stats",
        { command: SPEW_LINES, name: "spew" },
        undefined,
        undefined,
        ctx,
      );
      const id = startedId(res);
      await waitForWakes(wakes, 1);

      const log = readFileSync(join(dir, `${id}.log`), "utf8");
      // Lines the caller can still READ: the capped region. Counting from the
      // file (not from the implementation) keeps this honest — a trailing
      // partial line is a line, exactly as the counter treats it.
      const regionLines = log.slice(0, 1000).split("\n").length;
      assert.match(wakes[0].text, new RegExp(`, ${regionLines} lines`));
      assert.match(wakes[0].text, /Last output: line-\d+-a+$/m);
      assert.ok(
        !wakes[0].text.includes("Last output: __BGRUN_"),
        "the notice is never reported as the job's last line",
      );
    });
  });
});

test("bgrun: a job that outruns the cap by megabytes still finishes with its own exit code", async () => {
  await withEnv("PI_BGRUN_MAX_LOG_BYTES", "1000", async () => {
    await withJobsDir(async (dir, h) => {
      const { wakes, tools, ctx } = h;
      // ~1.3 MB, far more than the pipe buffers between producer and reader —
      // the drain must keep the producer alive (no SIGPIPE/141) and the job's
      // own exit code must survive the pipeline.
      const res = await tools.get("bgrun")!.execute(
        "call-cap-flood",
        { command: "seq 1 200000; exit 0", name: "flood" },
        undefined,
        undefined,
        ctx,
      );
      const id = startedId(res);
      await waitForWakes(wakes, 1);

      const log = readFileSync(join(dir, `${id}.log`), "utf8");
      assert.equal(log.indexOf("\n__BGRUN_TRUNC__ output truncated"), 1000);
      assert.match(log, /__BGRUN_EXIT__=0 truncated=1000\n$/);
      assert.match(wakes[0].text, /finished \(exit 0\)/);
    });
  });
});

test("bgrun: a log at exactly the cap is not called truncated; one byte over is", async () => {
  await withEnv("PI_BGRUN_MAX_LOG_BYTES", "4", async () => {
    await withJobsDir(async (dir, h) => {
      const { wakes, tools, ctx } = h;
      const run = async (command: string) => {
        const res = await tools.get("bgrun")!.execute(
          command,
          { command },
          undefined,
          undefined,
          ctx,
        );
        return startedId(res);
      };

      // "abc\n" is exactly 4 bytes — nothing was dropped.
      const atCap = await run("printf 'abc\\n'");
      // "abcd\n" is 5 — the trailing newline is the byte that had to go.
      const overCap = await run("printf 'abcd\\n'");
      await waitForWakes(wakes, 2);

      const exact = readFileSync(join(dir, `${atCap}.log`), "utf8");
      assert.equal(exact, "abc\n\n__BGRUN_EXIT__=0\n");
      assert.ok(!exact.includes("truncated"), "no notice at the boundary");

      const over = readFileSync(join(dir, `${overCap}.log`), "utf8");
      assert.ok(
        over.includes(
          "\n__BGRUN_TRUNC__ output truncated: kept the first 4 bytes\n",
        ),
        "one byte past the cap is truncated",
      );
      assert.match(over, /__BGRUN_EXIT__=0 truncated=4\n$/);
      assert.ok(over.startsWith("abcd"), "kept the first 4 bytes");
    });
  });
});

test("bgrun: maxLogBytes 0 leaves the log uncapped", async () => {
  await withEnv("PI_BGRUN_MAX_LOG_BYTES", "0", async () => {
    await withJobsDir(async (dir, h) => {
      const { wakes, tools, ctx } = h;
      const res = await tools.get("bgrun")!.execute(
        "call-cap-off",
        { command: SPEW_LINES, name: "spew" },
        undefined,
        undefined,
        ctx,
      );
      const id = startedId(res);
      await waitForWakes(wakes, 1);

      const log = readFileSync(join(dir, `${id}.log`), "utf8");
      assert.ok(log.includes("line-199-"), "the whole output is kept");
      assert.ok(!log.includes("truncated"), "no notice when uncapped");
      assert.match(log, /__BGRUN_EXIT__=3\n$/);
    });
  });
});

test("bgrun: a capped job leaves no staging files behind", async () => {
  await withEnv("PI_BGRUN_MAX_LOG_BYTES", "1000", async () => {
    await withJobsDir(async (dir, h) => {
      const { wakes, tools, ctx } = h;
      await tools.get("bgrun")!.execute(
        "call-cap-staging",
        { command: SPEW_LINES, name: "spew" },
        undefined,
        undefined,
        ctx,
      );
      await waitForWakes(wakes, 1);

      // The exit-code, fifo, liveness and truncation-flag files are the
      // wrapper's own scratch — it removes them before printing the marker, so
      // a wake never leaves a `.tmp-*` in the jobs dir.
      const strays = readdirSync(dir).filter((n) => n.startsWith(".tmp-"));
      assert.deepEqual(strays, []);
    });
  });
});

test("bgclean: stale staging files (.ec/.fifo/.pid/.trunc) are reclaimed, unrelated .tmp-* are not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const h = makeFakePi();
    await loadExtension(h.pi);
    const stale = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const ours = [
      ".tmp-spew-1-abcd.ec",
      ".tmp-spew-1-abcd.fifo",
      ".tmp-spew-1-abcd.pid",
      ".tmp-spew-1-abcd.trunc",
      ".tmp-spew-1-abcd.log",
    ];
    const foreign = ".tmp-someone-else.txt";
    for (const name of [foreign, ...ours]) {
      writeFileSync(join(dir, name), "");
      utimesSync(join(dir, name), new Date(stale), new Date(stale));
    }

    await h.tools
      .get("bgclean")!
      .execute("call-cap-sweep", { days: 7, all: true }, undefined, undefined, h.ctx);

    for (const name of ours) {
      assert.ok(!existsSync(join(dir, name)), `${name} reclaimed`);
    }
    assert.ok(existsSync(join(dir, foreign)), "an unrelated .tmp-* is left alone");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgtail/bggrep work on a capped log and only see what was kept", async () => {
  await withEnv("PI_BGRUN_MAX_LOG_BYTES", "1000", async () => {
    await withJobsDir(async (_dir, h) => {
      const { wakes, tools, ctx } = h;
      const bgrun = tools.get("bgrun")!;
      const bgtail = tools.get("bgtail")!;
      const bggrep = tools.get("bggrep")!;

      // "seq 1 400" fills the 1000-byte window exactly through line 277.
      const res = await bgrun.execute(
        "call-cap-read",
        { command: "seq 1 400", name: "seq" },
        undefined,
        undefined,
        ctx,
      );
      const id = startedId(res);
      await waitForWakes(wakes, 1);

      const grep1 = await bggrep.execute(
        "call-cap-read",
        { id, pattern: "^1$" },
        undefined,
        undefined,
        ctx,
      );
      assert.match(grep1.content[0].text as string, /L1: 1/);

      const grep400 = await bggrep.execute(
        "call-cap-read",
        { id, pattern: "^400$" },
        undefined,
        undefined,
        ctx,
      );
      assert.ok(
        !/L\d+: 400/.test(grep400.content[0].text as string),
        "output past the cap is not searchable — it was never written",
      );

      const tail = await bgtail.execute(
        "call-cap-read",
        { id, lines: 3 },
        undefined,
        undefined,
        ctx,
      );
      const tailText = tail.content[0].text as string;
      // The last 3 lines of what was KEPT (277 is the cap boundary), followed
      // by the truncation label — the wrapper's raw notice line stays filtered.
      assert.match(
        tailText,
        /275\n276\n277\n\n\(log truncated at 1000 bytes/,
      );
      assert.ok(
        !tailText.includes("[pi-bgrun] output truncated"),
        "the raw notice line is not shown as content",
      );
    });
  });
});

test("resolveConfig: maxLogBytes accepts 0 (unlimited) and ignores blank or invalid values", async () => {
  const mod = await loadModule();
  const envCases: [string | undefined, unknown][] = [
    [undefined, 67108864],
    ["0", 0],
    ["2048", 2048],
    ["", 67108864], // a blank env var must not silently disable the cap
    ["nonsense", 67108864],
    ["-5", 67108864],
  ];
  for (const [value, expected] of envCases) {
    await withEnv("PI_BGRUN_MAX_LOG_BYTES", value, () => {
      assert.equal(
        mod.resolveConfig({ isProjectTrusted: () => false }).maxLogBytes,
        expected,
        `PI_BGRUN_MAX_LOG_BYTES=${JSON.stringify(value)}`,
      );
    });
  }

  // The config-file layer: a non-negative number wins over the default; a
  // negative one or a string is ignored rather than trusted.
  const cfgFile = join(mkdtempSync(join(tmpdir(), "pi-bgrun-test-")), "user.json");
  try {
    for (const [value, expected] of [
      [4096, 4096],
      [-1, 67108864],
      ["4096", 67108864],
    ] as const) {
      writeFileSync(cfgFile, JSON.stringify({ maxLogBytes: value }));
      await withEnv("PI_BGRUN_USER_CONFIG", cfgFile, () => {
        assert.equal(
          mod.resolveConfig({ isProjectTrusted: () => false }).maxLogBytes,
          expected,
          `config maxLogBytes=${JSON.stringify(value)}`,
        );
      });
    }
  } finally {
    rmSync(dirname(cfgFile), { recursive: true, force: true });
  }
});

// ── truncation is visible to the agent, not just on disk ───────────────────

test("formatBytes / parseCapStatus: the cap comes from the marker, never from printable text", async () => {
  const mod = await loadModule();
  assert.equal(mod.formatBytes(900), "900 bytes");
  assert.equal(mod.formatBytes(1000), "1000 bytes");
  assert.equal(mod.formatBytes(1536), "1.5 KiB");
  assert.equal(mod.formatBytes(67108864), "64 MiB");

  // The wrapper's own marker, last, carries the flag.
  assert.deepEqual(
    mod.parseCapStatusFromContent(
      "out\n\n__BGRUN_TRUNC__ output truncated: kept the first 1000 bytes\n\n__BGRUN_EXIT__=0 truncated=1000\n",
    ),
    { kind: "truncated", bytes: 1000 },
  );
  assert.equal(
    mod.parseTruncationFromContent(
      "out\n\n__BGRUN_TRUNC__ output truncated: kept the first 1000 bytes\n\n__BGRUN_EXIT__=0 truncated=1000\n",
    ),
    1000,
  );
  // A ceiling that could not be installed is reported too, and is NOT a cap.
  assert.deepEqual(
    mod.parseCapStatusFromContent(
      "out\n__BGRUN_NOCAP__ log ceiling unavailable (mkfifo failed, so this job ran uncapped)\n\n__BGRUN_EXIT__=0 nocap=1\n",
    ),
    { kind: "ceiling-failed" },
  );
  // A running log, a plain marker, and any printable imitation of the notice
  // are not evidence of truncation. This is the direction that used to be
  // forgeable: the notice used to be believed purely on position + text.
  assert.equal(
    mod.parseTruncationFromContent(
      "__BGRUN_TRUNC__ output truncated: kept the first 1000 bytes\n",
    ),
    null,
  );
  assert.equal(mod.parseTruncationFromContent("boom\n__BGRUN_EXIT__=1\n"), null);
  assert.equal(
    mod.parseTruncationFromContent("x\n__BGRUN_TRUNC__ output truncated: kept the first 999 bytes\n\n__BGRUN_EXIT__=0\n"),
    null,
    "a notice without the marker flag is not a cap",
  );
  assert.ok(mod.isWrapperLine("__BGRUN_TRUNC__ anything"), "namespace is reserved");
  assert.ok(!mod.isWrapperLine("[pi-bgrun] output truncated"), "old text is job output");
});

test("wake: a capped job says so in the Stats line; an uncapped one does not", async () => {
  const run = async (cap: string, command: string) => {
    let wake = "";
    await withEnv("PI_BGRUN_MAX_LOG_BYTES", cap, async () => {
      await withJobsDir(async (_dir, h) => {
        await h.tools
          .get("bgrun")!
          .execute("call-wake-cap", { command, name: "j" }, undefined, undefined, h.ctx);
        await waitForWakes(h.wakes, 1);
        wake = h.wakes[0].text;
      });
    });
    return wake;
  };

  const capped = await run("1000", SPEW_LINES);
  assert.match(capped, /Stats: [\d.]+s, [\d,]+ lines, log truncated at 1000 bytes/);

  const plain = await run("1000000", "printf 'hello\\n'");
  assert.ok(
    !plain.includes("log truncated"),
    "no truncation claim for a log inside the cap",
  );
  assert.match(plain, /Stats: [\d.]+s, 1 lines/);
});

test("wake digest: a scorecard is skipped, not misreported, when the log was capped", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [{ label: "cap", command: "echo digest-ran" }],
    });

    await withEnv("PI_BGRUN_MAX_LOG_BYTES", "1000", async () => {
      const capped = await runDigestJob(proj, {
        command: SPEW_LINES,
        type: "test",
      });
      const line = digestLineOf(capped);
      assert.ok(line, "the digest line is still present");
      assert.match(line!, /^digest \(cap\): skipped — the log was truncated at 1000 bytes/);
      assert.ok(
        !capped.includes("digest-ran"),
        "the scorecard never ran against a truncated log",
      );
    });

    // Under the cap the scorecard runs exactly as before.
    const plain = await runDigestJob(proj, {
      command: "printf 'hello\\n'",
      type: "test",
    });
    assert.match(digestLineOf(plain)!, /^digest \(cap\): digest-ran$/);
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("bgtail/bggrep: a capped log is labelled, and carries truncatedAtBytes", async () => {
  await withEnv("PI_BGRUN_MAX_LOG_BYTES", "1000", async () => {
    await withJobsDir(async (_dir, h) => {
      const { wakes, tools, ctx } = h;
      const bgrun = tools.get("bgrun")!;
      const bgtail = tools.get("bgtail")!;
      const bggrep = tools.get("bggrep")!;

      const res = await bgrun.execute(
        "call-read-cap",
        { command: "seq 1 400", name: "seq" },
        undefined,
        undefined,
        ctx,
      );
      const id = startedId(res);
      await waitForWakes(wakes, 1);

      const tail = await bgtail.execute(
        "call-read-cap",
        { id, lines: 3 },
        undefined,
        undefined,
        ctx,
      );
      assert.match(
        tail.content[0].text as string,
        /log truncated at 1000 bytes .*not the run's real end/,
      );
      assert.equal(tail.details.truncatedAtBytes, 1000);

      // The dangerous case: failures past the cap look like "no failures".
      const none = await bggrep.execute(
        "call-read-cap",
        { id, pattern: "^400$" },
        undefined,
        undefined,
        ctx,
      );
      assert.match(none.content[0].text as string, /— none/);
      assert.match(
        none.content[0].text as string,
        /output past the cap was never written and was not searched/,
      );
      assert.equal(none.details.truncatedAtBytes, 1000);
    });
  });
});

test("bgtail/bggrep: no truncation label on an uncapped log", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;
    const bggrep = tools.get("bggrep")!;

    const res = await bgrun.execute(
      "call-read-plain",
      { command: "printf 'line1\\nline2\\n'", name: "plain" },
      undefined,
      undefined,
      ctx,
    );
    const id = startedId(res);
    await waitForWakes(wakes, 1);

    const tail = await bgtail.execute(
      "call-read-plain",
      { id, lines: 2 },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(!(tail.content[0].text as string).includes("truncated"));
    assert.equal(tail.details.truncatedAtBytes, undefined);

    const grep = await bggrep.execute(
      "call-read-plain",
      { id, pattern: "line1" },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(!(grep.content[0].text as string).includes("truncated"));
    assert.equal(grep.details.truncatedAtBytes, undefined);
  });
});

test("bgtail/bggrep: a log bigger than the 2 MB read window says it was only partly searched", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;
    const bggrep = tools.get("bggrep")!;

    // ~2.7 MB — past LOG_READ_BYTES, so both readers see only the tail of it.
    const res = await bgrun.execute(
      "call-window",
      { command: "seq 1 400000", name: "big" },
      undefined,
      undefined,
      ctx,
    );
    const id = startedId(res);
    await waitForWakes(wakes, 1);

    const tail = await bgtail.execute(
      "call-window",
      { id, lines: 3 },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      tail.content[0].text as string,
      /searched the last 2 MiB of [\d.]+ MiB — the earlier bytes were not searched/,
    );

    // "— none" on a >2 MB log must not read as "no failures anywhere".
    const grep = await bggrep.execute(
      "call-window",
      { id, pattern: "^1$" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(grep.content[0].text as string, /— none/);
    assert.match(
      grep.content[0].text as string,
      /the earlier bytes were not searched/,
    );
  });
});

test("bgtail/bggrep: no window caveat on a small log", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const res = await bgrun.execute(
      "call-window-small",
      { command: "printf 'a\\nb\\n'", name: "small" },
      undefined,
      undefined,
      ctx,
    );
    const id = startedId(res);
    await waitForWakes(wakes, 1);

    for (const tool of ["bgtail", "bggrep"] as const) {
      const out = await tools.get(tool)!.execute(
        "call-window-small",
        tool === "bgtail" ? { id, lines: 2 } : { id, pattern: "a" },
        undefined,
        undefined,
        ctx,
      );
      assert.ok(
        !(out.content[0].text as string).includes("searched the last"),
        `${tool}: no window caveat under the read bound`,
      );
    }
  });
});

test("bggrep/bgtail: `bytes` widens the search window without widening the output", async () => {
  await withJobsDir(async (_dir, h) => {
    const { wakes, tools, ctx } = h;
    const bgrun = tools.get("bgrun")!;
    const bggrep = tools.get("bggrep")!;
    const bgtail = tools.get("bgtail")!;

    // The marker is written FIRST, then ~2.7 MB of lines — so the default
    // 2 MiB window cannot see it, and a widened window can.
    const res = await bgrun.execute(
      "call-bytes",
      { command: "echo EARLY-MARKER; seq 1 400000", name: "wide" },
      undefined,
      undefined,
      ctx,
    );
    const id = startedId(res);
    await waitForWakes(wakes, 1);

    const narrow = await bggrep.execute(
      "call-bytes",
      { id, pattern: "EARLY-MARKER" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(narrow.content[0].text as string, /— none/);
    assert.match(narrow.content[0].text as string, /pass a larger `bytes`/);
    assert.equal(narrow.details.windowBytes, 2 * 1024 * 1024);

    const wide = await bggrep.execute(
      "call-bytes",
      { id, pattern: "EARLY-MARKER", bytes: 8 * 1024 * 1024 },
      undefined,
      undefined,
      ctx,
    );
    assert.match(wide.content[0].text as string, /L1: EARLY-MARKER/);
    assert.equal(wide.details.windowBytes, 8 * 1024 * 1024);
    // The claim that matters: scanning more does NOT mean returning more.
    assert.ok(
      (wide.content[0].text as string).length < 9000,
      "output stays under the condenser cap",
    );

    // A window bigger than any job could write is clamped to the bound in force
    // — the ceiling plus the wrapper's overhead, so a capped log is coverable.
    const mod = await loadModule();
    const huge = await bggrep.execute(
      "call-bytes",
      { id, pattern: "EARLY-MARKER", bytes: 1e15 },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(huge.details.windowBytes, mod.readWindowMax());

    // bgtail: changing the window is a different VIEW, not appended output —
    // it must reset to a full tail instead of claiming "+N new lines".
    const first = await bgtail.execute(
      "call-bytes",
      { id, lines: 3 },
      undefined,
      undefined,
      ctx,
    );
    assert.match(first.content[0].text as string, /400000/);
    const rewidened = await bgtail.execute(
      "call-bytes",
      { id, lines: 3, bytes: 8 * 1024 * 1024 },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      rewidened.content[0].text as string,
      /search window changed since last read/,
    );
    assert.ok(
      !rewidened.content[0].text.includes("new lines since last read"),
      "no bogus delta after a window change",
    );
  });
});

test("clampReadWindow: default, explicit, garbage, and ceiling", async () => {
  const mod = await loadModule();
  assert.equal(mod.clampReadWindow(undefined), 2097152);
  assert.equal(mod.clampReadWindow(0), 2097152);
  assert.equal(mod.clampReadWindow(-1), 2097152);
  assert.equal(mod.clampReadWindow(Number.NaN), 2097152);
  assert.equal(mod.clampReadWindow("8192"), 2097152);
  assert.equal(mod.clampReadWindow(65536), 65536);
  assert.equal(mod.clampReadWindow(65536.7), 65536);
  // The bound is the ceiling PLUS the wrapper overhead, so the widest window can
  // actually cover a log the cap produced.
  assert.equal(mod.clampReadWindow(1e12), mod.readWindowMax());
  assert.ok(mod.readWindowMax() > 67108864);
});

test("bggrep: the budget terminates a worker that is stuck mid-match (abort path)", async () => {
  const mod: any = await loadModule();
  // An input-driven catastrophic pattern cannot test this portably: V8
  // backtracks exponentially where JSC answers in constant time (measured:
  // `^(a+)+$` over 100 "a"s + "!" hangs Node past 10s and returns on Bun in
  // ~250ms). So the stall is injected instead — a worker body that never
  // returns — and the only assertion is that the budget still ends it. That is
  // exactly what a runaway regex looks like to the parent thread.
  const stall = 'require("node:worker_threads"); for (;;) {}';
  const t0 = Date.now();
  const outcome = await mod.matchLinesWithBudget(
    "a",
    ["a".repeat(50)],
    10,
    300,
    stall,
  );
  const elapsed = Date.now() - t0;
  assert.equal(outcome.kind, "timeout", "a stuck worker is reported as a timeout");
  assert.ok(elapsed < 3_000, `terminated promptly (${elapsed}ms)`);
});

// ── the sync fallback (bggrep without worker_threads) ──────────────────────
//
// Unreachable on Node and Bun, which is exactly why it needs direct tests: the
// path only runs where worker_threads is missing, so a regression would ship
// silently and surface as "bggrep behaves differently in that environment".

test("bggrep sync fallback: same results as the worker path, including the line cap", async () => {
  const mod: any = await loadModule();
  const lines = [
    "pass ok",
    "--- FAIL: TestA",
    "x".repeat(50) + "NEEDLE", // the only NEEDLE sits past the per-line cap
    "--- FAIL: TestB",
    "",
  ];
  for (const pattern of ["^--- FAIL:", "NEEDLE", "^pass", "nothing-matches"]) {
    const sync = mod.matchLinesSyncBounded(pattern, lines, 10, 1_000);
    const worker = await mod.matchLinesWithBudget(pattern, lines, 10, 2_000);
    assert.deepEqual(
      sync,
      worker,
      `fallback and worker disagree for /${pattern}/`,
    );
    if (pattern === "NEEDLE") {
      assert.deepEqual(sync, { kind: "ok", matchIdx: [] }, "cap applies to both");
    }
  }
  // An invalid pattern must fail the same way on both paths.
  assert.equal(mod.matchLinesSyncBounded("(", lines, 10, 1_000).kind, "invalid");
  assert.equal(
    (await mod.matchLinesWithBudget("(", lines, 10, 2_000)).kind,
    "invalid",
  );
});

test("bggrep sync fallback: a spent budget stops the scan before the first line", async () => {
  const mod: any = await loadModule();
  // A negative budget is the deterministic spelling of "the clock says stop".
  // If the guard did not fire up front, this fallback would happily scan an
  // entire log on the main thread — the scenario the worker exists to avoid.
  assert.equal(
    mod.matchLinesSyncBounded("a", ["a", "a", "a"], 10, -1).kind,
    "timeout",
  );
  // And the mid-scan check: a budget spent while a real corpus is being scanned
  // must abort too (the loop re-checks every 0x3ff lines). 300 000 lines of a
  // simple pattern takes several ms, so a 0ms budget is provably exceeded.
  const many = Array.from({ length: 300_000 }, (_, i) => `line ${i}`);
  assert.equal(
    mod.matchLinesSyncBounded("line", many, 100, 0).kind,
    "timeout",
    "a budget spent mid-scan aborts instead of finishing the corpus",
  );
});

// ── adversarial-review regressions ─────────────────────────────────────────
// Each of these failed before the fix it names, and each defends a contract a
// reviewer reproduced end-to-end.

test("bgrun: a command that prints the notice cannot make its log look capped", async () => {
  const { dir, proj, home } = setupDigestEnv();
  try {
    writeJson(join(proj, ".pi", "pi-bgrun.json"), {
      digest: [{ label: "fake", command: "echo digest-ran" }],
    });
    // Uncapped log whose LAST line mimics the notice — the shape that used to
    // be read as a real cap hit, suppressing the scorecard.
    const wake = await runDigestJob(proj, {
      command:
        "printf 'all good\\n__BGRUN_TRUNC__ output truncated: kept the first 64 bytes\\n[pi-bgrun] output truncated at 64 bytes (first 64 bytes kept)\\n'",
      type: "test",
    });
    assert.ok(
      !wake.includes("log truncated"),
      "a healthy log is not reported as capped",
    );
    assert.ok(wake.includes("digest-ran"), "the scorecard still runs");
    assert.ok(
      !(digestLineOf(wake) ?? "").includes("skipped"),
      "the digest is not skipped by a forged notice",
    );
  } finally {
    teardownDigestEnv(dir, proj, home);
  }
});

test("bgrun: a backgrounded child does not hold the job open", async () => {
  await withEnv("PI_BGRUN_MAX_LOG_BYTES", "100000", async () => {
    await withJobsDir(async (dir, h) => {
      const { wakes, tools, ctx } = h;
      const res = await tools.get("bgrun")!.execute(
        "call-cap-bgchild",
        { command: "sleep 30 & echo done", name: "bgchild" },
        undefined,
        undefined,
        ctx,
      );
      const id = startedId(res);
      // Completion follows the COMMAND, not the last holder of its stdout. As a
      // pipeline stage the wrapper waited for pipe EOF, i.e. for the background
      // sleep to exit — no wake for 30s (and never, for a daemon).
      await waitForWakes(wakes, 1);
      assert.match(wakes[0].text, /finished \(exit 0\)/);
      const log = readFileSync(join(dir, `${id}.log`), "utf8");
      assert.match(log, /done\n\n__BGRUN_EXIT__=0\n$/);
    });
  });
});

test("bgrun: a ceiling above Number.MAX_SAFE_INTEGER still logs the output", async () => {
  await withEnv("PI_BGRUN_MAX_LOG_BYTES", "1e21", async () => {
    await withJobsDir(async (dir, h) => {
      const { wakes, tools, ctx } = h;
      const res = await tools.get("bgrun")!.execute(
        "call-cap-huge",
        { command: "printf 'important-1\\nimportant-2\\n'", name: "huge" },
        undefined,
        undefined,
        ctx,
      );
      const id = startedId(res);
      await waitForWakes(wakes, 1);
      // Pre-fix the shell literal was "1e+21": `head -c` rejected it and every
      // byte of output was discarded while the job still reported success.
      const log = readFileSync(join(dir, `${id}.log`), "utf8");
      assert.ok(log.includes("important-1"), "output is kept");
      assert.ok(!log.includes("truncated"), "not reported as capped");
    });
  });
});

test("bgrun: a fractional ceiling caps instead of silently meaning unlimited", async () => {
  await withEnv("PI_BGRUN_MAX_LOG_BYTES", "0.5", async () => {
    await withJobsDir(async (dir, h) => {
      const { wakes, tools, ctx } = h;
      const res = await tools.get("bgrun")!.execute(
        "call-cap-fraction",
        { command: "printf 'abcdefghij'", name: "frac" },
        undefined,
        undefined,
        ctx,
      );
      const id = startedId(res);
      await waitForWakes(wakes, 1);
      // 0.5 floors to 0, and 0 is documented as unlimited — the cap the user
      // asked for would be silently off. It must mean "one byte" instead.
      const log = readFileSync(join(dir, `${id}.log`), "utf8");
      assert.ok(log.startsWith("a\n"), `kept one byte: ${JSON.stringify(log)}`);
      assert.match(log, /__BGRUN_EXIT__=0 truncated=1\n$/);
    });
  });
});

test("readWindowMax: the widest search window can cover a log the ceiling produced", async () => {
  const mod = await loadModule();
  for (const cap of ["1048576", "67108864", "134217728"]) {
    await withEnv("PI_BGRUN_MAX_LOG_BYTES", cap, async () => {
      // A capped log is cap + notice + marker, so a max EQUAL to the cap left
      // its first bytes permanently unreadable through bgtail/bggrep.
      assert.ok(
        mod.readWindowMax() > Number(cap),
        `window max must exceed the ceiling in force (${cap})`,
      );
    });
  }
  await withEnv("PI_BGRUN_MAX_LOG_BYTES", "0", async () => {
    assert.ok(mod.readWindowMax() > 67108864, "unlimited keeps a usable bound");
  });
});

test("bgtail/bggrep: a window of very short lines is scan-bounded, and says so", async () => {
  await withJobsDir(async (dir, h) => {
    // 250k single-character lines: well under the byte window, but the shape a
    // capped `yes ''` runaway produces — materializing every line costs GBs.
    const id = "shortlines-1-1";
    const body = Array.from({ length: 600_000 }, (_, i) =>
      i === 0 ? "FIRST-MARKER" : "x",
    ).join("\n");
    writeFileSync(join(dir, `${id}.log`), `${body}\n\n__BGRUN_EXIT__=0\n`);

    const grep = await h.tools
      .get("bggrep")!
      .execute("c", { id, pattern: "FIRST-MARKER" }, undefined, undefined, h.ctx);
    const text = grep.content[0].text as string;
    assert.match(text, /only the last [\d,]+ lines of that window were searched/);
    assert.match(text, /none/, "the trimmed-away head is not silently searched");

    const tail = await h.tools
      .get("bgtail")!
      .execute("c2", { id, lines: 3 }, undefined, undefined, h.ctx);
    assert.match(
      tail.content[0].text as string,
      /only the last [\d,]+ lines/,
      "bgtail reports the same bound",
    );
  });
});

test("bgclean: a running job's staging files survive an aggressive sweep", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  markJobsDir(dir);
  try {
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const live = ".tmp-live-1-beef";
    const orphan = ".tmp-dead-1-beef";
    // A live owner (this process) and an ownerless leftover, both as old as the
    // cutoff. Age alone used to delete the live job's scratch files mid-run,
    // which silently removed its truncation notice and injected a shell error
    // into its log.
    for (const name of [`${live}.pid`, `${live}.fifo`, `${live}.trunc`, `${orphan}.fifo`]) {
      writeFileSync(join(dir, name), "");
      utimesSync(join(dir, name), stale, stale);
    }
    // Written after the loop: this is the file the sweep trusts for liveness.
    writeFileSync(join(dir, `${live}.pid`), `${process.pid}\n`);
    utimesSync(join(dir, `${live}.pid`), stale, stale);

    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    await tools
      .get("bgclean")!
      .execute(
        "call-cap-live-sweep",
        { days: 0.0000001, all: true },
        undefined,
        undefined,
        ctx,
      );

    assert.ok(
      existsSync(join(dir, `${live}.fifo`)),
      "a running job keeps its staging files",
    );
    assert.ok(
      !existsSync(join(dir, `${orphan}.fifo`)),
      "an orphan's staging files are still reclaimed",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
