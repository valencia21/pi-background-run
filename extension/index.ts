/**
 * pi-bgrun — pi extension that runs long shell commands detached in the
 * background and optionally wakes the live agent session on completion.
 *
 * Architecture:
 * - In-process spawn via child_process.spawn with stdio redirected to a log file
 *   (detached + unref so the job survives pi crashing).
 * - The child wraps the command to append a trailing __BGRUN_EXIT__=N marker,
 *   making the log self-describing — exit codes survive pi restarting.
 * - Completion is the child 'exit' event, not a poller. The exit handler follows
 *   the per-job wake policy before using pi.sendUserMessage; toast/widget updates
 *   remain unconditional.
 * - Job records persist via pi.appendEntry (survives same-session restart,
 *   renders as a card in the transcript, does NOT enter LLM context).
 * - Live status widget above the editor while jobs are running.
 * - Desktop toast (ctx.ui.notify) on completion for the human.
 *
 * Three-tier state degradation:
 * 1. In-memory Map (fast path while alive) — instant bgstatus, live exit→wake.
 * 2. appendEntry reconstruction (same-session restart) — session_start rebuilds
 *    the Map from bgrun-job entries.
 * 3. Filesystem scan (cross-session, cross-restart, cross-worktree) — the jobs
 *    dir is the permanent truth: filename→pid, log→exit code, kill -0→liveness.
 *    Surfaced via bgstatus by id (always) or includeDone (explicit); other
 *    sessions' RUNNING jobs are adopted into the live widget only when
 *    adoptForeignJobs is enabled.
 */

import {
  CONFIG_DIR_NAME,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  readSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import {
  DIGEST_PRESET_IDS,
  digestNoMatchWarning,
  selectDigestEntry,
  type DigestEntry,
  type DigestJobTarget,
  type DigestMatch,
} from "./digestPresets.ts";

// Exit marker appended to every log so the file is self-describing: the exit
// code survives pi restarting. `;` (not `&&`) ensures the printf runs even when
// the command fails. Never use `set -e` in the wrapper.
const EXIT_MARKER = "__BGRUN_EXIT__=";
const JOBS_DIR_MARKER = ".bgrun-jobs";
// Tail-read caps — avoid whole-file readFileSync on runaway logs.
const LOG_TAIL_BYTES = 256 * 1024; // exit marker + last line
const LOG_READ_BYTES = 2 * 1024 * 1024; // bgtail / bggrep default window
const BGGREP_LINE_CAP = 10_000; // per-line match length cap

// Cap on the bytes a job may write to its log (stdout+stderr). Enforced inside
// the detached process tree, so it holds after pi exits. 0 = unlimited.
const DEFAULT_MAX_LOG_BYTES = 64 * 1024 * 1024;
// Above 2^53-1 a Number stringifies in exponential notation ("1e+21"), and the
// wrapper bakes the ceiling into the shell as a literal — `head -c 1e+21` fails
// and every byte of job output is discarded. A ceiling that large means
// "effectively unlimited", so it is clamped to the largest integral literal the
// shell can still parse.
const MAX_MAX_LOG_BYTES = Number.MAX_SAFE_INTEGER;
// Slack added when deriving read/count bounds from a ceiling: the wrapper writes
// its notice and exit marker PAST the capped bytes, so a capped log is slightly
// larger than the cap. A bound equal to the cap leaves the first bytes of every
// capped log unreadable and drops its line count.
const WRAPPER_OVERHEAD_BYTES = 4096;
// Machine-readable flags the wrapper appends to its exit marker. The marker is
// the one line a command cannot forge (only the LAST marker counts, so printing
// one is not evidence of completion) — carrying truncation there makes "the log
// was capped" unforgeable, unlike a printable notice line that job output can
// imitate.
const EXIT_MARKER_TRUNC_FLAG = " truncated=";
const EXIT_MARKER_NOCAP_FLAG = " nocap=1";
// Human-readable wrapper notices, in the reserved `__BGRUN_` namespace so they
// cannot collide with a command's own output. Readers filter them exactly like
// EXIT_MARKER: wrapper bookkeeping, not job output, so they are never counted as
// content lines or reported as the job's last line.
const TRUNC_NOTICE_PREFIX = "__BGRUN_TRUNC__ output truncated";
const CAPFAIL_NOTICE_PREFIX = "__BGRUN_NOCAP__ log ceiling unavailable";
// Line bound for a log scan. A byte window alone is not enough: a capped log of
// very short lines (the classic `yes ''` runaway) holds millions of lines in a
// few MiB, and materializing them as JS strings costs ~100 bytes each — measured
// at >3 GB of RSS for a 64 MiB window, i.e. an OOM on exactly the log class the
// ceiling exists for. 500k lines is ~40 MB of JS strings — a bounded cost that
// still dwarfs anything a real job prints into a window.
// ceiling exists for. Past this many lines only the tail is scanned, and the
// caveat says so.
const LOG_SCAN_LINES_MAX = 500_000;

const DEFAULT_CLEANUP_DAYS = 7;
const STALE_POLL_MS = 30_000; // re-check interval for jobs with no live child handle
/** Default jobs dir inside a recognizable project root (`.git` or `.pi`). */
const PROJECT_LOCAL_JOBS_REL = ".pi-bgrun/jobs";

// Files a spawn stages in the jobs dir under one shared
// `.tmp-<slug>-<ts>-<hex>` stem: the log itself (renamed to `<id>.log` once the
// child pid is known) plus the wrapper's exit-code, fifo, liveness and
// truncation-flag files. Only these exact suffixes are ours — an unrelated
// `.tmp-*` is not.
const STAGING_SUFFIXES = [".log", ".ec", ".fifo", ".pid", ".trunc"];
// A staging file is only reclaimable once it is clearly nobody's business: the
// owner's liveness file says the wrapper is gone AND the file is older than this
// floor. Without the floor, an aggressive cleanup cutoff (a `bgclean` "clean
// everything" using a tiny positive `days`) can unlink the scratch files of a
// job that started milliseconds ago, before its liveness file exists.
const STAGING_MIN_AGE_MS = 60_000;

// Machine-global jobs dir. Resolved per call (not a module constant) so
// PI_BGRUN_GLOBAL_DIR can redirect it — used by tests to stay off the real
// ~/.pi-bgrun, and available for setups with a custom home or shared scratch.
function globalJobsDir(): string {
  return expandTilde(
    process.env.PI_BGRUN_GLOBAL_DIR || join(homeDir(), ".pi-bgrun", "jobs"),
  );
}

// bggrep runs caller-supplied regexes. A pathological pattern (e.g. /^(a+)+$/)
// can backtrack catastrophically, and V8 has no regex step limit and cannot
// interrupt a regex running on the main thread — so the match loop runs in a
// worker with a wall-clock budget. On expiry the worker is terminated and a
// bounded error is returned instead of hanging the session. Bun's engine is
// more backtracking-resistant, but Node is the common case.
const BGGREP_DEFAULT_TIMEOUT_MS = 2_000;

// Executed inside the worker (eval'd). Uses require(): available in an eval
// worker on both Node and Bun, unlike a static import (the eval body is CJS).
const BGGREP_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
try {
  const re = new RegExp(workerData.source);
  const lines = workerData.lines;
  const cap = workerData.cap;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.length > cap) line = line.slice(0, cap);
    if (re.test(line)) out.push(i);
  }
  parentPort.postMessage({ ok: true, matches: out });
} catch (err) {
  parentPort.postMessage({ ok: false, message: String((err && err.message) || err) });
}
`;

// Normalize a configured byte ceiling. 0 stays "unlimited"; a positive fraction
// (0.5) becomes 1 rather than flooring to 0, which would silently mean
// "unlimited"; anything above MAX_MAX_LOG_BYTES is clamped so the value always
// renders as a plain integer in the wrapper.
export function normalizeMaxLogBytes(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  if (value === 0) return 0;
  const floored = Math.floor(value);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_MAX_LOG_BYTES);
}

// Upper bound for an explicit search window (bgtail/bggrep `bytes`): the ceiling
// in force plus the wrapper's overhead, so the widest window a caller can ask
// for can actually cover a log the cap produced. An equal-to-cap bound (the
// original constant) left the first bytes of every capped log unreadable while
// the caveat advertised itself as the remedy.
export function readWindowMax(): number {
  let cap = DEFAULT_MAX_LOG_BYTES;
  try {
    const configured = resolveConfig().maxLogBytes;
    if (configured > 0) cap = configured;
  } catch {
    // No resolvable config → the default ceiling.
  }
  return cap + WRAPPER_OVERHEAD_BYTES;
}

// Clamp a caller-supplied log search window: absent/garbage/non-positive →
// the default, anything wider than the bound above → the bound (searching past
// what a job could have written is pure cost, and the window is materialized).
export function clampReadWindow(bytes: unknown, max = readWindowMax()): number {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return LOG_READ_BYTES;
  }
  return Math.min(Math.floor(bytes), max);
}

// Trim a scan window to its last LOG_SCAN_LINES_MAX lines without splitting the
// whole window first: walking the newline positions backwards costs one pass
// over the window and never materializes millions of short strings. Returns the
// text to scan plus whether the line bound (rather than the byte window) decided
// the view, so callers can say so instead of implying the whole window was read.
export function boundScanLines(content: string): {
  content: string;
  lineBoundHit: boolean;
} {
  let end = content.length;
  let seen = 0;
  while (seen < LOG_SCAN_LINES_MAX) {
    const nl = content.lastIndexOf("\n", end - 1);
    if (nl === -1) break;
    end = nl;
    seen++;
  }
  // "Hit" only when the limit is what stopped the walk AND bytes were actually
  // trimmed off the front — running out of newlines means the whole window fits.
  const hit = seen === LOG_SCAN_LINES_MAX && end > 0;
  return hit
    ? { content: content.slice(end + 1), lineBoundHit: true }
    : { content, lineBoundHit: false };
}

// Read at call time so tests (and users) can lower the budget; a non-positive
// or non-numeric value falls back to the default.
export function bggrepTimeoutMs(): number {
  const raw = Number(process.env.PI_BGRUN_GREP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : BGGREP_DEFAULT_TIMEOUT_MS;
}

type GrepMatchOutcome =
  | { kind: "ok"; matchIdx: number[] }
  | { kind: "timeout" }
  | { kind: "invalid"; message: string };

// Bounded between lines only — a single pathological line can still stall.
// Used solely when worker_threads is unavailable (never on Node or Bun).
export function matchLinesSyncBounded(
  source: string,
  lines: string[],
  cap: number,
  budgetMs: number,
): GrepMatchOutcome {
  let re: RegExp;
  try {
    re = new RegExp(source);
  } catch (err) {
    return { kind: "invalid", message: (err as Error).message };
  }
  const out: number[] = [];
  const start = Date.now();
  for (let i = 0; i < lines.length; i++) {
    if ((i & 0x3ff) === 0 && Date.now() - start > budgetMs) {
      return { kind: "timeout" };
    }
    const line = lines[i].length > cap ? lines[i].slice(0, cap) : lines[i];
    if (re.test(line)) out.push(i);
  }
  return { kind: "ok", matchIdx: out };
}

// Exported, and workerSource-injectable, so a test can prove the ABORT path on
// any engine: pass a worker body that never returns and the budget must still
// yield `{kind: "timeout"}`. Input-driven catastrophic patterns cannot test it
// — engines differ (V8 backtracks exponentially where JSC does not), so the
// only portable assertion is that termination works.
export async function matchLinesWithBudget(
  source: string,
  lines: string[],
  cap: number,
  budgetMs: number,
  workerSource: string = BGGREP_WORKER_SOURCE,
): Promise<GrepMatchOutcome> {
  let WorkerCtor: typeof import("node:worker_threads").Worker;
  try {
    ({ Worker: WorkerCtor } = await import("node:worker_threads"));
  } catch {
    return matchLinesSyncBounded(source, lines, cap, budgetMs);
  }
  let worker: import("node:worker_threads").Worker;
  try {
    worker = new WorkerCtor(workerSource, {
      eval: true,
      workerData: { source, lines, cap },
    });
  } catch {
    return matchLinesSyncBounded(source, lines, cap, budgetMs);
  }
  return new Promise<GrepMatchOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: GrepMatchOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      // Swallow a late 'error' emitted after listeners are dropped, or it
      // becomes an unhandled emitter throw on the way to terminate().
      worker.on("error", () => {});
      void worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), budgetMs);
    worker.on(
      "message",
      (msg: { ok: boolean; matches?: number[]; message?: string }) => {
        finish(
          msg.ok
            ? { kind: "ok", matchIdx: msg.matches ?? [] }
            : { kind: "invalid", message: msg.message ?? "invalid pattern" },
        );
      },
    );
    worker.on("error", (err) =>
      finish({ kind: "invalid", message: err.message }),
    );
    worker.on("exit", (code) => {
      // Any exit before a message is a failure — including exit 0, which would
      // otherwise linger until the budget and be misreported as a timeout.
      if (!settled) {
        finish({
          kind: "invalid",
          message: `grep worker exited with code ${code} before a result`,
        });
      }
    });
  });
}

// Default regex for bggrep when the caller passes no pattern: common failure
// signatures across test runners and build tools. ONLY a convenience default —
// bggrep's contract is that the caller's own pattern always wins, because a
// generic default on arbitrary tools/languages misses more than it catches.
export const DEFAULT_GREP_PATTERN =
  "--- FAIL:|^FAIL\\b|^panic:|fatal error:|AssertionError|Error:|error:|make: \\*\\*\\*.*Error|✗|✖";

function readLogSlice(
  logPath: string,
  maxBytes: number,
): { content: string; truncated: boolean; size: number } | null {
  try {
    const st = statSync(logPath);
    const size = st.size;
    if (size === 0) return { content: "", truncated: false, size: 0 };
    const readLen = Math.min(size, maxBytes);
    const fd = openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(readLen);
      // Honor the byte count: a short read (file rotated/truncated between stat
      // and read) would otherwise leave the buffer's tail zero-filled and leak
      // NUL bytes into bgtail/bggrep output.
      const n = readSync(fd, buf, 0, readLen, size - readLen);
      return {
        content: (n < readLen ? buf.subarray(0, n) : buf).toString("utf8"),
        truncated: readLen < size,
        size,
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

// The wrapper writes __BGRUN_EXIT__=N as the FINAL line of the log. A marker
// that is NOT the last non-empty line is just job output that happened to
// contain the string (e.g. a command that greps a bgrun log) and is NOT
// evidence of completion. Position matters both ways: trusting any marker would
// let cleanup delete a running job's log; trusting none would let a finished
// log whose pid was later reused live forever.
function parseExitFromContent(content: string): number | null {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length === 0) continue;
    const match = lines[i].match(/^__BGRUN_EXIT__=(-?\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }
  return null;
}

export function parseExitFromLogPath(logPath: string): number | null {
  const slice = readLogSlice(logPath, LOG_TAIL_BYTES);
  if (!slice) return null;
  return parseExitFromContent(slice.content);
}

// Wrapper bookkeeping lines — never job output. Every reader filters them, so a
// capped log's last line, line count, tail window and grep results still
// describe the COMMAND's output rather than the wrapper's own bookkeeping.
// The whole `__BGRUN_` namespace is reserved (exit marker + notices), which is
// also what makes a command printing those lines a deliberate forgery rather
// than an accident.
export function isWrapperLine(line: string): boolean {
  return line.startsWith("__BGRUN_");
}

// What the wrapper recorded about the ceiling, read from the exit marker — the
// last non-empty line, and the only line a command cannot forge: only the LAST
// marker counts, so printing one is not evidence of completion. The flag rides
// on that marker ("__BGRUN_EXIT__=0 truncated=1000"), which is why a command's
// own output can no longer make a healthy log look capped (it used to be read
// from the notice line, whose position and text a command controls).
export type CapStatus =
  | { kind: "truncated"; bytes: number }
  | { kind: "ceiling-failed" }
  | null;

export function parseCapStatusFromContent(content: string): CapStatus {
  const lines = content.split("\n");
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim().length === 0) i--;
  if (i < 0) return null;
  const marker = lines[i];
  if (!marker.startsWith(EXIT_MARKER)) return null;
  const truncated = marker.match(/ truncated=(\d+)/);
  if (truncated) return { kind: "truncated", bytes: parseInt(truncated[1], 10) };
  if (marker.includes(EXIT_MARKER_NOCAP_FLAG)) return { kind: "ceiling-failed" };
  return null;
}

// The byte ceiling a log hit, or null when it was not capped. Thin accessor over
// the marker parse, kept because most callers only care about the number.
export function parseTruncationFromContent(content: string): number | null {
  const status = parseCapStatusFromContent(content);
  return status?.kind === "truncated" ? status.bytes : null;
}

// The marker is written within the last few hundred bytes of the log, so the
// standard tail slice decides this — no full read, even at the ceiling.
function readCapStatus(logPath: string): CapStatus {
  const slice = readLogSlice(logPath, LOG_TAIL_BYTES);
  if (!slice) return null;
  return parseCapStatusFromContent(slice.content);
}

// Compact byte size for the wake and reader notes ("64 MiB", "1.5 KiB",
// "900 bytes"). One decimal is enough: this labels a ceiling, not a quantity.
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round((n / (1024 * 1024)) * 10) / 10} MiB`;
  if (n >= 1024) return `${Math.round((n / 1024) * 10) / 10} KiB`;
  return `${n} bytes`;
}

function readLastLogLine(logPath: string, maxLen = 200): string | null {
  const slice = readLogSlice(logPath, LOG_TAIL_BYTES);
  if (!slice) return null;
  return readLastLineFromContent(slice.content, maxLen);
}

function readLastLineFromContent(content: string, maxLen = 200): string | null {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  const real = lines.filter((l) => !isWrapperLine(l));
  // No content lines (a marker-only log) → nothing to show. Never fall back to
  // the exit-marker line — that leaks "__BGRUN_EXIT__=N" into the wake.
  if (real.length === 0) return null;
  const last = real[real.length - 1];
  return last.length > maxLen ? last.slice(0, maxLen) + "…" : last;
}

function validateJobId(id: string, tool: string): void {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`${tool}: invalid job id ${JSON.stringify(id)}`);
  }
}

function isRunningPid(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it — treat as alive.
    return code === "EPERM";
  }
}

function pidFromId(id: string): number | null {
  const parts = id.split("-");
  const pid = parseInt(parts[parts.length - 1], 10);
  return Number.isFinite(pid) ? pid : null;
}

