import type * as vscodeTypes from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import * as https from "https";

const execAsync = promisify(exec);

function getVscode(): typeof vscodeTypes | null {
  try {
    return require("vscode");
  } catch {
    return null;
  }
}

export interface DependencyStatus {
  opencodeInstalled: boolean;
  opencodeVersion?: string;
  atlasInstalled: boolean;
  atlasVersion?: string;
  atlasPath?: string;
}

export interface ProvisionProgress {
  stage: string;
  percent: number;
  detail: string;
  completed?: boolean;
  error?: boolean;
}

export class DependencyManager {
  private static instance: DependencyManager;
  private cachedAtlasPath: string | null = null;
  private cachedOpencodePath: string | null = null;
  private globalStoragePath: string | null = null;
  private progressListeners: ((p: ProvisionProgress) => void)[] = [];
  private lastReportedProgress: ProvisionProgress | null = null;
  private inflightOpencodeInstall: Promise<string> | null = null;
  private inflightAtlasInstall: Promise<string> | null = null;
  private inflightEnsureDeps: Promise<void> | null = null;

  private constructor() {}

  public static getInstance(): DependencyManager {
    if (!DependencyManager.instance) {
      DependencyManager.instance = new DependencyManager();
    }
    return DependencyManager.instance;
  }

  public isProvisioning(): boolean {
    if (this.inflightEnsureDeps || this.inflightOpencodeInstall || this.inflightAtlasInstall) {
      return true;
    }
    if (this.lastReportedProgress && !this.lastReportedProgress.completed && !this.lastReportedProgress.error) {
      return true;
    }
    return false;
  }

  public getLastProgress(): ProvisionProgress | null {
    return this.lastReportedProgress;
  }

  public async waitForDependencies(): Promise<void> {
    if (this.inflightEnsureDeps) {
      try {
        await this.inflightEnsureDeps;
      } catch {}
    }
    if (this.inflightOpencodeInstall) {
      try {
        await this.inflightOpencodeInstall;
      } catch {}
    }
    if (this.inflightAtlasInstall) {
      try {
        await this.inflightAtlasInstall;
      } catch {}
    }
  }

  public onProgress(listener: (p: ProvisionProgress) => void): () => void {
    this.progressListeners.push(listener);
    if (this.lastReportedProgress) {
      try { listener(this.lastReportedProgress); } catch {}
    }
    return () => {
      this.progressListeners = this.progressListeners.filter((l) => l !== listener);
    };
  }

  public reportProgress(p: ProvisionProgress): void {
    this.lastReportedProgress = p;
    for (const l of this.progressListeners) {
      try { l(p); } catch {}
    }
  }

  public setStoragePath(p: string): void {
    this.globalStoragePath = p;
    try {
      fs.mkdirSync(this.getBinDir(), { recursive: true });
    } catch {}
  }

  public getStoragePath(): string {
    if (!this.globalStoragePath) {
      this.globalStoragePath =
        process.env.CODESENTINEL_STORAGE_PATH || path.join(os.homedir(), ".codesentinel");
    }
    return this.globalStoragePath;
  }

  public getBinDir(): string {
    const binDir = path.join(this.getStoragePath(), "bin");
    try {
      fs.mkdirSync(binDir, { recursive: true });
    } catch {}
    return binDir;
  }

