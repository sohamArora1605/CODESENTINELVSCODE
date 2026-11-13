import * as path from "path";
import * as fs from "fs";
import type * as vscodeTypes from "vscode";
import { RepositoryInfo, GitStatus } from "../types";
import { GitSyncService } from "../git/gitSyncService";
import { GraphService } from "../graph/graphService";
import * as os from "os";
import { getSetting } from "../config/settings";

function getVscode(): typeof vscodeTypes | null {
  try {
    return require("vscode");
  } catch {
    return null;
  }
}

export class MultiRepoManager {
  private static instance: MultiRepoManager;
  private repositories: Map<string, RepositoryInfo> = new Map();
  private activeRepoPath: string | null = null;
  private changeListeners: Array<(repos: RepositoryInfo[]) => void> = [];
  private activeRepoListeners: Array<(active: RepositoryInfo | null) => void> = [];

  private constructor() {
    this.initGitSyncHooks();
  }

  public static getInstance(): MultiRepoManager {
    if (!MultiRepoManager.instance) {
      MultiRepoManager.instance = new MultiRepoManager();
    }
    return MultiRepoManager.instance;
  }

  private initGitSyncHooks(): void {
    const gitSync = GitSyncService.getInstance();
    gitSync.onDidBranchChange((repoPath, newBranch) => {
      const repo = this.repositories.get(repoPath);
      if (repo) {
        repo.currentBranch = newBranch;
        repo.syncStatus = "syncing";
        this.notifyChange();
      }
    });

    gitSync.onDidSyncGraph((result) => {
      const repo = this.repositories.get(result.repoPath);
      if (repo) {
        repo.isIndexed = result.success;
        repo.syncStatus = result.success ? "synced" : "error";
        repo.syncError = result.success ? undefined : result.message;
        repo.lastSyncTime = Date.now();
        this.notifyChange();
      }
    });
  }

