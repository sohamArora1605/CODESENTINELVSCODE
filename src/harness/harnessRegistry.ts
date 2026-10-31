import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { DependencyManager } from "../services/dependencyManager";

export type HarnessId =
  | "opencode"
  | "claude-code"
  | "cursor"
  | "vscode-copilot"
  | "gemini-antigravity"
  | "windsurf"
  | "roo-code"
  | "cline"
  | "kilo-code"
  | "kiro"
  | "continue"
  | "zed"
  | "codex";

export interface HarnessDescriptor {
  id: HarnessId;
  name: string;
  description: string;
  configLocationLabel: string;
}

export interface McpRuntimeCommand {
  command: string;
  args: string[];
  bridgeArgs: string[];
  env: Record<string, string>;
}

export interface HarnessSyncResult {
  harnessId: HarnessId;
  harnessName: string;
  configPath: string;
  skillsPath?: string;
  success: boolean;
  error?: string;
}

/**
 * Universal Multi-Harness Registry for CodeSentinel.
 *
 * Bridges CodeSentinel's MCP Server (`dist/mcp-server.js` + `dist/atlas-bridge.js`)
 * and Markdown Security Skills (`resources/skills/*`) into any AI coding harness:
 * - OpenCode (`opencode.json` + `~/.opencode/skills/`)
 * - Claude Code (`.mcp.json` + `.claude/skills/`)
 * - Cursor (`.cursor/mcp.json` + `.cursor/rules/`)
 * - VS Code / GitHub Copilot (`.vscode/mcp.json`)
 * - Gemini CLI / Antigravity (`.gemini/settings.json` + `.agent/skills/`)
 * - Windsurf (`~/.codeium/windsurf/mcp_config.json` + `.windsurf/rules/`)
 * - Roo Code (`.roo/mcp.json` + `.roo/rules/`)
 * - Cline (`cline_mcp_settings.json` + `.clinerules/`)
 * - Kilo Code (`.kilocode/mcp.json` + `.kilocode/rules/`)
 * - Amazon Kiro (`.kiro/settings/mcp.json`)
 * - Continue.dev (`.continue/mcpServers/codesentinel.json`)
 * - Zed Editor (`.zed/settings.json`)
 * - OpenAI Codex CLI (`~/.codex/config.toml`)
 */
export class HarnessRegistry {
  private static instance: HarnessRegistry;
  private cachedNodeRuntime: { command: string; needsElectronFlag: boolean } | null = null;

  private constructor() {}

  public static getInstance(): HarnessRegistry {
    if (!HarnessRegistry.instance) {
      HarnessRegistry.instance = new HarnessRegistry();
    }
    return HarnessRegistry.instance;
  }

  public getSupportedHarnesses(): HarnessDescriptor[] {
    return [
      {
        id: "opencode",
        name: "OpenCode",
        description: "OpenCode CLI & Embedded Web Agent",
        configLocationLabel: "opencode.json + ~/.opencode/skills",
      },
      {
        id: "claude-code",
        name: "Claude Code",
        description: "Anthropic Claude Code CLI & IDE Agent",
        configLocationLabel: ".mcp.json + .claude/skills",
      },
      {
        id: "cursor",
        name: "Cursor",
        description: "Cursor AI IDE",
        configLocationLabel: ".cursor/mcp.json + .cursor/rules",
      },
      {
        id: "vscode-copilot",
        name: "VS Code / GitHub Copilot",
        description: "VS Code Native MCP & GitHub Copilot Agent Mode",
        configLocationLabel: ".vscode/mcp.json",
      },
      {
        id: "gemini-antigravity",
        name: "Gemini CLI / Antigravity",
        description: "Google Gemini CLI & Antigravity Agentic IDE",
        configLocationLabel: ".gemini/settings.json + .agent/skills",
      },
      {
        id: "windsurf",
        name: "Windsurf (Codeium)",
        description: "Windsurf Cascade Agent",
        configLocationLabel: "~/.codeium/windsurf/mcp_config.json + .windsurf/rules",
      },
      {
        id: "roo-code",
        name: "Roo Code",
        description: "Roo Code Autonomous Coding Agent",
        configLocationLabel: ".roo/mcp.json + .roo/rules",
      },
      {
        id: "cline",
        name: "Cline",
        description: "Cline VS Code Autonomous Agent",
        configLocationLabel: ".clinerules",
      },
      {
        id: "kilo-code",
        name: "Kilo Code",
        description: "Kilo Code AI Agent",
        configLocationLabel: ".kilocode/mcp.json + .kilocode/rules",
      },
      {
        id: "kiro",
        name: "Kiro",
        description: "AWS Kiro Spec-Driven Agentic IDE",
        configLocationLabel: ".kiro/settings/mcp.json",
      },
      {
        id: "continue",
        name: "Continue.dev",
        description: "Continue Open-Source AI Code Assistant",
        configLocationLabel: ".continue/mcpServers/codesentinel.json",
      },
      {
        id: "zed",
        name: "Zed Editor",
        description: "Zed AI Context Server Integration",
        configLocationLabel: ".zed/settings.json",
      },
      {
        id: "codex",
        name: "OpenAI Codex CLI",
        description: "OpenAI Codex Terminal Agent",
        configLocationLabel: "~/.codex/config.toml",
      },
    ];
  }

