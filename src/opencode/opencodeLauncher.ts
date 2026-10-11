import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { exec, spawn, ChildProcess } from "child_process";
import * as net from "net";
import { promisify } from "util";
import { OpenCodeMcpConfig } from "../types";
import { DockerClient } from "../docker/dockerClient";

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
      return config.get<string>("opencodePath", "opencode").trim() || "opencode";
    } catch {
      return "opencode";
    }
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

  public async syncWorkspaceConfig(
    workspaceRoot: string,
    mcpServerScriptPath: string,
    options?: { useDocker?: boolean; imageName?: string }
  ): Promise<string> {
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

    // Normalize path with forward slashes for cross-platform Docker mount compatibility
    const normalizedMount = workspaceRoot.replace(/\\/g, "/");

    // Configure codesentinel local MCP server entry: containerized or host
    if (options?.useDocker) {
      const imageName = options.imageName || "codesentinel/core:latest";
      currentConfig.mcp["codesentinel"] = {
        type: "local",
        command: [
          "docker",
          "run",
          "-i",
          "--rm",
          "-v",
          `${normalizedMount}:/workspace:ro`,
          "-e",
          "CODESENTINEL_WORKSPACE=/workspace",
          imageName,
        ],
        enabled: true,
      };
    } else {
      currentConfig.mcp["codesentinel"] = {
        type: "local",
        command: ["node", mcpServerScriptPath],
        enabled: true,
        environment: {
          CODESENTINEL_WORKSPACE: workspaceRoot,
        },
      };
    }

    // Configure Atlas Semantic Code Graph MCP Server in Unified codesentinel/core container
    const coreImage = options?.imageName || "codesentinel/core:latest";
    currentConfig.mcp["atlas"] = {
      type: "local",
      command: [
        "docker",
        "run",
        "-i",
        "--rm",
        "--entrypoint",
        "atlas",
        "-v",
        `${normalizedMount}:/workspace`,
        "-w",
        "/workspace",
        coreImage,
        "mcp",
      ],
      enabled: true,
    };

    fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2), "utf-8");
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
      const excludeArgs = this.buildAtlasExcludeArgs(workspaceRoot);
      const atlasCmd = `docker run --rm --entrypoint atlas -v "${workspaceRoot}:/workspace" -w /workspace codesentinel/core:latest index ${excludeArgs}`;
      const { stdout, stderr } = await execAsync(atlasCmd, { timeout: 180000 });
      return { success: true, output: stdout || stderr };
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

    const terminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: workspaceRoot,
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
    const proc = spawn(opencodeCmd, ["serve", "--port", targetPort.toString(), "--hostname", targetHost], {
      cwd: workspaceRoot,
      shell: true,
      stdio: "pipe",
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

  /** Returns the default directory an OpenCode server on `port` is bound to, or null if none responds. */
  public async getServerDirectory(port: number): Promise<string | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600);
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
   * Finds an already-running OpenCode server that is bound to THIS workspace.
   * Servers started from other projects (other IDE windows / repos) are ignored,
   * otherwise their opencode.json MCP servers would leak into this workspace.
   */
  public async findRunningServerPort(workspaceRoot?: string): Promise<number | null> {
    const candidatePorts = [this.webPort, 5123, 4096, 8080];
    const uniquePorts = [...new Set(candidatePorts)];
    for (const port of uniquePorts) {
      const dir = await this.getServerDirectory(port);
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

  public async startWebProcess(
    workspaceRoot: string,
    port?: number
  ): Promise<{ url: string; port: number; pid?: number }> {
    if (
      this.isWebRunning() &&
      this.activeWorkspaceRoot &&
      this.normalizeDir(this.activeWorkspaceRoot) === this.normalizeDir(workspaceRoot) &&
      this.webServerUrl
    ) {
      const activeDir = await this.getServerDirectory(this.webPort);
      if (activeDir && this.normalizeDir(activeDir) === this.normalizeDir(workspaceRoot)) {
        return { url: this.webServerUrl, port: this.webPort, pid: this.webProcess?.pid };
      }
    }

    // If a different workspace was active, terminate it to ensure isolation
    if (this.isWebRunning()) {
      await this.stopWebProcess();
    }

    // Check if an existing OpenCode server on the host is already bound to this workspace
    const existingPort = await this.findRunningServerPort(workspaceRoot);
    if (existingPort) {
      this.webPort = existingPort;
      this.activeWorkspaceRoot = workspaceRoot;
      const projectUrl = await this.ensureWorkspaceSession(workspaceRoot, existingPort);
      this.webServerUrl = projectUrl;
      return { url: projectUrl, port: existingPort };
    }

    const config = vscode.workspace.getConfiguration("codesentinel");
    const preferredPort = port ?? config.get<number>("opencodeWebPort", 5123);
    const targetPort = await this.findFreePort(preferredPort);
    this.webPort = targetPort;
    this.activeWorkspaceRoot = workspaceRoot;

    const opencodeCmd = this.getOpencodeCommand();
    return new Promise((resolve, reject) => {
      let resolved = false;
      let pollInterval: NodeJS.Timeout | null = null;
      let failTimeout: NodeJS.Timeout | null = null;

      const finishStartup = async (pid?: number) => {
        if (resolved) return;
        resolved = true;
        if (pollInterval) clearInterval(pollInterval);
        if (failTimeout) clearTimeout(failTimeout);
        const sessionUrl = await this.ensureWorkspaceSession(workspaceRoot, targetPort);
        this.webServerUrl = sessionUrl;
        resolve({ url: sessionUrl, port: targetPort, pid });
      };

      const proc = spawn(
        opencodeCmd,
        ["serve", "--port", targetPort.toString(), "--hostname", "127.0.0.1"],
        {
          cwd: workspaceRoot,
          shell: true,
          stdio: "pipe",
          env: {
            ...process.env,
            BROWSER: "none",
          },
        }
      );

      this.webProcess = proc;

      // Fast polling on /path to resolve as soon as OpenCode is listening
      let attempts = 0;
      pollInterval = setInterval(async () => {
        attempts++;
        const dir = await this.getServerDirectory(targetPort);
        if (dir && !resolved) {
          finishStartup(proc.pid);
        } else if (attempts >= 40) {
          if (pollInterval) clearInterval(pollInterval);
        }
      }, 250);

      failTimeout = setTimeout(() => {
        if (!resolved) {
          finishStartup(proc.pid);
        }
      }, 12000);

      const handleOutput = (data: Buffer) => {
        const text = data.toString();
        const match = text.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?/);
        if (match && !resolved) {
          finishStartup(proc.pid);
        }
      };

      proc.stdout?.on("data", handleOutput);
      proc.stderr?.on("data", handleOutput);

      proc.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          if (pollInterval) clearInterval(pollInterval);
          if (failTimeout) clearTimeout(failTimeout);
          this.webProcess = null;
          this.webServerUrl = null;
          reject(new Error(`Failed to start OpenCode service: ${err.message}`));
        }
      });

      proc.on("exit", (code) => {
        this.webProcess = null;
        if (!resolved) {
          resolved = true;
          if (pollInterval) clearInterval(pollInterval);
          if (failTimeout) clearTimeout(failTimeout);
          this.webServerUrl = null;
          reject(new Error(`OpenCode service exited prematurely with code ${code}`));
        }
      });
    });
  }

  public encodeDirectory(dir: string): string {
    const normalized = dir.replace(/\\/g, "/");
    const buf = Buffer.from(normalized, "utf8");
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }

  public async ensureWorkspaceSession(workspaceRoot: string, port: number): Promise<string> {
    const baseUrl = `http://127.0.0.1:${port}/`;
    const encodedDir = this.encodeDirectory(workspaceRoot);
    return `${baseUrl}${encodedDir}/session`;
  }

  public async stopWebProcess(): Promise<boolean> {
    let stopped = false;
    if (this.dockerContainerName) {
      try {
        await execAsync(`docker rm -f ${this.dockerContainerName}`);
      } catch {}
      this.dockerContainerName = null;
      stopped = true;
    }
    if (this.webProcess && !this.webProcess.killed) {
      const pid = this.webProcess.pid;
      if (process.platform === "win32" && pid) {
        try {
          await execAsync(`taskkill /pid ${pid} /T /F`);
        } catch {
          this.webProcess.kill();
        }
      } else {
        this.webProcess.kill();
      }
      this.webProcess = null;
      stopped = true;
    }
    this.webServerUrl = null;
    this.activeWorkspaceRoot = null;
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
