import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { exec, spawn, ChildProcess } from "child_process";
import * as net from "net";
import * as os from "os";
import { promisify } from "util";
import { OpenCodeMcpConfig } from "../types";
import { DockerClient } from "../docker/dockerClient";
import { DependencyManager } from "../services/dependencyManager";
import { HarnessRegistry } from "../harness/harnessRegistry";

const execAsync = promisify(exec);

export class OpenCodeLauncher {
  private static instance: OpenCodeLauncher;
  private activeTerminal: vscode.Terminal | null = null;
  private serverProcess: ChildProcess | null = null;
  private serverPort: number = 4096;
  private webProcess: ChildProcess | null = null;
  private webPort: number = 5123;
  private webServerUrl: string | null = null;
  private dockerContainerName: string | null = null;
  private activeWorkspaceRoot: string | null = null;
  /** One OpenCode web server per workspace directory (key = normalized dir). proc is null when adopted from another window/orphan. */
  private webServers: Map<string, { port: number; proc: ChildProcess | null }> = new Map();
  /** Serializes server start-ups so concurrent callers (extension host + sidebar) cannot race each other. */
  private startLock: Promise<unknown> = Promise.resolve();
  private inflightStarts: Map<string, Promise<{ url: string; port: number; pid?: number }>> = new Map();

  private constructor() {}

  public static getInstance(): OpenCodeLauncher {
    if (!OpenCodeLauncher.instance) {
      OpenCodeLauncher.instance = new OpenCodeLauncher();
    }
    return OpenCodeLauncher.instance;
  }

  public getOpencodeCommand(): string {
    try {
      const config = vscode.workspace.getConfiguration("codesentinel");
      const custom = config.get<string>("opencodePath", "").trim();
      if (custom && custom !== "opencode" && fs.existsSync(custom)) {
        return custom;
      }
    } catch {}

    const binDir = DependencyManager.getInstance().getBinDir();
    const isWin = process.platform === "win32";
    const binExe = path.join(binDir, isWin ? "opencode.exe" : "opencode");
    if (fs.existsSync(binExe)) {
      return binExe;
    }

    const storagePath = DependencyManager.getInstance().getStoragePath();
    const nodeBin = path.join(
      storagePath,
      "node_modules",
      ".bin",
      isWin ? "opencode.cmd" : "opencode"
    );
    if (fs.existsSync(nodeBin)) {
      return nodeBin;
    }

    if (isWin && process.env.APPDATA) {
      const npmCmd = path.join(process.env.APPDATA, "npm", "opencode.cmd");
      if (fs.existsSync(npmCmd)) {
        return npmCmd;
      }
      const npmBinExe = path.join(
        process.env.APPDATA,
        "npm",
        "node_modules",
        "opencode-ai",
        "bin",
        "opencode.exe"
      );
      if (fs.existsSync(npmBinExe)) {
        return npmBinExe;
      }
    }

    return "opencode";
  }

  public async checkOpenCodeInstalled(customCommand?: string): Promise<{ installed: boolean; version?: string; error?: string }> {
    const cmd = customCommand || this.getOpencodeCommand();
    try {
      const { stdout } = await execAsync(`"${cmd}" --version`);
      return { installed: true, version: stdout.trim() };
    } catch (err: any) {
      return { installed: false, error: err.message || `OpenCode CLI '${cmd}' not found in PATH` };
    }
  }

  /**
   * Automatically provisions bundled CodeSentinel skills (such as cloud-security-audit)
   * into the workspace's `.opencode/skills/` directory and user's global `~/.opencode/skills/`.
   * This guarantees that OpenCode immediately recognizes and loads the skills
   * whenever a user installs or runs CodeSentinel.
   */
  public async provisionSkills(
    workspaceRoot: string,
    extensionPath?: string
  ): Promise<{ workspaceSkillPath: string; globalSkillPath?: string }> {
    const candidateDirs = [
      extensionPath ? path.join(extensionPath, "resources", "skills") : null,
      path.join(__dirname, "..", "resources", "skills"),
      path.join(__dirname, "resources", "skills"),
      path.resolve(process.cwd(), "resources", "skills"),
    ].filter((p): p is string => Boolean(p && fs.existsSync(p)));

    const homedir = os.homedir();
    const targetGlobalSkillsDir = homedir ? path.join(homedir, ".opencode", "skills") : null;
    const targetWorkspaceSkillsDir = path.join(workspaceRoot, ".codesentinel", "skills");

    if (candidateDirs.length === 0) {
      return { workspaceSkillPath: targetWorkspaceSkillsDir };
    }

    const sourceSkillsDir = candidateDirs[0];

    const copyDirRecursive = (src: string, dest: string) => {
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }
      const entries = fs.readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          copyDirRecursive(srcPath, destPath);
        } else if (entry.isFile()) {
          let shouldCopy = true;
          if (fs.existsSync(destPath)) {
            try {
              const srcBuf = fs.readFileSync(srcPath);
              const destBuf = fs.readFileSync(destPath);
              if (srcBuf.equals(destBuf)) {
                shouldCopy = false;
              }
            } catch {}
          }
          if (shouldCopy) {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      }
    };

