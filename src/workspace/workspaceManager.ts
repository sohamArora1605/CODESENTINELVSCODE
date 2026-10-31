import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { WorkspaceContext } from "../types";

export class WorkspaceManager {
  private static instance: WorkspaceManager;
  private currentContext: WorkspaceContext | null = null;
  private onWorkspaceChangeEmitter = new vscode.EventEmitter<WorkspaceContext | null>();
  public readonly onDidChangeWorkspace = this.onWorkspaceChangeEmitter.event;

  private constructor() {
    this.refreshContext();
  }

  public static getInstance(): WorkspaceManager {
    if (!WorkspaceManager.instance) {
      WorkspaceManager.instance = new WorkspaceManager();
    }
    return WorkspaceManager.instance;
  }

  public registerWatchers(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.refreshContext();
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && editor.document) {
          this.refreshContext(editor.document.uri);
        }
      })
    );
  }

  public refreshContext(preferredUri?: vscode.Uri): WorkspaceContext | null {
    const folders = vscode.workspace.workspaceFolders;
    let targetFolder: vscode.WorkspaceFolder | null = folders && folders.length > 0 ? folders[0] : null;
    let externalRoot: string | null = null; // root outside VS Code workspace folders

    const candidateUri = preferredUri || vscode.window.activeTextEditor?.document?.uri;
    if (candidateUri && candidateUri.scheme === "file") {
      const match = vscode.workspace.getWorkspaceFolder(candidateUri);
      if (match) {
        targetFolder = match;
      } else {
        // Active file is outside all open workspace folders — detect its project root or directory
        externalRoot = this.findProjectRoot(candidateUri.fsPath);
      }
    }

    // If the active file lives in an external project/folder, use that directly
    const rootPath = externalRoot || (targetFolder ? targetFolder.uri.fsPath : null);
    if (!rootPath) {
      this.currentContext = null;
      this.onWorkspaceChangeEmitter.fire(null);
      return null;
    }

    const folderName = externalRoot
      ? path.basename(externalRoot)
      : targetFolder
      ? targetFolder.name
      : path.basename(rootPath);

    const detectedLanguages = this.detectWorkspaceLanguages(rootPath);
    const hasGit = fs.existsSync(path.join(rootPath, ".git"));
    const hasOpenCodeConfig =
      fs.existsSync(path.join(rootPath, "opencode.json")) ||
      fs.existsSync(path.join(rootPath, ".opencode", "config.json")) ||
      fs.existsSync(path.join(rootPath, ".opencode"));

    const activeFilePath = vscode.window.activeTextEditor?.document?.uri?.fsPath;

    const previous = this.currentContext;
    const hasChanged =
      !previous ||
      previous.rootPath !== rootPath ||
      previous.name !== folderName ||
      previous.hasGit !== hasGit ||
      previous.hasOpenCodeConfig !== hasOpenCodeConfig ||
      previous.detectedLanguages.join(",") !== detectedLanguages.join(",");

    this.currentContext = {
      rootPath,
      name: folderName,
      detectedLanguages,
      hasGit,
      hasOpenCodeConfig,
      activeFilePath,
    };

    if (hasChanged) {
      this.onWorkspaceChangeEmitter.fire(this.currentContext);
    }
    return this.currentContext;
  }

  public getActiveWorkspaceRoot(): string | null {
    if (!this.currentContext) {
      this.refreshContext();
    }
    return this.currentContext ? this.currentContext.rootPath : null;
  }

  public getContext(): WorkspaceContext | null {
    if (!this.currentContext) {
      this.refreshContext();
    }
    return this.currentContext;
  }

  public resolveWorkspacePath(relativePath: string): string {
    const root = this.getActiveWorkspaceRoot();
    if (!root) {
      throw new Error("No active workspace folder open. Open a project repository first.");
    }
    return path.resolve(root, relativePath);
  }

  /**
   * Walk up the directory tree from `startPath` to find the nearest project root.
   * Recognises: .git, package.json, pyproject.toml, go.mod, Cargo.toml, pom.xml,
   * CMakeLists.txt, build.gradle — stops at the filesystem root.
   * If no project marker is found, safely falls back to the directory containing startPath.
   */
  private findProjectRoot(startPath: string): string | null {
    if (!startPath || typeof startPath !== "string") {
      return null;
    }

    let dir: string;
    try {
      if (!fs.existsSync(startPath)) {
        return null;
      }
      const stat = fs.statSync(startPath);
      dir = stat.isDirectory() ? startPath : path.dirname(startPath);
    } catch {
      return null;
    }

    const fallbackDir = dir;
    const projectMarkers = [
      ".git",
      "package.json",
      "pyproject.toml",
      "go.mod",
      "Cargo.toml",
      "pom.xml",
      "CMakeLists.txt",
      "build.gradle",
      "build.gradle.kts",
      ".opencode",
      "opencode.json",
    ];

    try {
      const parsedRoot = path.parse(dir).root;

      while (dir && dir !== parsedRoot) {
        for (const marker of projectMarkers) {
          try {
            if (fs.existsSync(path.join(dir, marker))) {
              return dir;
            }
          } catch {}
        }
        const parent = path.dirname(dir);
        if (parent === dir) break; // reached filesystem root
        dir = parent;
      }
    } catch {}

    // Fall back to the immediate folder containing the file rather than remote workspace folder
    return fallbackDir;
  }

  private detectWorkspaceLanguages(rootPath: string): string[] {
    const languageMap: Record<string, string> = {
      ".py": "python",
      ".ts": "typescript",
      ".tsx": "typescript",
      ".js": "javascript",
      ".jsx": "javascript",
      ".go": "go",
      ".java": "java",
      ".rs": "rust",
      ".c": "c",
      ".cpp": "cpp",
      ".php": "php",
      ".rb": "ruby",
      ".cs": "csharp",
      ".kt": "kotlin",
      ".swift": "swift",
      ".scala": "scala",
    };

    const ignoredDirs = new Set([
      "node_modules",
      ".git",
      ".atlas",
      ".codesentinel",
      "target",
      "build",
      ".gradle",
      "dist",
      "out",
      "bin",
      "obj",
      "vendor",
      ".venv",
      "venv",
      "env",
      "__pycache__",
    ]);

    const foundLanguages = new Set<string>();

    const scanDir = (dir: string, depth: number) => {
      if (depth > 4) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (languageMap[ext]) {
              foundLanguages.add(languageMap[ext]);
            }
          } else if (entry.isDirectory() && !entry.name.startsWith(".") && !ignoredDirs.has(entry.name)) {
            scanDir(path.join(dir, entry.name), depth + 1);
          }
        }
      } catch {}
    };

    scanDir(rootPath, 0);
    return Array.from(foundLanguages);
  }
}