  /**
   * Resolves a Node.js runtime capable of loading `node:sqlite` (Node 22.5+).
   * If system `node` is missing or older than Node 22.5, falls back to the current
   * Electron/Node executable (`process.execPath`) with `ELECTRON_RUN_AS_NODE=1`.
   * Note: For `opencode.json`, `"node"` is preserved when system `node` supports `node:sqlite`
   * so existing CLI configurations remain clean and portable.
   */
  public resolveNodeRuntime(preferSimpleNodeCommand = true): {
    command: string;
    needsElectronFlag: boolean;
  } {
    if (this.cachedNodeRuntime) {
      return this.cachedNodeRuntime;
    }

    try {
      const out = execSync('node -e "require(\'node:sqlite\'); console.log(\'OK\')"', {
        encoding: "utf-8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out === "OK") {
        this.cachedNodeRuntime = {
          command: preferSimpleNodeCommand ? "node" : "node",
          needsElectronFlag: false,
        };
        return this.cachedNodeRuntime;
      }
    } catch {}

    // Fallback: Use the host VS Code / Electron / Node binary directly with ELECTRON_RUN_AS_NODE=1
    const execPath = process.execPath.replace(/\\/g, "/");
    const isElectronHost =
      Boolean(process.versions && (process.versions as any).electron) ||
      /code|cursor|windsurf|antigravity|kiro|electron/i.test(path.basename(execPath));

    this.cachedNodeRuntime = {
      command: execPath,
      needsElectronFlag: isElectronHost,
    };
    return this.cachedNodeRuntime;
  }

  public buildMcpRuntimeCommand(
    workspaceRoot: string,
    mcpServerScriptPath: string,
    extensionPath?: string
  ): McpRuntimeCommand {
    const runtime = this.resolveNodeRuntime(true);
    const storagePath = DependencyManager.getInstance().getStoragePath();
    const extRoot = extensionPath || path.resolve(path.dirname(mcpServerScriptPath), "..");
    const normalizedMcpScript = mcpServerScriptPath.replace(/\\/g, "/");
    const bridgeScriptPath = path
      .join(path.dirname(mcpServerScriptPath), "atlas-bridge.js")
      .replace(/\\/g, "/");
    const normalizedWorkspace = workspaceRoot.replace(/\\/g, "/");

    const env: Record<string, string> = {
      CODESENTINEL_WORKSPACE: workspaceRoot,
      CODESENTINEL_STORAGE_PATH: storagePath,
      CODESENTINEL_EXTENSION_PATH: extRoot,
    };

    if (runtime.needsElectronFlag) {
      env.ELECTRON_RUN_AS_NODE = "1";
    }

    return {
      command: runtime.command,
      args: [normalizedMcpScript],
      bridgeArgs: [bridgeScriptPath, "local", normalizedWorkspace],
      env,
    };
  }

  /**
   * Detects which AI coding harnesses are actively used in the given workspace
   * or installed on the user's host machine.
   */
  public detectActiveHarnesses(workspaceRoot: string): HarnessId[] {
    const detected = new Set<HarnessId>(["opencode"]);
    const homedir = os.homedir();

    const checkWorkspaceAny = (...relPaths: string[]) =>
      relPaths.some((p) => fs.existsSync(path.join(workspaceRoot, p)));

    if (checkWorkspaceAny(".mcp.json", ".claude", "CLAUDE.md")) {
      detected.add("claude-code");
    }
    if (checkWorkspaceAny(".cursor", ".cursorrules")) {
      detected.add("cursor");
    }
    if (checkWorkspaceAny(".vscode/mcp.json", ".github/copilot-instructions.md")) {
      detected.add("vscode-copilot");
    }
    if (checkWorkspaceAny(".gemini", ".agent")) {
      detected.add("gemini-antigravity");
    }
    if (
      checkWorkspaceAny(".windsurf", ".windsurfrules") ||
      (homedir && fs.existsSync(path.join(homedir, ".codeium", "windsurf")))
    ) {
      detected.add("windsurf");
    }
    if (checkWorkspaceAny(".roo", ".roorules")) {
      detected.add("roo-code");
    }
    if (checkWorkspaceAny(".clinerules")) {
      detected.add("cline");
    }
    if (checkWorkspaceAny(".kilocode", "kilo.json", "kilo.jsonc")) {
      detected.add("kilo-code");
    }
    if (checkWorkspaceAny(".kiro")) {
      detected.add("kiro");
    }
    if (checkWorkspaceAny(".continue")) {
      detected.add("continue");
    }
    if (checkWorkspaceAny(".zed")) {
      detected.add("zed");
    }

    return Array.from(detected);
  }

  /**
   * Adds generated local harness configuration paths to `.git/info/exclude`
   * so `git status` remains clean without modifying the project's committed `.gitignore`.
   */
  public ensureGitInfoExclude(workspaceRoot: string, relativeEntries: string[]): void {
    const gitExcludePath = path.join(workspaceRoot, ".git", "info", "exclude");
    if (!fs.existsSync(path.dirname(gitExcludePath))) {
      return;
    }

    try {
      let existingContent = "";
      if (fs.existsSync(gitExcludePath)) {
        existingContent = fs.readFileSync(gitExcludePath, "utf-8");
      }
      const existingLines = new Set(
        existingContent
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
      );

      const toAppend: string[] = [];
      for (const entry of relativeEntries) {
        const clean = entry.replace(/\\/g, "/").trim();
        if (!clean || existingLines.has(clean)) continue;
        // Only add to .git/info/exclude if the file is not already tracked in git
        try {
          const tracked = execSync(`git ls-files "${clean}"`, {
            cwd: workspaceRoot,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          if (tracked) continue;
        } catch {}
        existingLines.add(clean);
        toAppend.push(clean);
      }

      if (toAppend.length > 0) {
        const prefix = existingContent.endsWith("\n") || !existingContent ? "" : "\n";
        const block = `${prefix}# CodeSentinel local harness & graph cache\n${toAppend.join("\n")}\n`;
        fs.writeFileSync(gitExcludePath, existingContent + block, "utf-8");
      }
    } catch {}
  }

  private resolveSourceSkillsDir(extensionPath?: string): string | null {
    const candidateDirs = [
      extensionPath ? path.join(extensionPath, "resources", "skills") : null,
      path.join(__dirname, "..", "resources", "skills"),
      path.join(__dirname, "..", "..", "resources", "skills"),
      path.join(__dirname, "resources", "skills"),
      path.resolve(process.cwd(), "resources", "skills"),
    ].filter((p): p is string => Boolean(p && fs.existsSync(p)));

    return candidateDirs.length > 0 ? candidateDirs[0] : null;
  }

  private copyDirRecursive(src: string, dest: string): void {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath);
      } else if (entry.isFile()) {
        let shouldCopy = true;
        if (fs.existsSync(destPath)) {
          try {
            if (fs.readFileSync(srcPath).equals(fs.readFileSync(destPath))) {
              shouldCopy = false;
            }
          } catch {}
        }
        if (shouldCopy) {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }
  }

  private readJsonSafe(filePath: string, fallback: Record<string, any> = {}): Record<string, any> {
    if (!fs.existsSync(filePath)) {
      return { ...fallback };
    }
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return { ...fallback };
    }
  }

  private writeJsonSafe(filePath: string, data: Record<string, any>): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }

