import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import { shQuote } from "../util/proc";
import { AgentHarnessType } from "./agentRunner";
import { getSetting } from "../config/settings";

export { AgentHarnessType };

function getVscode(): any {
  return require("vscode");
}

/**
 * Builds the shell line that starts an interactive agent with the prompt read from a file.
 * The prompt (which contains Jira text) is never interpolated into the command line, so
 * `$(...)`, backticks and quotes in a ticket cannot execute.
 */
export function buildInteractiveCommand(
  harness: AgentHarnessType,
  promptFile: string | null,
  platform: NodeJS.Platform = process.platform
): string {
  const win = platform === "win32";
  const arg = promptFile ? (win ? ` (Get-Content -Raw -LiteralPath '${promptFile.replace(/'/g, "''")}')` : ` "$(cat ${shQuote(promptFile)})"`) : "";
  switch (harness) {
    case "claude-code": return `claude${arg}`;
    case "gemini-antigravity":
      return promptFile
        ? (win ? `agy -i (Get-Content -Raw -LiteralPath '${promptFile.replace(/'/g, "''")}')` : `agy -i "$(cat ${shQuote(promptFile)})"`)
        : "agy";
    case "cursor": return `cursor-agent${arg}`;
    case "opencode":
    default: return promptFile ? `opencode --prompt${arg}` : "opencode";
  }
}

export function writePromptFile(prompt: string): string {
  const dir = path.join(os.tmpdir(), "codesentinel-prompts");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.md`);
  fs.writeFileSync(f, prompt, { mode: 0o600 });
  return f;
}

export function buildTicketPrompt(t: { key: string; summary: string; branch: string; description?: string; plan?: string }): string {
  return [
    `You are working on Jira ticket ${t.key} on branch ${t.branch}.`,
    `Summary: ${t.summary}`,
    t.description ? `\nDescription:\n${t.description}` : "",
    t.plan ? `\nApproved plan:\n${t.plan}` : "",
    "\nUse the CodeSentinel MCP tools (codesentinel_search_symbols, codesentinel_call_hierarchy, codesentinel_scan_git_diff) to explore the code graph and check your changes for security issues.",
    "Do not push, switch branches or merge; CodeSentinel handles that.",
  ].filter(Boolean).join("\n");
}

export class AgentTerminalLauncher {
  private static instance: AgentTerminalLauncher;
  private constructor() {}

  public static getInstance(): AgentTerminalLauncher {
    if (!AgentTerminalLauncher.instance) AgentTerminalLauncher.instance = new AgentTerminalLauncher();
    return AgentTerminalLauncher.instance;
  }

  public getDefaultHarness(): AgentHarnessType {
    return getSetting<AgentHarnessType>("defaultAgentHarness", "claude-code");
  }

  private label(h: AgentHarnessType): string {
    return { "claude-code": "Claude Code", "gemini-antigravity": "Antigravity", opencode: "OpenCode", cursor: "Cursor Agent" }[h];
  }

  public launchAgentTerminal(
    workspaceRoot: string,
    harness: AgentHarnessType = this.getDefaultHarness(),
    customPrompt?: string,
    ticket?: { key: string; summary: string; branch: string; description?: string; plan?: string }
  ): any {
    const vscode = getVscode();
    const repoName = path.basename(workspaceRoot);
    const prompt = customPrompt || (ticket ? buildTicketPrompt(ticket) : "");
    const cmd = buildInteractiveCommand(harness, prompt ? writePromptFile(prompt) : null);
    // One terminal per (harness, repo, ticket) so tickets can run side by side.
    const name = `${this.label(harness)} [${repoName}${ticket ? ` · ${ticket.key}` : ""}]`;

    const existing = vscode.window.terminals.find((t: any) => t.name === name);
    if (existing) {
      existing.show();
      existing.sendText(cmd);
      return existing;
    }
    const env: Record<string, string> = {
      CODESENTINEL_WORKSPACE: workspaceRoot,
      CODESENTINEL_TICKET: ticket?.key || "",
      CODESENTINEL_BRANCH: ticket?.branch || "",
    };
    try {
      const { DependencyManager } = require("../services/dependencyManager");
      const e = DependencyManager.getInstance().getEnvWithBinPath();
      if (e.PATH) env.PATH = e.PATH;
    } catch {}
    const extraDirs = [
      path.join(os.homedir(), ".local", "bin"),
      path.join(os.homedir(), ".codesentinel", "bin"),
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
    ];
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const currentPath = env[pathKey] || process.env[pathKey] || process.env.PATH || "";
    env[pathKey] = extraDirs.filter((p) => fs.existsSync(p)).concat(currentPath ? [currentPath] : []).join(path.delimiter);
    env.PATH = env[pathKey];
    const terminal = vscode.window.createTerminal({ name, cwd: workspaceRoot, env });
    terminal.show();
    terminal.sendText(cmd);
    return terminal;
  }
}