  /**
   * Prepend the self-contained bin directory to PATH so child processes & terminals
   * execute tools directly without requiring any manual host installation.
   */
  public getEnvWithBinPath(extraEnv?: Record<string, string>): Record<string, string> {
    const binDir = this.getBinDir();
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(extraEnv || {}),
    };
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const currentPath = env[pathKey] || env["PATH"] || env["Path"] || "";
    env[pathKey] = `${binDir}${path.delimiter}${currentPath}`;
    env["PATH"] = env[pathKey];
    return env;
  }

  /**
   * Determine the exact host-native Atlas binary download asset name based on OS & Arch.
   */
  public getAtlasAssetName(): string | null {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === "win32") {
      return arch === "arm64" ? "atlas-windows-arm64.zip" : "atlas-windows-x86_64.zip";
    } else if (platform === "darwin") {
      return arch === "arm64" ? "atlas-macos-arm64.tar.gz" : "atlas-macos-x86_64.tar.gz";
    } else if (platform === "linux") {
      return arch === "arm64" ? "atlas-linux-arm64.tar.gz" : "atlas-linux-x86_64.tar.gz";
    }
    return null;
  }

  /**
   * Determine the exact host-native OpenCode binary download asset name based on OS & Arch.
   */
  public getOpencodeAssetName(): string | null {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === "win32") {
      return arch === "arm64" ? "opencode-windows-arm64.zip" : "opencode-windows-x64.zip";
    } else if (platform === "darwin") {
      return arch === "arm64" ? "opencode-darwin-arm64.zip" : "opencode-darwin-x64.zip";
    } else if (platform === "linux") {
      return arch === "arm64" ? "opencode-linux-arm64.tar.gz" : "opencode-linux-x64.tar.gz";
    }
    return null;
  }

  /**
   * Resolve Atlas CLI command or binary path dynamically.
   */
  public async getAtlasCommand(storagePath?: string): Promise<string> {
    if (this.cachedAtlasPath && fs.existsSync(this.cachedAtlasPath)) {
      return this.cachedAtlasPath;
    }

    // 1. Check custom user setting
    try {
      const vscode = getVscode();
      if (vscode) {
        const config = vscode.workspace.getConfiguration("codesentinel");
        const customPath = config.get<string>("atlasPath", "").trim();
        if (customPath && fs.existsSync(customPath)) {
          this.cachedAtlasPath = customPath;
          return customPath;
        }
      }
    } catch {}

    // 2. Check if Atlas binary is in extension local/global storage bin
    const binName = process.platform === "win32" ? "atlas.exe" : "atlas";
    const effectiveStorage = storagePath || this.getStoragePath();
    const localBin = path.join(effectiveStorage, "bin", binName);
    if (fs.existsSync(localBin)) {
      this.cachedAtlasPath = localBin;
      return localBin;
    }

    // 3. Check if Atlas is in system PATH
    try {
      await execAsync("atlas --version");
      this.cachedAtlasPath = "atlas";
      return "atlas";
    } catch {}

    // 4. Fallback to storage bin path
    return localBin;
  }

  /**
   * Resolve OpenCode command dynamically from self-contained storage first.
   */
  public async getOpencodeCommand(storagePath?: string): Promise<string> {
    if (this.cachedOpencodePath && fs.existsSync(this.cachedOpencodePath)) {
      return this.cachedOpencodePath;
    }

    // 1. Check custom setting
    try {
      const vscode = getVscode();
      if (vscode) {
        const config = vscode.workspace.getConfiguration("codesentinel");
        const custom = config.get<string>("opencodePath", "").trim();
        if (custom && custom !== "opencode" && fs.existsSync(custom)) {
          this.cachedOpencodePath = custom;
          return custom;
        }
      }
    } catch {}

    // 2. Check self-contained extension storage bin folder
    const effectiveStorage = storagePath || this.getStoragePath();
    const isWin = process.platform === "win32";
    const binExe = path.join(effectiveStorage, "bin", isWin ? "opencode.exe" : "opencode");
    if (fs.existsSync(binExe)) {
      this.cachedOpencodePath = binExe;
      return binExe;
    }

    // 3. Check self-contained node_modules bin folder inside extension storage
    const nodeBin = path.join(
      effectiveStorage,
      "node_modules",
      ".bin",
      isWin ? "opencode.cmd" : "opencode"
    );
    if (fs.existsSync(nodeBin)) {
      this.cachedOpencodePath = nodeBin;
      return nodeBin;
    }

    // 4. Check if OpenCode is installed on system PATH
    try {
      await execAsync("opencode --version");
      this.cachedOpencodePath = "opencode";
      return "opencode";
    } catch {}

    // 5. Default to the self-contained bin location
    return binExe;
  }

  /**
   * Check status of all host dependencies.
   */
  public async checkDependencies(storagePath?: string): Promise<DependencyStatus> {
    let opencodeInstalled = false;
    let opencodeVersion: string | undefined;
    let atlasInstalled = false;
    let atlasVersion: string | undefined;
    let atlasPath: string | undefined;

    const opencodeCmd = await this.getOpencodeCommand();
    try {
      const { stdout } = await execAsync(`"${opencodeCmd}" --version`);
      opencodeInstalled = true;
      opencodeVersion = stdout.trim();
    } catch {
      opencodeInstalled = false;
    }

    const atlasCmd = await this.getAtlasCommand(storagePath);
    try {
      const { stdout } = await execAsync(`"${atlasCmd}" --version`);
      atlasInstalled = true;
      atlasVersion = stdout.trim();
      atlasPath = atlasCmd;
    } catch {
      atlasInstalled = false;
    }

    return {
      opencodeInstalled,
      opencodeVersion,
      atlasInstalled,
      atlasVersion,
      atlasPath,
    };
  }

  /**
   * Download a remote file following redirects using an atomic temp file.
   */
  private downloadFile(
    url: string,
    destPath: string,
    onProgress?: (downloadedBytes: number, totalBytes: number) => void
  ): Promise<void> {
    const tempPath = `${destPath}.tmp_${process.pid}_${Date.now()}`;
    return new Promise((resolve, reject) => {
      const follow = (curUrl: string) => {
        https
          .get(curUrl, { headers: { "User-Agent": "CodeSentinel-Extension" } }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              follow(res.headers.location);
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`Failed to download: HTTP status ${res.statusCode}`));
              return;
            }
            const expectedLength = parseInt(res.headers["content-length"] || "0", 10);
            let downloadedBytes = 0;
            let lastReportTime = 0;
            res.on("data", (chunk) => {
              downloadedBytes += chunk.length;
              if (onProgress) {
                const now = Date.now();
                if (now - lastReportTime >= 250 || (expectedLength > 0 && downloadedBytes >= expectedLength)) {
                  lastReportTime = now;
                  try {
                    onProgress(downloadedBytes, expectedLength);
                  } catch {}
                }
              }
            });
            const fileStream = fs.createWriteStream(tempPath);
            res.pipe(fileStream);
            fileStream.on("finish", () => {
              fileStream.close(() => {
                if (expectedLength > 0 && downloadedBytes < expectedLength) {
                  try { fs.unlinkSync(tempPath); } catch {}
                  reject(new Error(`Download truncated: expected ${expectedLength} bytes, received ${downloadedBytes}`));
                } else {
                  try {
                    if (fs.existsSync(destPath)) {
                      try { fs.unlinkSync(destPath); } catch {}
                    }
                    fs.renameSync(tempPath, destPath);
                    resolve();
                  } catch (renameErr) {
                    try {
                      fs.copyFileSync(tempPath, destPath);
                      fs.unlinkSync(tempPath);
                      resolve();
                    } catch (copyErr) {
                      try { fs.unlinkSync(tempPath); } catch {}
                      reject(copyErr || renameErr);
                    }
                  }
                }
              });
            });
            fileStream.on("error", (err) => {
              try { fs.unlinkSync(tempPath); } catch {}
              reject(err);
            });
          })
          .on("error", (err) => {
            try { fs.unlinkSync(tempPath); } catch {}
            reject(err);
          });
      };
      follow(url);
    });
  }

  /**
   * Download and install the host-native Atlas binary into extension storage.
   * Deduplicated so concurrent callers share the same in-flight installation.
   */
  public async installAtlas(storagePath: string): Promise<string> {
    if (this.inflightAtlasInstall) {
      return this.inflightAtlasInstall;
    }
    this.inflightAtlasInstall = this.installAtlasInternal(storagePath).finally(() => {
      this.inflightAtlasInstall = null;
    });
    return this.inflightAtlasInstall;
  }

  private async installAtlasInternal(storagePath: string): Promise<string> {
    const assetName = this.getAtlasAssetName();
    if (!assetName) {
      throw new Error(`Unsupported platform: ${process.platform} ${process.arch}`);
    }

    const binDir = path.join(storagePath, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const binName = process.platform === "win32" ? "atlas.exe" : "atlas";
    const binaryPath = path.join(binDir, binName);

    if (fs.existsSync(binaryPath)) {
      try {
        const stat = fs.statSync(binaryPath);
        if (stat.size > 5 * 1024 * 1024) {
          this.cachedAtlasPath = binaryPath;
          return binaryPath;
        }
      } catch {}
    }

    // If local verified binary already exists in user's codesentinel store, copy it instantly
    const primaryLocalBin = path.join(this.getStoragePath(), "bin", binName);
    const homeLocalBin = path.join(os.homedir(), ".codesentinel", "bin", binName);
    const candidateBin = fs.existsSync(primaryLocalBin) ? primaryLocalBin : fs.existsSync(homeLocalBin) ? homeLocalBin : null;

    if (candidateBin && candidateBin !== binaryPath && fs.existsSync(candidateBin)) {
      try {
        const stat = fs.statSync(candidateBin);
        if (stat.size > 20 * 1024 * 1024) {
          fs.copyFileSync(candidateBin, binaryPath);
          if (process.platform !== "win32") {
            try { fs.chmodSync(binaryPath, 0o755); } catch {}
          }
          this.cachedAtlasPath = binaryPath;
          return binaryPath;
        }
      } catch {}
    }

    const downloadUrl = `https://github.com/LordCasser/atlas/releases/download/v1.7.0/${assetName}`;
    const archivePath = path.join(storagePath, assetName);

    const onAtlasDlProgress = (downloaded: number, total: number) => {
      const mbDown = (downloaded / (1024 * 1024)).toFixed(1);
      const mbTotal = total > 0 ? (total / (1024 * 1024)).toFixed(1) : "?";
      const ratio = total > 0 ? downloaded / total : 0.5;
      const pct = Math.min(92, Math.round(70 + ratio * 22));
      this.reportProgress({
        stage: "Downloading Atlas Code Graph Engine",
        percent: pct,
        detail: total > 0
          ? `Downloading ${assetName}: ${mbDown} MB / ${mbTotal} MB (${Math.round(ratio * 100)}%)...`
          : `Downloading ${assetName}: ${mbDown} MB...`,
      });
    };

    try {
      await this.downloadFile(downloadUrl, archivePath, onAtlasDlProgress);
    } catch (dlErr) {
      // Fallback for macOS x64 -> arm64 (Rosetta 2) or Windows arm64 -> x86_64 if native arch asset is absent
      if (process.platform === "darwin" && assetName !== "atlas-macos-arm64.tar.gz") {
        const fallbackUrl = "https://github.com/LordCasser/atlas/releases/download/v1.7.0/atlas-macos-arm64.tar.gz";
        await this.downloadFile(fallbackUrl, archivePath, onAtlasDlProgress);
      } else if (process.platform === "win32" && assetName !== "atlas-windows-x86_64.zip") {
        const fallbackUrl = "https://github.com/LordCasser/atlas/releases/download/v1.7.0/atlas-windows-x86_64.zip";
        await this.downloadFile(fallbackUrl, archivePath, onAtlasDlProgress);
      } else {
        throw dlErr;
      }
    }

    this.reportProgress({
      stage: "Extracting Atlas Code Graph Engine",
      percent: 94,
      detail: `Extracting ${assetName} into self-contained storage...`,
    });

    // Extract archive natively
    if (assetName.endsWith(".zip")) {
      if (process.platform === "win32") {
        try {
          await execAsync(`tar -xf "${archivePath}" -C "${binDir}"`, { timeout: 60000 });
        } catch {
          const safeArchive = archivePath.replace(/'/g, "''");
          const safeDest = binDir.replace(/'/g, "''");
          await execAsync(
            `powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '${safeArchive}' -DestinationPath '${safeDest}' -Force"`,
            { timeout: 90000 }
          );
        }
      } else {
        await execAsync(`unzip -o "${archivePath}" -d "${binDir}"`);
      }
    } else if (assetName.endsWith(".tar.gz")) {
      await execAsync(`tar -xzf "${archivePath}" -C "${binDir}"`);
    }

    // Clean up archive
    try {
      fs.unlinkSync(archivePath);
    } catch {}

    if (process.platform !== "win32" && fs.existsSync(binaryPath)) {
      try {
        fs.chmodSync(binaryPath, 0o755);
      } catch {}
    }

    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Extracted Atlas binary not found at ${binaryPath}`);
    }

    this.cachedAtlasPath = binaryPath;
    return binaryPath;
  }

  /**
   * Install OpenCode CLI into the self-contained extension storage directory.
   * Deduplicated so concurrent callers share the exact same download/extraction promise.
   */
  public async installOpenCode(storagePath: string): Promise<string> {
    if (this.inflightOpencodeInstall) {
      return this.inflightOpencodeInstall;
    }
    this.inflightOpencodeInstall = this.installOpenCodeInternal(storagePath).finally(() => {
      this.inflightOpencodeInstall = null;
    });
    return this.inflightOpencodeInstall;
  }

  private async installOpenCodeInternal(storagePath: string): Promise<string> {
    const binDir = path.join(storagePath || this.getStoragePath(), "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const isWin = process.platform === "win32";
    const binName = isWin ? "opencode.exe" : "opencode";
    const destBinary = path.join(binDir, binName);

    if (fs.existsSync(destBinary)) {
      try {
        const stat = fs.statSync(destBinary);
        if (stat.size > 5 * 1024 * 1024) {
          this.cachedOpencodePath = destBinary;
          return destBinary;
        }
        // Corrupt/partial binary from interrupted extraction: remove before re-installing
        fs.unlinkSync(destBinary);
      } catch {}
    }

    const assetName = this.getOpencodeAssetName();
    let downloaded = false;

    if (assetName) {
      try {
        const downloadUrl = `https://github.com/anomalyco/opencode/releases/latest/download/${assetName}`;
        const archivePath = path.join(storagePath, assetName);
        await this.downloadFile(downloadUrl, archivePath, (dlBytes, totalBytes) => {
          const mbDown = (dlBytes / (1024 * 1024)).toFixed(1);
          const mbTotal = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(1) : "?";
          const ratio = totalBytes > 0 ? dlBytes / totalBytes : 0.5;
          const pct = Math.min(64, Math.round(25 + ratio * 39));
          this.reportProgress({
            stage: "Downloading OpenCode AI Agent",
            percent: pct,
            detail: totalBytes > 0
              ? `Downloading ${assetName}: ${mbDown} MB / ${mbTotal} MB (${Math.round(ratio * 100)}%)...`
              : `Downloading ${assetName}: ${mbDown} MB...`,
          });
        });

        this.reportProgress({
          stage: "Extracting OpenCode AI Agent",
          percent: 66,
          detail: `Extracting ${assetName} into self-contained storage...`,
        });

        if (assetName.endsWith(".zip")) {
          if (isWin) {
            try {
              await execAsync(`tar -xf "${archivePath}" -C "${binDir}"`, { timeout: 60000 });
            } catch {
              const safeArchive = archivePath.replace(/'/g, "''");
              const safeDest = binDir.replace(/'/g, "''");
              await execAsync(
                `powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '${safeArchive}' -DestinationPath '${safeDest}' -Force"`,
                { timeout: 90000 }
              );
            }
          } else {
            await execAsync(`unzip -o "${archivePath}" -d "${binDir}"`);
          }
        } else if (assetName.endsWith(".tar.gz")) {
          await execAsync(`tar -xzf "${archivePath}" -C "${binDir}"`);
        }

        try {
          fs.unlinkSync(archivePath);
        } catch {}

        if (fs.existsSync(destBinary)) {
          const stat = fs.statSync(destBinary);
          if (stat.size > 5 * 1024 * 1024) {
            downloaded = true;
            if (!isWin) {
              try {
                fs.chmodSync(destBinary, 0o755);
              } catch {}
            }
          }
        }
      } catch (dlErr: any) {
        console.warn("Direct OpenCode binary download notice:", dlErr?.message);
      }
    }

    if (!downloaded && !fs.existsSync(destBinary)) {
      // Fallback: Local self-contained npm installation into extension storage (Zero global flags!)
      try {
        await execAsync(`npm install --prefix "${storagePath}" opencode-ai@1.18.35`, {
          timeout: 120000,
        });
        const localNpmBin = path.join(
          storagePath,
          "node_modules",
          ".bin",
          isWin ? "opencode.cmd" : "opencode"
        );
        if (fs.existsSync(localNpmBin)) {
          this.cachedOpencodePath = localNpmBin;
          return localNpmBin;
        }
      } catch (npmErr: any) {
        console.warn("Local isolated OpenCode npm install notice:", npmErr?.message);
      }
    }

    this.cachedOpencodePath = destBinary;
    return destBinary;
  }

  /**
   * Verify and automatically install missing host dependencies with progress reporting.
   * Deduplicated so concurrent callers await the same provisioning promise.
   */
  public async ensureDependencies(context: vscodeTypes.ExtensionContext): Promise<void> {
    if (this.inflightEnsureDeps) {
      return this.inflightEnsureDeps;
    }
    this.inflightEnsureDeps = this.ensureDependenciesInternal(context).finally(() => {
      this.inflightEnsureDeps = null;
    });
    return this.inflightEnsureDeps;
  }

  private async ensureDependenciesInternal(context: vscodeTypes.ExtensionContext): Promise<void> {
    const storagePath = context.globalStorageUri.fsPath;
    this.setStoragePath(storagePath);
    fs.mkdirSync(storagePath, { recursive: true });

    // Sync with SecurityToolManager so all tool binaries reside in the unified storage folder
    const { SecurityToolManager } = await import("../scanner/securityToolManager");
    SecurityToolManager.getInstance().setStoragePath(storagePath);

    this.reportProgress({
      stage: "Verifying runtime tools",
      percent: 10,
      detail: "Checking self-contained OpenCode, Atlas AST Graph, and Security Engines...",
    });

    // Background warm-provisioning of all security scanning tools (Opengrep, Gitleaks, OSV-Scanner)
    const securityToolsPromise = SecurityToolManager.getInstance()
      .ensureSecurityTools((msg) => {
        if (!this.inflightOpencodeInstall && !this.inflightAtlasInstall) {
          this.reportProgress({
            stage: "Provisioning Security Scanner Tools",
            percent: 20,
            detail: msg,
          });
        }
      })
      .catch((err) => {
        console.warn("Security scanner tools auto-provisioning background notice:", err?.message);
      });

    const status = await this.checkDependencies(storagePath);
    if (status.opencodeInstalled && status.atlasInstalled) {
      await securityToolsPromise;
      this.reportProgress({
        stage: "Runtime tools ready",
        percent: 100,
        detail: "OpenCode AI Agent, Atlas Semantic Engine, and Security Scanners verified.",
        completed: true,
      });
      return;
    }

    const missing: string[] = [];
    if (!status.opencodeInstalled) missing.push("OpenCode AI Agent");
    if (!status.atlasInstalled) missing.push("Atlas Semantic Engine");

    this.reportProgress({
      stage: "Installing runtime tools",
      percent: 22,
      detail: `Downloading first-time dependencies: ${missing.join(", ")}...`,
    });

    const vscode = getVscode();
    if (!vscode) {
      if (!status.opencodeInstalled) await this.installOpenCode(storagePath);
      if (!status.atlasInstalled) await this.installAtlas(storagePath);
      await securityToolsPromise;
      this.reportProgress({
        stage: "Runtime tools ready",
        percent: 100,
        detail: "All self-contained runtime tools verified and ready.",
        completed: true,
      });
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `CodeSentinel: Installing self-contained dependencies (${missing.join(", ")})...`,
        cancellable: false,
      },
      async (progress) => {
        if (!status.opencodeInstalled) {
          this.reportProgress({
            stage: "Downloading OpenCode AI Agent",
            percent: 25,
            detail: "Downloading self-contained OpenCode AI Agent into extension storage...",
          });
          progress.report({ message: "Downloading OpenCode AI Agent into extension storage..." });
          try {
            await this.installOpenCode(storagePath);
          } catch (err: any) {
            console.warn(`Could not setup OpenCode: ${err.message}`);
          }
        }

        if (!status.atlasInstalled) {
          this.reportProgress({
            stage: "Downloading Atlas Code Graph Engine",
            percent: 70,
            detail: "Downloading Atlas semantic code graph engine...",
          });
          progress.report({ message: "Downloading Atlas semantic code graph engine into extension storage..." });
          try {
            await this.installAtlas(storagePath);
          } catch (err: any) {
            console.warn(`Could not setup Atlas: ${err.message}`);
          }
        }

        progress.report({ message: "Finalizing security scanner engines..." });
        await securityToolsPromise;

        this.reportProgress({
          stage: "Runtime tools ready",
          percent: 100,
          detail: "All self-contained runtime tools verified and ready.",
          completed: true,
        });
      }
    );
  }
}