    // 1. Primary: Copy to global user ~/.opencode/skills/ (zero workspace pollution, discovered by OpenCode globally)
    if (targetGlobalSkillsDir) {
      try {
        copyDirRecursive(sourceSkillsDir, targetGlobalSkillsDir);
      } catch (e: any) {
        console.warn(`CodeSentinel: Failed to copy skills to global ~/.opencode: ${e.message}`);
      }
    }

    // 2. Also keep a copy in workspace .codesentinel/skills/
    try {
      copyDirRecursive(sourceSkillsDir, targetWorkspaceSkillsDir);
    } catch (e: any) {
      console.warn(`CodeSentinel: Failed to copy skills to .codesentinel: ${e.message}`);
    }

    return {
      workspaceSkillPath: targetWorkspaceSkillsDir,
      globalSkillPath: targetGlobalSkillsDir || undefined,
    };
  }

  public async syncWorkspaceConfig(
    workspaceRoot: string,
    mcpServerScriptPath: string,
    options?: { useDocker?: boolean; imageName?: string; extensionPath?: string; timeout?: number }
  ): Promise<string> {
    // Auto-provision bundled skills into the workspace and user global config
    const extensionRoot = options?.extensionPath || path.resolve(path.dirname(mcpServerScriptPath), "..");
    await this.provisionSkills(workspaceRoot, extensionRoot).catch((err) => {
      console.warn("Auto-provisioning skills during sync skipped:", err?.message);
    });

    const configPath = path.join(workspaceRoot, "opencode.json");
    let currentConfig: Record<string, any> = {
      $schema: "https://opencode.ai/config.json",
      mcp: {},
    };

    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        currentConfig = JSON.parse(raw);
        if (!currentConfig.mcp) {
          currentConfig.mcp = {};
        }
      } catch (err: any) {
        console.warn(`Could not parse existing opencode.json, backing up: ${err.message}`);
      }
    }

    // Read configured MCP timeout (default: 600,000ms / 10 minutes)
    let mcpTimeoutMs = 600000;
    try {
      const config = vscode.workspace.getConfiguration("codesentinel");
      mcpTimeoutMs = options?.timeout ?? config.get<number>("mcpTimeout", 600000);
    } catch {}

    // Remove legacy top-level mcp.timeout object (unsupported in OpenCode v1.19+ schema;
    // timeout is configured per-server on mcp.codesentinel.timeout and mcp.atlas.timeout)
    if (currentConfig.mcp && "timeout" in currentConfig.mcp) {
      delete currentConfig.mcp["timeout"];
    }

    // Normalize path with forward slashes for cross-platform Docker mount compatibility
    const normalizedMount = workspaceRoot.replace(/\\/g, "/");

    // Configure codesentinel local MCP server entry: host Node runtime by default
    // or Docker container when useDocker is explicitly requested.
    const useDocker = options?.useDocker ?? false;
    const imageName = options?.imageName || "codesentinel/core:latest";

    if (useDocker) {
      currentConfig.mcp["codesentinel"] = {
        type: "local",
        command: [
          "docker",
          "run",
          "-i",
          "--rm",
          "-v",
          `${normalizedMount}:/workspace`,
          imageName,
          "node",
          "/app/dist/mcp-server.js",
        ],
        enabled: true,
        timeout: mcpTimeoutMs,
        environment: {
          CODESENTINEL_WORKSPACE: "/workspace",
        },
      };
    } else {
      const storagePath = DependencyManager.getInstance().getStoragePath();
      currentConfig.mcp["codesentinel"] = {
        type: "local",
        command: ["node", mcpServerScriptPath.replace(/\\/g, "/")],
        enabled: true,
        timeout: mcpTimeoutMs,
        environment: {
          CODESENTINEL_WORKSPACE: workspaceRoot,
          CODESENTINEL_STORAGE_PATH: storagePath,
          CODESENTINEL_EXTENSION_PATH: extensionRoot,
        },
      };
    }

    // Configure Atlas Semantic Code Graph MCP Server via host runtime bridge.
    // Zero Docker containers required: directly interacts with host .atlas/atlas.db.
    const runtimeCmd = HarnessRegistry.getInstance().buildMcpRuntimeCommand(
      workspaceRoot,
      mcpServerScriptPath,
      extensionRoot
    );
    if (!useDocker) {
      currentConfig.mcp["codesentinel"] = {
        type: "local",
        command: [runtimeCmd.command, ...runtimeCmd.args],
        enabled: true,
        timeout: mcpTimeoutMs,
        environment: runtimeCmd.env,
      };
    }

    const bridgeScriptPath = path.join(
      path.dirname(mcpServerScriptPath),
      "atlas-bridge.js"
    ).replace(/\\/g, "/");
    currentConfig.mcp["atlas"] = {
      type: "local",
      command: [
        runtimeCmd.command,
        bridgeScriptPath,
        "local",
        normalizedMount,
      ],
      enabled: true,
      timeout: mcpTimeoutMs,
      environment: runtimeCmd.env,
    };

    fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2), "utf-8");
    HarnessRegistry.getInstance().ensureGitInfoExclude(workspaceRoot, [".codesentinel/", "opencode.json"]);
    return configPath;
  }

  public getUniversalExcludes(): string[] {
    return [
      // Dependency caches & virtual environments (Node, Python, Go, Rust, Java, PHP, Ruby, .NET)
      "**/node_modules/**",
      "**/venv/**",
      "**/.venv/**",
      "**/env/**",
      "**/__pycache__/**",
      "**/vendor/**",
      "**/target/**",
      "**/.gradle/**",
      "**/build/**",
      "**/dist/**",
      "**/out/**",
      "**/bin/**",
      "**/obj/**",
      "**/Pods/**",
      "**/.cargo/**",
      "**/.atlas/**",
      "**/.codesentinel/**",

      // Version control & IDE meta
      "**/.git/**",
      "**/.svn/**",
      "**/.vscode/**",
      "**/.idea/**",

      // Non-code audio, video, & media files
      "**/*.mp3",
      "**/*.wav",
      "**/*.ogg",
      "**/*.flac",
      "**/*.aac",
      "**/*.mp4",
      "**/*.avi",
      "**/*.mov",
      "**/*.webm",
      "**/*.mkv",

      // Static image & font assets
      "**/*.png",
      "**/*.jpg",
      "**/*.jpeg",
      "**/*.gif",
      "**/*.svg",
      "**/*.ico",
      "**/*.webp",
      "**/*.tiff",
      "**/*.bmp",
      "**/*.ttf",
      "**/*.woff",
      "**/*.woff2",

      // Binaries, archives & compiled artifacts
      "**/*.zip",
      "**/*.tar",
      "**/*.gz",
      "**/*.7z",
      "**/*.rar",
      "**/*.wasm",
      "**/*.exe",
      "**/*.dll",
      "**/*.so",
      "**/*.dylib",
      "**/*.class",
      "**/*.jar",
      "**/*.pyc",
      "**/*.o",
      "**/*.a",

      // Documents, logs & lockfiles
      "**/*.pdf",
      "**/*.log",
      "**/*.lock",
      "**/package-lock.json",
      "**/yarn.lock",
      "**/pnpm-lock.yaml",
      "**/Cargo.lock",
      "**/go.sum",
      "**/composer.lock",
    ];
  }

  public getGitignoreExcludes(workspaceRoot: string): string[] {
    const gitignorePath = path.join(workspaceRoot, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      return [];
    }
    try {
      const content = fs.readFileSync(gitignorePath, "utf-8");
      return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"))
        .map((rule) => {
          let r = rule;
          if (r.endsWith("/")) {
            r = `**/${r}**`;
          } else if (!r.includes("/")) {
            r = `**/${r}/**`;
          }
          return r;
        });
    } catch {
      return [];
    }
  }

  public buildAtlasExcludeArgs(workspaceRoot: string): string {
    const allExcludes = [
      ...this.getUniversalExcludes(),
      ...this.getGitignoreExcludes(workspaceRoot),
    ];
    const unique = [...new Set(allExcludes)];
    return unique.map((pattern) => `--exclude "${pattern}"`).join(" ");
  }

  public async indexWithAtlas(workspaceRoot: string): Promise<{ success: boolean; output: string }> {
    try {
      const sentinelDir = path.join(workspaceRoot, ".codesentinel");
      if (!fs.existsSync(sentinelDir)) {
        try { fs.mkdirSync(sentinelDir, { recursive: true }); } catch {}
      }
      const sentinelGitignore = path.join(sentinelDir, ".gitignore");
      if (!fs.existsSync(sentinelGitignore)) {
        try { fs.writeFileSync(sentinelGitignore, "*\n", "utf-8"); } catch {}
      }
      HarnessRegistry.getInstance().ensureGitInfoExclude(workspaceRoot, [".codesentinel/"]);

      const sentinelDb = path.join(sentinelDir, "atlas.db");
      const legacyDb = path.join(workspaceRoot, ".atlas", "atlas.db");
      const dbToCheck = fs.existsSync(sentinelDb) ? sentinelDb : legacyDb;

      // Auto-heal: verify SQLite header and delete corrupt / non-database file if damaged
      if (fs.existsSync(dbToCheck)) {
        try {
          const stats = fs.statSync(dbToCheck);
          if (stats.size < 100) {
            fs.unlinkSync(dbToCheck);
          } else {
            const fd = fs.openSync(dbToCheck, "r");
            const buf = Buffer.alloc(16);
            fs.readSync(fd, buf, 0, 16, 0);
            fs.closeSync(fd);
            if (!buf.toString("utf8").startsWith("SQLite format 3")) {
              fs.unlinkSync(dbToCheck);
            }
          }
        } catch {
          try { fs.unlinkSync(dbToCheck); } catch {}
        }
      }

      const excludeArgs = this.buildAtlasExcludeArgs(workspaceRoot);

      // Wait for any in-flight initial dependency provisioning before resolving Atlas
      await DependencyManager.getInstance().waitForDependencies();

      // Prioritize host-native Atlas binary from self-contained extension storage
      let atlasCmd = await DependencyManager.getInstance().getAtlasCommand();
      if (!fs.existsSync(atlasCmd) && atlasCmd !== "atlas") {
        try {
          atlasCmd = await DependencyManager.getInstance().installAtlas(
            DependencyManager.getInstance().getStoragePath()
          );
        } catch {}
      }

      const env = DependencyManager.getInstance().getEnvWithBinPath();
      const { stdout: hostOut, stderr: hostErr } = await execAsync(`"${atlasCmd}" index ${excludeArgs}`, {
        cwd: workspaceRoot,
        timeout: 180000,
        env,
      });

      // Relocate .atlas/atlas.db into .codesentinel/atlas.db to prevent workspace pollution
      const generatedAtlasDb = path.join(workspaceRoot, ".atlas", "atlas.db");
      if (fs.existsSync(generatedAtlasDb)) {
        try {
          fs.copyFileSync(generatedAtlasDb, sentinelDb);
          fs.unlinkSync(generatedAtlasDb);
          const atlasDir = path.join(workspaceRoot, ".atlas");
          if (fs.existsSync(atlasDir)) {
            try { fs.rmdirSync(atlasDir); } catch {}
          }
        } catch (moveErr: any) {
          console.warn("Notice relocating atlas.db into .codesentinel:", moveErr?.message);
        }
      }

      return { success: true, output: hostOut || hostErr };
    } catch (err: any) {
      return { success: false, output: err.message };
    }
  }

  public async buildUnifiedImage(extensionPath: string): Promise<{ success: boolean; output: string }> {
    try {
      const buildCmd = `docker build -t codesentinel/core:latest "${extensionPath}"`;
      const { stdout, stderr } = await execAsync(buildCmd, { timeout: 300000 });
      return { success: true, output: stdout || stderr };
    } catch (err: any) {
      return { success: false, output: err.message };
    }
  }

  public launchTerminal(workspaceRoot: string, customPrompt?: string): vscode.Terminal {
    // Ensure bundled skills (e.g. cloud-security-audit) are provisioned before launch
    this.provisionSkills(workspaceRoot).catch(() => {});

    const repoName = path.basename(workspaceRoot);
    const terminalName = `OpenCode [${repoName}]`;

    // Dispose any stale OpenCode terminals from other directories to ensure isolation
    vscode.window.terminals
      .filter((t) => t.name.startsWith("OpenCode [") && t.name !== terminalName)
      .forEach((t) => t.dispose());

    // Check if an existing terminal exists with this name
    const existing = vscode.window.terminals.find((t) => t.name === terminalName);
    if (existing) {
      existing.show();
      if (customPrompt) {
        existing.sendText(customPrompt);
      }
      return existing;
    }

    const env = DependencyManager.getInstance().getEnvWithBinPath();
    const terminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: workspaceRoot,
      env: {
        PATH: env.PATH,
        Path: env.Path,
        CODESENTINEL_WORKSPACE: workspaceRoot,
      },
    });

    terminal.show();

    const opencodeCmd = this.getOpencodeCommand();
    const cmd = customPrompt
      ? `"${opencodeCmd}" run "${customPrompt.replace(/"/g, '\\"')}"`
      : `"${opencodeCmd}"`;
    terminal.sendText(cmd);

    this.activeTerminal = terminal;
    return terminal;
  }

  public async launchWeb(workspaceRoot: string): Promise<void> {
    if (this.webServerUrl && this.isWebRunning()) {
      vscode.env.openExternal(vscode.Uri.parse(this.webServerUrl));
      return;
    }
    const res = await this.startWebProcess(workspaceRoot);
    vscode.env.openExternal(vscode.Uri.parse(res.url));
  }

  public async startHeadlessServer(
    workspaceRoot: string,
    port?: number,
    hostname?: string
  ): Promise<{ port: number; pid?: number }> {
    if (this.serverProcess && !this.serverProcess.killed) {
      return { port: this.serverPort, pid: this.serverProcess.pid };
    }

    const config = vscode.workspace.getConfiguration("codesentinel");
    const targetPort = port ?? config.get<number>("opencodeServerPort", 4096);
    const targetHost = hostname ?? config.get<string>("opencodeServerHost", "127.0.0.1");

    this.serverPort = targetPort;
    const opencodeCmd = this.getOpencodeCommand();
    const safeCmd =
      opencodeCmd.includes(" ") && !opencodeCmd.startsWith('"')
        ? `"${opencodeCmd}"`
        : opencodeCmd;
    const env = DependencyManager.getInstance().getEnvWithBinPath({
      CODESENTINEL_WORKSPACE: workspaceRoot,
    });
    const proc = spawn(safeCmd, ["serve", "--port", targetPort.toString(), "--hostname", targetHost], {
      cwd: workspaceRoot,
      shell: true,
      stdio: "pipe",
      env,
    });

    this.serverProcess = proc;

    proc.on("error", (err) => {
      console.error("OpenCode server failed to start:", err);
      this.serverProcess = null;
    });

    proc.on("exit", (code) => {
      console.log(`OpenCode server exited with code ${code}`);
      this.serverProcess = null;
    });

    return { port: targetPort, pid: proc.pid };
  }

  private normalizeDir(dir: string): string {
    return path.normalize(dir).replace(/[\\/]+$/, "").toLowerCase();
  }

  /**
   * Cleans up stale OpenCode state lockfiles (`~/.local/state/opencode/locks/*.lock`)
   * whose owning PID is no longer alive, preventing OpenCode v1.19+ from throwing
   * `ReleaseError: token mismatch` / `metadata missing` and returning HTTP 499 on `/command`.
   */
  public cleanupStaleOpenCodeLocks(): void {
    try {
      const homedir = os.homedir();
      if (!homedir) return;
      const locksDir = path.join(homedir, ".local", "state", "opencode", "locks");
      if (!fs.existsSync(locksDir)) return;

      const entries = fs.readdirSync(locksDir, { withFileTypes: true });
      for (const entry of entries) {
        const lockPath = path.join(locksDir, entry.name);
        if (!entry.isDirectory()) continue;
        const metaPath = path.join(lockPath, "meta.json");
        let shouldRemove = false;
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
            const pid = Number(meta?.pid);
            if (pid > 0) {
              try {
                process.kill(pid, 0);
              } catch (e: any) {
                if (e?.code === "ESRCH") {
                  shouldRemove = true;
                }
              }
            } else {
              shouldRemove = true;
            }
          } catch {
            shouldRemove = true;
          }
        } else {
          shouldRemove = true;
        }
        if (shouldRemove) {
          try {
            fs.rmSync(lockPath, { recursive: true, force: true });
          } catch {}
        }
      }
    } catch {}
  }

  /** Returns the default directory an OpenCode server on `port` is bound to, or null if none responds. */
  public async getServerDirectory(port: number): Promise<string | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1200);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/path`, { signal: controller.signal });
      if (!res.ok) return null;
      const info: any = await res.json();
      return typeof info?.directory === "string" ? info.directory : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Verifies that the OpenCode server's workspace instance (`/command` and `/config/providers`)
   * is fully warmed up and responding with HTTP 200 (not 499 while bootstrapping MCP / skills / models).
   */
  public async isServerWorkspaceReady(port: number, workspaceRoot: string): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const canonicalRoot = this.canonicalizeWorkspacePath(workspaceRoot);
      const encodedDir = encodeURIComponent(canonicalRoot);
      const [cmdRes, provRes] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/command?directory=${encodedDir}`, {
          signal: controller.signal,
        }),
        fetch(`http://127.0.0.1:${port}/config/providers?directory=${encodedDir}`, {
          signal: controller.signal,
        }),
      ]);
      return cmdRes.ok && provRes.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Finds an already-running OpenCode server that is bound to THIS workspace.
   * Servers started from other projects (other IDE windows / repos) are ignored,
   * otherwise their opencode.json MCP servers would leak into this workspace.
   */
  public async findRunningServerPort(workspaceRoot?: string): Promise<number | null> {
    let basePort = 5123;
    try {
      basePort = vscode.workspace.getConfiguration("codesentinel").get<number>("opencodeWebPort", 5123);
    } catch {}

    // Servers are spawned on the first free port at/after basePort, so they can live anywhere in this
    // window. Scan the whole range (in parallel) instead of a handful of fixed ports, otherwise
    // orphaned servers are never found again and a fresh duplicate is spawned on every reload.
    const candidatePorts: number[] = [this.webPort, 4096, 8080];
    for (let p = basePort; p < basePort + 60; p++) candidatePorts.push(p);
    const uniquePorts = [...new Set(candidatePorts)];

    const results = await Promise.all(
      uniquePorts.map(async (port) => ({ port, dir: await this.getServerDirectory(port) }))
    );
    for (const { port, dir } of results) {
      if (!dir) continue;
      if (!workspaceRoot || this.normalizeDir(dir) === this.normalizeDir(workspaceRoot)) {
        return port;
      }
    }
    return null;
  }

  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
  }

  public async findFreePort(preferred: number, attempts: number = 50): Promise<number> {
    for (let p = preferred; p < preferred + attempts; p++) {
      if (await this.isPortFree(p)) return p;
    }
    return preferred;
  }

  /**
   * Starts (or reuses) the OpenCode web server bound to `workspaceRoot` and returns the URL of a
   * session that is guaranteed to belong to that exact directory.
   * Calls are serialized and de-duplicated per directory.
   */
  public startWebProcess(
    workspaceRoot: string,
    port?: number
  ): Promise<{ url: string; port: number; pid?: number }> {
    const key = this.normalizeDir(workspaceRoot);
    const inflight = this.inflightStarts.get(key);
    if (inflight) {
      return inflight;
    }

    const run = this.startLock
      .catch(() => {})
      .then(() => this.startWebProcessInternal(workspaceRoot, port));
    this.startLock = run.catch(() => {});

    const tracked: Promise<{ url: string; port: number; pid?: number }> = run.finally(() => {
      if (this.inflightStarts.get(key) === tracked) {
        this.inflightStarts.delete(key);
      }
    });
    this.inflightStarts.set(key, tracked);
    return tracked;
  }

  /** Marks `workspaceRoot` as the active workspace and resolves the session URL for it. */
  private async activateWebServer(
    workspaceRoot: string,
    port: number,
    proc: ChildProcess | null
  ): Promise<{ url: string; port: number; pid?: number }> {
    this.webPort = port;
    this.activeWorkspaceRoot = workspaceRoot;
    this.webProcess = proc;
    for (let w = 0; w < 6; w++) {
      if (await this.isServerWorkspaceReady(port, workspaceRoot)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    const sessionUrl = await this.ensureWorkspaceSession(workspaceRoot, port);
    this.webServerUrl = sessionUrl;
    return { url: sessionUrl, port, pid: proc?.pid };
  }

  private async startWebProcessInternal(
    workspaceRoot: string,
    port?: number
  ): Promise<{ url: string; port: number; pid?: number }> {
    const key = this.normalizeDir(workspaceRoot);

    // 1. Reuse a server this window already started for this exact directory (no kill / respawn when
    //    the user just switches between projects).
    const known = this.webServers.get(key);
    if (known) {
      const dir = await this.getServerDirectory(known.port);
      if (dir && this.normalizeDir(dir) === key) {
        return this.activateWebServer(workspaceRoot, known.port, known.proc);
      }
      this.webServers.delete(key);
    }

    // 2. Adopt an already-running server bound to this directory (other window / orphan from reload).
    const existingPort = await this.findRunningServerPort(workspaceRoot);
    if (existingPort) {
      this.webServers.set(key, { port: existingPort, proc: null });
      return this.activateWebServer(workspaceRoot, existingPort, null);
    }

    // 3. Spawn a brand new server whose working directory is this workspace.
    // Wait for any active first-time dependency downloads before attempting to spawn OpenCode
    await DependencyManager.getInstance().waitForDependencies();

    // Clean up any orphaned OpenCode state locks, pre-populate free models if empty, and provision skills
    this.cleanupStaleOpenCodeLocks();
    this.ensureFreeModelsState();
    await this.provisionSkills(workspaceRoot).catch(() => {});

    const config = vscode.workspace.getConfiguration("codesentinel");
    const preferredPort = port ?? config.get<number>("opencodeWebPort", 5123);
    const targetPort = await this.findFreePort(preferredPort);

    // Ensure opencode binary exists in self-contained storage (or PATH) before spawning
    let opencodeCmd = await DependencyManager.getInstance().getOpencodeCommand();
    if (!opencodeCmd || (opencodeCmd !== "opencode" && !fs.existsSync(opencodeCmd))) {
      try {
        opencodeCmd = await DependencyManager.getInstance().installOpenCode(
          DependencyManager.getInstance().getStoragePath()
        );
      } catch (installErr: any) {
        console.warn("Auto-install OpenCode during startWebProcess notice:", installErr?.message);
      }
    }
    if (!opencodeCmd || (opencodeCmd !== "opencode" && !fs.existsSync(opencodeCmd))) {
      opencodeCmd = this.getOpencodeCommand();
    }

    // If opencodeCmd is still bare "opencode", verify it is actually installed on PATH; if not, force install into storage
    if (opencodeCmd === "opencode") {
      const check = await this.checkOpenCodeInstalled("opencode");
      if (!check.installed) {
        opencodeCmd = await DependencyManager.getInstance().installOpenCode(
          DependencyManager.getInstance().getStoragePath()
        );
      }
    }

    if (opencodeCmd !== "opencode" && !fs.existsSync(opencodeCmd)) {
      throw new Error(
        `OpenCode binary is still being installed or could not be found at ${opencodeCmd}. Please wait for dependency setup to finish.`
      );
    }

    const isDirectBinary =
      opencodeCmd !== "opencode" &&
      fs.existsSync(opencodeCmd) &&
      !opencodeCmd.toLowerCase().endsWith(".cmd") &&
      !opencodeCmd.toLowerCase().endsWith(".bat");

    const spawnCmd = isDirectBinary
      ? opencodeCmd
      : opencodeCmd.includes(" ") && !opencodeCmd.startsWith('"')
      ? `"${opencodeCmd}"`
      : opencodeCmd;

    return new Promise((resolve, reject) => {
      let resolved = false;
      let pollInFlight = false;
      let pollInterval: NodeJS.Timeout | null = null;
      let failTimeout: NodeJS.Timeout | null = null;
      let stderrLog = "";

      const finishStartup = async (pid?: number) => {
        if (resolved) return;
        resolved = true;
        if (pollInterval) clearInterval(pollInterval);
        if (failTimeout) clearTimeout(failTimeout);
        this.webPort = targetPort;
        this.activeWorkspaceRoot = workspaceRoot;
        this.webProcess = proc;
        this.webServers.set(key, { port: targetPort, proc });
        // Warm up /command and session before resolving so the webview iframe never hits HTTP 499
        for (let w = 0; w < 8; w++) {
          if (await this.isServerWorkspaceReady(targetPort, workspaceRoot)) {
            break;
          }
          await new Promise((r) => setTimeout(r, 350));
        }
        const sessionUrl = await this.ensureWorkspaceSession(workspaceRoot, targetPort);
        this.webServerUrl = sessionUrl;
        resolve({ url: sessionUrl, port: targetPort, pid });
      };

      const proc = spawn(
        spawnCmd,
        ["serve", "--port", targetPort.toString(), "--hostname", "127.0.0.1"],
        {
          cwd: this.canonicalizeWorkspacePath(workspaceRoot),
          shell: !isDirectBinary,
          windowsHide: true,
          stdio: "pipe",
          env: DependencyManager.getInstance().getEnvWithBinPath({
            BROWSER: "none",
            CODESENTINEL_WORKSPACE: this.canonicalizeWorkspacePath(workspaceRoot),
          }),
        }
      );

      this.webProcess = proc;

      // Fast polling on /path + /command readiness to resolve as soon as OpenCode is listening
      let attempts = 0;
      pollInterval = setInterval(async () => {
        if (pollInFlight || resolved) return;
        pollInFlight = true;
        try {
          attempts++;
          const dir = await this.getServerDirectory(targetPort);
          if (dir && !resolved) {
            finishStartup(proc.pid);
          } else if (attempts >= 60) {
            if (pollInterval) clearInterval(pollInterval);
          }
        } finally {
          pollInFlight = false;
        }
      }, 300);

      failTimeout = setTimeout(() => {
        if (!resolved) {
          finishStartup(proc.pid);
        }
      }, 18000);

      const handleOutput = (data: Buffer) => {
        const text = data.toString();
        if (stderrLog.length < 1500) {
          stderrLog += text;
        }
        const match = text.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?/);
        if (match && !resolved) {
          finishStartup(proc.pid);
        }
      };

      proc.stdout?.on("data", handleOutput);
      proc.stderr?.on("data", handleOutput);

      proc.on("error", (err) => {
        this.webServers.delete(key);
        if (this.webProcess === proc) {
          this.webProcess = null;
        }
        if (!resolved) {
          resolved = true;
          if (pollInterval) clearInterval(pollInterval);
          if (failTimeout) clearTimeout(failTimeout);
          this.webServerUrl = null;
          reject(new Error(`Failed to start OpenCode service: ${err.message}`));
        }
      });

      proc.on("exit", (code) => {
        this.webServers.delete(key);
        if (this.webProcess === proc) {
          this.webProcess = null;
        }
        if (!resolved) {
          resolved = true;
          if (pollInterval) clearInterval(pollInterval);
          if (failTimeout) clearTimeout(failTimeout);
          this.webServerUrl = null;
          const detail = stderrLog.trim() ? ` (${stderrLog.trim().slice(0, 240)})` : "";
          reject(new Error(`OpenCode service exited prematurely with code ${code}${detail}`));
        }
      });
    });
  }

  public encodeDirectory(dir: string): string {
    let normalized = dir.replace(/\\/g, "/");
    if (process.platform === "win32" && /^[a-z]:\//.test(normalized)) {
      normalized = normalized[0].toUpperCase() + normalized.slice(1);
    }
    const buf = Buffer.from(normalized, "utf8");
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }

  private canonicalizeWorkspacePath(workspaceRoot: string): string {
    if (process.platform === "win32" && /^[a-z]:[\\/]/.test(workspaceRoot)) {
      return workspaceRoot[0].toUpperCase() + workspaceRoot.slice(1);
    }
    return workspaceRoot;
  }

  /**
   * Ensures `~/.local/state/opencode/model.json` has OpenCode's built-in free models
   * pre-populated when `recent` / `favorite` are empty so a brand-new installation
   * immediately displays all free models in the OpenCode selector without requiring
   * manual hunting.
   */
  public ensureFreeModelsState(): void {
    try {
      const homedir = os.homedir();
      if (!homedir) return;
      const stateDir = path.join(homedir, ".local", "state", "opencode");
      const modelJsonPath = path.join(stateDir, "model.json");

      const defaultFreeModels = [
        { providerID: "opencode", modelID: "big-pickle" },
        { providerID: "opencode", modelID: "glm-5.3-flash-free" },
        { providerID: "opencode", modelID: "deepseek-v4.1-flash-free" },
        { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
        { providerID: "opencode", modelID: "nemotron-3.5-super-vl-free" },
        { providerID: "opencode", modelID: "nemotron-3.5-lightning-free" },
        { providerID: "opencode", modelID: "flint-40b-free" },
        { providerID: "opencode", modelID: "beam-free" },
      ];

      let state: any = {
        recent: defaultFreeModels,
        favorite: defaultFreeModels,
        variant: {},
      };

      if (fs.existsSync(modelJsonPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(modelJsonPath, "utf-8"));
          const hasRecents = Array.isArray(parsed?.recent) && parsed.recent.length > 0;
          const hasFavorites = Array.isArray(parsed?.favorite) && parsed.favorite.length > 0;
          if (hasRecents || hasFavorites) {
            return; // User already has active model selections; preserve them
          }
          state = {
            ...parsed,
            recent: defaultFreeModels,
            favorite: defaultFreeModels,
            variant: parsed?.variant && typeof parsed.variant === "object" ? parsed.variant : {},
          };
        } catch {}
      }

      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(modelJsonPath, JSON.stringify(state, null, 2), "utf-8");
    } catch {}
  }

  public async ensureWorkspaceSession(workspaceRoot: string, port: number): Promise<string> {
    const baseUrl = `http://127.0.0.1:${port}/`;
    const canonicalRoot = this.canonicalizeWorkspacePath(workspaceRoot);
    const encodedDir = this.encodeDirectory(canonicalRoot);
    const fallbackUrl = `${baseUrl}${encodedDir}/session`;

    try {
      const encodedHeader = encodeURIComponent(canonicalRoot);
      const headers: Record<string, string> = {
        "x-opencode-directory": encodedHeader,
        "Accept": "application/json",
      };

      // 1. Check if a session already exists for this exact directory
      const listRes = await fetch(`${baseUrl}session?directory=${encodedHeader}&roots=true&limit=1`, {
        headers,
      });

      if (listRes.ok) {
        const sessions: any = await listRes.json();
        if (Array.isArray(sessions) && sessions.length > 0 && sessions[0]?.id) {
          return `${baseUrl}${encodedDir}/session/${sessions[0].id}`;
        }
      }

      // 2. If no session exists, create a new session explicitly scoped to this directory
      const createRes = await fetch(`${baseUrl}session`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      if (createRes.ok) {
        const created: any = await createRes.json();
        if (created?.id) {
          return `${baseUrl}${encodedDir}/session/${created.id}`;
        }
      }
    } catch (e: any) {
      console.warn("Could not bind OpenCode session via REST API:", e?.message);
    }

    return fallbackUrl;
  }

  public async stopWebProcess(): Promise<boolean> {
    let stopped = false;

    const procsToStop = new Set<ChildProcess>();
    for (const [, server] of this.webServers.entries()) {
      if (server?.proc) {
        procsToStop.add(server.proc);
      }
    }
    if (this.webProcess) {
      procsToStop.add(this.webProcess);
    }

    this.webServers.clear();
    this.webProcess = null;
    this.webServerUrl = null;
    this.activeWorkspaceRoot = null;

    for (const proc of procsToStop) {
      if (!proc || proc.killed) continue;
      const pid = proc.pid;
      if (process.platform === "win32" && pid) {
        try {
          await execAsync(`taskkill /pid ${pid} /T /F`);
        } catch {
          try {
            proc?.kill();
          } catch {}
        }
      } else {
        try {
          proc?.kill();
        } catch {}
      }
      stopped = true;
    }

    return stopped;
  }

  public isWebRunning(): boolean {
    return (
      (this.webProcess !== null && !this.webProcess.killed) ||
      this.webServerUrl !== null
    );
  }

  public getWebServerUrl(): string | null {
    return this.webServerUrl;
  }

  public getActiveWorkspaceRoot(): string | null {
    return this.activeWorkspaceRoot;
  }

  public stopHeadlessServer(): boolean {
    if (this.serverProcess && !this.serverProcess.killed) {
      this.serverProcess.kill();
      this.serverProcess = null;
      return true;
    }
    return false;
  }

  public isServerRunning(): boolean {
    return this.serverProcess !== null && !this.serverProcess.killed;
  }
}
