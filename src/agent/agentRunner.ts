import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { runStream } from "../util/proc";
import { getSetting } from "../config/settings";

export type AgentHarnessType = "claude-code" | "gemini-antigravity" | "opencode" | "cursor";
export type AgentRole = "planner" | "developer" | "tester" | "fixer" | "ticket";

export interface AgentRunRequest {
  role: AgentRole;
  harness?: AgentHarnessType;
  /** Explicit model for this run; otherwise resolved from settings (per-role override, then per-harness). */
  model?: string;
  /** Reasoning effort for this run (claude / agy / opencode); otherwise resolved from settings. */
  effort?: string;
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Human-readable progress lines (tool calls, messages) while the agent works. */
  onActivity?: (line: string) => void;
}

export interface AgentRunResult {
  success: boolean;
  output: string;
  code: number;
  harness: AgentHarnessType;
  /** Model the harness reported using (or the one requested when it does not report one). */
  model?: string;
  effort?: string;
}

/** Seam for tests and future harnesses: anything that can run one prompt to completion in a directory. */
export interface AgentExecutor {
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}

const READ_TOOLS = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git log:*)"];
const WRITE_TOOLS = ["Edit", "Write", "MultiEdit"];
// Agents may never move history or leave the repo; the workflow engine owns commit/push.
const DENY = [
  "Bash(git push:*)", "Bash(git checkout:*)", "Bash(git switch:*)", "Bash(git reset:*)", "Bash(git rebase:*)",
  "Bash(git branch:*)", "Bash(rm -rf:*)", "Bash(sudo:*)", "Bash(curl:*)", "Bash(wget:*)",
];

/** Defaults are deliberately NOT the most expensive model. */
export const DEFAULT_MODELS: Record<string, string> = {
  "claude-code": "sonnet",
  "gemini-antigravity": "gemini-3.8-flash",
  opencode: "opencode/big-pickle",
  cursor: "",
};
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Harnesses whose CLI has an effort/variant flag (`claude --effort`, `agy --effort`, `opencode --variant`). */
const EFFORT_HARNESSES = new Set<string>(["claude-code", "gemini-antigravity", "opencode"]);
export const DEFAULT_EFFORT: Record<string, string> = {
  "claude-code": "medium",
  "gemini-antigravity": "medium",
  opencode: "medium",
};

export function isValidEffort(e: string): boolean {
  return (EFFORT_LEVELS as readonly string[]).includes(e as any);
}

/** Resolves candidate directory locations cross-platform (Windows, macOS, Linux). */
export function getCandidateSearchDirs(): string[] {
  const isWin = process.platform === "win32";
  const home = os.homedir();
  const dirs: string[] = [];

  // Extension self-contained storage
  try {
    const { DependencyManager } = require("../services/dependencyManager");
    const dm = DependencyManager.getInstance();
    const binDir = dm.getBinDir?.();
    if (binDir && fs.existsSync(binDir)) dirs.push(binDir);
  } catch {}

  if (isWin) {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    dirs.push(
      path.join(appData, "Code", "User", "globalStorage", "codesentinel.codesentinel", "bin"),
      path.join(appData, "npm"),
      path.join(localAppData, "npm"),
      path.join(localAppData, "Programs"),
      path.join(localAppData, "Microsoft", "WinGet", "Links"),
      path.join(home, ".local", "bin"),
      path.join(home, ".codesentinel", "bin"),
      path.join(home, ".antigravity", "bin"),
      path.join(home, ".gemini", "antigravity-cli", "bin")
    );
  } else {
    dirs.push(
      path.join(home, "Library", "Application Support", "Code", "User", "globalStorage", "codesentinel.codesentinel", "bin"),
      path.join(home, ".local", "bin"),
      path.join(home, ".codesentinel", "bin"),
      path.join(home, ".gemini", "antigravity-cli", "bin"),
      path.join(home, ".antigravity", "bin"),
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin"
    );
  }

  return dirs;
}

/** Resolves executable binary name for a harness cross-platform. */
export function resolveHarnessPath(harness: AgentHarnessType): string {
  switch (harness) {
    case "claude-code": return "claude";
    case "gemini-antigravity": return "agy";
    case "opencode": return "opencode";
    case "cursor": return "cursor-agent";
    default: return harness;
  }
}

