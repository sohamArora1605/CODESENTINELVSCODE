import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function getVscode(): any | null {
  try {
    return require("vscode");
  } catch {
    return null;
  }
}

export const SETTING_KEYS = [
  "openCodeEnabled", "multiRepoEnabled", "gitAutoSyncEnabled", "defaultAgentHarness", "branchNamingTemplate",
  "jira.mode", "jira.mcpUrl", "jira.harnessAllowedTools", "jira.host", "jira.email", "jira.projectKey", "jira.jqlFilter",
  "testing.playwrightEnabled", "testing.apiTestingEnabled", "testing.stageDeployMode", "testing.stageDeployCommand",
  "testing.stageApiBaseUrl", "workflow.useWorktrees", "workflow.maxFixIterations", "workflow.autoPush",
  "workflow.requirePlanApproval", "workflow.agentTimeoutMinutes", "workflow.baseBranches",
  "workflow.pauseMode", "workflow.jiraStageComments", "workflow.stages", "agent.model.claude-code", "agent.model.gemini-antigravity", "agent.model.opencode", "agent.roleModels",
  "agent.effort.claude-code", "agent.effort.gemini-antigravity", "agent.roleEfforts",
];

function snapshotPath(): string {
  return path.join(process.env.CODESENTINEL_VAULT_DIR || path.join(os.homedir(), ".codesentinel"), "settings.snapshot.json");
}

let overrides: Record<string, unknown> = {};

/** Test hook */
export function setSettingsOverrides(o: Record<string, unknown>): void {
  overrides = o;
}

export type JiraMode = "disabled" | "manual" | "harness";

/** `jira.mode`, falling back to the legacy boolean `jira.enabled` (true = manual). */
export function getJiraMode(): JiraMode {
  const m = getSetting<string>("jira.mode", "");
  if (m === "manual" || m === "harness" || m === "disabled") return m;
  return getSetting<boolean>("jira.enabled", false) ? "manual" : "disabled";
}

/** Reads codesentinel.<key>: overrides → VS Code → snapshot file (MCP/CLI processes) → default. */
export function getSetting<T>(key: string, def: T): T {
  if (key in overrides) return overrides[key] as T;
  const vs = getVscode();
  if (vs?.workspace?.getConfiguration) {
    const v = vs.workspace.getConfiguration("codesentinel").get(key);
    if (v !== undefined && v !== null) return v as T;
    return def;
  }
  try {
    const snap = JSON.parse(fs.readFileSync(snapshotPath(), "utf-8"));
    if (snap[key] !== undefined) return snap[key] as T;
  } catch {}
  const env = process.env[`CODESENTINEL_${key.replace(/\./g, "_").toUpperCase()}`];
  if (env !== undefined) {
    if (typeof def === "boolean") return (env === "true") as unknown as T;
    if (typeof def === "number") return Number(env) as unknown as T;
    return env as unknown as T;
  }
  return def;
}

/** Called by the extension so the MCP server process sees the same configuration. */
export function writeSettingsSnapshot(): void {
  const vs = getVscode();
  if (!vs) return;
  const cfg = vs.workspace.getConfiguration("codesentinel");
  const snap: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) {
    const v = cfg.get(k);
    if (v !== undefined) snap[k] = v;
  }
  try {
    fs.mkdirSync(path.dirname(snapshotPath()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(snapshotPath(), JSON.stringify(snap, null, 2), { mode: 0o600 });
  } catch {}
}

// ---------------------------------------------------------------- per-repo configuration
export interface RepoConfig {
  /** Branch naming template for tickets in this repo, e.g. feature/${ticketKey}-${slug} */
  branchTemplate?: string;
  /** Allowed base branches shown in the dropdown (first is default) */
  baseBranches?: string[];
  jiraProjectKey?: string;
  /** "auto" cuts from the default base without asking; "ask" lets the developer choose */
  branchMode?: "auto" | "ask";
  /** Runs once in each new ticket worktree before the agents start (e.g. `npm ci`). Auto-detected for Node repos. */
  setupCommand?: string;
  testCommand?: string;
  apiTestCommand?: string;
  playwrightCommand?: string;
  stageDeployMode?: "manual" | "auto" | "disabled";
  stageDeployCommand?: string;
  stageApiBaseUrl?: string;
  playwrightEnabled?: boolean;
  apiTestingEnabled?: boolean;
  enabled?: boolean;
}

/** Creates <repo>/.codesentinel with a catch-all .gitignore so state, worktrees and graphs never show up in git. */
export function ensureSentinelDir(repoPath: string): string {
  const dir = path.join(repoPath, ".codesentinel");
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n");
  return dir;
}

function repoCfgPath(repoPath: string): string {
  return path.join(repoPath, ".codesentinel", "repo-config.json");
}

export function getRepoConfig(repoPath: string): RepoConfig {
  try {
    return JSON.parse(fs.readFileSync(repoCfgPath(repoPath), "utf-8")) as RepoConfig;
  } catch {
    return {};
  }
}

export function setRepoConfig(repoPath: string, patch: Partial<RepoConfig>): RepoConfig {
  const next: RepoConfig = { ...getRepoConfig(repoPath), ...patch };
  for (const k of Object.keys(next) as (keyof RepoConfig)[]) if (next[k] === undefined) delete next[k];
  ensureSentinelDir(repoPath);
  fs.writeFileSync(repoCfgPath(repoPath), JSON.stringify(next, null, 2));
  return next;
}