// One entry per *.log in a jobs dir, with the derived state every caller needs
// (finish marker, owning pid + liveness, timestamps). This is the single scan
// used by cleanup, foreign-job adoption, and bgstatus — they used to each
// re-implement the readdir/filter/parse/pid dance and drifted apart.
interface ScannedLogFile {
  id: string;
  logPath: string;
  pid: number | null; // pid encoded in the id's last segment
  alive: boolean; // pid > 0 and signalable (or EPERM)
  mtimeMs: number;
  birthtimeMs: number;
}

interface ScannedLog extends ScannedLogFile {
  exit: number | null; // parsed __BGRUN_EXIT__ marker, null while running
}

// The scan WITHOUT the exit-marker read. Exit parsing needs a tail read of the
// file, so callers that can filter by mtime first (cleanup) use this and pay
// for the read only on files they may actually act on.
function scanLogFiles(jobsDir: string): ScannedLogFile[] {
  let names: string[];
  try {
    names = readdirSync(jobsDir);
  } catch {
    return []; // jobs dir doesn't exist — nothing to scan
  }
  const out: ScannedLogFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".log")) continue;
    // .tmp-*.log is the pre-rename staging file (see the spawn path). It is
    // never a job — a crashed spawn can leave one behind; sweepStaleMarkers
    // reclaims it.
    if (name.startsWith(".tmp-")) continue;
    const logPath = join(jobsDir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(logPath);
    } catch {
      continue; // vanished between readdir and stat
    }
    const pid = pidFromId(name.slice(0, -".log".length));
    out.push({
      id: name.slice(0, -".log".length),
      logPath,
      pid,
      alive: pid !== null && pid > 0 && isRunningPid(pid),
      mtimeMs: st.mtimeMs,
      birthtimeMs: st.birthtimeMs,
    });
  }
  return out;
}

// The full scan (exit marker resolved) for callers that need finished/running
// state for every entry.
function scanJobsDir(jobsDir: string): ScannedLog[] {
  return scanLogFiles(jobsDir).map((e) => ({
    ...e,
    exit: parseExitFromLogPath(e.logPath),
  }));
}

// Redact obvious credential values before they reach a filename, widget, or
// status line. The raw command still appears in the wake message (needed for
// context), but the persisted job id / slug is a much longer-lived leak
// channel (it survives in filenames and `bgstatus` output for cleanupDays).
// ── Secret redaction for slugs ─────────────────────────────────────────────
// A job id becomes a filename, and filenames get listed, shared, and scraped.
// Commands routinely embed credentials, so redact values BEFORE they reach a
// slug. This deliberately errs toward over-redaction: a mangled slug is
// cosmetic, a leaked token is not.

// Secret-ish key words, matched as a substring of a longer key (GH_TOKEN,
// AWS_SECRET_ACCESS_KEY, DB_PASSWORD) with a trailing non-letter guard so
// "author"/"designer" are not mistaken for "auth"/"sig".
const SECRET_KEY_WORDS =
  "authorization|pass(?:word|wd|phrase)?|passw(?:or)?d|secret|token|" +
  "api[-_]?key|apikey|access[-_]?key|private[-_]?key|client[-_]?secret|" +
  "credential(?:s)?|session[-_]?id|signature|pwd|bearer|auth";
// A key: optional surrounding word chars/dots/dashes, then a secret word.
const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*(?:${SECRET_KEY_WORDS})(?![A-Za-z])`;
// A value: a quoted string, a `scheme credential` pair ("Bearer abc"), or a
// bare token. The scheme form is tried first so the credential after it is
// consumed too — otherwise "Authorization: Bearer abc" redacts only "Bearer".
const SECRET_VALUE = String.raw`(?:'[^']*'|"[^"]*"|(?:bearer|basic|token|digest)\s+\S+|\S+)`;
const SECRET_ASSIGN_RE = new RegExp(
  String.raw`(${SECRET_KEY})["']?\s*[:=]\s*["']?${SECRET_VALUE}`,
  "gi",
);
const SECRET_FLAG_RE = new RegExp(
  String.raw`(^|\s)(-{1,2}${SECRET_KEY})(\s*[:=]\s*|\s+)["']?${SECRET_VALUE}`,
  "gi",
);

export function redactForSlug(command: string): string {
  return (
    command
      // Header arguments: -H stays CASE-SENSITIVE (so a lower-case `-h`/help
      // flag is never mangled); --header is case-insensitive. The whole
      // argument is consumed — any header can carry a token.
      .replace(/(^|\s)-H(=|\s+)('[^']*'|"[^"]*"|\S+)/g, "$1-H$2-REDACTED")
      .replace(
        /(^|\s)--header(=|\s+)('[^']*'|"[^"]*"|\S+)/gi,
        "$1--header$2-REDACTED",
      )
      // curl -u user:pass / --user user:pass (only when it looks like a pair,
      // so unrelated flags like `sort -u` are left alone).
      .replace(/(^|\s)-u(\s+)([^\s:]+:[^\s]+)/g, "$1-u$2-REDACTED")
      .replace(/(^|\s)--user(\s+)([^\s:]+:[^\s]+)/g, "$1--user$2-REDACTED")
      // URL userinfo: scheme://user:pass@host.
      .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, "$1-REDACTED@")
      // KEY=value / KEY: value, including quoted JSON ("password":"x").
      .replace(SECRET_ASSIGN_RE, "$1-REDACTED")
      // --flag value / --flag=value / --flag: value.
      .replace(SECRET_FLAG_RE, "$1$2-REDACTED")
  );
}

function resolveGitCommonDir(gitDir: string): string {
  const commonFile = join(gitDir, "commondir");
  if (!existsSync(commonFile)) return gitDir;
  try {
    const rel = readFileSync(commonFile, "utf8").trim();
    return isAbsolute(rel) ? rel : join(gitDir, rel);
  } catch {
    return gitDir;
  }
}

function ensureJobsDirMarker(jobsDir: string): void {
  try {
    mkdirSync(jobsDir, { recursive: true });
    const marker = join(jobsDir, JOBS_DIR_MARKER);
    if (!existsSync(marker)) writeFileSync(marker, "");
  } catch {
    // best-effort
  }
}

function logReadError(id: string, logPath: string): string {
  if (existsSync(logPath)) {
    return `Log for job ${id} at ${logPath} exists but could not be read (file may be too large or unreadable)`;
  }
  return `No log found for job ${id} at ${logPath}`;
}

// ── Configuration ───────────────────────────────────────────────────────────
//
// Layered: defaults ← user config file ← project config file (trusted projects
// only) ← environment variables. Pi passes no first-class per-extension config
// through the ExtensionAPI, so this follows the documented pattern: the
// extension reads its own JSON config from ~/.pi/agent/pi-bgrun.json (user) and
// <cwd>/<CONFIG_DIR_NAME>/pi-bgrun.json (project, honored only when the project
// is trusted), with PI_BGRUN_* env vars as overrides.

export type WakePolicy = "never" | "failure" | "always";

export function shouldWakeAgent(
  policy: WakePolicy,
  exitCode: number,
): boolean {
  return policy === "always" || (policy === "failure" && exitCode !== 0);
}

function normalizeWakePolicy(value: unknown): WakePolicy | undefined {
  return value === "never" || value === "failure" || value === "always"
    ? value
    : undefined;
}

interface BgrunConfig {
  jobsDir: string;
  // True when jobsDir resolves inside the project root (the default in a
  // recognizable project, or an explicit RELATIVE path). Only then does bgrun
  // auto-ignore the dir in .git/info/exclude — an absolute dir is the user's
  // explicit choice.
  jobsDirProjectLocal: boolean;
  // Adopt other sessions' running jobs (found in the shared jobs dir) into
  // this session's widget and job list. Default false — most sessions don't
  // want unrelated jobs from other projects cluttering the widget.
  adoptForeignJobs: boolean;
  // Include finished jobs in bgstatus listings by default. Default false —
  // completed jobs are noise; ask for them explicitly (bgstatus includeDone).
  showCompletedJobs: boolean;
  // Default policy for injecting a completion message into the model turn.
  // Human toast/widget updates are independent and always remain enabled.
  defaultWake: WakePolicy;
  // Log retention for cleanup (auto-sweeps and the bgclean default).
  cleanupDays: number;
  // Byte ceiling for a job's log (stdout+stderr). A runaway job (`yes`, a spew
  // loop) would otherwise fill the disk. The cap keeps the FIRST maxLogBytes
  // bytes and appends a truncation notice; the job itself runs to completion
  // with its real exit code. 0 = unlimited. Read per job at spawn time.
  maxLogBytes: number;
  // Auto-sweep the shared jobs dirs at session boundaries for orphans —
  // finished (exit marker or dead pid) logs older than cleanupDays from
  // sessions that crashed or are never resumed again. Both the machine-global
  // dir and the current project's dir are swept (see sharedJobsDirs), so
  // pre-project-local logs are still reclaimed. Running jobs are always
  // pid-protected. Throttled to once per cleanupDays via a .last-clean marker.
  // Default true — without it, orphaned logs accumulate forever. Set false to
  // keep every sweep session-scoped (then only `bgclean all` touches foreign
  // logs).
  globalAutoClean: boolean;
  // Opt-in digest scorecards, normalized to an ordered list of entries (or
  // undefined when unconfigured or fully invalid — an empty array is normalized
  // to undefined so the session_start nudge still sees "not configured"). The
  // object form is normalized to a single entry with no matchers. Each entry
  // carries an optional `match` (globs against the job name / command line),
  // an optional wake `label`, and a `preset` or custom `command`. At wake time
  // the FIRST matching entry wins. Presets are shipped sh commands (see
  // digestPresets.ts); command receives the job's log path as $1. Resolved from
  // trusted project config only — never runs pattern matching unless the
  // project opted in.
  digest?: DigestEntry[];
}

interface BgrunConfigFile {
  jobsDir?: unknown;
  adoptForeignJobs?: unknown;
  showCompletedJobs?: unknown;
  defaultWake?: unknown;
  cleanupDays?: unknown;
  maxLogBytes?: unknown;
  globalAutoClean?: unknown;
  digest?: unknown;
}

function parseBoolEnv(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const t = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(t)) return true;
  if (["0", "false", "no", "off"].includes(t)) return false;
  return undefined;
}

function readConfigFile(path: string): BgrunConfigFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {}; // missing — normal, not an error
  }
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      return raw as BgrunConfigFile;
    console.error(
      `[pi-bgrun] config ${path} is not a JSON object — ignoring its contents`,
    );
  } catch (err) {
    console.error(
      `[pi-bgrun] config ${path} is malformed JSON (${(err as Error).message}) — ignoring its contents`,
    );
  }
  return {};
}

// A byte-budget copier that writes as it reads: keep the first $cap bytes of
// stdin on stdout, flag (O_EXCL, 0600) if anything was left over, and drain the
// rest so the producer never gets SIGPIPE. Used as the drain when perl is
// available: `dd` and `head` are the portable choices, but both buffer their
// output — measured: nothing on disk until 4-8 KiB accumulated, so a running
// capped job's log looks stalled for a slow producer, breaking the live-tail
// workflow bgtail documents. perl's sysread/syswrite has no stdio buffering, so
// the first byte lands immediately. The program avoids quotes so it can be
// single-quoted in the wrapper.
const PERL_CAP_COPIER = [
  `use Fcntl;`,
  `my $cap = $ARGV[0]; my $flag = $ARGV[1]; my $left = $cap; my $over = 0; my $flagged = 0; my $buf;`,
  `while (1) {`,
  `  my $n = sysread(STDIN, $buf, 65536);`,
  `  last if !defined($n) || $n == 0;`,
  `  if ($left > 0) {`,
  `    my $take = $n < $left ? $n : $left;`,
  `    my $off = 0;`,
  `    while ($off < $take) { my $w = syswrite(STDOUT, $buf, $take - $off, $off); last if !defined($w) || $w <= 0; $off += $w; }`,
  `    $left -= $off;`,
  `    $over = 1 if $n > $take;`,
  `  } else { $over = 1; }`,
  `  if ($over && !$flagged) { my $fh; if (sysopen($fh, $flag, O_WRONLY | O_CREAT | O_EXCL, 0600)) { close($fh); } $flagged = 1; }`,
  `}`,
].join("\n");

// ── Job wrapper ─────────────────────────────────────────────────────────────
//
// Every job runs inside a detached `sh -c` tree, so the log ceiling has to live
// there too — it must hold after pi exits. The command is passed as argv ($1),
// never interpolated, or `#`, quotes and heredocs would break.
//
// Capped shape: the command runs as its OWN background job writing into a fifo;
// a drain copies at most `cap` bytes of that into the log and then reports
// whether anything was left over. Two properties drive that structure:
//
//  - Completion must follow the COMMAND, not the data flow. As a pipeline stage,
//    `wait` would return only when every holder of the pipe's write end closes
//    it — and a child the command backgrounded (`server &`, a watcher, a
//    daemonized tool) inherited that fd, so the job would never wake while the
//    child lived. `wait "$prod"` returns when `sh -c` is reaped; the strays keep
//    running, they just stop being logged (which is the point of a ceiling).
//  - The drain may outlive the command, so truncation is reported through a flag
//    FILE, and the wrapper's exit marker carries the machine-readable flag. A
//    notice line in the log is not evidence: a command can print the same text,
//    and only the LAST marker counts, so the marker is the one line a command
//    cannot forge.
//
// The drain's byte budget is exact only with `dd iflag=fullblock` (each block is
// filled before it counts): plain `dd` counts READS, so a slow writer would
// exhaust the budget without filling the cap. Without `iflag` (most non-GNU
// systems) `head -c` is used instead — exact, but block-buffered, so a running
// job's log lags by up to 8 KiB until the job exits.
//
// If `mkfifo` fails, fall back to the uncapped path: losing output is worse than
// losing the ceiling — but say so, in the log and in the marker.
//
// argv: $1 command, $2 ecfile, $3 fifo, $4 pidfile, $5 truncation flag.
export function cappedWrapper(maxBytes: number): string {
  const cap = String(maxBytes);
  return [
    `flag=`,
    // Staging names are ours: clear any leftover or planted entry first — rm
    // unlinks the name and never follows a link — and every write below runs
    // under `set -C` (noclobber) so a path that reappears is refused rather than
    // written through. umask is scoped to those writes: the command must keep
    // its own.
    `rm -f "$2" "$3" "$4" "$5" 2>/dev/null`,
    `if mkfifo -m 600 "$3" 2>/dev/null && [ -p "$3" ]; then`,
    `  ( umask 077; set -C; printf '%d' "$$" >"$4" ) 2>/dev/null || :`,
    `  { sh -c "$1" 2>&1; ec=$?; ( umask 077; set -C; printf '%d' "$ec" >"$2" ) 2>/dev/null; } >"$3" &`,
    `  prod=$!`,
    `  { if command -v perl >/dev/null 2>&1; then`,
    // One process: cap + flag + drain, no stdio buffering (see PERL_CAP_COPIER).
    `      perl -e '${PERL_CAP_COPIER}' ${cap} "$5"`,
    `    elif dd iflag=fullblock bs=1 count=0 </dev/null >/dev/null 2>&1; then`,
    // Exact, but block-buffered: the log lags by up to one block while the job
    // runs. (Plain `dd` is worse: it counts READS, so a slow writer exhausts the
    // budget without filling the cap and later output is dropped.)
    `      { dd iflag=fullblock bs=4096 count=$(( ${cap} / 4096 )) 2>/dev/null; dd iflag=fullblock bs=1 count=$(( ${cap} % 4096 )) 2>/dev/null; }`,
    `      if [ "$(dd bs=1 count=1 2>/dev/null | wc -c)" -gt 0 ]; then ( umask 077; set -C; : >"$5" ) 2>/dev/null || :; fi`,
    `      cat >/dev/null`,
    `    else`,
    `      head -c ${cap}`,
    `      if [ "$(dd bs=1 count=1 2>/dev/null | wc -c)" -gt 0 ]; then ( umask 077; set -C; : >"$5" ) 2>/dev/null || :; fi`,
    `      cat >/dev/null`,
    `    fi; } <"$3" &`,
    `  drain=$!`,
    `  wait "$prod"`,
    // The command is done. The drain copies unbuffered, so there is nothing to
    // flush — this short bounded wait only gives it the moment it needs to
    // notice EOF. A child the command backgrounded and did not wait for can hold
    // the fifo open indefinitely; the job must complete anyway (and that stray's
    // output simply stops being logged, which is what a ceiling is for). Note
    // that after the byte budget is spent only the discard stage remains, so
    // nothing can be written to the log after these notices.
    `  j=0`,
    `  while kill -0 "$drain" 2>/dev/null && [ "$j" -lt 5 ]; do sleep 0.02; j=$((j + 1)); done`,
    `  ec=$(if [ -f "$2" ]; then cat "$2" 2>/dev/null; fi)`,
    `  if [ -e "$5" ]; then`,
    `    printf '\\n${TRUNC_NOTICE_PREFIX}: kept the first %s bytes\\n' ${cap}`,
    `    flag="${EXIT_MARKER_TRUNC_FLAG}${cap}"`,
    `  fi`,
    `else`,
    `  sh -c "$1" 2>&1`,
    `  ec=$?`,
    `  printf '\\n${CAPFAIL_NOTICE_PREFIX} (mkfifo failed, so this job ran uncapped)\\n'`,
    `  flag="${EXIT_MARKER_NOCAP_FLAG}"`,
    `fi`,
    `rm -f "$2" "$3" "$4" "$5" 2>/dev/null`,
    `[ -n "$ec" ] || ec=-1`,
    `printf '\\n%s%d%s\\n' "${EXIT_MARKER}" "$ec" "\${flag}"`,
    `exit "$ec"`,
  ].join("\n");
}

// ── Project-local jobs dir ──────────────────────────────────────────────────
//
// By default, when the session cwd is inside a recognizable project root
// (`.git` or `.pi`), logs land at `<project>/.pi-bgrun/jobs`. The root is found
// by walking up from the cwd, so a session started in a subdirectory still
// resolves project-locally. With no project root the default falls back to the
// machine-global `~/.pi-bgrun/jobs`. An explicit RELATIVE `jobsDir` (from any
// config layer, or PI_BGRUN_DIR) resolves the same way; an absolute path is
// used as-is (migration-safe). Project-local logs stay inside the workspace
// sandbox so analysis tools confined to the project root (e.g. context-mode's
// ctx_execute_file/ctx_index) can process whole logs without flooding context.