/** Provides an augmented environment with known CLI directories prepended to PATH cross-platform. */
export function getAugmentedEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isWin = process.platform === "win32";
  const pathKey = isWin ? "Path" : "PATH";

  // If caller explicitly passed a PATH / Path in extraEnv (e.g. unit tests isolating binaries or asserting not-found),
  // honor caller's PATH without force-injecting global candidate dirs.
  if (extraEnv && (extraEnv.PATH !== undefined || (isWin && extraEnv.Path !== undefined))) {
    const callerPath = (extraEnv.PATH ?? extraEnv.Path ?? "") as string;
    const out: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
    out.PATH = callerPath;
    if (isWin) out.Path = callerPath;
    return out;
  }

  const currentPath = process.env[pathKey] || process.env.PATH || "";
  const existing = currentPath.split(path.delimiter).filter(Boolean);
  const candidateDirs = getCandidateSearchDirs().filter((d) => fs.existsSync(d));

  // Candidate search directories come first so GUI launched apps (macOS Dock, Windows shortcuts)
  // have access to Homebrew, npm global, local bin, etc.
  const combined = [...candidateDirs, ...existing];
  const unique = Array.from(new Set(combined)).join(path.delimiter);
  const out: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  out[pathKey] = unique;
  out.PATH = unique;
  return out;
}

/** per-run override > per-stage setting > per-harness setting > built-in default. Empty = the CLI's own default. */
export function resolveEffort(harness: AgentHarnessType, role: AgentRole, override?: string): string | undefined {
  if (!EFFORT_HARNESSES.has(harness)) return undefined;
  const roleEfforts = getSetting<Record<string, string>>("agent.roleEfforts", {});
  const candidates = [override, roleEfforts?.[role], getSetting<string>(`agent.effort.${harness}`, DEFAULT_EFFORT[harness] ?? "")];
  for (const c of candidates) {
    const v = (c ?? "").trim().toLowerCase();
    if (v && isValidEffort(v)) return v;
  }
  return undefined;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/\-\[\]]{0,79}$/;

export function isValidModel(m: string): boolean {
  return MODEL_RE.test(m);
}

/** per-run override > per-role setting > per-harness setting > built-in default. Invalid values are ignored. */
export function resolveModel(harness: AgentHarnessType, role: AgentRole, override?: string): string | undefined {
  const roleModels = getSetting<Record<string, string>>("agent.roleModels", {});
  const candidates = [override, roleModels?.[role], getSetting<string>(`agent.model.${harness}`, DEFAULT_MODELS[harness] ?? "")];
  for (const c of candidates) {
    const v = (c ?? "").trim();
    if (v && isValidModel(v)) return v;
  }
  return undefined;
}

/**
 * Resolves model and effort flags for Antigravity (agy).
 * agy throws CLI errors when:
 * 1) Non-Gemini models (claude-sonnet-4-6, claude-opus-4-6-thinking) receive --effort.
 * 2) Models with hardcoded effort suffixes (gemini-3.8-flash-high, gpt-oss-120b-medium) conflict with a different --effort value.
 *
 * This normalizes gemini-3.8-flash(-...) to base model "gemini-3.8-flash" when effort is passed,
 * drops --effort for models that do not support it, and avoids passing redundant conflicting flags.
 */
export function resolveAgyModelAndEffort(
  model?: string,
  effort?: string
): { model?: string; effort?: string } {
  const m = (model || "").trim();
  const e = (effort || "").trim().toLowerCase();

  // Claude models hosted in agy reject the --effort flag completely
  if (m.startsWith("claude-")) {
    return { model: m, effort: undefined };
  }

  // Gemini Flash: strip baked suffix if effort is provided or keep clean base name
  if (/^gemini-3\.8-flash(-low|-medium|-high|-xhigh|-max)?$/i.test(m)) {
    if (e && isValidEffort(e)) {
      return { model: "gemini-3.8-flash", effort: e };
    }
    // If no explicit effort, keep m (e.g. "gemini-3.8-flash" or "gemini-3.8-flash-high") with no --effort flag
    return { model: m || "gemini-3.8-flash", effort: undefined };
  }

  // Models with baked effort suffix like gpt-oss-120b-medium
  const suffixMatch = m.match(/-(low|medium|high|xhigh|max)$/i);
  if (suffixMatch) {
    // Model already specifies effort in its alias; do not pass --effort to prevent conflicts
    return { model: m, effort: undefined };
  }

  return { model: m || undefined, effort: e && isValidEffort(e) ? e : undefined };
}

