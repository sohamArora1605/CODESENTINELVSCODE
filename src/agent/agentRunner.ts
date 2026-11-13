import { runStream } from "../util/proc";
import { getSetting } from "../config/settings";

export type AgentHarnessType = "claude-code" | "gemini-antigravity" | "opencode" | "cursor";
export type AgentRole = "planner" | "developer" | "tester" | "fixer" | "ticket";

export interface AgentRunRequest {
  role: AgentRole;
  harness?: AgentHarnessType;
  /** Explicit model for this run; otherwise resolved from settings (per-role override, then per-harness). */
  model?: string;
  /** Reasoning effort for this run (claude / agy); otherwise resolved from settings. */
  effort?: string;
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
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

/** Defaults are deliberately NOT the most expensive model. Empty string means "the harness's own default". */
export const DEFAULT_MODELS: Record<string, string> = { "claude-code": "sonnet", "gemini-antigravity": "", opencode: "", cursor: "" };
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Harnesses whose CLI has an --effort flag (checked against `claude --help` and `agy --help`). */
const EFFORT_HARNESSES = new Set<string>(["claude-code", "gemini-antigravity"]);
export const DEFAULT_EFFORT: Record<string, string> = { "claude-code": "medium", "gemini-antigravity": "medium" };

export function isValidEffort(e: string): boolean {
  return (EFFORT_LEVELS as readonly string[]).includes(e);
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
  switch (harness) {
    case "claude-code":
      return {
        file: "claude",
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
    case "gemini-antigravity":
      return { file: "agy", args: ["-p", prompt, ...(m ? ["--model", m] : []), ...(e ? ["--effort", e] : []), "--mode", readOnly ? "plan" : "accept-edits"] };
    case "opencode":
      return { file: "opencode", args: ["run", ...(m ? ["--model", m] : []), prompt] };
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
    const r = await runStream(cmd.file, cmd.args, {
      cwd: req.cwd,
      input: cmd.input,
      env: { ...process.env, ...req.env },
      timeoutMs: req.timeoutMs ?? minutes * 60000,
      onLine: (line) => {
        if (harness === "claude-code") {
          const ev = parseClaudeStreamLine(line);
          if (!ev) return;
          if (ev.model) reportedModel = ev.model;
          if (ev.result) final = ev.result;
          if (ev.activity) req.onActivity?.(ev.activity);
        } else {
          req.onActivity?.(line.slice(0, 240));
        }
      },
    });
    if (harness === "claude-code") {
      const text = (final?.text ?? "").trim();
      const ok = r.code === 0 && !!final && !final.isError;
      return {
        success: ok,
        output: text || (r.stderr || (r.timedOut ? "Agent timed out." : "")).trim(),
        code: r.code,
        harness,
        model: reportedModel ?? model,
        effort,
      };
    }
    return {
      success: r.code === 0,
      output: (r.stdout || r.stderr).trim() || (r.timedOut ? "Agent timed out." : ""),
      code: r.code,
      harness,
      model,
      effort,
    };
  }
}