function isProjectRootLike(dir: string): boolean {
  // Cheap heuristic: a directory holding .git or pi's config dir is a project.
  return (
    existsSync(join(dir, ".git")) || existsSync(join(dir, CONFIG_DIR_NAME))
  );
}

// realpath that never throws: a non-existent or unreadable path falls back to
// the literal path so callers can compare paths without guarding every step.
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// Nearest ancestor of `start` (inclusive) that looks like a project root.
// The user's home directory is never treated as a project root: pi's global
// agent dir (~/.pi/agent) would otherwise make every cwd under $HOME resolve
// to $HOME. Paths are canonicalized so a symlinked $HOME is still recognized.
function findProjectRoot(
  start: string,
  home: string = homeDir(),
): string | undefined {
  const homeReal = safeRealpath(home);
  let cur = start;
  for (;;) {
    if (safeRealpath(cur) !== homeReal && isProjectRootLike(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur || safeRealpath(cur) === homeReal) return undefined;
    cur = parent;
  }
}

// The user's home directory, HOME-first. Node's os.homedir() already resolves
// HOME before falling back to the passwd entry, but Bun's ignores HOME — so
// deriving it here keeps `~`, the machine-global jobs dir and the project-root
// exclusion identical under both runtimes (and lets tests pin HOME).
function homeDir(): string {
  return process.env.HOME || homedir();
}

// Expand a leading `~` (bare or `~/...`) to the user's home directory so a
// config/env path like `~/.pi-bgrun/jobs` is absolute rather than a relative
// path interpreted project-locally.
function expandTilde(p: string): string {
  if (p === "~") return homeDir();
  if (p.startsWith("~/")) return join(homeDir(), p.slice(2));
  return p;
}

// Project/worktree root for identity keys — the enclosing project root when
// there is one, else the directory itself (so a non-project cwd still gets a
// stable key). Matches the root resolveJobsDirPath uses for project-local
// logs, so two cwds in the same checkout share one digest-nudge key.
function projectRootFor(dir: string): string {
  return findProjectRoot(dir) ?? dir;
}

export function resolveJobsDirPath(
  raw: string | undefined,
  ctx?: { cwd?: string; home?: string },
): { dir: string; projectLocal: boolean } {
  const p = raw ? expandTilde(raw) : raw;
  // Absolute paths are the user's explicit choice: used as-is, never flagged
  // project-local, and no ancestor walk needed.
  if (p && isAbsolute(p)) return { dir: p, projectLocal: false };
  const cwd = ctx?.cwd ?? process.cwd();
  const root = cwd ? findProjectRoot(cwd, ctx?.home) : undefined;
  if (!p) {
    return root
      ? { dir: join(root, PROJECT_LOCAL_JOBS_REL), projectLocal: true }
      : { dir: globalJobsDir(), projectLocal: false };
  }
  if (!root) return { dir: globalJobsDir(), projectLocal: false };
  // A relative path can escape the project root ("../outside"); only flag it
  // project-local when the joined dir actually stays inside the root, so git
  // exclusion and the untrusted-repo guard apply to the right thing.
  const joined = join(root, p);
  const rel = relative(root, joined);
  // `..foo` is a sibling, not an escape — only `..` itself or `../` escapes.
  const inside =
    rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
  return { dir: joined, projectLocal: inside };
}

// Auto-ignore a project-local jobs dir in git so logs never pollute
// `git status`: appends the dir pattern to the enclosing repo's
// .git/info/exclude (local-only — the tracked .gitignore is never touched).
// Memoized only on SUCCESS — a transient failure (unwritable exclude file,
// .git appearing later) is retried on the next bgrun. Every step is
// best-effort and must never fail a bgrun.
const gitExcludedDirs = new Set<string>();

// Returns true when the dir is settled (pattern written, already present, or
// legitimately nothing to do — no repo above, dir is the repo root itself).
// False only on failure, so the caller retries next time.
export function ensureGitExcluded(jobsDir: string): boolean {
  if (gitExcludedDirs.has(jobsDir)) return true;
  if (tryEnsureGitExcluded(jobsDir)) {
    gitExcludedDirs.add(jobsDir);
    return true;
  }
  return false;
}

function tryEnsureGitExcluded(jobsDir: string): boolean {
  try {
    // Walk up from jobsDir to the enclosing work tree.
    let cur = jobsDir;
    for (;;) {
      const dot = join(cur, ".git");
      if (existsSync(dot)) return appendExcludePattern(cur, dot, jobsDir);
      const parent = dirname(cur);
      if (parent === cur) return true; // filesystem root — no repo above; nothing to do
      cur = parent;
    }
  } catch {
    // best-effort — ignore hygiene must never break job creation
    return false;
  }
}

function appendExcludePattern(
  repoRoot: string,
  dotGit: string,
  jobsDir: string,
): boolean {
  if (jobsDir === repoRoot) return true; // can't exclude the whole repo; nothing to do
  // `.git` is a directory in a normal checkout, or a file pointing at the
  // real git dir in linked worktrees (git worktree add) and submodules.
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
    if (!m) return false; // unparseable .git file — retry later
    gitDir = m[1].trim();
  }
  gitDir = resolveGitCommonDir(gitDir);
  const rel = relative(repoRoot, jobsDir);
  // Defense-in-depth: the walk-up guarantees jobsDir sits under repoRoot, but
  // a future caller or symlinked path could break that — ../-prefixed
  // patterns are silently useless in gitignore semantics, so skip them.
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    return true;
  const pattern = rel.split(sep).join("/") + "/";
  const excludePath = join(gitDir, "info", "exclude");
  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf8");
  } catch {
    // no exclude file yet — we'll create it
  }
  if (existing.split("\n").some((l) => l.trim() === pattern)) return true;
  mkdirSync(join(gitDir, "info"), { recursive: true });
  appendFileSync(
    excludePath,
    `\n# pi-bgrun job logs (auto-added)\n${pattern}\n`,
  );
  return true;
}

// Digest config validation: invalid values are dropped from the resolved
// config (best-effort — a malformed digest section must never break a wake or
// the whole config), but the human gets one console.error per distinct invalid
// field so typos are discoverable without flooding the log. The field set is a
// fixed, code-defined list (preset / command / match / type / ...), so the
// dedupe set is naturally bounded.
const digestWarned = new Set<string>();
function warnDigestInvalid(field: string, value: unknown): void {
  if (digestWarned.has(field)) return;
  digestWarned.add(field);
  const hint =
    field === "preset"
      ? ` — valid presets: ${DIGEST_PRESET_IDS.join(", ")}`
      : "";
  // Point at the array form too: the same `digest` key accepts an ordered
  // list of { type, match, label, preset, command } entries.
  const shapeHint =
    " — digest takes an object or an array of { type, match, label, preset, command } entries";
  // field "" means the whole `digest` section was unusable (wrong shape).
  const where = field ? `digest.${field}` : "digest";
  console.error(
    `[pi-bgrun] ignoring invalid ${where} in pi-bgrun.json: ${JSON.stringify(value)}${hint}${shapeHint}`,
  );
}

function projectHash(projectDir: string): string {
  return createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
}

/**
 * Per-project "this project has run a bgrun job" marker in the jobs dir,
 * keyed by the project/worktree root (the enclosing root found by walking up
 * from cwd, falling back to cwd itself). Written (best-effort) at spawn and
 * read at session_start by the digest nudge, so evidence of use stays
 * project-scoped even when the jobs dir is shared (an absolute/global
 * `jobsDir`); project-local dirs get the same per-project key harmlessly.
 */
function projectMarkerPath(
  jobsDir: string,
  projectDir: string,
  prefix: string,
): string {
  return join(jobsDir, `${prefix}${projectHash(projectDir)}`);
}

export function jobUsageMarkerPath(
  jobsDir: string,
  projectDir: string,
): string {
  return projectMarkerPath(jobsDir, projectDir, ".bgrun-used-");
}

/**
 * Per-project marker path for the one-shot digest nudge. When the jobs dir is
 * shared (an absolute/global `jobsDir`), a bare `.digest-nudge-done` marker
 * would silence the nudge for every other project after the first to earn it;
 * keying by the project/worktree root gives each project its own one-shot.
 * Under the project-local default the dir is already per-project, so the key
 * is redundant but harmless.
 */
export function digestNudgeMarkerPath(
  jobsDir: string,
  projectDir: string,
): string {
  return projectMarkerPath(jobsDir, projectDir, ".digest-nudge-");
}

/**
 * One-shot session_start toast for a trusted project with no digest
 * configured (see maybeNudgeDigest). Exported so tests assert the real string.
 */
export const DIGEST_NUDGE_TEXT =
  "pi-bgrun: no digest configured for this project — use the digest-config skill to set one up.";

// Job and config `type` values are short routing tokens. Both sides cap at the
// same length; if only the job side truncated, a >MAX_TYPE_LEN config type
// would silently never match the job's truncated type.
const MAX_TYPE_LEN = 40;
const MAX_LABEL_LEN = 60;

/**
 * Trim, lowercase, and cap a job or config `type`. Non-string or blank →
 * undefined. Both the bgrun param and the digest config go through here so
 * their truncation can never drift apart.
 */
function normalizeType(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_TYPE_LEN);
}

// Normalize one digest entry from the object-or-array config. Best-effort:
// anything unusable is dropped (never throws). An entry without a usable
// preset or command contributes nothing; a non-string `match` field drops the
// whole entry (the human gets the one-time warning).
function normalizeDigestEntry(raw: unknown): DigestEntry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entry = raw as {
    type?: unknown;
    match?: unknown;
    label?: unknown;
    preset?: unknown;
    command?: unknown;
  };

  // `type` and `match` compose (AND): both are kept and both must match at
  // selection time. An invalid `type` (present but not a non-empty string)
  // drops the whole entry (same best-effort policy as an invalid `match`).
  // normalizeType() applies the same trim/lowercase/cap the job side uses, so
  // a long config type still matches the (truncated) long job type.
  let type: string | undefined;
  if (entry.type !== undefined) {
    type = normalizeType(entry.type);
    if (!type) {
      warnDigestInvalid("type", entry.type);
      return undefined;
    }
  }

  let match: DigestMatch | undefined;
  if (entry.match !== undefined) {
    if (
      !entry.match ||
      typeof entry.match !== "object" ||
      Array.isArray(entry.match)
    ) {
      warnDigestInvalid("match", entry.match);
      return undefined;
    }
    const rawMatch = entry.match as { name?: unknown; command?: unknown };
    const normalized: DigestMatch = {};
    // A glob pattern is any string; a blank one is treated as absent so it
    // doesn't constrain matching. A non-string is invalid → drop the entry.
    if (rawMatch.name !== undefined) {
      if (typeof rawMatch.name !== "string") {
        warnDigestInvalid("match.name", rawMatch.name);
        return undefined;
      }
      if (rawMatch.name.trim()) normalized.name = rawMatch.name;
    }
    if (rawMatch.command !== undefined) {
      if (typeof rawMatch.command !== "string") {
        warnDigestInvalid("match.command", rawMatch.command);
        return undefined;
      }
      if (rawMatch.command.trim()) normalized.command = rawMatch.command;
    }
    if (normalized.name !== undefined || normalized.command !== undefined) {
      match = normalized;
    }
  }

  let preset: string | undefined;
  if (entry.preset !== undefined) {
    if (
      typeof entry.preset === "string" &&
      DIGEST_PRESET_IDS.includes(entry.preset)
    ) {
      preset = entry.preset;
    } else {
      warnDigestInvalid("preset", entry.preset);
    }
  }

  let command: string | undefined;
  if (entry.command !== undefined) {
    if (typeof entry.command === "string" && entry.command.trim()) {
      command = entry.command;
    } else {
      warnDigestInvalid("command", entry.command);
    }
  }

  // Neither preset nor command → nothing this entry can score. Drop it.
  if (!preset && !command) return undefined;

  const out: DigestEntry = {};
  if (type) out.type = type;
  if (match) out.match = match;
  if (typeof entry.label === "string" && entry.label.trim()) {
    out.label = entry.label.trim().slice(0, MAX_LABEL_LEN);
  }
  if (preset) out.preset = preset;
  if (command) out.command = command;
  return out;
}

// Resolved per call (cheap: at most two small file reads) so env/config
// changes are picked up without module reloads — and tests can isolate.
// Exported for tests, like formatSince.
export function resolveConfig(ctx?: {
  cwd?: string;
  isProjectTrusted?: () => boolean;
  // Test seam: an explicit path, immutable for the process. Tests may also
  // simply pin HOME — homeDir() honors it under every runtime, unlike Bun's
  // os.homedir().
  userConfigPath?: string;
}): BgrunConfig {
  // User config: $HOME/.pi/agent/pi-bgrun.json. Overridable by an explicit
  // test seam (ctx.userConfigPath) and by PI_BGRUN_USER_CONFIG (mirrors the
  // PI_BGRUN_DIR escape hatch).
  const user = readConfigFile(
    ctx?.userConfigPath ??
      process.env.PI_BGRUN_USER_CONFIG ??
      join(homeDir(), ".pi", "agent", "pi-bgrun.json"),
  );
  let project: BgrunConfigFile = {};
  try {
    if (ctx?.isProjectTrusted?.()) {
      // Read the project config from the same root resolveJobsDirPath uses, so
      // a session started in a subdirectory still picks up <root>/.pi config.
      const cwd = ctx.cwd ?? process.cwd();
      const projectRoot = projectRootFor(cwd);
      project = readConfigFile(
        join(projectRoot, CONFIG_DIR_NAME, "pi-bgrun.json"),
      );
    }
  } catch {
    // unreadable project config — ignore
  }
  const merged: BgrunConfigFile = { ...user, ...project };
  const foreignFile =
    typeof merged.adoptForeignJobs === "boolean"
      ? merged.adoptForeignJobs
      : undefined;
  const completedFile =
    typeof merged.showCompletedJobs === "boolean"
      ? merged.showCompletedJobs
      : undefined;
  const globalCleanFile =
    typeof merged.globalAutoClean === "boolean"
      ? merged.globalAutoClean
      : undefined;
  const wakeFile = normalizeWakePolicy(merged.defaultWake);
  const wakeEnv = normalizeWakePolicy(process.env.PI_BGRUN_WAKE);
  const dirFile =
    typeof merged.jobsDir === "string" && merged.jobsDir
      ? merged.jobsDir
      : undefined;
  const daysFile =
    typeof merged.cleanupDays === "number" &&
    Number.isFinite(merged.cleanupDays) &&
    merged.cleanupDays > 0
      ? merged.cleanupDays
      : undefined;
  const envDays = Number(process.env.PI_BGRUN_CLEANUP_DAYS);
  const daysEnv = Number.isFinite(envDays) && envDays > 0 ? envDays : undefined;
  // Byte ceiling: unlike cleanupDays, 0 is meaningful ("unlimited"), so it is
  // accepted — but a BLANK env var is not, or an empty
  // PI_BGRUN_MAX_LOG_BYTES= would silently disable the cap. Normalization also
  // keeps the value in a range the wrapper can express: a positive fraction
  // becomes 1 (flooring it to 0 would silently mean "unlimited"), and an
  // enormous value is clamped instead of stringifying to "1e+21", which the
  // shell's `head -c`/`dd` reject — discarding every byte of job output.
  const maxBytesFile = normalizeMaxLogBytes(merged.maxLogBytes);
  const maxBytesRaw = process.env.PI_BGRUN_MAX_LOG_BYTES;
  const maxBytesEnvValue =
    maxBytesRaw === undefined || maxBytesRaw.trim() === ""
      ? NaN
      : Number(maxBytesRaw);
  const maxBytesEnv = normalizeMaxLogBytes(maxBytesEnvValue);
  const { dir: jobsDir, projectLocal: jobsDirProjectLocal } =
    resolveJobsDirPath(process.env.PI_BGRUN_DIR || dirFile, ctx);
  // Digest section: accept either the legacy single-object form (normalized to
  // one entry with no matchers) or an ordered array of entries. Invalid inputs
  // are dropped best-effort (warnDigestInvalid logs once per distinct field) —
  // including a present-but-unusable section (a string/number, or a list that
  // empties out). When both preset and command are valid within an entry, both
  // are kept here — resolveDigest() gives the preset precedence. An empty or
  // all-invalid section normalizes to undefined so `cfg.digest` truthiness
  // still means "configured" (the session_start nudge relies on that).
  let digest: BgrunConfig["digest"];
  if (Array.isArray(merged.digest)) {
    const entries = merged.digest
      .map((raw) => normalizeDigestEntry(raw))
      .filter((e): e is DigestEntry => e !== undefined);
    if (entries.length) {
      digest = entries;
    } else if (merged.digest.length) {
      // A non-empty list that normalized to nothing: every entry was invalid.
      warnDigestInvalid("", merged.digest);
    }
  } else if (merged.digest !== undefined && merged.digest !== null) {
    // A present non-null value that isn't a list. `null` is treated as absent.
    if (typeof merged.digest === "object") {
      const entry = normalizeDigestEntry(merged.digest);
      if (entry) {
        digest = [entry];
      } else {
        warnDigestInvalid("", merged.digest);
      }
    } else {
      // Present but not an object/list — a likely mistake like
      // `"digest": "go-test"`, which would otherwise be silently unconfigured.
      warnDigestInvalid("", merged.digest);
    }
  }
  return {
    jobsDir,
    jobsDirProjectLocal,
    adoptForeignJobs:
      parseBoolEnv(process.env.PI_BGRUN_FOREIGN_JOBS) ?? foreignFile ?? false,
    showCompletedJobs:
      parseBoolEnv(process.env.PI_BGRUN_SHOW_COMPLETED) ??
      completedFile ??
      false,
    // Preserve the package's historical behavior unless the user/project opts
    // into quieter defaults. Each bgrun call can still override this policy.
    defaultWake: wakeEnv ?? wakeFile ?? "always",
    cleanupDays: daysEnv ?? daysFile ?? DEFAULT_CLEANUP_DAYS,
    maxLogBytes: maxBytesEnv ?? maxBytesFile ?? DEFAULT_MAX_LOG_BYTES,
    globalAutoClean:
      parseBoolEnv(process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN) ??
      globalCleanFile ??
      true,
    digest,
  };
}