  public onDidChangeRepositories(listener: (repos: RepositoryInfo[]) => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  public onDidChangeActiveRepo(listener: (active: RepositoryInfo | null) => void): () => void {
    this.activeRepoListeners.push(listener);
    return () => {
      this.activeRepoListeners = this.activeRepoListeners.filter((l) => l !== listener);
    };
  }

  private notifyChange(): void {
    const list = this.getRepositories();
    for (const l of this.changeListeners) {
      try { l(list); } catch {}
    }
  }

  private notifyActiveChange(): void {
    const active = this.getActiveRepo();
    for (const l of this.activeRepoListeners) {
      try { l(active); } catch {}
    }
  }

  /** Repositories added by hand are remembered across reloads (shared by the UI and the MCP server). */
  private registryFile(): string {
    return path.join(process.env.CODESENTINEL_VAULT_DIR || path.join(os.homedir(), ".codesentinel"), "repos.json");
  }

  private loadRegistry(): string[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.registryFile(), "utf-8"));
      return Array.isArray(v) ? v.filter((p) => typeof p === "string" && fs.existsSync(p)) : [];
    } catch {
      return [];
    }
  }

  private saveRegistry(): void {
    try {
      const workspace = new Set(this.workspaceFolders());
      const extra = Array.from(this.repositories.keys()).filter((p) => !workspace.has(p));
      fs.mkdirSync(path.dirname(this.registryFile()), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.registryFile(), JSON.stringify(extra, null, 2));
    } catch {}
  }

  private workspaceFolders(): string[] {
    const vscode = getVscode();
    return (vscode?.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
  }

  public async syncWithWorkspace(): Promise<RepositoryInfo[]> {
    const vscode = getVscode();
    const candidatePaths = new Set<string>();

    if (vscode && vscode.workspace.workspaceFolders) {
      for (const f of vscode.workspace.workspaceFolders) {
        if (f.uri.scheme === "file") {
          candidatePaths.add(f.uri.fsPath);
        }
      }
    }

    if (candidatePaths.size === 0) {
      const envRoot = process.env.CODESENTINEL_WORKSPACE || process.cwd();
      if (fs.existsSync(envRoot)) {
        candidatePaths.add(path.resolve(envRoot));
      }
    }

    // Hand-added repositories (multi-repo only)
    if (getSetting<boolean>("multiRepoEnabled", true)) {
      for (const p of this.loadRegistry()) candidatePaths.add(p);
    }

    // Multi-repo off: manage only the primary workspace repository
    if (!getSetting<boolean>("multiRepoEnabled", true)) {
      const primary = Array.from(candidatePaths)[0];
      for (const known of Array.from(this.repositories.keys())) {
        if (known !== primary) this.removeRepository(known, false); // hide, but keep remembered for when multi-repo is back on
      }
      candidatePaths.clear();
      if (primary) candidatePaths.add(primary);
    }

    // Refresh each repository
    for (const p of candidatePaths) {
      await this.inspectAndRegisterRepo(p);
    }

    // Default active repo
    if (!this.activeRepoPath || !this.repositories.has(this.activeRepoPath)) {
      const first = Array.from(candidatePaths)[0];
      if (first) {
        this.activeRepoPath = first;
      }
    }

    this.notifyChange();
    this.notifyActiveChange();
    return this.getRepositories();
  }

  public async addRepository(repoPath: string): Promise<RepositoryInfo> {
    const resolved = path.resolve(repoPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Directory does not exist: ${resolved}`);
    }
    if (!getSetting<boolean>("multiRepoEnabled", true) && this.repositories.size > 0 && !this.repositories.has(resolved)) {
      throw new Error("Multi-repo support is turned off (codesentinel.multiRepoEnabled).");
    }
    const info = await this.inspectAndRegisterRepo(resolved);
    this.saveRegistry();
    this.activeRepoPath = resolved;
    this.notifyChange();
    this.notifyActiveChange();
    return info;
  }

  public removeRepository(repoPath: string, persist = true): void {
    const resolved = path.resolve(repoPath);
    GitSyncService.getInstance().unwatchRepo(resolved);
    this.repositories.delete(resolved);
    if (persist) this.saveRegistry();
    if (this.activeRepoPath === resolved) {
      const remaining = Array.from(this.repositories.keys());
      this.activeRepoPath = remaining.length > 0 ? remaining[0] : null;
      this.notifyActiveChange();
    }
    this.notifyChange();
  }

  public setActiveRepo(repoPath: string): RepositoryInfo | null {
    const resolved = path.resolve(repoPath);
    if (this.repositories.has(resolved)) {
      this.activeRepoPath = resolved;
      this.notifyActiveChange();
      return this.repositories.get(resolved) || null;
    }
    return null;
  }

  public getActiveRepo(): RepositoryInfo | null {
    if (this.activeRepoPath && this.repositories.has(this.activeRepoPath)) {
      return this.repositories.get(this.activeRepoPath) || null;
    }
    const all = this.getRepositories();
    return all.length > 0 ? all[0] : null;
  }

  public getActiveRepoPath(): string | null {
    const active = this.getActiveRepo();
    return active ? active.path : null;
  }

  public getRepositories(): RepositoryInfo[] {
    return Array.from(this.repositories.values());
  }

  public async refreshRepo(repoPath: string): Promise<RepositoryInfo | null> {
    const resolved = path.resolve(repoPath);
    if (!fs.existsSync(resolved)) return null;
    return await this.inspectAndRegisterRepo(resolved);
  }

  public async refreshAll(): Promise<RepositoryInfo[]> {
    for (const p of Array.from(this.repositories.keys())) {
      await this.inspectAndRegisterRepo(p);
    }
    this.notifyChange();
    this.notifyActiveChange();
    return this.getRepositories();
  }

  private async inspectAndRegisterRepo(repoPath: string): Promise<RepositoryInfo> {
    const gitSync = GitSyncService.getInstance();
    const graphService = GraphService.getInstance();

    const name = path.basename(repoPath);
    const hasGit = gitSync.isGitRepo(repoPath);
    let currentBranch = "main";
    let branches = ["main"];
    let gitStatus: GitStatus = {
      branch: "main",
      isClean: true,
      staged: [],
      unstaged: [],
      untracked: [],
      ahead: 0,
      behind: 0,
    };
    let headCommit = "HEAD";

    if (hasGit) {
      gitSync.watchRepo(repoPath);
      currentBranch = await gitSync.getCurrentBranch(repoPath);
      branches = await gitSync.getBranches(repoPath);
      gitStatus = await gitSync.getGitStatus(repoPath);
      headCommit = await gitSync.getHeadCommit(repoPath);
    }

    const isIndexed = graphService.isGraphAvailable(repoPath);

    const existing = this.repositories.get(repoPath);
    const info: RepositoryInfo = {
      id: Buffer.from(repoPath).toString("base64url").substring(0, 16),
      path: repoPath,
      name,
      currentBranch,
      branches,
      isDirty: !gitStatus.isClean,
      stagedCount: gitStatus.staged.length,
      unstagedCount: gitStatus.unstaged.length,
      headCommit,
      isIndexed,
      lastSyncTime: existing?.lastSyncTime || (isIndexed ? Date.now() : undefined),
      syncStatus: isIndexed ? "synced" : "outdated",
    };

    this.repositories.set(repoPath, info);
    return info;
  }
}
