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
    if (!folders || folders.length === 0) {
      this.currentContext = null;
      this.onWorkspaceChangeEmitter.fire(null);
      return null;
    }

    let targetFolder: vscode.WorkspaceFolder = folders[0];
    if (preferredUri) {
      const match = vscode.workspace.getWorkspaceFolder(preferredUri);
      if (match) {
        targetFolder = match;
      }
    } else if (vscode.window.activeTextEditor) {
      const match = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
      if (match) {
        targetFolder = match;
      }
    }

    const rootPath = targetFolder.uri.fsPath;
    const detectedLanguages = this.detectWorkspaceLanguages(rootPath);
    const hasGit = fs.existsSync(path.join(rootPath, ".git"));
    const hasOpenCodeConfig =
      fs.existsSync(path.join(rootPath, "opencode.json")) ||
      fs.existsSync(path.join(rootPath, ".opencode", "config.json")) ||
      fs.existsSync(path.join(rootPath, ".opencode"));

    const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;

    const previous = this.currentContext;
    const hasChanged =
      !previous ||
      previous.rootPath !== rootPath ||
      previous.name !== targetFolder.name ||
      previous.hasGit !== hasGit ||
      previous.hasOpenCodeConfig !== hasOpenCodeConfig ||
      previous.detectedLanguages.join(",") !== detectedLanguages.join(",");

    this.currentContext = {
      rootPath,
      name: targetFolder.name,
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