// Widget "since" formatting: time-only when the job started today; otherwise
// include the date (and the year too when it differs) — a job that has been
// running since a previous day shouldn't render as if it started today at
// that time. `now` is injectable for deterministic tests.
export function formatSince(started: number, now: number = Date.now()): string {
  const d = new Date(started);
  const n = new Date(now);
  const time = d.toLocaleTimeString([], { hour12: false });
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  if (sameDay) return time;
  if (d.getFullYear() === n.getFullYear()) {
    const md = d.toLocaleDateString([], { month: "short", day: "numeric" });
    return `${md} ${time}`;
  }
  const ymd = d.toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `${ymd} ${time}`;
}

// Universal-stats duration formatting for the wake message's Stats line: one
// decimal in seconds under a minute ("42.3s"), m:ss above ("5:07").
// Exported for tests, like formatSince.
export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60) + (Math.round(s % 60) === 60 ? 1 : 0);
  const rem = Math.round(s % 60) % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

interface JobRecord {
  id: string;
  pid: number;
  cmd: string;
  name?: string; // optional human-readable label
  type?: string; // optional job type used for digest scorecard selection
  wake: WakePolicy; // whether completion injects a model turn
  started: number;
  logPath: string;
  exitedAt?: number;
  exitCode?: number;
  donePersisted?: boolean; // done entry already appended to the transcript
  child?: ReturnType<typeof spawn>; // absent for adopted (fs-discovered) jobs
  ctx: ExtensionContext; // captured at tool-call time for isIdle() in the exit handler
  adopted?: boolean; // true when discovered from the jobs dir (another session's job)
}

// Shape persisted via pi.appendEntry — survives same-session restart, renders
// as a transcript card, does NOT enter LLM context.
interface BgrunJobEntryData {
  id: string;
  pid: number;
  cmd: string;
  name?: string;
  type?: string;
  wake?: WakePolicy;
  started: number;
  logPath: string;
  state: "running" | "done";
  exitCode?: number;
  exitedAt?: number;
}

interface BgStatusDetails {
  id?: string;
  state?: string;
  exitCode?: number;
  cmd?: string;
  name?: string;
  type?: string;
  wake?: WakePolicy;
  count?: number;
  recovered?: boolean;
}

function defineTool(
  tool: ToolDefinition<any, any, any>,
): ToolDefinition<any, any, any> {
  return tool;
}