  private writeStandardMcpServersConfig(
    configPath: string,
    runtimeCmd: McpRuntimeCommand,
    rootKey: "mcpServers" | "servers" = "mcpServers",
    extraServerProps: Record<string, any> = {}
  ): void {
    const config = this.readJsonSafe(configPath, {});
    if (!config[rootKey] || typeof config[rootKey] !== "object") {
      config[rootKey] = {};
    }

    config[rootKey]["codesentinel"] = {
      command: runtimeCmd.command,
      args: runtimeCmd.args,
      env: runtimeCmd.env,
      ...extraServerProps,
    };

    config[rootKey]["atlas"] = {
      command: runtimeCmd.command,
      args: runtimeCmd.bridgeArgs,
      env: runtimeCmd.env,
      ...extraServerProps,
    };

    this.writeJsonSafe(configPath, config);
  }

  /**
   * Syncs CodeSentinel MCP server and security skills to a specific AI coding harness.
   */
  public async syncHarness(
    harnessId: HarnessId,
    workspaceRoot: string,
    mcpServerScriptPath: string,
    options?: { extensionPath?: string; timeout?: number }
  ): Promise<HarnessSyncResult> {
    const extRoot = options?.extensionPath || path.resolve(path.dirname(mcpServerScriptPath), "..");
    const runtimeCmd = this.buildMcpRuntimeCommand(workspaceRoot, mcpServerScriptPath, extRoot);
    const sourceSkillsDir = this.resolveSourceSkillsDir(extRoot);
    const descriptor = this.getSupportedHarnesses().find((h) => h.id === harnessId);
    const harnessName = descriptor?.name || harnessId;

    try {
      switch (harnessId) {
        case "opencode": {
          const configPath = path.join(workspaceRoot, "opencode.json");
          const currentConfig = this.readJsonSafe(configPath, {
            $schema: "https://opencode.ai/config.json",
            mcp: {},
          });
          if (!currentConfig.mcp) currentConfig.mcp = {};
          const mcpTimeoutMs = options?.timeout ?? 600000;
          if ("timeout" in currentConfig.mcp) {
            delete currentConfig.mcp["timeout"];
          }
          currentConfig.mcp["codesentinel"] = {
            type: "local",
            command: [runtimeCmd.command, ...runtimeCmd.args],
            enabled: true,
            timeout: mcpTimeoutMs,
            environment: runtimeCmd.env,
          };
          currentConfig.mcp["atlas"] = {
            type: "local",
            command: [runtimeCmd.command, ...runtimeCmd.bridgeArgs],
            enabled: true,
            timeout: mcpTimeoutMs,
            environment: runtimeCmd.env,
          };
          this.writeJsonSafe(configPath, currentConfig);

          let skillsPath: string | undefined;
          if (sourceSkillsDir) {
            const wsSkills = path.join(workspaceRoot, ".codesentinel", "skills");
            this.copyDirRecursive(sourceSkillsDir, wsSkills);
            skillsPath = wsSkills;
            const homedir = os.homedir();
            if (homedir) {
              try {
                this.copyDirRecursive(sourceSkillsDir, path.join(homedir, ".opencode", "skills"));
              } catch {}
            }
          }
          this.ensureGitInfoExclude(workspaceRoot, [".codesentinel/", "opencode.json"]);
          return { harnessId, harnessName, configPath, skillsPath, success: true };
        }

        case "claude-code": {
          const configPath = path.join(workspaceRoot, ".mcp.json");
          this.writeStandardMcpServersConfig(configPath, runtimeCmd, "mcpServers");
          let skillsPath: string | undefined;
          if (sourceSkillsDir) {
            skillsPath = path.join(workspaceRoot, ".claude", "skills");
            this.copyDirRecursive(sourceSkillsDir, skillsPath);
          }
          this.ensureGitInfoExclude(workspaceRoot, [".mcp.json", ".claude/skills/"]);
          return { harnessId, harnessName, configPath, skillsPath, success: true };
        }

        case "cursor": {
          const configPath = path.join(workspaceRoot, ".cursor", "mcp.json");
          this.writeStandardMcpServersConfig(configPath, runtimeCmd, "mcpServers");
          let skillsPath: string | undefined;
          if (sourceSkillsDir) {
            skillsPath = path.join(workspaceRoot, ".cursor", "skills");
            this.copyDirRecursive(sourceSkillsDir, skillsPath);
          }
          this.ensureGitInfoExclude(workspaceRoot, [".cursor/mcp.json", ".cursor/skills/"]);
          return { harnessId, harnessName, configPath, skillsPath, success: true };
        }

        case "vscode-copilot": {
          const configPath = path.join(workspaceRoot, ".vscode", "mcp.json");
          this.writeStandardMcpServersConfig(configPath, runtimeCmd, "servers", { type: "stdio" });
          this.ensureGitInfoExclude(workspaceRoot, [".vscode/mcp.json"]);
          return { harnessId, harnessName, configPath, success: true };
        }

        case "gemini-antigravity": {
          const configPath = path.join(workspaceRoot, ".gemini", "settings.json");
          this.writeStandardMcpServersConfig(configPath, runtimeCmd, "mcpServers");
          let skillsPath: string | undefined;
          if (sourceSkillsDir) {
            skillsPath = path.join(workspaceRoot, ".agent", "skills");
            this.copyDirRecursive(sourceSkillsDir, skillsPath);
          }
          this.ensureGitInfoExclude(workspaceRoot, [".gemini/settings.json", ".agent/skills/"]);
          return { harnessId, harnessName, configPath, skillsPath, success: true };
        }

        case "windsurf": {
          const homedir = os.homedir();
          const configPath = homedir
            ? path.join(homedir, ".codeium", "windsurf", "mcp_config.json")
            : path.join(workspaceRoot, ".windsurf", "mcp_config.json");
          this.writeStandardMcpServersConfig(configPath, runtimeCmd, "mcpServers");
          let skillsPath: string | undefined;
          if (sourceSkillsDir) {
            skillsPath = path.join(workspaceRoot, ".windsurf", "skills");
            this.copyDirRecursive(sourceSkillsDir, skillsPath);
            this.ensureGitInfoExclude(workspaceRoot, [".windsurf/skills/"]);
          }
          return { harnessId, harnessName, configPath, skillsPath, success: true };
        }

        case "roo-code": {
          const configPath = path.join(workspaceRoot, ".roo", "mcp.json");
          this.writeStandardMcpServersConfig(configPath, runtimeCmd, "mcpServers", {
            alwaysAllow: [
              "codesentinel_workspace_status",
              "codesentinel_atlas_graph_status",
              "codesentinel_search_symbols",
              "codesentinel_call_hierarchy",
              "codesentinel_find_path",
              "codesentinel_analyze_impact",
              "codesentinel_file_dependencies",
              "codesentinel_code_snippet",
              "codesentinel_explain_flow",
              "codesentinel_run_vulnerability_scan",
              "codesentinel_verify_vulnerability_cegar",
              "codesentinel_cloud_security_audit",
            ],
          });
          let skillsPath: string | undefined;
          if (sourceSkillsDir) {
            skillsPath = path.join(workspaceRoot, ".roo", "skills");
            this.copyDirRecursive(sourceSkillsDir, skillsPath);
          }
          this.ensureGitInfoExclude(workspaceRoot, [".roo/mcp.json", ".roo/skills/"]);
          return { harnessId, harnessName, configPath, skillsPath, success: true };
        }

        case "cline": {
          let skillsPath: string | undefined;
          if (sourceSkillsDir) {
            skillsPath = path.join(workspaceRoot, ".clinerules", "skills");
            this.copyDirRecursive(sourceSkillsDir, skillsPath);
          }
          const configPath = path.join(workspaceRoot, ".clinerules", "mcp.json");
          this.writeStandardMcpServersConfig(configPath, runtimeCmd, "mcpServers");
          this.ensureGitInfoExclude(workspaceRoot, [".clinerules/"]);
          return { harnessId, harnessName, configPath, skillsPath, success: true };
        }

        case "kilo-code": {
          const configPath = path.join(workspaceRoot, ".kilocode", "mcp.json");
          this.writeStandardMcpServersConfig(configPath, runtimeCmd, "mcpServers");
          let skillsPath: string | undefined;
          if (sourceSkillsDir) {
            skillsPath = path.join(workspaceRoot, ".kilocode", "skills");
            this.copyDirRecursive(sourceSkillsDir, skillsPath);
          }
          this.ensureGitInfoExclude(workspaceRoot, [".kilocode/mcp.json", ".kilocode/skills/"]);
          return { harnessId, harnessName, configPath, skillsPath, success: true };
        }

        case "kiro": {
          const configPath = path.join(workspaceRoot, ".kiro", "settings", "mcp.json");
          this.writeStandardMcpServersConfig(configPath, runtimeCmd, "mcpServers", {
            disabled: false,
          });
          this.ensureGitInfoExclude(workspaceRoot, [".kiro/settings/mcp.json"]);
          return { harnessId, harnessName, configPath, success: true };
        }

        case "continue": {
          const configPath = path.join(workspaceRoot, ".continue", "mcpServers", "codesentinel.json");
          this.writeStandardMcpServersConfig(configPath, runtimeCmd, "mcpServers");
          this.ensureGitInfoExclude(workspaceRoot, [".continue/mcpServers/codesentinel.json"]);
          return { harnessId, harnessName, configPath, success: true };
        }

        case "zed": {
          const configPath = path.join(workspaceRoot, ".zed", "settings.json");
          const config = this.readJsonSafe(configPath, {});
          if (!config.context_servers || typeof config.context_servers !== "object") {
            config.context_servers = {};
          }
          config.context_servers["codesentinel"] = {
            command: runtimeCmd.command,
            args: runtimeCmd.args,
            env: runtimeCmd.env,
          };
          config.context_servers["atlas"] = {
            command: runtimeCmd.command,
            args: runtimeCmd.bridgeArgs,
            env: runtimeCmd.env,
          };
          this.writeJsonSafe(configPath, config);
          this.ensureGitInfoExclude(workspaceRoot, [".zed/settings.json"]);
          return { harnessId, harnessName, configPath, success: true };
        }

        case "codex": {
          const configPath = path.join(workspaceRoot, ".codex", "config.toml");
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          const escapeTomlStr = (s: string) => s.replace(/\\/g, "/").replace(/"/g, '\\"');
          const argsList = runtimeCmd.args.map((a) => `"${escapeTomlStr(a)}"`).join(", ");
          const envLines = Object.entries(runtimeCmd.env)
            .map(([k, v]) => `${k} = "${escapeTomlStr(v)}"`)
            .join("\n");
          const tomlBlock = `# CodeSentinel MCP Server Configuration
[mcp_servers.codesentinel]
command = "${escapeTomlStr(runtimeCmd.command)}"
args = [${argsList}]

[mcp_servers.codesentinel.env]
${envLines}
`;
          fs.writeFileSync(configPath, tomlBlock, "utf-8");
          this.ensureGitInfoExclude(workspaceRoot, [".codex/config.toml"]);
          return { harnessId, harnessName, configPath, success: true };
        }
      }
    } catch (err: any) {
      return {
        harnessId,
        harnessName,
        configPath: "",
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Automatically syncs CodeSentinel MCP & skills to all detected harnesses in the workspace.
   */
  public async syncDetectedHarnesses(
    workspaceRoot: string,
    mcpServerScriptPath: string,
    options?: { extensionPath?: string; timeout?: number }
  ): Promise<HarnessSyncResult[]> {
    const activeHarnesses = this.detectActiveHarnesses(workspaceRoot);
    const results: HarnessSyncResult[] = [];
    for (const hId of activeHarnesses) {
      results.push(await this.syncHarness(hId, workspaceRoot, mcpServerScriptPath, options));
    }
    return results;
  }

  /**
   * Syncs CodeSentinel MCP & skills to a user-selected list of harnesses.
   */
  public async syncHarnesses(
    harnessIds: HarnessId[],
    workspaceRoot: string,
    mcpServerScriptPath: string,
    options?: { extensionPath?: string; timeout?: number }
  ): Promise<HarnessSyncResult[]> {
    const results: HarnessSyncResult[] = [];
    for (const hId of harnessIds) {
      results.push(await this.syncHarness(hId, workspaceRoot, mcpServerScriptPath, options));
    }
    return results;
  }
}