export function buildHeadlessCommand(
  harness: AgentHarnessType,
  role: AgentRole,
  prompt: string,
  model?: string,
  effort?: string
): { file: string; args: string[]; input?: string } | null {
  const readOnly = role === "planner" || role === "ticket";
  // Connector tools are loaded lazily through ToolSearch, so it must be allowed or the agent sees no Jira tools at all.
  const jiraTools = role === "ticket" ? ["ToolSearch", ...getSetting<string[]>("jira.harnessAllowedTools", ["mcp__claude_ai_Atlassian", "mcp__atlassian", "mcp__jira"])] : [];
  const m = model && isValidModel(model) ? model : undefined;
  const e = effort && isValidEffort(effort) ? effort : undefined;
  const executable = resolveHarnessPath(harness);

  switch (harness) {
    case "claude-code":
      return {
        file: executable,
        args: [
          "-p",
          "--output-format", "stream-json", "--verbose", // structured events so progress can be shown live
          ...(m ? ["--model", m] : []),
          ...(e ? ["--effort", e] : []),
          // plan mode would stop the ticket agent from calling Jira tools; its tool allowlist already makes it read-only on files
          ...(role === "ticket" ? [] : ["--permission-mode", readOnly ? "plan" : "acceptEdits"]),
          "--allowedTools", ...(role === "ticket" ? jiraTools : readOnly ? READ_TOOLS : [...READ_TOOLS, ...WRITE_TOOLS]),
          "--disallowedTools", ...DENY,
        ],
        input: prompt, // via stdin: no quoting, no argv length limits
      };

    case "gemini-antigravity": {
      const agy = resolveAgyModelAndEffort(m, e);
      return {
        file: executable,
        args: [
          "-p", prompt,
          "--output-format", "stream-json",
          "--dangerously-skip-permissions",
          ...(agy.model ? ["--model", agy.model] : []),
          ...(agy.effort ? ["--effort", agy.effort] : []),
          "--mode", readOnly ? "plan" : "accept-edits",
        ],
      };
    }

    case "opencode":
      return {
        file: executable,
        args: [
          "run",
          ...(m ? ["--model", m] : []),
          "--auto",
          "--format", "json",
          ...(e ? ["--variant", e] : []),
          prompt,
        ],
      };

    default:
      return null;
  }
}

export interface ClaudeStreamEvent {
  activity?: string;
  model?: string;
  result?: { text: string; isError: boolean };
}

const short = (v: unknown, n = 90) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Turns one line of `claude -p --output-format stream-json` into something a person can read. */
export function parseClaudeStreamLine(line: string): ClaudeStreamEvent | null {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (j.type === "system" && j.subtype === "init") return { model: j.model, activity: `started (${j.model ?? "model unknown"})` };
  if (j.type === "assistant" && Array.isArray(j.message?.content)) {
    const parts: string[] = [];
    for (const b of j.message.content) {
      if (b.type === "tool_use") {
        const input = b.input ?? {};
        const arg = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.query ?? Object.values(input).find((x) => typeof x === "string");
        parts.push(`${b.name}${arg ? " " + short(arg) : ""}`);
      } else if (b.type === "text" && String(b.text).trim()) {
        parts.push(`says: ${short(b.text, 220)}`);
      }
    }
    return parts.length ? { activity: parts.join(" | ") } : null;
  }
  if (j.type === "result") return { result: { text: String(j.result ?? ""), isError: Boolean(j.is_error) || j.subtype !== "success" } };
  return null;
}

/** Turns one line of `agy -p ... --output-format stream-json` into readable activity & result. */
export function parseAgyStreamLine(line: string): ClaudeStreamEvent | null {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (j.event === "init") {
    return { activity: "started (agy session)" };
  }
  if (j.event === "step_update" && j.step_update) {
    const su = j.step_update;
    if (su.step_type === "agent_response" && su.text_delta) {
      return { activity: `says: ${short(su.text_delta, 220)}` };
    }
    if (su.step_type === "tool" || su.step_type === "tool_call" || su.tool_call || su.tool_info) {
      const tc = su.tool_call || su.tool_info || {};
      const name = su.tool_name || tc.name || tc.tool_name || "tool";
      const args = tc.parameters || tc.arguments || tc.input || {};
      const argStr = typeof args === "string" ? args : Object.values(args).find((x) => typeof x === "string") || "";
      return { activity: `${name}${argStr ? " " + short(String(argStr), 80) : ""}` };
    }
  }
  if (j.event === "result" && j.result) {
    const res = j.result;
    return {
      result: {
        text: String(res.response ?? ""),
        isError: res.status !== "SUCCESS",
      },
    };
  }
  return null;
}