export default function (pi: ExtensionAPI) {
  const jobs = new Map<string, JobRecord>();
  // bgtail's delta-tailing bookmarks: one entry per job id ever tailed, holding
  // the high-water mark of what the caller has already had the opportunity to
  // see. Declared here, ahead of the cleanup helpers, so removing a log can
  // evict its bookmark. TAIL_BOOKMARK_CAP bounds the rest — cleanup only evicts
  // jobs whose log it removed, and a long session that tails many job ids
  // (foreign ones are never cleaned here) would otherwise grow it forever.
  const TAIL_BOOKMARK_CAP = 1_000;
  // A bookmark is the high-water mark of what the caller has seen PLUS the
  // search window it was seen through: the same log read through a wider window
  // is a different view, not newly appended output.
  type TailBookmark = {
    lines: number;
    bytes: number;
    first: string;
    window: number;
  };
  const tailBookmarks = new Map<string, TailBookmark>();
  // Poller for stale job records — anything running with no live ChildProcess
  // handle (adopted foreign jobs + jobs reconstructed from transcript entries
  // after a restart). No exit event exists for those, so their logs/pids are
  // re-checked on an interval instead.
  let stalePoller: ReturnType<typeof setInterval> | undefined;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function makeSlug(command: string): string {
    const raw = redactForSlug(command)
      .toLowerCase()
      .replace(/[/\\.-]+/g, " ")
      .trim();
    const slug = raw
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return slug || "job";
  }

  // Normalize an optional human-readable name: strip control characters
  // (newlines, tabs, escape/ANSI bytes) so a name can never forge extra lines
  // in the wake, widget, toast, or transcript; collapse whitespace; cap length.
  function sanitizeName(name: string | undefined): string | undefined {
    const trimmed = (name ?? "")
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!trimmed) return undefined;
    return trimmed.slice(0, 80);
  }

  // Normalize an optional job type via the shared normalizeType(), so the
  // bgrun param and the config `type` truncate identically (see MAX_TYPE_LEN).
  function sanitizeType(type: string | undefined): string | undefined {
    return normalizeType(type);
  }

  // Count the log's total lines with a bounded-memory streaming scan (one
  // fixed-size buffer, no full-file read). Missing/unreadable file → null:
  // the Stats line then just omits the line count — best-effort, never
  // breaks a wake.
  function countLogLines(logPath: string): number | null {
    let fd: number;
    try {
      fd = openSync(logPath, "r");
    } catch {
      return null;
    }
    try {
      // fstat, not the scan's own progress: the tail pread below is positioned
      // by the REAL file size, so bounding the scan can never misplace it.
      const size = fstatSync(fd).size;
      if (size === 0) return 0;
      // readWindowMax, not the cap: a capped log is cap + notice + marker, so a
      // bound EQUAL to the cap would omit the line count for every capped job —
      // exactly where magnitude matters most.
      if (size > readWindowMax()) return null;
      const buf = Buffer.alloc(64 * 1024);
      let newlines = 0;
      let seen = 0;
      let bytesRead = 0;
      do {
        bytesRead = readSync(fd, buf, 0, buf.length, null);
        if (bytesRead <= 0) break;
        seen += bytesRead;
        for (let i = 0; i < bytesRead; i++) {
          if (buf[i] === 0x0a) newlines++;
        }
      } while (bytesRead === buf.length);
      // A log that changed size mid-scan (rotated, or appended by a resumed
      // job) would produce a count that matches neither state.
      if (seen !== size) return null;
      // One bounded pread of the tail for the final-byte + exit-marker check.
      const tailLen = Math.min(size, 512);
      const tail = Buffer.alloc(tailLen);
      readSync(fd, tail, 0, tailLen, size - tailLen);
      const tailText = tail.toString("latin1");
      const endsWithNewline = tailText.charCodeAt(tailText.length - 1) === 0x0a;
      let count = newlines + (endsWithNewline ? 0 : 1);
      // The wrapper appends "\n<EXIT_MARKER><ec><flags>\n" — and, when it had to
      // drop output or could not install the ceiling, "\n<NOTICE>\n" before
      // that. Those newlines are not command output, so drop the whole trailing
      // wrapper block, including its leading separator when the output already
      // ended in a newline. WHICH notice precedes the marker is decided by the
      // marker's own flags, not by matching notice text: a command that prints
      // the phrase must not have its line discounted as wrapper bookkeeping.
      const markerAt = tailText.lastIndexOf("\n" + EXIT_MARKER);
      if (markerAt === 0) {
        // The file is only the wrapper's "\n<marker>\n" — no command output.
        return 0;
      }
      if (markerAt !== -1) {
        const afterMarker = tailText.slice(markerAt + 1);
        const markerEnd = afterMarker.indexOf("\n");
        const markerLine =
          markerEnd === -1 ? afterMarker : afterMarker.slice(0, markerEnd);
        const noticePrefix = markerLine.includes(EXIT_MARKER_NOCAP_FLAG)
          ? CAPFAIL_NOTICE_PREFIX
          : markerLine.includes(EXIT_MARKER_TRUNC_FLAG)
            ? TRUNC_NOTICE_PREFIX
            : null;
        const noticeAt = noticePrefix
          ? tailText.lastIndexOf("\n" + noticePrefix)
          : -1;
        const blockStart =
          noticeAt !== -1 && noticeAt < markerAt ? noticeAt : markerAt;
        let extra = 0;
        for (let i = blockStart + 1; i < tailText.length; i++) {
          if (tailText.charCodeAt(i) === 0x0a) extra++;
        }
        if (blockStart > 0 && tailText.charCodeAt(blockStart - 1) === 0x0a)
          extra++;
        count = Math.max(0, count - extra);
      }
      return count;
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  // ── Live status widget ────────────────────────────────────────────────────

  function updateWidget(
    ctx: ExtensionContext,
    opts: { persistRevalidate?: boolean } = {},
  ): void {
    if (!ctx.hasUI) return;
    revalidateStaleJobs({ persist: opts.persistRevalidate ?? true });
    const running: JobRecord[] = [];
    for (const rec of jobs.values()) {
      if (rec.exitCode === undefined) running.push(rec);
    }
    if (running.length === 0) {
      ctx.ui.setWidget("bgrun", undefined);
      return;
    }
    const lines = [`📊 bgrun: ${running.length} running`];
    for (const rec of running) {
      const startedAt = formatSince(rec.started);
      const cmd = rec.cmd.length > 40 ? rec.cmd.slice(0, 37) + "…" : rec.cmd;
      const label = rec.name ? `${rec.name} · ${cmd}` : cmd;
      const tag = rec.adopted ? " (adopted)" : "";
      // Full id (not truncated) so it can be copied straight into /bgtail <id>.
      lines.push(`  ${rec.id}  ${label}  (since ${startedAt})${tag}`);
    }
    ctx.ui.setWidget("bgrun", lines);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  // Is the wrapper that owns this staging stem still running? It records its
  // own pid next to its scratch files, so liveness is exact for a job started by
  // ANY session sharing this jobs dir — unlike a log, whose protection needs the
  // pid in the file name.
  function stagingOwnerAlive(pidPath: string): boolean {
    try {
      const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
      return Number.isFinite(pid) && isRunningPid(pid);
    } catch {
      // No liveness record (or unreadable) → treat as an orphan's leftovers.
      return false;
    }
  }

  // Sweep stale per-project digest markers (.bgrun-used-*, .digest-nudge-*) and
  // orphaned staging files. Markers aren't session-scoped, so they'd otherwise
  // accumulate one per project forever; a project that runs bgrun again
  // re-writes its usage marker at spawn, so removing a stale one can at most
  // re-enable one future nudge.
  function sweepStaleMarkers(jobsDir: string, cutoff: number): void {
    let names: string[];
    try {
      names = readdirSync(jobsDir);
    } catch {
      return;
    }
    // Staging files are only reclaimable when nobody owns them. Age alone used
    // to delete a RUNNING job's fifo/flag — the wrapper's scratch files live for
    // the whole job, so any aggressive cutoff killed them mid-run, silently
    // removing the truncation notice and injecting a shell error into the log.
    const stagingCutoff = Math.max(cutoff, Date.now() - STAGING_MIN_AGE_MS);
    for (const name of names) {
      const isStaging =
        name.startsWith(".tmp-") &&
        STAGING_SUFFIXES.some((suffix) => name.endsWith(suffix));
      if (
        !isStaging &&
        !name.startsWith(".bgrun-used-") &&
        !name.startsWith(".digest-nudge-")
      )
        continue;
      try {
        const markerPath = join(jobsDir, name);
        const mtimeMs = statSync(markerPath).mtimeMs;
        if (isStaging) {
          if (mtimeMs > stagingCutoff) continue;
          const stem = name.replace(/\.[a-z]+$/, "");
          if (stagingOwnerAlive(join(jobsDir, `${stem}.pid`))) continue;
        } else if (mtimeMs > cutoff) {
          continue;
        }
        unlinkSync(markerPath);
      } catch {
        // ignore
      }
    }
  }

  function cleanOldJobs(
    days: number,
    jobsDir: string,
    ctx?: ExtensionContext,
    // The ownership marker protects the AUTOMATIC global sweep from deleting
    // logs in an unrelated dir (a stray PI_BGRUN_DIR). An explicit
    // `bgclean all` is the user's direct intent, so it bypasses the gate.
    opts: { requireOwnership?: boolean } = {},
  ): { removed: number; kept: number; skippedRunning: number } {
    const result = { removed: 0, kept: 0, skippedRunning: 0 };
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    if (
      opts.requireOwnership !== false &&
      !existsSync(join(jobsDir, JOBS_DIR_MARKER))
    ) {
      // Not recognizably ours — touch NOTHING, marker files included. The gate
      // exists so a stray PI_BGRUN_DIR is never emptied.
      return result;
    }
    // Past the gate: sweep our own stale per-project marker files.
    sweepStaleMarkers(jobsDir, cutoff);
    for (const entry of scanLogFiles(jobsDir)) {
      // mtime check FIRST — young files are never candidates, so skip early.
      if (entry.mtimeMs > cutoff) {
        result.kept++;
        continue;
      }
      // A TERMINAL marker means the wrapper finished writing — trust it even
      // when the pid looks alive (that is a reused pid; otherwise the log would
      // never be reclaimed). A non-terminal marker is not completion evidence,
      // so fall through to pid liveness, which protects a job that merely
      // printed the string.
      const finished = parseExitFromLogPath(entry.logPath) !== null;
      if (!finished) {
        const rec = jobs.get(entry.id);
        if (entry.alive && rec?.exitCode === undefined) {
          result.skippedRunning++;
          continue;
        }
      }
      // finished, dead pid, or our record says done → safe to remove.
      try {
        unlinkSync(entry.logPath);
        result.removed++;
        // The log is gone: its delta bookmark would otherwise pin a stale
        // high-water mark (and a Map slot) for the life of the session.
        tailBookmarks.delete(entry.id);
      } catch {
        // ignore
      }
    }
    if (result.removed > 0 && ctx?.hasUI) {
      ctx.ui.notify(`bgrun: cleaned ${result.removed} old job log(s)`, "info");
    }
    return result;
  }

  // Session-scoped sweep: remove THIS session's finished job logs older than
  // `days`. Only looks at the in-memory Map (which, after reconstruction, is
  // exactly this session's lineage) — other sessions' logs are never touched.
  // Running jobs are always skipped. Cheap (a handful of stats), so it runs
  // unthrottled at session boundaries.
  function cleanSessionJobs(
    days: number,
    ctx?: ExtensionContext,
  ): { removed: number; kept: number; skippedRunning: number } {
    const result = { removed: 0, kept: 0, skippedRunning: 0 };
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const rec of jobs.values()) {
      // Adopted foreign jobs belong to another session — this session neither
      // owns nor reports on them (counting them as "skipped running" was
      // misleading).
      if (rec.adopted) continue;
      if (rec.exitCode === undefined) {
        result.skippedRunning++;
        continue;
      }
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(rec.logPath);
      } catch {
        // Log already gone (cleaned by a global sweep). Drop the in-memory
        // record once it's past retention so finished jobs can't pin the Map
        // (and its ExtensionContext) for the life of the process.
        if (rec.exitedAt !== undefined && rec.exitedAt < cutoff) {
          jobs.delete(rec.id);
          tailBookmarks.delete(rec.id);
        }
        continue;
      }
      if (st.mtimeMs > cutoff) {
        result.kept++;
        continue;
      }
      try {
        unlinkSync(rec.logPath);
        result.removed++;
        jobs.delete(rec.id);
        tailBookmarks.delete(rec.id);
      } catch {
        // ignore
      }
    }
    // Markers aren't session data, so a session-scoped sweep may still drop
    // stale ones from this jobs dir — except in an untrusted project-local dir,
    // where deletion would mutate a repo the user has not trusted (the same
    // boundary autoCleanJobs enforces below).
    const cfg = resolveConfig(ctx);
    if (!(cfg.jobsDirProjectLocal && ctx?.isProjectTrusted?.() !== true)) {
      sweepStaleMarkers(cfg.jobsDir, cutoff);
    }
    if (result.removed > 0 && ctx?.hasUI) {
      ctx.ui.notify(`bgrun: cleaned ${result.removed} old job log(s)`, "info");
    }
    return result;
  }

  // Every shared jobs dir the orphan sweep / `bgclean all` should touch. The
  // machine-global dir is included only for the project-local default (so
  // pre-project-local logs are still reclaimed); an explicit absolute jobsDir
  // is treated as fully isolated and swept alone.
  function sharedJobsDirs(projectDir: string, projectLocal: boolean): string[] {
    if (!projectLocal) return [projectDir];
    const global = globalJobsDir();
    // Dedup aliased paths (equal strings, or symlinks to the same dir) so the
    // sweep never counts/removes the same log twice.
    return safeRealpath(projectDir) === safeRealpath(global)
      ? [global]
      : [global, projectDir];
  }

  // Auto-clean at session boundaries. Two parts:
  //  1. Session-scoped sweep — this session's old logs only; cheap,
  //     unthrottled.
  //  2. Orphan sweep (default on; disable via globalAutoClean: false /
  //     PI_BGRUN_GLOBAL_AUTO_CLEAN=0) — every shared jobs dir (see
  //     sharedJobsDirs), removing FINISHED logs (exit marker, or dead pid)
  //     older than cleanupDays. This is what keeps orphans from crashed /
  //     never-resumed sessions from accumulating: a week-old finished log is
  //     garbage under the same retention the owning session would apply
  //     itself, and running jobs are always pid-protected. Throttled to one
  //     sweep per cleanupDays via a .last-clean marker in each dir so
  //     restart-heavy workflows don't re-sweep on every launch.
  function autoCleanJobs(ctx: ExtensionContext): void {
    const cfg = resolveConfig(ctx);
    // Trust boundary: session start / shutdown must not write into a repo the
    // user has not trusted. For an untrusted project we skip both the
    // .git/info/exclude edit and the project-local dir sweep below (which would
    // create the dir for its .last-clean marker). The bgrun tool still ensures
    // exclusion at job-creation time — that is an explicit agent action, not an
    // incidental side effect of opening a session.
    const trusted = ctx?.isProjectTrusted?.() === true;
    if (cfg.jobsDirProjectLocal && trusted) ensureGitExcluded(cfg.jobsDir);
    cleanSessionJobs(cfg.cleanupDays, ctx);
    if (!cfg.globalAutoClean) return;
    for (const dir of sharedJobsDirs(cfg.jobsDir, cfg.jobsDirProjectLocal)) {
      if (
        cfg.jobsDirProjectLocal &&
        !trusted &&
        safeRealpath(dir) === safeRealpath(cfg.jobsDir)
      )
        continue;
      const markerPath = join(dir, ".last-clean");
      try {
        const last = Number(readFileSync(markerPath, "utf8").trim());
        if (
          Number.isFinite(last) &&
          Date.now() - last < cfg.cleanupDays * 24 * 60 * 60 * 1000
        )
          continue;
      } catch {
        // no marker yet — run the sweep
      }
      // The known machine-global dir is ours even without a .bgrun-jobs marker
      // (the project-local default never writes one there), so bypass the
      // ownership gate for it only; the project-local dir stays gated.
      // The DEFAULT machine-global dir is ours even without a .bgrun-jobs
      // marker (the project-local default never writes one there). A custom
      // PI_BGRUN_GLOBAL_DIR is gated like any other dir, per the README.
      const isGlobal =
        !process.env.PI_BGRUN_GLOBAL_DIR &&
        safeRealpath(dir) === safeRealpath(globalJobsDir());
      cleanOldJobs(cfg.cleanupDays, dir, ctx, { requireOwnership: !isGlobal });
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(markerPath, String(Date.now()));
      } catch {
        // best-effort
      }
    }
  }

  // Re-check stale job records — anything running with no live ChildProcess
  // handle (rec.child unset): adopted foreign jobs, and jobs reconstructed
  // from transcript entries after a restart. None of these get an exit event,
  // so the exit marker in the log (or a dead pid) is the only completion
  // signal. Without this they render as "running" forever — e.g. a job that
  // finished while pi was down reconstructs as a zombie on every resume.
  //  - Adopted jobs are dropped from the registry entirely (not this
  //    session's history; the log on disk still covers id lookup + cleanup).
  //  - Reconstructed jobs ARE this session's history: mark them done and
  //    append a done entry so future resumes reconstruct them as done too.
  // `persist: false` is for read-only callers (bgstatus): they still need an
  // accurate view, but asking for status must not append transcript cards.
  // The stale poller / session_start re-run with persistence and reconcile.
  function persistDoneEntry(rec: JobRecord, exit: number): void {
    rec.donePersisted = true;
    pi.appendEntry<BgrunJobEntryData>("bgrun-job", {
      id: rec.id,
      pid: rec.pid,
      cmd: rec.cmd,
      name: rec.name,
      type: rec.type,
      wake: rec.wake,
      started: rec.started,
      logPath: rec.logPath,
      state: "done",
      exitCode: exit >= 0 ? exit : undefined,
      exitedAt: rec.exitedAt,
    });
  }

  function revalidateStaleJobs(opts: { persist?: boolean } = {}): void {
    const persist = opts.persist ?? true;
    for (const [id, rec] of jobs) {
      if (rec.child) continue;
      if (rec.exitCode !== undefined) {
        // Already reconciled. A read-only pass (bgstatus, persist:false) sets
        // exitCode WITHOUT persisting, so a later persisting pass must still
        // write the done entry — otherwise the transcript card stays "running"
        // for the rest of the session.
        if (persist && !rec.donePersisted && !rec.adopted) {
          persistDoneEntry(rec, rec.exitCode);
        }
        continue;
      }
      let exit = parseExitFromLogPath(rec.logPath);
      if (exit === null && rec.pid <= 0) {
        exit = -1;
      }
      if (exit === null && rec.pid > 0 && !isRunningPid(rec.pid)) {
        // pid gone with no marker — killed/crashed before the wrapper could write it,
        // or the log was already cleaned up
        exit = -1;
      }
      if (exit === null) continue; // still genuinely running
      if (rec.adopted) {
        jobs.delete(id);
      } else {
        rec.exitCode = exit;
        rec.exitedAt = Date.now();
        if (persist) persistDoneEntry(rec, exit);
      }
    }
  }

  function hasUnsupervisedRunning(): boolean {
    for (const rec of jobs.values()) {
      if (!rec.child && rec.exitCode === undefined) return true;
    }
    return false;
  }

  function ensureStalePoller(ctx: ExtensionContext): void {
    if (stalePoller !== undefined || !hasUnsupervisedRunning()) return;
    stalePoller = setInterval(() => {
      revalidateStaleJobs();
      updateWidget(ctx);
      if (!hasUnsupervisedRunning()) stopStalePoller();
    }, STALE_POLL_MS);
    stalePoller.unref();
  }

  function stopStalePoller(): void {
    if (stalePoller !== undefined) {
      clearInterval(stalePoller);
      stalePoller = undefined;
    }
  }

  // ── Entry renderer: job cards in the transcript ───────────────────────────

  pi.registerEntryRenderer<BgrunJobEntryData>(
    "bgrun-job",
    (entry, { expanded }, theme) => {
      const d =
        entry.data ??
        ({
          id: "?",
          cmd: "",
          started: 0,
          logPath: "",
          state: "running",
        } as BgrunJobEntryData);
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      const icon = d.state === "done" ? (d.exitCode === 0 ? "✅" : "❌") : "🔄";
      const exitStr = d.state === "done" ? ` exit=${d.exitCode ?? "?"}` : "";
      const namePrefix = d.name ? `"${d.name}" ` : "";
      box.addChild(
        new Text(
          `${icon} ${theme.fg("accent", "bgrun")} ${namePrefix}${d.id}${exitStr}`,
          0,
          0,
        ),
      );
      const cmdPreview = d.cmd.length > 60 ? d.cmd.slice(0, 57) + "…" : d.cmd;
      box.addChild(new Text(theme.fg("dim", `  $ ${cmdPreview}`), 0, 0));
      if (expanded) {
        box.addChild(new Text(theme.fg("dim", `  log: ${d.logPath}`), 0, 0));
        box.addChild(
          new Text(
            theme.fg(
              "dim",
              `  started: ${new Date(d.started).toLocaleString()}`,
            ),
            0,
            0,
          ),
        );
        if (d.exitedAt) {
          box.addChild(
            new Text(
              theme.fg(
                "dim",
                `  finished: ${new Date(d.exitedAt).toLocaleString()}`,
              ),
              0,
              0,
            ),
          );
        }
      }
      return box;
    },
  );

  // ── session_start: reconstruct Map from entries + auto-cleanup ────────────

  pi.on("session_start", async (_event, ctx) => {
    // Reconstruct the in-memory Map from this session's bgrun-job entries.
    // Only the current session's entries are visible; jobs from other sessions
    // remain discoverable via the filesystem scan in bgstatus.
    try {
      // Build a map of id → latest entry data. Entries are append-ordered, so
      // the last one for a given id wins (a running entry is followed by a done
      // entry when the job finishes).
      const latestBydId = new Map<string, BgrunJobEntryData>();
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === "bgrun-job") {
          const d = entry.data as BgrunJobEntryData | undefined;
          if (!d || !d.id) continue;
          latestBydId.set(d.id, d);
        }
      }
      for (const d of latestBydId.values()) {
        if (jobs.has(d.id)) continue;
        // A done entry is authoritative even when exitCode is missing (jobs
        // killed by a signal persist exitCode: undefined) — without the state
        // check those reconstruct as "running" zombies on every resume.
        const isDone = d.state === "done" || d.exitCode !== undefined;
        jobs.set(d.id, {
          id: d.id,
          pid: d.pid,
          cmd: d.cmd,
          name: d.name,
          type: d.type,
          wake: d.wake ?? resolveConfig(ctx).defaultWake,
          started: d.started,
          logPath: d.logPath,
          exitedAt: d.exitedAt,
          exitCode: isDone ? (d.exitCode ?? -1) : undefined,
          // Mark the done entry as already persisted, or revalidateStaleJobs
          // appends a duplicate done card on every resume.
          donePersisted: isDone,
          ctx,
        });
      }
    } catch (err) {
      console.error(
        "[pi-bgrun] session_start reconstruction failed:",
        (err as Error).message,
      );
    }

    // Adopt running jobs discovered from the jobs dir (started by other sessions).
    // Opt-in (adoptForeignJobs / PI_BGRUN_FOREIGN_JOBS=1): the jobs dir is shared
    // across every pi session on the machine, and most sessions don't want
    // unrelated jobs from other projects cluttering the widget. Adopted jobs
    // have no ChildProcess handle — no exit event, so a poller re-checks their
    // logs and pids instead, and they leave the widget once finished.
    const cfg = resolveConfig(ctx);
    const jobsDir = cfg.jobsDir;
    if (cfg.adoptForeignJobs) {
      for (const entry of scanJobsDir(jobsDir)) {
        if (jobs.has(entry.id)) continue;
        if (entry.exit !== null) continue; // finished — nothing to show in the widget
        if (!entry.alive) continue; // dead pid, marker just not written yet
        jobs.set(entry.id, {
          id: entry.id,
          pid: entry.pid ?? -1,
          cmd: "(started by another session)",
          wake: "never",
          started: entry.birthtimeMs || Date.now(),
          logPath: entry.logPath,
          ctx,
          adopted: true,
        });
      }
    }

    // One-shot digest nudge (toast only, never the LLM context). All of its
    // failure modes are swallowed inside — it must never break session_start.
    maybeNudgeDigest(ctx);

    // Show the widget if anything is now running. revalidateStaleJobs()
    // inside clears zombies — reconstructed jobs that finished while pi was
    // down — before they ever render. Then start the stale poller for
    // anything still genuinely running without a child handle (also gives
    // resumed sessions live tracking of their still-running jobs).
    updateWidget(ctx);
    ensureStalePoller(ctx);
    // Auto-cleanup of old logs, throttled to one sweep per cleanupDays via a
    // marker in the jobs dir (see autoCleanJobs). Also runs on session_shutdown.
    autoCleanJobs(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopStalePoller();
    // Sweep old logs on the way out. Throttled via the .last-clean marker so
    // restart-heavy workflows don't sweep more than once per cleanupDays.
    try {
      autoCleanJobs(ctx);
    } catch {
      // best-effort — shutdown must never throw
    }
  });

  // ── bgrun tool ────────────────────────────────────────────────────────────

  const bgrunTool = defineTool({
    name: "bgrun",
    label: "Run in Background",
    description:
      "Run a genuinely asynchronous shell command detached in the background. Returns 'started: <job-id>' immediately. " +
      "Use this for deployment/CI monitoring, long evals, sustained observability, or work that must continue while the agent does something else—not merely because a command is a test, build, lint, query, or external request. " +
      "Choose `wake` explicitly when the agent must resume on completion; human toast/widget updates always remain enabled. " +
      "Optionally pass `name` for a short human-readable label and `type` to select the project's digest scorecard.",
    promptSnippet:
      "Run a genuinely asynchronous command detached; choose whether completion should wake the agent",
    promptGuidelines: [
      "Default to foreground execution. Use bgrun only for genuinely asynchronous monitoring/concurrency or work known to be long-running; do not infer background execution from command category alone.",
      "Set wake:'always' when continuation depends on completion (deploy/eval monitors), wake:'failure' when only failure needs attention, or wake:'never' for independent work.",
      "Give every bgrun job a short name so it is recognizable in status output, the status widget, and notifications.",
      "When the project's digest config defines `type` entries, pass the matching `type` so a waking job selects the right scorecard.",
      "After bgrun returns a job id, continue other work; do not poll through model turns.",
      "Never cat or Read a full bgrun log — bgtail returns a condensed peek (ANSI stripped, repeats collapsed, ~8KB cap); use bggrep for pattern search or ctx_execute_file on the log path for whole-log analysis.",
    ],
    parameters: Type.Object({
      command: Type.String({
        description:
          "Shell command to run in the background. Run as `sh -c`, so pipes and && work.",
      }),
      name: Type.Optional(
        Type.String({
          description:
            "Optional short human-readable label for the job (e.g. 'unit-tests', 'frontend-build'). " +
            "Used in the job id, status output, the status widget, and wake messages.",
        }),
      ),
      type: Type.Optional(
        Type.String({
          description:
            "Optional job type used to select the project's digest scorecard (e.g. 'test', 'build', 'lint'). " +
            "The vocabulary comes from the `type` fields in the project's `digest` config entries in " +
            "`.pi/pi-bgrun.json`; when the project's digest config defines types, prefer passing the matching one.",
        }),
      ),
      wake: Type.Optional(
        Type.Union(
          ["never", "failure", "always"].map((policy) =>
            Type.Literal(policy),
          ),
          {
            description:
              "Whether completion injects a model turn: never, only on failure, or always. " +
              "When omitted, defaultWake from configuration applies. Human toast/widget updates are always shown.",
          },
        ),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { command: string; name?: string; type?: string; wake?: WakePolicy },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const {
        command,
        name: rawName,
        type: rawType,
        wake: rawWake,
      } = params;
      if (!command || !command.trim()) {
        throw new Error("bgrun: command is required");
      }
      const name = sanitizeName(rawName);
      const type = sanitizeType(rawType);

      const cfg = resolveConfig(ctx);
      const wake = normalizeWakePolicy(rawWake) ?? cfg.defaultWake;
      // Project-local logs are auto-ignored in .git/info/exclude (best-effort)
      // so they never pollute `git status`. Absolute dirs are left untouched.
      if (cfg.jobsDirProjectLocal) ensureGitExcluded(cfg.jobsDir);
      const jobsDir = cfg.jobsDir;
      mkdirSync(jobsDir, { recursive: true });
      ensureJobsDirMarker(jobsDir);
      // Evidence-of-use marker (best-effort): lets the digest nudge tell that
      // THIS project has run bgrun, without scanning the shared jobs dir.
      try {
        writeFileSync(
          jobUsageMarkerPath(jobsDir, projectRootFor(ctx.cwd ?? process.cwd())),
          String(Date.now()),
        );
      } catch {
        // a marker write must never block a spawn
      }

      const slug = makeSlug(name ?? command);
      const ts = Math.floor(Date.now() / 1000);
      // The id must carry the CHILD's pid (liveness checks depend on it), but the
      // log fd must exist before spawn. Create at a temp path, rename after spawn.
      // randomBytes (not Math.random) plus O_EXCL: the temp name is not
      // guessable and a pre-planted symlink cannot be truncated through.
      const stem = `.tmp-${slug}-${ts}-${randomBytes(4).toString("hex")}`;
      const tmpPath = join(jobsDir, `${stem}.log`);
      let logFd: number | undefined;
      let logPath = tmpPath;
      try {
        // 0600: job logs can contain secrets pulled from the environment.
        logFd = openSync(tmpPath, "wx", 0o600);
      } catch (err) {
        throw new Error(
          `bgrun: cannot create log file: ${(err as Error).message}`,
        );
      }
      try {
        // Pass command as argv — interpolation breaks on #, quotes, heredocs.
        // maxLogBytes 0 means "unlimited": keep the pre-ceiling wrapper exactly
        // (a zero-byte ceiling is meaningless, so it cannot be routed through
        // the capped path).
        const capped = cfg.maxLogBytes > 0;
        const wrapper = capped
          ? cappedWrapper(cfg.maxLogBytes)
          : `sh -c "$1"; ec=$?; printf '\\n${EXIT_MARKER}%d\\n' "$ec"; exit "$ec"`;
        const child = spawn(
          "sh",
          capped
            ? [
                "-c",
                wrapper,
                "bgrun",
                command,
                join(jobsDir, `${stem}.ec`),
                join(jobsDir, `${stem}.fifo`),
                // Liveness, so a cleanup sweep can tell a running job's scratch
                // files from an orphan's instead of judging them by age alone.
                join(jobsDir, `${stem}.pid`),
                // Truncation flag: written by the drain when bytes were left
                // over. A file, not the drain's exit status, because the drain
                // may still be running when the wrapper prints.
                join(jobsDir, `${stem}.trunc`),
              ]
            : ["-c", wrapper, "bgrun", command],
          {
            stdio: ["ignore", logFd, logFd],
            detached: true,
          },
        );
        child.unref();

        const childPid = child.pid ?? -1;
        const id = `${slug}-${ts}-${childPid}`;
        const finalLogPath = join(jobsDir, `${id}.log`);
        try {
          renameSync(tmpPath, finalLogPath);
          logPath = finalLogPath;
        } catch (err) {
          console.error(
            `[pi-bgrun] rename to final log path failed:`,
            (err as Error).message,
          );
        }

        const record: JobRecord = {
          id,
          pid: childPid,
          cmd: command,
          name,
          type,
          wake,
          started: Date.now(),
          logPath,
          child,
          ctx,
        };
        jobs.set(id, record);

        // Persist a bgrun-job entry (running state) — transcript card + restart recovery.
        pi.appendEntry<BgrunJobEntryData>("bgrun-job", {
          id,
          pid: childPid,
          cmd: command,
          name,
          type,
          wake,
          started: Date.now(),
          logPath,
          state: "running",
        });

        updateWidget(ctx);

        const finishSpawnFailure = (err: Error) => {
          const rec = jobs.get(id);
          if (!rec || rec.exitCode !== undefined) return;
          rec.exitedAt = Date.now();
          rec.exitCode = -1;
          rec.donePersisted = true;
          delete rec.child;
          try {
            appendFileSync(
              rec.logPath,
              `\n[pi-bgrun] spawn failed: ${err.message}\n${EXIT_MARKER}-1\n`,
            );
          } catch {
            // best-effort
          }
          pi.appendEntry<BgrunJobEntryData>("bgrun-job", {
            id,
            pid: rec.pid,
            cmd: rec.cmd,
            name: rec.name,
            type: rec.type,
            wake: rec.wake,
            started: rec.started,
            logPath: rec.logPath,
            state: "done",
            exitCode: -1,
            exitedAt: rec.exitedAt,
          });
          if (shouldWakeAgent(rec.wake, -1)) {
            const namePrefix = rec.name ? `"${rec.name}" ` : "";
            const wakeMessage =
              `❌ Background job ${namePrefix}\`${id}\` failed to start: ${err.message}\n` +
              `Command: ${command}`;
            try {
              if (rec.ctx.isIdle()) pi.sendUserMessage(wakeMessage);
              else
                pi.sendUserMessage(wakeMessage, { deliverAs: "followUp" });
            } catch {
              try {
                pi.sendUserMessage(wakeMessage, { deliverAs: "followUp" });
              } catch (e2) {
                console.error(
                  `[pi-bgrun] wake failed for job ${id}:`,
                  (e2 as Error).message,
                );
              }
            }
          }
          if (rec.ctx.hasUI) {
            rec.ctx.ui.notify(
              `❌ ${(rec.name ?? command).slice(0, 50)} → spawn failed`,
              "error",
            );
          }
          updateWidget(rec.ctx);
        };

        // ── exit handler: record exit, persist done entry, wake, notify, widget ─
        child.on("exit", async (code, signal) => {
          const rec = jobs.get(id);
          if (!rec) return;
          // A spawn that emitted 'error' first already finalized this job; a
          // follow-up 'exit' must not append a second done entry or wake.
          if (rec.exitCode !== undefined) return;
          rec.exitedAt = Date.now();
          rec.exitCode = code ?? -1;
          // Set BEFORE the digest await: without it a read-only bgstatus in
          // that window could append a second done entry.
          rec.donePersisted = true;
          delete rec.child; // release the handle reference

          const exitCode = code ?? parseExitFromLogPath(logPath) ?? -1;
          const exitStr =
            exitCode >= 0 ? String(exitCode) : `signal ${signal ?? "?"}`;
          const exitEmoji = exitCode === 0 ? "✅" : "❌";
          const lastLine = readLastLogLine(logPath);

          // Universal stats — duration + log line count. Non-heuristic, always
          // present, never pattern-based. A missing log contributes no line
          // count (duration is always known).
          const logLines = countLogLines(logPath);
          const statsParts = [formatDuration(rec.exitedAt - rec.started)];
          if (logLines !== null)
            statsParts.push(`${logLines.toLocaleString("en-US")} lines`);
          // The cap is the one fact that changes what the others MEAN: the line
          // count, the last line and any digest describe only the bytes that
          // were kept. Say so in the line the agent reads first. A ceiling that
          // could not be installed is the opposite case — the log is complete
          // but unbounded — and that must not be silent either.
          const capStatus = readCapStatus(logPath);
          const truncatedAt =
            capStatus?.kind === "truncated" ? capStatus.bytes : null;
          if (truncatedAt !== null)
            statsParts.push(`log truncated at ${formatBytes(truncatedAt)}`);
          else if (capStatus?.kind === "ceiling-failed")
            statsParts.push("no log ceiling (command ran uncapped)");

          // Persist the done-state entry.
          pi.appendEntry<BgrunJobEntryData>("bgrun-job", {
            id,
            pid: rec.pid,
            cmd: rec.cmd,
            name: rec.name,
            type: rec.type,
            wake: rec.wake,
            started: rec.started,
            logPath,
            state: "done",
            exitCode: exitCode >= 0 ? exitCode : undefined,
            exitedAt: rec.exitedAt,
          });

          // Opt-in project-config digest (best-effort, silent-fail). rec.ctx is
          // the ExtensionContext captured at tool-call time and retains
          // everything resolveConfig needs (cwd + isProjectTrusted), so the
          // digest config is resolved here at exit — config edits made while the
          // job ran are picked up, and trust is evaluated against the same
          // session that spawned the job. No spawn-time capture needed. When a
          // digest is configured, the wake is sent only after this bounded
          // attempt (≤ ~5.25s: 5s timeout + 250ms kill grace) completes; a digest
          // that fails, times out, or prints
          // nothing appends nothing, and the exit code / universal part above are
          // never affected.
          const willWake = shouldWakeAgent(rec.wake, exitCode);
          let digestBlock: { label: string; text: string } | undefined;
          if (willWake) {
            try {
            // First matching entry wins, in config order. The label defaults to
            // the entry's label, the entry's type, a matched `match.name`, then
            // the entry's preset id (or "command").
            const digestEntries = resolveConfig(rec.ctx).digest;
            const digestTarget: DigestJobTarget = {
              name: rec.name,
              type: rec.type,
              command: rec.cmd,
            };
            const selected = selectDigestEntry(digestEntries, digestTarget);
            if (selected) {
              if (truncatedAt !== null) {
                // A scorecard reads the log's END (summary lines, failure
                // lists) — exactly what a head cap drops. Its numbers would be
                // confidently wrong, so report why it was skipped instead.
                digestBlock = {
                  label: selected.label,
                  text:
                    `skipped — the log was truncated at ${formatBytes(truncatedAt)} ` +
                    "and this scorecard reads the log's end, which the cap dropped",
                };
              } else {
                const raw = await runDigestCommand(selected.command, logPath);
                const text = raw === undefined ? undefined : capDigestOutput(raw);
                if (text) digestBlock = { label: selected.label, text };
              }
            } else if (digestEntries?.length) {
              // Configured but nothing selected — otherwise silent. Surface the
              // job's type/name plus the configured types, once per distinct
              // diagnostic (capped), so a type mismatch or dead glob is visible.
              const warning = digestNoMatchWarning(digestTarget, digestEntries);
              if (!digestNoMatchWarned.has(warning)) {
                if (digestNoMatchWarned.size < DIGEST_NO_MATCH_WARN_CAP) {
                  digestNoMatchWarned.add(warning);
                  console.error(warning);
                } else if (!digestNoMatchSuppressed) {
                  // Don't silently drop further distinct mismatches.
                  digestNoMatchSuppressed = true;
                  console.error(
                    `[pi-bgrun] further digest no-match diagnostics suppressed (cap ${DIGEST_NO_MATCH_WARN_CAP})`,
                  );
                }
              }
            }
            } catch (e) {
              // Silent-fail: a broken digest never breaks a wake (ground rule 3).
              console.error(
                `[pi-bgrun] digest failed for job ${id}:`,
                (e as Error).message,
              );
            }
          }

          // Wake the agent only when this job's explicit/configured policy
          // requires a model turn. Toast and widget updates below are always
          // delivered independently.
          if (willWake) {
            const namePrefix = rec.name ? `"${rec.name}" ` : "";
            let wakeMessage = `${exitEmoji} Background job ${namePrefix}\`${id}\` finished (exit ${exitStr}).\n`;
            wakeMessage += `Command: ${command}\n`;
            wakeMessage += `Stats: ${statsParts.join(", ")}\n`;
            if (lastLine) wakeMessage += `Last output: ${lastLine}\n`;
            if (digestBlock) {
              wakeMessage += `digest (${digestBlock.label}): ${digestBlock.text}\n`;
            }
            wakeMessage += `Review the result now: call \`bgtail\` with this job id to see the output, summarize pass/fail, and continue the task that depended on it.`;
            try {
              if (rec.ctx.isIdle()) {
                pi.sendUserMessage(wakeMessage);
              } else {
                pi.sendUserMessage(wakeMessage, { deliverAs: "followUp" });
              }
            } catch {
              try {
                pi.sendUserMessage(wakeMessage, { deliverAs: "followUp" });
              } catch (e2) {
                console.error(
                  `[pi-bgrun] wake failed for job ${id}:`,
                  (e2 as Error).message,
                );
              }
            }
          }

          // Toast for the human.
          if (rec.ctx.hasUI) {
            const toastLabel = (rec.name ?? command).slice(0, 50);
            rec.ctx.ui.notify(
              `${exitEmoji} ${toastLabel} → exit ${exitStr}`,
              exitCode === 0 ? "info" : "error",
            );
          }

          // Update/clear the widget.
          updateWidget(rec.ctx);
        });

        child.on("error", (err) => {
          console.error(`[pi-bgrun] spawn error for job ${id}:`, err.message);
          finishSpawnFailure(err);
        });

        const startedLines = [`started: ${id}`];
        if (name) startedLines.push(`  name: ${name}`);
        if (type) startedLines.push(`  type: ${type}`);
        startedLines.push(`  wake: ${wake}`, `  log: ${logPath}`);
        if (wake === "always")
          startedLines.push("  You'll be woken when it finishes.");
        else if (wake === "failure")
          startedLines.push("  You'll be woken only if it fails.");
        else
          startedLines.push(
            "  Completion will update the toast/widget without waking the agent.",
          );
        return {
          content: [{ type: "text", text: startedLines.join("\n") }],
          details: { id, name, type, wake, logPath, pid: childPid },
        };
      } finally {
        if (logFd !== undefined) closeSync(logFd);
      }
    },
  });
  pi.registerTool(bgrunTool);

  // ── Log condenser: ANSI strip, per-line cap, collapse runs, total budget ────
  // Keeps bgtail output small enough that a "quick peek" never floods context:
  // colored test output often carries 2-3x its text size in ANSI escapes, and
  // one unbounded line (minified bundle, base64 blob) can blow the whole budget.
  const ANSI_RE =
    /[\u001B\u009B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><]/g;
  const LINE_CAP = 2000; // chars per line after stripping
  const TOTAL_CAP = 8000; // chars for the whole bgtail result

  // ── Digest: opt-in project-config scorecard appended to the wake ──────────
  // Runs only when a trusted project (or the user file) configures a `digest`
  // section. Best-effort, silent-fail: errors, timeouts, and empty output all
  // contribute nothing, and the digest never affects the exit code, ordering,
  // or the wake's universal part (ground rules 2-3).
  const DIGEST_TIMEOUT_MS = 5000; // hard bound on added wake latency
  const DIGEST_KILL_GRACE_MS = 250; // SIGTERM → SIGKILL grace
  const DIGEST_TOTAL_CAP = 500; // chars appended to the wake, first lines win
  const DIGEST_LINE_CAP = 200; // per-line cap, consistent with the condenser

  // Run a digest command (log path arrives as $1) and collect stdout.
  // Resolves undefined on spawn error, non-timeout failure semantics are the
  // caller's concern (empty output is dropped when capping). A timed-out
  // command contributes NOTHING — after SIGKILL we resolve immediately with
  // undefined so the wake is never delayed past DIGEST_TIMEOUT_MS + grace.
  function runDigestCommand(
    cmd: string,
    logPath: string,
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      const finish = (out: string | undefined) => {
        if (settled) return;
        settled = true;
        // Stop accepting output. A grandchild can keep the pipe's write end
        // open after `sh` exits (pipelines, `cmd &`), and a live `data`
        // listener would otherwise grow this buffer forever.
        child?.stdout?.removeAllListeners("data");
        resolve(out);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("sh", ["-c", cmd, "--", logPath], {
          stdio: ["ignore", "pipe", "ignore"],
          // Own process group so a timeout can kill the whole pipeline (sh AND
          // its children), not just `sh`. Without this, grandchildren survive
          // and keep the pipe open.
          detached: true,
        });
      } catch {
        finish(undefined);
        return;
      }
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        // Bounded collection: once past the wake cap, stop buffering but keep
        // the listener attached so the child is never blocked on a full pipe.
        // capDigestOutput() trims the overshoot to DIGEST_TOTAL_CAP.
        if (stdout.length > DIGEST_TOTAL_CAP) return;
        stdout += chunk.toString();
      });
      // Kill the whole process group (see `detached` above). Process groups
      // are POSIX-only; the `child.kill` fallback covers platforms where the
      // negative-pid kill fails. `childExited` guards against signalling a
      // group whose pid may already have been recycled after the child exits.
      let childExited = false;
      const killGroup = (signal: NodeJS.Signals) => {
        if (childExited) return;
        const pid = child.pid;
        try {
          if (pid === undefined) throw new Error("no pid");
          process.kill(-pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // already gone
          }
        }
      };
      // Hard timeout: SIGTERM first, SIGKILL after a short grace.
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const killTimer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        graceTimer = setTimeout(() => {
          killGroup("SIGKILL");
          finish(undefined);
        }, DIGEST_KILL_GRACE_MS);
      }, DIGEST_TIMEOUT_MS);
      const stopTimers = () => {
        clearTimeout(killTimer);
        if (graceTimer) clearTimeout(graceTimer);
      };
      child.on("error", () => {
        childExited = true;
        stopTimers();
        finish(undefined);
      });
      child.on("exit", (code) => {
        childExited = true;
        stopTimers();
        // Contract: a digest that ERRORS contributes nothing. Gate on the exit
        // code so partial output from a failed command never reaches the wake.
        // Shipped presets all end in `head`, which exits 0.
        finish(timedOut || code !== 0 ? undefined : stdout);
      });
    });
  }

  // Cap digest output for the wake: first lines win. ANSI stripped (reusing
  // the condenser's regex), per-line cap for consistency, blank lines
  // dropped, ~500 chars total. Nothing usable → undefined (nothing appended).
  function capDigestOutput(raw: string): string | undefined {
    const lines = raw
      .replace(ANSI_RE, "")
      .split("\n")
      .map((l) =>
        l.length > DIGEST_LINE_CAP ? l.slice(0, DIGEST_LINE_CAP) : l,
      )
      .filter((l) => l.trim().length > 0);
    if (lines.length === 0) return undefined;
    const joined = lines.join("\n");
    const capped =
      joined.length > DIGEST_TOTAL_CAP
        ? joined.slice(0, DIGEST_TOTAL_CAP)
        : joined;
    return capped.trim() || undefined;
  }

  // No-match diagnostics seen this process (capped) — keyed by the full
  // warning string so a type mismatch and a dead regex each surface once.
  const digestNoMatchWarned = new Set<string>();
  let digestNoMatchSuppressed = false;
  const DIGEST_NO_MATCH_WARN_CAP = 3;

  // ── Digest nudge: one-shot session_start toast for digest-less projects ────
  // When a trusted project has actually used bgrun (≥1 finished job log in the
  // jobs dir) but never configured a digest, point the human at the
  // digest-config skill once. Toast only — never sendUserMessage, so it costs
  // zero LLM context. Dismissal is a per-project marker file in the jobs dir;
  // the user's config files are never written.
  function maybeNudgeDigest(ctx: ExtensionContext): void {
    try {
      if (!ctx.isProjectTrusted?.()) return;
      const cfg = resolveConfig(ctx);
      if (cfg.digest) return; // already configured — nothing to nudge
      if (!ctx.hasUI) return; // toast-only feature; no UI → nothing to do
      const projectDir = projectRootFor(ctx.cwd ?? process.cwd());
      // Project-scoped evidence of use (written at spawn) — never the shared
      // jobs dir as a whole, which would toast every project on the machine.
      if (!existsSync(jobUsageMarkerPath(cfg.jobsDir, projectDir))) return;
      const markerPath = digestNudgeMarkerPath(cfg.jobsDir, projectDir);
      if (existsSync(markerPath)) return; // already nudged once — stay silent
      ctx.ui.notify(DIGEST_NUDGE_TEXT, "info");
      try {
        writeFileSync(markerPath, String(Date.now()));
      } catch {
        // best-effort — a marker write failure must never break session_start
      }
    } catch (err) {
      console.error("[pi-bgrun] digest nudge failed:", (err as Error).message);
    }
  }

  function condenseLogLines(
    lines: string[],
    opts: { raw?: boolean } = {},
  ): { text: string; truncated: string[] } {
    const notes: string[] = [];
    if (opts.raw) return { text: lines.join("\n"), truncated: notes };
    let stripped = 0;
    let cappedLines = 0;
    const clean = lines.map((l) => {
      if (ANSI_RE.test(l)) {
        stripped++;
        l = l.replace(ANSI_RE, "");
      }
      return l;
    });
    ANSI_RE.lastIndex = 0;
    // collapse runs of 3+ identical lines (spinner frames, retry spam)
    const collapsed: { text: string; count: number }[] = [];
    let runs = 0;
    for (const l of clean) {
      const prev = collapsed[collapsed.length - 1];
      if (prev && prev.text === l) {
        prev.count++;
        if (prev.count === 3) runs++;
      } else {
        collapsed.push({ text: l, count: 1 });
      }
    }
    const out: string[] = [];
    let total = 0;
    for (const c of collapsed) {
      let line = c.count >= 3 ? `${c.text}  [x${c.count}]` : c.text;
      if (line.length > LINE_CAP) {
        line = line.slice(0, LINE_CAP) + ` …[+${line.length - LINE_CAP} chars]`;
        cappedLines++;
      }
      total += line.length + 1;
      if (total > TOTAL_CAP) {
        notes.push(
          `output capped at ${TOTAL_CAP} chars — ${lines.length} raw lines total; raise \`lines\`, use \`raw: true\`, or run ctx_execute_file on the log for whole-log analysis`,
        );
        break;
      }
      out.push(line);
    }
    if (stripped > 0)
      notes.push(
        `${stripped} ANSI escape sequence${stripped === 1 ? "" : "s"} stripped`,
      );
    if (runs > 0)
      notes.push(`${runs} repeated-line run${runs === 1 ? "" : "s"} collapsed`);
    if (cappedLines > 0)
      notes.push(
        `${cappedLines} long line${cappedLines === 1 ? "" : "s"} truncated to ${LINE_CAP} chars`,
      );
    return { text: out.join("\n"), truncated: notes };
  }

  // ── bgtail: read the newest lines of a job's log, condensed for context ────
  //
  // Delta tailing: each read bookmarks the total raw line count at read time
  // (the high-water mark of what the caller has had the opportunity to see).
  // The FIRST read for a job returns the full last-N tail; repeat reads return
  // only lines appended since, so polling a running job never re-pays context
  // for lines already seen. Deliberately-skipped prefix lines are never
  // replayed as "new". raw: true keeps the verbatim last-N window (no delta
  // header) but still advances the bookmark. A shrunken log (rotated/replaced)
  // resets to a full tail. Bookmarks are in-memory only (see tailBookmarks
  // above) — a session restart starts fresh with a full tail.

  // Record a bookmark, evicting the oldest entry once the map is full. Cleanup
  // drops bookmarks when it removes a log; this bounds the rest.
  function rememberTail(id: string, bookmark: TailBookmark): void {
    tailBookmarks.set(id, bookmark);
    if (tailBookmarks.size <= TAIL_BOOKMARK_CAP) return;
    const oldest = tailBookmarks.keys().next().value;
    if (oldest !== undefined && oldest !== id) tailBookmarks.delete(oldest);
  }

  // Resolve a job's log path and read its bounded slice, single-sourcing the
  // "in-memory record first, then the configured jobs dir" rule shared by
  // bgtail and bggrep. The record's logPath stays correct even if the config
  // (and thus the resolved jobs dir) changes mid-session. On failure the caller
  // renders tool-specific error details.
  function resolveLogForJob(
    id: string,
    tool: string,
    ctx: ExtensionContext | undefined,
    window: number,
  ):
    | { logPath: string; content: string; size: number }
    | { logPath: string; errorText: string; notFound: boolean } {
    validateJobId(id, tool);
    const logPath =
      jobs.get(id)?.logPath ?? join(resolveConfig(ctx).jobsDir, `${id}.log`);
    const slice = readLogSlice(logPath, window);
    if (!slice) {
      return {
        logPath,
        errorText: logReadError(id, logPath),
        notFound: !existsSync(logPath),
      };
    }
    return { logPath, content: slice.content, size: slice.size };
  }

  // Shared by the bgtail tool (agent-facing) and the /bgtail slash command
  // (human-facing).
  async function bgtailCore(
    params: { id: string; lines?: number; raw?: boolean; bytes?: number },
    ctx?: ExtensionContext,
  ): Promise<{
    content: { type: "text"; text: string }[];
    details: Record<string, unknown>;
    isError?: boolean;
  }> {
    const { id, lines: linesParam = 40, raw = false } = params;
    // Clamp defensively — direct callers (e.g. the slash command) bypass the
    // tool schema, and lines < 1 would corrupt slicing (slice(-0) = whole log).
    const lines = Math.max(1, Math.floor(linesParam));
    if (!id) throw new Error("bgtail: id is required");
    const readWindow = clampReadWindow(params.bytes);
    const resolved = resolveLogForJob(id, "bgtail", ctx, readWindow);
    if ("errorText" in resolved) {
      return {
        content: [{ type: "text", text: resolved.errorText }],
        details: {
          id,
          logPath: resolved.logPath,
          notFound: resolved.notFound,
        },
        isError: true,
      };
    }
    const { logPath, content, size } = resolved;
    // The cap dropped bytes off the END, so every "last N lines" view below is
    // the end of what was KEPT. Flag it in the output, or a mid-run line reads
    // as the job's final word — and in the details, for callers that parse them.
    const truncatedAt = parseTruncationFromContent(content);
    const capNote =
      truncatedAt === null
        ? ""
        : `\n\n(log truncated at ${formatBytes(truncatedAt)} — lines past the cap were never written, so this is not the run's real end)`;
    const truncDetails =
      truncatedAt === null ? {} : { truncatedAtBytes: truncatedAt };
    // Tail reads are bounded at LOG_READ_BYTES, so on a log past that window
    // every view above is the end of a slice — say so, or "not in the output"
    // reads as "not in the log". The advertised maximum is the ceiling actually
    // in force plus the wrapper's overhead, so it can cover a capped log
    // (a max equal to the cap left its first bytes permanently unreadable).
    const windowNote =
      size > readWindow
        ? `\n\n(searched the last ${formatBytes(readWindow)} of ${formatBytes(size)} — the earlier bytes were not searched; pass a larger \`bytes\` (max ${formatBytes(readWindowMax())}) or use ctx_execute_file on the log path)`
        : "";
    // Content lines only: wrapper bookkeeping (exit marker, truncation notice)
    // and blanks are filtered BEFORE the window is sliced, so "last N lines"
    // means the last N content lines (matching pre-delta behavior) and
    // bookmarks count content lines.
    // boundScanLines first: a window of very short lines (the `yes ''` runaway
    // the ceiling exists for) is millions of lines in a few MiB, and splitting
    // it all costs gigabytes of RSS on the host's main thread.
    // /\r?\n/ keeps CRLF logs from leaving a stray \r on every line.
    const scan = boundScanLines(content);
    const lineNote = scan.lineBoundHit
      ? `\n\n(and only the last ${LOG_SCAN_LINES_MAX.toLocaleString("en-US")} lines of that window were scanned)`
      : "";
    const rawLines = scan.content
      .split(/\r?\n/)
      .filter((l) => !isWrapperLine(l) && l.trim().length > 0);
    const total = rawLines.length;
    const first = rawLines[0]?.slice(0, 200) ?? "";
    const prev = tailBookmarks.get(id);
    // Same log, different window: a wider view would look like pages of "new"
    // lines that were only never looked at before, so reset the delta. It also
    // moves the window's first line, so it must be tested BEFORE the
    // replacement heuristic below — otherwise a widened read misreports the log
    // as replaced.
    const windowChanged = prev !== undefined && prev.window !== readWindow;
    // Append-only logs never mutate earlier lines, so a changed first
    // content line means the log was replaced or rotated — reset to a full
    // tail. Catches same-size replacements the shrink checks cannot see.
    // (A previously-empty log growing content is growth, not replacement.)
    const replaced =
      prev !== undefined &&
      !windowChanged &&
      prev.lines > 0 &&
      prev.first !== first;
    const shrank =
      prev !== undefined && (prev.lines > total || prev.bytes > size);
    let window: string[];
    let header: string | undefined;
    let newLines: number | undefined;
    if (raw || prev === undefined || shrank || replaced || windowChanged) {
      // Full tail: first read, raw mode, a shrunken/replaced log, or a changed
      // search window (all resets).
      window = rawLines.slice(-lines);
      if (!raw) {
        header = shrank
          ? "log shrank since last read — showing full tail"
          : replaced
            ? "log was replaced since last read — showing full tail"
            : windowChanged
              ? "search window changed since last read — showing full tail"
              : undefined;
      }
    } else {
      const fresh = rawLines.slice(prev.lines);
      newLines = fresh.length;
      if (fresh.length === 0) {
        rememberTail(id, {
          lines: total,
          bytes: size,
          first,
          window: readWindow,
        });
        return {
          content: [
            {
              type: "text",
              text: `(no new lines since last read — log at ${total} line${total === 1 ? "" : "s"})${capNote}${windowNote}${lineNote}`,
            },
          ],
          details: {
            id,
            linesShown: 0,
            logPath,
            notFound: false,
            condensed: true,
            newLines: 0,
            totalLines: total,
            windowBytes: readWindow,
            ...truncDetails,
          },
        };
      }
      window = fresh.length > lines ? fresh.slice(-lines) : fresh;
      header =
        `+${fresh.length} new line${fresh.length === 1 ? "" : "s"} since last read — ` +
        `log at ${total} lines${fresh.length > lines ? ` (showing last ${lines})` : ""}`;
    }
    rememberTail(id, {
      lines: total,
      bytes: size,
      first,
      window: readWindow,
    });
    const shown = window;
    const { text, truncated } = condenseLogLines(shown, { raw });
    // Delta reads early-return above, so an empty window here can only be
    // a first read of an empty log (full-tail path).
    const body = shown.length === 0 ? "(empty log)" : text;
    const notes = truncated.length > 0 ? `\n\n(${truncated.join("; ")})` : "";
    const head = header ? `${header}\n` : "";
    return {
      content: [
        {
          type: "text",
          text: head + body + notes + capNote + windowNote + lineNote,
        },
      ],
      details: {
        id,
        linesShown: shown.length,
        logPath,
        notFound: false,
        condensed: !raw,
        ...(newLines === undefined ? {} : { newLines, totalLines: total }),
        ...(truncated.length > 0 ? { condenserNotes: truncated } : {}),
        windowBytes: readWindow,
        ...truncDetails,
      },
    };
  }

  const bgtailTool = defineTool({
    name: "bgtail",
    label: "Tail Background Log",
    description:
      "Read the newest lines of a background job's log, condensed for context: ANSI escapes stripped, repeated lines collapsed, long lines truncated, output capped (~8KB). Strips the exit-marker line. The first read returns the last N lines (default 40); REPEAT reads return only lines appended since your last read (delta tailing) — polling a running job never re-pays for the same lines. raw: true returns the unprocessed last-N window. A shrunken, replaced, or differently-windowed log resets to a full tail. Reads only the log's last 2 MiB by default (`bytes` widens it, max 64 MiB) and says so when the log is bigger. For pattern search use bggrep; for whole-log analysis, ctx_execute_file on the log path.",
    promptSnippet: "Read the last N lines of a bgrun job's log",
    parameters: Type.Object({
      id: Type.String({
        description: "Job id (from bgrun's 'started: <id>' response)",
      }),
      lines: Type.Optional(
        Type.Number({
          description: "Number of lines to show (default 40)",
          minimum: 1,
        }),
      ),
      raw: Type.Optional(
        Type.Boolean({
          description:
            "Skip condensing (ANSI strip, collapse, caps) and return raw text",
        }),
      ),
      bytes: Type.Optional(
        Type.Number({
          description:
            "Search window in bytes (default 2097152 = 2 MiB; capped at the configured log ceiling plus the wrapper's overhead — 67108864 = 64 MiB by default). Widening affects how much is SCANNED (and what the scan costs in CPU and memory) — the returned text stays capped.",
          minimum: 1,
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { id: string; lines?: number; raw?: boolean; bytes?: number },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      return bgtailCore(params, ctx);
    },
  });
  pi.registerTool(bgtailTool);

  // ── bggrep: pattern search over a job's log, capped for context ───────────
  //
  // bggrep runs inside the extension, so it resolves the job id to the
  // configured jobs dir itself (no path to reconstruct) and needs no shell
  // quoting for the regex; ctx_execute_file can read the same file, but you
  // must hand it the absolute path. Matches are line-numbered (grep -n style),
  // optionally with context lines, capped at MAX_GREP_MATCHES, and run
  // through the same condenser as bgtail so a search can never flood context.

  const MAX_GREP_MATCHES = 50;

  async function bggrepCore(
    params: { id: string; pattern?: string; context?: number; bytes?: number },
    ctx?: ExtensionContext,
  
  ): Promise<{
    content: { type: "text"; text: string }[];
    details: Record<string, unknown>;
    isError?: boolean;
  }> {
    const { id, pattern, context: contextParam = 0 } = params;
    // Clamp defensively — negative context would exclude the match lines
    // themselves from the context windows (lo > hi no-ops the inner loop).
    const context = Math.max(0, Math.floor(contextParam));
    if (!id) throw new Error("bggrep: id is required");
    // resolveLogForJob() below validates the id; no need to double-check.
    const source = pattern ?? DEFAULT_GREP_PATTERN;
    try {
      // Validate up front so a bad pattern fails immediately, without a worker.
      void new RegExp(source);
    } catch (err) {
      throw new Error(
        `bggrep: invalid pattern ${JSON.stringify(source)}: ${(err as Error).message}`,
      );
    }
    // Record-first, same as bgtail — correct across config changes.
    const readWindow = clampReadWindow(params.bytes);
    const resolved = resolveLogForJob(id, "bggrep", ctx, readWindow);
    if ("errorText" in resolved) {
      return {
        content: [{ type: "text", text: resolved.errorText }],
        details: {
          id,
          matches: 0,
          logPath: resolved.logPath,
          notFound: resolved.notFound,
        },
        isError: true,
      };
    }
    const { logPath, content, size } = resolved;
    // A capped log is missing its END, and "no matches" is exactly what a
    // failure pattern looks like when the failures were past the cap — so the
    // note belongs next to the count, not just in the details.
    const truncatedAt = parseTruncationFromContent(content);
    const truncNote =
      truncatedAt === null
        ? ""
        : `\n\n(log truncated at ${formatBytes(truncatedAt)} — output past the cap was never written and was not searched)`;
    const truncDetails =
      truncatedAt === null ? {} : { truncatedAtBytes: truncatedAt };
    // Same window caveat as bgtail: the search covers only the last `window`
    // bytes, so a miss on a bigger log means "not in the searched slice". The
    // advertised maximum is the ceiling in force plus the wrapper's overhead, so
    // it can cover a capped log.
    const windowNote =
      size > readWindow
        ? `\n\n(searched the last ${formatBytes(readWindow)} of ${formatBytes(size)} — the earlier bytes were not searched; pass a larger \`bytes\` (max ${formatBytes(readWindowMax())}) or use ctx_execute_file on the log path)`
        : "";
    // Bound the LINE count before splitting: a window of very short lines is
    // millions of lines in a few MiB, and materializing them costs ~100 bytes
    // each (>3 GB measured for a 64 MiB window) — on the main thread, in the
    // very log class the ceiling exists for. The caveat says when it bit.
    const scan = boundScanLines(content);
    const lineNote = scan.lineBoundHit
      ? `\n\n(and only the last ${LOG_SCAN_LINES_MAX.toLocaleString("en-US")} lines of that window were searched)`
      : "";
    // /\r?\n/ normalizes CRLF (a trailing \r would break $-anchored patterns
    // and leak into output); blank lines are KEPT so L<n> numbers match the
    // file. A trailing empty split element is dropped; "" yields zero lines.
    const split = scan.content === "" ? [] : scan.content.split(/\r?\n/);
    if (split.length > 0 && split[split.length - 1] === "") split.pop();
    const rawLines = split.filter((l) => !isWrapperLine(l));
    // Match under a wall-clock budget in a worker: a caller-supplied regex can
    // backtrack catastrophically and would otherwise hang the main thread with
    // no way to interrupt it.
    const budgetMs = bggrepTimeoutMs();
    const outcome = await matchLinesWithBudget(
      source,
      rawLines,
      BGGREP_LINE_CAP,
      budgetMs,
    );
    if (outcome.kind === "invalid") {
      throw new Error(
        `bggrep: invalid pattern ${JSON.stringify(source)}: ${outcome.message}`,
      );
    }
    if (outcome.kind === "timeout") {
      return {
        content: [
          {
            type: "text",
            text:
              `bggrep: /${source}/ exceeded the ${budgetMs}ms match budget across ` +
              `${rawLines.length} line${rawLines.length === 1 ? "" : "s"} — likely ` +
              `catastrophic backtracking; no results computed.`,
          },
        ],
        details: {
          id,
          matches: 0,
          linesSearched: rawLines.length,
          logPath,
          notFound: false,
          pattern: source,
          timedOut: true,
          windowBytes: readWindow,
          ...truncDetails,
        },
        isError: true,
      };
    }
    const matchIdx = outcome.matchIdx;
    const header =
      `${matchIdx.length} match${matchIdx.length === 1 ? "" : "es"} for /${source}/ ` +
      `in ${rawLines.length} line${rawLines.length === 1 ? "" : "s"}`;
    if (matchIdx.length === 0) {
      return {
        content: [
          { type: "text", text: `${header} — none${truncNote}${windowNote}${lineNote}` },
        ],
        details: {
          id,
          matches: 0,
          linesSearched: rawLines.length,
          logPath,
          notFound: false,
          windowBytes: readWindow,
          ...truncDetails,
        },
      };
    }
    const capped = matchIdx.length > MAX_GREP_MATCHES;
    const shownIdx = capped ? matchIdx.slice(0, MAX_GREP_MATCHES) : matchIdx;
    // Context windows, merged where they overlap or touch (grep -C style).
    const include = new Set<number>();
    for (const i of shownIdx) {
      const lo = Math.max(0, i - context);
      const hi = Math.min(rawLines.length - 1, i + context);
      for (let j = lo; j <= hi; j++) include.add(j);
    }
    const sorted = [...include].sort((a, b) => a - b);
    const out: string[] = [];
    let prev = -2;
    for (const i of sorted) {
      if (prev >= 0 && i > prev + 1) {
        const gap = i - prev - 1;
        out.push(`…[${gap} line${gap === 1 ? "" : "s"} skipped]…`);
      }
      out.push(`L${i + 1}: ${rawLines[i]}`);
      prev = i;
    }
    const { text, truncated } = condenseLogLines(out);
    const notes = truncated.length > 0 ? `\n\n(${truncated.join("; ")})` : "";
    const capNote = capped
      ? ` — showing first ${MAX_GREP_MATCHES}; ${matchIdx.length - MAX_GREP_MATCHES} more not shown`
      : "";
    return {
      content: [
        {
          type: "text",
          text: `${header}${capNote}\n${text}${notes}${truncNote}${windowNote}${lineNote}`,
        },
      ],
      details: {
        id,
        matches: matchIdx.length,
        linesSearched: rawLines.length,
        logPath,
        notFound: false,
        pattern: source,
        capped,
        windowBytes: readWindow,
        ...truncDetails,
      },
    };
  }

  const bggrepTool = defineTool({
    name: "bggrep",
    label: "Grep Background Log",
    description:
      "Search the tail of a background job's log with a regex — the last 2 MiB by default, widen with `bytes` (each line is pre-truncated to 10k chars before matching); returns only matching lines with line numbers (optional context lines), capped (~50 matches, ~8KB) and condensed. Matching runs under a wall-clock budget (default 2s, PI_BGRUN_GREP_TIMEOUT_MS), so a runaway regex fails instead of hanging. Resolves the job id to the configured jobs dir itself, so there is no log path to reconstruct; ctx_execute_file can read the same file, but needs the absolute path. Pass your own pattern whenever you know the log's format; with no pattern a generic failure-signature default is used (a convenience only — not a guarantee).",
    promptSnippet: "Search a bgrun job's log for a pattern",
    promptGuidelines: [
      "Never search a bgrun log with the bash tool — uncapped output can flood context, and it needs manual log-path reconstruction and regex shell-quoting; bggrep is bounded by design.",
      "Prefer bggrep over bash grep or reading a bgrun log — matches are line-numbered, capped, and condensed.",
      "Pass an explicit pattern when you know the tool's output format; the default only catches common failure signatures.",
    ],
    parameters: Type.Object({
      id: Type.String({
        description: "Job id (from bgrun's 'started: <id>' response)",
      }),
      pattern: Type.Optional(
        Type.String({
          description:
            "Regex to search for. Default: generic failure signatures — override when you know the format.",
        }),
      ),
      context: Type.Optional(
        Type.Number({
          description:
            "Context lines around each match (default 0, grep -C style)",
          minimum: 0,
        }),
      ),
      bytes: Type.Optional(
        Type.Number({
          description:
            "Search window in bytes (default 2097152 = 2 MiB; capped at the configured log ceiling plus the wrapper's overhead — 67108864 = 64 MiB by default). Widening affects how much is SCANNED (and what the scan costs in CPU and memory) — the returned matches stay capped (~50 matches, ~8KB).",
          minimum: 1,
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { id: string; pattern?: string; context?: number; bytes?: number },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      return bggrepCore(params, ctx);
    },
  });
  pi.registerTool(bggrepTool);

  // ── bgstatus: list jobs (in-memory while alive; dir scan after restart) ─────

  // Shared by the bgstatus tool (agent-facing) and the /bgstatus slash command
  // (human-facing).
  async function bgstatusCore(
    params: { id?: string; includeDone?: boolean },
    ctx: ExtensionContext,
  ): Promise<{
    content: { type: "text"; text: string }[];
    details: BgStatusDetails;
    isError?: boolean;
  }> {
    const { id } = params;
    const cfg = resolveConfig(ctx);
    const jobsDir = cfg.jobsDir;
    if (id) {
      validateJobId(id, "bgstatus");
      const rec = jobs.get(id);
      if (rec) {
        // Read-only reconciliation: an in-memory record whose exit event never
        // fired (or one reconstructed on restart) can lag its log. Derive the
        // real state from the marker / pid liveness WITHOUT mutating or
        // persisting — the list path and the 30s poller own persistence. This
        // keeps by-id and list from disagreeing for up to a poll interval.
        let exit = rec.exitCode;
        if (exit === undefined && !rec.child) {
          // No live handle (reconstructed/adopted) — derive from the log or a
          // dead pid. A live child is authoritative: a running job whose own
          // output contains a spurious __BGRUN_EXIT__ line must not read done.
          const fromLog = parseExitFromLogPath(rec.logPath);
          if (fromLog !== null) exit = fromLog;
          else if (rec.pid <= 0 || !isRunningPid(rec.pid)) exit = -1;
        }
        const state = exit === undefined ? "running" : "done";
        const exitStr = exit === undefined ? "" : ` exit=${exit}`;
        const lines = [`${id}: ${state}${exitStr}`];
        if (rec.name) lines.push(`  name: ${rec.name}`);
        if (rec.type) lines.push(`  type: ${rec.type}`);
        lines.push(`  wake: ${rec.wake}`);
        lines.push(`  cmd: ${rec.cmd}`, `  log: ${rec.logPath}`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            id,
            state,
            exitCode: exit ?? undefined,
            cmd: rec.cmd,
            name: rec.name,
            type: rec.type,
            wake: rec.wake,
            recovered: false,
          },
        };
      }
      const logPath = join(jobsDir, `${id}.log`);
      if (!existsSync(logPath)) {
        return {
          content: [{ type: "text", text: `No job found with id ${id}` }],
          details: { id, state: "unknown" },
          isError: true,
        };
      }
      let exit = parseExitFromLogPath(logPath);
      if (exit === null) {
        const pid = pidFromId(id);
        if (pid !== null && (pid <= 0 || !isRunningPid(pid))) exit = -1;
      }
      const state = exit === null ? "running" : "done";
      return {
        content: [
          {
            type: "text",
            text: `${id}: ${state}${exit === null ? "" : ` exit=${exit}`} (recovered from log)\n  log: ${logPath}`,
          },
        ],
        details: {
          id,
          state,
          exitCode: exit ?? undefined,
          recovered: true,
        },
      };
    }
    // List: this session's jobs (running by default; finished only when
    // includeDone / showCompletedJobs is set). Other sessions' RUNNING jobs
    // appear only when adoptForeignJobs is opted in; finished foreign logs
    // from the shared dir can also appear when finished jobs are included.
    // Hidden disk logs get a one-line count instead of spamming the listing.
    const showDone = params.includeDone ?? cfg.showCompletedJobs;
    // Read-only: asking for status must not append transcript cards. The stale
    // poller (when a job is unsupervised) persists independently.
    revalidateStaleJobs({ persist: false });
    updateWidget(ctx, { persistRevalidate: false });
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const [jid, rec] of jobs) {
      seen.add(jid);
      if (rec.exitCode === undefined || showDone) {
        const state = rec.exitCode === undefined ? "running" : "done";
        const exit = rec.exitCode === undefined ? "" : ` exit=${rec.exitCode}`;
        const label = rec.name ? `${jid} — ${rec.name}` : jid;
        const from = rec.adopted ? " (adopted)" : "";
        lines.push(`  ${label}: ${state}${exit}${from}`);
      }
    }
    let hiddenOnDisk = 0;
    if (!showDone && !cfg.adoptForeignJobs) {
      // Default listing: every on-disk log is just a hidden count. Skip the
      // exit-marker parse (a 256 KB tail read per file) — the cheap scan's
      // names are all we need.
      for (const entry of scanLogFiles(jobsDir)) {
        if (!seen.has(entry.id)) hiddenOnDisk++;
      }
    } else {
      for (const entry of scanJobsDir(jobsDir)) {
        if (seen.has(entry.id)) continue;
        if (entry.exit !== null) {
          // finished log on disk (other or older session)
          if (showDone) {
            lines.push(`  ${entry.id}: done exit=${entry.exit} (from log)`);
          } else {
            hiddenOnDisk++;
          }
        } else if (cfg.adoptForeignJobs && entry.alive) {
          lines.push(`  ${entry.id}: running (from log)`);
        } else {
          hiddenOnDisk++;
        }
      }
    }
    // Count jobs, not display lines: capture before appending the "(N more…)"
    // footer, which is a note rather than a job.
    const jobCount = lines.length;
    if (hiddenOnDisk > 0) {
      lines.push(
        `  (${hiddenOnDisk} more job log(s) on disk — pass includeDone to list, bgclean all to prune)`,
      );
    }
    if (lines.length === 0) {
      return {
        content: [{ type: "text", text: "(no bgrun jobs)" }],
        details: { count: 0 },
      };
    }
    return {
      content: [{ type: "text", text: `bgrun jobs:\n${lines.join("\n")}` }],
      details: { count: jobCount },
    };
  }

  const bgstatusTool = defineTool({
    name: "bgstatus",
    label: "Background Job Status",
    description:
      "Show status of background jobs. With an id: one job's state + exit code. Without: list this session's " +
      "running jobs (finished jobs are hidden by default — pass includeDone or set showCompletedJobs to list " +
      "them). Other sessions' running jobs are listed only when adoptForeignJobs is enabled; finished foreign " +
      "logs from the shared dir can also appear when finished jobs are included.",
    promptSnippet: "Check status of bgrun jobs",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({ description: "Optional job id to inspect" }),
      ),
      includeDone: Type.Optional(
        Type.Boolean({
          description:
            "Include finished jobs (and other logs on disk) in the listing",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { id?: string; includeDone?: boolean },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      return bgstatusCore(params, ctx);
    },
  });
  pi.registerTool(bgstatusTool);

  // ── bgclean: remove old job logs ───────────────────────────────────────────

  // Shared by the bgclean tool (agent-facing) and the /bgclean slash command
  // (human-facing).
  async function bgcleanCore(
    params: { days?: number; all?: boolean },
    ctx?: ExtensionContext,
  ): Promise<{
    content: { type: "text"; text: string }[];
    details: { removed: number; kept: number; skippedRunning: number };
  }> {
    const cfg = resolveConfig(ctx);
    const { days = cfg.cleanupDays, all = false } = params;
    if (typeof days !== "number" || days <= 0 || !Number.isFinite(days)) {
      throw new Error(`bgclean: days must be a positive number, got ${days}`);
    }
    let result;
    if (all) {
      result = { removed: 0, kept: 0, skippedRunning: 0 };
      // "all" spans every shared jobs dir — the current project's plus the
      // machine-global default (so pre-project-local logs are still reachable).
      for (const dir of sharedJobsDirs(cfg.jobsDir, cfg.jobsDirProjectLocal)) {
        // An explicit `bgclean all` is the user's direct intent — bypass the
        // ownership marker gate so it always works.
        const r = cleanOldJobs(days, dir, ctx, { requireOwnership: false });
        result.removed += r.removed;
        result.kept += r.kept;
        result.skippedRunning += r.skippedRunning;
        // Do not create a jobs dir just to stamp the throttle marker — that
        // would dirty git status in a repo with no jobs (and mutate an
        // untrusted repo). Only refresh the marker when the dir already exists.
        if (!existsSync(dir)) continue;
        // Only the project-local dir may be git-excluded. The shared global
        // dir must NOT be excluded in whatever repo happens to contain it
        // (e.g. $HOME being a dotfiles repo).
        if (
          cfg.jobsDirProjectLocal &&
          safeRealpath(dir) === safeRealpath(cfg.jobsDir)
        )
          ensureGitExcluded(dir);
        try {
          writeFileSync(join(dir, ".last-clean"), String(Date.now()));
        } catch {
          // best-effort
        }
      }
    } else {
      // Session-scoped by default: bg* commands apply to the current
      // session's jobs only.
      result = cleanSessionJobs(days, ctx);
    }
    const scope = all ? "all sessions" : "this session";
    const summary = `removed ${result.removed} job log(s) (${scope}), kept ${result.kept}${result.skippedRunning > 0 ? `, skipped ${result.skippedRunning} running` : ""}`;
    return {
      content: [{ type: "text", text: summary }],
      details: result,
    };
  }

  const bgcleanTool = defineTool({
    name: "bgclean",
    label: "Clean Old Background Jobs",
    description:
      "Remove old background job logs from disk. Default scope: THIS session's jobs only (other sessions' logs are " +
      "untouched); this also drops stale per-project digest markers in the session's jobs dir (they are not session " +
      "data). Pass all: true to sweep every shared jobs dir — under the project-local default that is the current " +
      "project's dir plus the machine-global one; an explicit absolute jobsDir is swept alone. Retention: " +
      "cleanupDays config (default 7 days). Never removes a running job's log. Prints a summary of what was removed " +
      "vs kept.",
    promptSnippet:
      "Remove old bgrun job logs (this session by default; all: true for every session's)",
    parameters: Type.Object({
      days: Type.Optional(
        Type.Number({
          description: "Remove logs older than this many days (default 7)",
        }),
      ),
      all: Type.Optional(
        Type.Boolean({
          description:
            "Sweep every shared jobs dir (all sessions' logs) — plus the machine-global dir under the project-local default; an absolute jobsDir is swept alone (default false)",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { days?: number; all?: boolean },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      return bgcleanCore(params, ctx);
    },
  });
  pi.registerTool(bgcleanTool);

  // ── Unified job tool: the compact default surface ─────────────────────────

  async function cancelJobCore(
    params: { id: string },
    ctx: ExtensionContext,
  ): Promise<{
    content: { type: "text"; text: string }[];
    details: { id: string; state: string; pid?: number };
    isError?: boolean;
  }> {
    const { id } = params;
    if (!id) throw new Error("job cancel: id is required");
    validateJobId(id, "job cancel");
    const rec = jobs.get(id);
    const cfg = resolveConfig(ctx);
    const logPath = rec?.logPath ?? join(cfg.jobsDir, `${id}.log`);
    if (!rec && !existsSync(logPath)) {
      return {
        content: [{ type: "text", text: `No job found with id ${id}` }],
        details: { id, state: "unknown" },
        isError: true,
      };
    }
    const existingExit = rec?.exitCode ?? parseExitFromLogPath(logPath);
    if (existingExit !== undefined && existingExit !== null) {
      return {
        content: [
          {
            type: "text",
            text: `${id}: already done (exit ${existingExit})`,
          },
        ],
        details: { id, state: "done", pid: rec?.pid },
      };
    }
    const pid = rec?.pid ?? pidFromId(id);
    if (pid === null || pid <= 0) {
      return {
        content: [{ type: "text", text: `${id}: no cancellable process id` }],
        details: { id, state: "unknown" },
        isError: true,
      };
    }
    // Cancellation is user/agent initiated and must not generate a completion
    // wake. The normal exit handler still persists the terminal state and
    // updates the human toast/widget.
    if (rec) rec.wake = "never";
    try {
      process.kill(-pid, "SIGTERM");
    } catch (groupError) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (pidError) {
        const message =
          pidError instanceof Error
            ? pidError.message
            : groupError instanceof Error
              ? groupError.message
              : "process is not running";
        return {
          content: [
            { type: "text", text: `${id}: cancellation failed: ${message}` },
          ],
          details: { id, state: "unknown", pid },
          isError: true,
        };
      }
    }
    updateWidget(ctx);
    return {
      content: [
        { type: "text", text: `${id}: cancellation requested (SIGTERM)` },
      ],
      details: { id, state: "cancelling", pid },
    };
  }

  pi.registerTool({
    name: "job",
    label: "Background Job",
    description:
      "Control genuinely asynchronous commands through one compact interface: run, status, tail, grep, cancel, or clean. Use foreground bash by default; use job only when work must outlive the current turn or run concurrently.",
    promptSnippet:
      "Run, inspect, cancel, and clean genuinely asynchronous background jobs",
    promptGuidelines: [
      "Default to foreground bash. Use job action=run only for deployment/CI monitoring, long evals, sustained observability, or work that must continue concurrently.",
      "For job action=run, choose wake=always when continuation depends on completion, wake=failure when only failure needs attention, or wake=never for independent work.",
      "After starting a job, continue other work; do not poll it through model turns.",
      "Use job action=tail for a bounded recent view and action=grep for targeted failure or status evidence; never read a whole background log through bash or read.",
    ],
    parameters: Type.Object({
      action: Type.Union(
        ["run", "status", "tail", "grep", "cancel", "clean"].map((value) =>
          Type.Literal(value),
        ),
        { description: "Job operation" },
      ),
      command: Type.Optional(
        Type.String({ description: "run: shell command to execute" }),
      ),
      id: Type.Optional(
        Type.String({ description: "status/tail/grep/cancel: job id" }),
      ),
      name: Type.Optional(Type.String({ description: "run: short job label" })),
      type: Type.Optional(
        Type.String({ description: "run: digest scorecard type" }),
      ),
      wake: Type.Optional(
        Type.Union(
          ["never", "failure", "always"].map((value) => Type.Literal(value)),
          { description: "run: completion wake policy" },
        ),
      ),
      lines: Type.Optional(
        Type.Number({ minimum: 1, description: "tail: newest line count" }),
      ),
      raw: Type.Optional(
        Type.Boolean({ description: "tail: disable output condensation" }),
      ),
      pattern: Type.Optional(
        Type.String({ description: "grep: regular expression" }),
      ),
      context: Type.Optional(
        Type.Number({ minimum: 0, description: "grep: context lines" }),
      ),
      bytes: Type.Optional(
        Type.Number({ minimum: 1, description: "tail/grep: scan window bytes" }),
      ),
      includeDone: Type.Optional(
        Type.Boolean({ description: "status: include completed jobs" }),
      ),
      days: Type.Optional(
        Type.Number({ minimum: 0, description: "clean: retention days" }),
      ),
      all: Type.Optional(
        Type.Boolean({ description: "clean: include all sessions" }),
      ),
    }),
    renderCall(args, theme) {
      const target =
        args.name || args.id || (args.command ? String(args.command) : "");
      const compact = String(target).replace(/\s+/g, " ").trim();
      const suffix = compact
        ? ` ${compact.length > 110 ? `${compact.slice(0, 107)}…` : compact}`
        : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold(`job ${args.action || "…"}`))}${theme.fg("muted", suffix)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = result.content
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n")
        .trimEnd();
      if (expanded) {
        return new Text(
          text
            ? `\n${text
                .split("\n")
                .map((line) => theme.fg("toolOutput", line))
                .join("\n")}`
            : "",
          0,
          0,
        );
      }
      if (isPartial) return new Text(theme.fg("muted", "… working"), 0, 0);
      const details = (result.details ?? {}) as Record<string, unknown>;
      const action = String((context.args as { action?: string })?.action || "job");
      let summary = "✓ done";
      if (action === "run" && details.id) summary = `✓ started ${details.id}`;
      else if (action === "tail")
        summary = `✓ ${details.newLines ?? details.linesShown ?? 0} lines`;
      else if (action === "grep") summary = `✓ ${details.matches ?? 0} matches`;
      else if (action === "status")
        summary = details.state
          ? `✓ ${details.state}${details.exitCode === undefined ? "" : ` · exit ${details.exitCode}`}`
          : `✓ ${details.count ?? 0} jobs`;
      else if (action === "cancel") summary = `✓ ${details.state ?? "cancelling"}`;
      else if (action === "clean") summary = `✓ removed ${details.removed ?? 0}`;
      return new Text(
        `${theme.fg("success", summary)}${text ? theme.fg("muted", ` · ${keyHint("app.tools.expand", "expand")}`) : ""}`,
        0,
        0,
      );
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      switch (params.action) {
        case "run":
          if (!params.command) throw new Error("job run: command is required");
          return bgrunTool.execute(
            toolCallId,
            {
              command: params.command,
              name: params.name,
              type: params.type,
              wake: params.wake,
            },
            signal,
            onUpdate,
            ctx,
          );
        case "status":
          return bgstatusCore(
            { id: params.id, includeDone: params.includeDone },
            ctx,
          );
        case "tail":
          if (!params.id) throw new Error("job tail: id is required");
          return bgtailCore(
            {
              id: params.id,
              lines: params.lines,
              raw: params.raw,
              bytes: params.bytes,
            },
            ctx,
          );
        case "grep":
          if (!params.id) throw new Error("job grep: id is required");
          return bggrepCore(
            {
              id: params.id,
              pattern: params.pattern,
              context: params.context,
              bytes: params.bytes,
            },
            ctx,
          );
        case "cancel":
          if (!params.id) throw new Error("job cancel: id is required");
          return cancelJobCore({ id: params.id }, ctx);
        case "clean":
          return bgcleanCore({ days: params.days, all: params.all }, ctx);
        default:
          throw new Error(`job: unsupported action ${String(params.action)}`);
      }
    },
  });

  // ── Slash commands: human-facing mirrors of the read/clean tools ───────────
  //
  // pi.registerTool registers AGENT tools; slash commands need a separate
  // pi.registerCommand registration. These let the human check jobs or prune
  // logs directly from the TUI without asking the agent. /bgrun is
  // deliberately NOT a command — starting jobs (and reacting to their wakes)
  // is the agent's workflow.

  pi.registerCommand("bgstatus", {
    description: "Background jobs: status (/bgstatus [id] [done])",
    handler: async (args: string, ctx: ExtensionContext) => {
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const includeDone = tokens.some((t) =>
        ["done", "all"].includes(t.toLowerCase()),
      );
      const id = tokens.find((t) => !["done", "all"].includes(t.toLowerCase()));
      const res = await bgstatusCore(
        { id, includeDone: includeDone || undefined },
        ctx,
      );
      if (ctx.hasUI) {
        ctx.ui.notify(res.content[0].text, res.isError ? "error" : "info");
      }
    },
  });

  pi.registerCommand("bgtail", {
    description: "Background jobs: tail a log (/bgtail <id> [lines])",
    handler: async (args: string, ctx: ExtensionContext) => {
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const id = tokens[0];
      if (!id) {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /bgtail <job-id> [lines]", "error");
        }
        return;
      }
      const n = Number(tokens[1]);
      const res = await bgtailCore(
        { id, lines: Number.isFinite(n) && n > 0 ? n : undefined },
        ctx,
      );
      if (ctx.hasUI) {
        ctx.ui.notify(res.content[0].text, res.isError ? "error" : "info");
      }
    },
  });

  pi.registerCommand("bgclean", {
    description: "Background jobs: remove old logs (/bgclean [days] [all])",
    handler: async (args: string, ctx: ExtensionContext) => {
      const tokens = (args ?? "")
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const daysToken = Number(tokens.find((t) => /^\d+(\.\d+)?$/.test(t)));
      const all = tokens.includes("all");
      try {
        const res = await bgcleanCore(
          { days: Number.isFinite(daysToken) ? daysToken : undefined, all },
          ctx,
        );
        if (ctx.hasUI) {
          ctx.ui.notify(res.content[0].text, "info");
        }
      } catch (err) {
        if (ctx.hasUI) {
          ctx.ui.notify(String(err), "error");
        }
      }
    },
  });
}
