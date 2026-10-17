import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import * as https from "https";

const execAsync = promisify(exec);

export interface DependencyStatus {
  opencodeInstalled: boolean;
  opencodeVersion?: string;
  atlasInstalled: boolean;
  atlasVersion?: string;
  atlasPath?: string;
}

export class DependencyManager {
  private static instance: DependencyManager;
  private cachedAtlasPath: string | null = null;
  private cachedOpencodePath: string | null = null;
  private globalStoragePath: string | null = null;

  private constructor() {}

  public static getInstance(): DependencyManager {
    if (!DependencyManager.instance) {
      DependencyManager.instance = new DependencyManager();
    }
    return DependencyManager.instance;
  }

  public setStoragePath(p: string): void {
    this.globalStoragePath = p;
    try {
      fs.mkdirSync(this.getBinDir(), { recursive: true });
    } catch {}
  }

  public getStoragePath(): string {
    if (!this.globalStoragePath) {
      this.globalStoragePath = path.join(os.homedir(), ".codesentinel");
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
      return arch === "arm64" ? "atlas-macos-arm64.tar.gz" : "atlas-macos-arm64.tar.gz";
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
      const config = vscode.workspace.getConfiguration("codesentinel");
      const customPath = config.get<string>("atlasPath", "").trim();
      if (customPath && fs.existsSync(customPath)) {
        this.cachedAtlasPath = customPath;
        return customPath;
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
      const config = vscode.workspace.getConfiguration("codesentinel");
      const custom = config.get<string>("opencodePath", "").trim();
      if (custom && custom !== "opencode" && fs.existsSync(custom)) {
        this.cachedOpencodePath = custom;
        return custom;
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
   * Download a remote file following redirects.
   */
  private downloadFile(url: string, destPath: string): Promise<void> {
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
            const fileStream = fs.createWriteStream(destPath);
            res.pipe(fileStream);
            fileStream.on("finish", () => {
              fileStream.close(() => resolve());
            });
            fileStream.on("error", (err) => {
              fs.unlink(destPath, () => {});
              reject(err);
            });
          })
          .on("error", (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
          });
      };
      follow(url);
    });
  }

  /**
   * Download and install the host-native Atlas binary into extension storage.
   */
  public async installAtlas(storagePath: string): Promise<string> {
    const assetName = this.getAtlasAssetName();
    if (!assetName) {
      throw new Error(`Unsupported platform: ${process.platform} ${process.arch}`);
    }

    const binDir = path.join(storagePath, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const downloadUrl = `https://github.com/LordCasser/atlas/releases/download/v1.7.0/${assetName}`;
    const archivePath = path.join(storagePath, assetName);

    await this.downloadFile(downloadUrl, archivePath);

    // Extract archive natively
    if (assetName.endsWith(".zip")) {
      if (process.platform === "win32") {
        await execAsync(`powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${binDir}' -Force"`);
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

    const binName = process.platform === "win32" ? "atlas.exe" : "atlas";
    const binaryPath = path.join(binDir, binName);

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
   * Priority:
   * 1. Check if bundled in extension storage bin
   * 2. Download precompiled binary from official release and place into storage/bin/
   * 3. Fallback to local isolated `npm install --prefix "<storagePath>" opencode-ai`
   * Never pollutes global npm or requires root/admin permissions.
   */
  public async installOpenCode(storagePath: string): Promise<string> {
    const binDir = this.getBinDir();
    const isWin = process.platform === "win32";
    const binName = isWin ? "opencode.exe" : "opencode";
    const destBinary = path.join(binDir, binName);

    if (fs.existsSync(destBinary)) {
      this.cachedOpencodePath = destBinary;
      return destBinary;
    }

    const assetName = this.getOpencodeAssetName();
    let downloaded = false;

    if (assetName) {
      try {
        const downloadUrl = `https://github.com/anomalyco/opencode/releases/latest/download/${assetName}`;
        const archivePath = path.join(storagePath, assetName);
        await this.downloadFile(downloadUrl, archivePath);

        if (assetName.endsWith(".zip")) {
          if (isWin) {
            await execAsync(
              `powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${binDir}' -Force"`
            );
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
          downloaded = true;
          if (!isWin) {
            try {
              fs.chmodSync(destBinary, 0o755);
            } catch {}
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
   */
  public async ensureDependencies(context: vscode.ExtensionContext): Promise<void> {
    const storagePath = context.globalStorageUri.fsPath;
    this.setStoragePath(storagePath);
    fs.mkdirSync(storagePath, { recursive: true });

    // Sync with SecurityToolManager so all tool binaries reside in the unified storage folder
    const { SecurityToolManager } = await import("../scanner/securityToolManager");
    SecurityToolManager.getInstance().setStoragePath(storagePath);

    // Background warm-provisioning of all security scanning tools (Opengrep, Gitleaks, OSV-Scanner)
    SecurityToolManager.getInstance()
      .ensureSecurityTools()
      .catch((err) => {
        console.warn("Security scanner tools auto-provisioning background notice:", err?.message);
      });

    const status = await this.checkDependencies(storagePath);
    if (status.opencodeInstalled && status.atlasInstalled) {
      return;
    }

    const missing: string[] = [];
    if (!status.opencodeInstalled) missing.push("OpenCode AI Agent");
    if (!status.atlasInstalled) missing.push("Atlas Semantic Engine");

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `CodeSentinel: Provisioning self-contained runtime tools (${missing.join(", ")})...`,
        cancellable: false,
      },
      async (progress) => {
        if (!status.opencodeInstalled) {
          progress.report({ message: "Configuring OpenCode agent in self-contained extension storage..." });
          try {
            await this.installOpenCode(storagePath);
          } catch (err: any) {
            console.warn(`Could not setup OpenCode: ${err.message}`);
          }
        }

        if (!status.atlasInstalled) {
          progress.report({ message: "Downloading Atlas semantic code graph engine into extension storage..." });
          try {
            await this.installAtlas(storagePath);
          } catch (err: any) {
            console.warn(`Could not setup Atlas: ${err.message}`);
          }
        }
      }
    );
  }
}