/** Turns one line of `opencode run` into readable activity & result. */
export function parseOpenCodeStreamLine(line: string): ClaudeStreamEvent | null {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    const trimmed = line.trim();
    if (!trimmed) return null;
    return { activity: short(trimmed, 200) };
  }
  if (j.type === "step_start") {
    return { activity: "started (opencode)" };
  }
  if (j.type === "step" || j.event === "step") {
    return { activity: short(j.message || j.step || "working...", 120) };
  }
  if (j.type === "tool_call" || j.type === "tool" || j.event === "tool" || j.tool) {
    const part = j.part || {};
    const tool = part.tool || j.tool || j.name || "tool";
    const input = part.input || j.input || {};
    const target = input.path || input.file || (typeof input === "string" ? input : Object.values(input).find((x) => typeof x === "string"));
    return { activity: target ? `${tool} ${target}` : `using tool ${tool}` };
  }
  if (j.type === "text" && j.part?.text) {
    return { activity: `says: ${j.part.text}`, result: { text: j.part.text, isError: false } };
  }
  if (j.type === "response" || j.response || j.result) {
    const text = String(j.response || j.result || j.text || "");
    return { result: { text, isError: Boolean(j.error || j.isError) } };
  }
  return null;
}

export const parseOpencodeStreamLine = parseOpenCodeStreamLine;

export class CliAgentExecutor implements AgentExecutor {
  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const harness = req.harness ?? getSetting<AgentHarnessType>("defaultAgentHarness", "claude-code");
    const model = resolveModel(harness, req.role, req.model);
    const effort = resolveEffort(harness, req.role, req.effort);
    const cmd = buildHeadlessCommand(harness, req.role, req.prompt, model, effort);
    if (!cmd) {
      return { success: false, output: `Harness '${harness}' has no headless mode; use the interactive terminal.`, code: 1, harness };
    }
    const minutes = getSetting<number>("workflow.agentTimeoutMinutes", 30);
    let reportedModel: string | undefined;
    let final: { text: string; isError: boolean } | undefined;

    // Cross-platform environment with comprehensive binary search paths
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const env = req.env?.[pathKey] !== undefined ? { ...process.env, ...req.env } : getAugmentedEnv(req.env);

    const r = await runStream(cmd.file, cmd.args, {
      cwd: req.cwd,
      input: cmd.input,
      env,
      signal: req.signal,
      timeoutMs: req.timeoutMs ?? minutes * 60000,
      onLine: (line) => {
        if (harness === "claude-code") {
          const ev = parseClaudeStreamLine(line);
          if (!ev) return;
          if (ev.model) reportedModel = ev.model;
          if (ev.result) final = ev.result;
          if (ev.activity) req.onActivity?.(ev.activity);
        } else if (harness === "gemini-antigravity") {
          const ev = parseAgyStreamLine(line);
          if (ev) {
            if (ev.model) reportedModel = ev.model;
            if (ev.result) final = ev.result;
            if (ev.activity) req.onActivity?.(ev.activity);
          } else {
            req.onActivity?.(line.slice(0, 240));
          }
        } else if (harness === "opencode") {
          const ev = parseOpenCodeStreamLine(line);
          if (ev) {
            if (ev.model) reportedModel = ev.model;
            if (ev.result) final = ev.result;
            if (ev.activity) req.onActivity?.(ev.activity);
          } else {
            req.onActivity?.(line.slice(0, 240));
          }
        } else {
          req.onActivity?.(line.slice(0, 240));
        }
      },
    });

    const text = (final?.text ?? "").trim() || (r.stdout || r.stderr).trim();
    const ok = r.code === 0 && (!final || !final.isError);
    return {
      success: ok,
      output: text || (r.stderr || (r.timedOut ? "Agent timed out." : "")).trim(),
      code: r.code,
      harness,
      model: reportedModel ?? model,
      effort,
    };
  }
}
