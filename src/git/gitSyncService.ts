import * as path from "path";
import * as fs from "fs";
import { GitStatus } from "../types";
import { run } from "../util/proc";
import { ensureSentinelDir } from "../config/settings";

export interface GraphSyncResult {
  repoPath: string;
  branch: string;
  success: boolean;
  /** true when only changed files were re-processed (atlas sync) rather than a full index */
  isDelta: boolean;
  restoredSnapshot: boolean;
  changedFilesCount: number;
  durationMs: number;
  message: string;
}

export const PROTECTED_BRANCHES = ["main", "master", "develop", "release", "prod", "production"];

/** Pluggable graph engine so the sync logic is testable without the Atlas binary. */
export interface GraphEngine {
  /** Full index (first time) */
  index(repoPath: string): Promise<{ success: boolean; output: string }>;
  /** Incremental update of an existing index */
  sync(repoPath: string): Promise<{ success: boolean; output: string }>;
}

export class AtlasEngine implements GraphEngine {
  constructor(private cmdOverride?: string) {}

  private async atlas(repoPath: string, sub: "index" | "sync"): Promise<{ success: boolean; output: string }> {
    const { DependencyManager } = await import("../services/dependencyManager");
    const dm = DependencyManager.getInstance();
    let cmd = this.cmdOverride;
    if (!cmd) {
      await dm.waitForDependencies();
      cmd = await dm.getAtlasCommand();
    }
    const sentinelDb = path.join(repoPath, ".codesentinel", "atlas.db");
    const atlasDir = path.join(repoPath, ".atlas");
    const atlasDb = path.join(atlasDir, "atlas.db");
    // Atlas looks for .atlas/atlas.db; we keep the canonical copy in .codesentinel/
    if (fs.existsSync(sentinelDb)) {
      fs.mkdirSync(atlasDir, { recursive: true });
      fs.copyFileSync(sentinelDb, atlasDb);
    }
    const r = await run(cmd, [sub], { cwd: repoPath, timeoutMs: 180000, env: dm.getEnvWithBinPath() });
    if (fs.existsSync(atlasDb)) {
      fs.mkdirSync(path.dirname(sentinelDb), { recursive: true });
      fs.copyFileSync(atlasDb, sentinelDb);
      fs.rmSync(atlasDir, { recursive: true, force: true });
    }
    return { success: r.code === 0, output: (r.stdout || r.stderr).trim() };
  }
  index(repoPath: string) {
    return this.atlas(repoPath, "index");
  }
  sync(repoPath: string) {
    return this.atlas(repoPath, "sync");
  }
}

export class GitSyncService {
  private static instance: GitSyncService;
  private headWatchers: Map<string, fs.FSWatcher[]> = new Map();
  private lastKnown: Map<string, { branch: string; head: string }> = new Map();
  private queues: Map<string, Promise<unknown>> = new Map();
  private debounce: Map<string, NodeJS.Timeout> = new Map();
  private listeners: Array<(result: GraphSyncResult) => void> = [];
  private branchChangeListeners: Array<(repoPath: string, newBranch: string) => void> = [];
  private engine: GraphEngine = new AtlasEngine();
  private autoSyncEnabled: () => boolean = () => true;

  private constructor() {}

  public static getInstance(): GitSyncService {
    if (!GitSyncService.instance) {
      GitSyncService.instance = new GitSyncService();
    }
    return GitSyncService.instance;
  }

  /** Test / host hooks */
  public setGraphEngine(engine: GraphEngine): void {
    this.engine = engine;
  }
  public setAutoSyncPredicate(fn: () => boolean): void {
    this.autoSyncEnabled = fn;
  }

  public onDidSyncGraph(listener: (result: GraphSyncResult) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  public onDidBranchChange(listener: (repoPath: string, newBranch: string) => void): () => void {
    this.branchChangeListeners.push(listener);
    return () => {
      this.branchChangeListeners = this.branchChangeListeners.filter((l) => l !== listener);
    };
  }

  // ---------------------------------------------------------------- git helpers
  private git(repoPath: string, args: string[], timeoutMs = 60000) {
    return run("git", args, { cwd: repoPath, timeoutMs });
  }

  public isGitRepo(repoPath: string): boolean {
    return fs.existsSync(path.join(repoPath, ".git"));
  }

  /** Validates with git's own ref-format rules; also rejects leading '-' (option injection). */
  public async isValidBranchName(name: string): Promise<boolean> {
    if (!name || name.startsWith("-") || /\s/.test(name)) return false;
    const r = await run("git", ["check-ref-format", "--branch", name]);
    return r.code === 0;
  }

  public async getCurrentBranch(repoPath: string): Promise<string> {
    if (!this.isGitRepo(repoPath)) return "main";
    const r = await this.git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const out = r.stdout.trim();
    if (r.code === 0 && out) return out;
    // Unborn branch (no commits yet)
    const s = await this.git(repoPath, ["symbolic-ref", "--short", "HEAD"]);
    return s.stdout.trim() || "main";
  }

  public async getBranches(repoPath: string, includeRemote = true): Promise<string[]> {
    if (!this.isGitRepo(repoPath)) return ["main"];
    const refs = includeRemote ? ["refs/heads", "refs/remotes"] : ["refs/heads"];
    const r = await this.git(repoPath, ["for-each-ref", "--format=%(refname:short)", ...refs]);
    const set = new Set<string>();
    for (const line of r.stdout.split("\n")) {
      const b = line.trim();
      if (!b || b.endsWith("/HEAD") || b === "origin") continue;
      set.add(b);
    }
    return set.size ? Array.from(set) : ["main"];
  }

  public async branchExists(repoPath: string, branch: string): Promise<boolean> {
    const r = await this.git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return r.code === 0;
  }

  public async getGitStatus(repoPath: string): Promise<GitStatus> {
    const empty: GitStatus = { branch: "main", isClean: true, staged: [], unstaged: [], untracked: [], ahead: 0, behind: 0 };
    if (!this.isGitRepo(repoPath)) return empty;
    const r = await this.git(repoPath, ["status", "--porcelain=v1", "-b", "-uall"]);
    if (r.code !== 0) return empty;
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];
    let ahead = 0;
    let behind = 0;
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      if (line.startsWith("##")) {
        ahead = Number(line.match(/ahead (\d+)/)?.[1] ?? 0);
        behind = Number(line.match(/behind (\d+)/)?.[1] ?? 0);
        continue;
      }
      const x = line[0];
      const y = line[1];
      const file = line.substring(3).trim();
      if (x === "?" && y === "?") untracked.push(file);
      else {
        if (x !== " ") staged.push(file);
        if (y !== " ") unstaged.push(file);
      }
    }
    return {
      branch: await this.getCurrentBranch(repoPath),
      isClean: !staged.length && !unstaged.length && !untracked.length,
      staged,
      unstaged,
      untracked,
      ahead,
      behind,
    };
  }

  public async getHeadCommit(repoPath: string): Promise<string> {
    if (!this.isGitRepo(repoPath)) return "HEAD";
    const r = await this.git(repoPath, ["rev-parse", "--short", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : "HEAD";
  }

  public async createAndCheckoutBranch(
    repoPath: string,
    branchName: string,
    baseBranch = "main"
  ): Promise<{ success: boolean; message: string }> {
    if (!this.isGitRepo(repoPath)) return { success: false, message: "Target directory is not a Git repository." };
    const safe = branchName.trim().replace(/\s+/g, "-");
    if (!(await this.isValidBranchName(safe))) {
      return { success: false, message: `Invalid branch name '${branchName}'.` };
    }
    if (await this.branchExists(repoPath, safe)) {
      const co = await this.git(repoPath, ["checkout", safe]);
      if (co.code !== 0) return { success: false, message: `Failed to checkout '${safe}': ${co.stderr.trim()}` };
      await this.notifyBranchSwitched(repoPath, safe);
      return { success: true, message: `Switched to existing branch '${safe}'.` };
    }
    const base = await this.resolveBase(repoPath, baseBranch);
    const args = ["checkout", "-b", safe, ...(base ? [base] : [])];
    const r = await this.git(repoPath, args);
    if (r.code !== 0) return { success: false, message: `Failed to create branch: ${r.stderr.trim()}` };
    await this.notifyBranchSwitched(repoPath, safe);
    return { success: true, message: `Created branch '${safe}'${base ? ` from '${base}'` : ""}.` };
  }

  /** Resolves a base to a local ref, falling back to origin/<base>. Returns undefined to use HEAD. */
  public async resolveBase(repoPath: string, baseBranch: string): Promise<string | undefined> {
    if (!baseBranch) return undefined;
    for (const ref of [baseBranch, `origin/${baseBranch}`]) {
      const r = await this.git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      if (r.code === 0) return ref;
    }
    return undefined;
  }

  public async checkoutBranch(repoPath: string, branchName: string): Promise<{ success: boolean; message: string }> {
    if (!this.isGitRepo(repoPath)) return { success: false, message: "Target directory is not a Git repository." };
    if (!(await this.isValidBranchName(branchName))) return { success: false, message: `Invalid branch name '${branchName}'.` };
    const r = await this.git(repoPath, ["checkout", branchName]);
    if (r.code !== 0) return { success: false, message: `Failed to checkout branch: ${r.stderr.trim()}` };
    await this.notifyBranchSwitched(repoPath, branchName);
    return { success: true, message: `Checked out branch '${branchName}'.` };
  }

  /** Files changed on the branch vs base plus the working tree (staged, unstaged, untracked). */
  public async getModifiedFilesDiff(repoPath: string, baseBranch = "main"): Promise<string[]> {
    if (!this.isGitRepo(repoPath)) return [];
    const files = new Set<string>();
    const add = (out: string) => out.split("\n").map((f) => f.trim()).filter(Boolean).forEach((f) => files.add(f));
    add((await this.git(repoPath, ["diff", "--name-only", "HEAD"])).stdout);
    add((await this.git(repoPath, ["ls-files", "--others", "--exclude-standard"])).stdout);
    const base = await this.resolveBase(repoPath, baseBranch);
    if (base) add((await this.git(repoPath, ["diff", "--name-only", `${base}...HEAD`])).stdout);
    return Array.from(files);
  }

  public async getDiffContent(repoPath: string, baseBranch = "main"): Promise<string> {
    if (!this.isGitRepo(repoPath)) return "";
    const base = await this.resolveBase(repoPath, baseBranch);
    let out = "";
    if (base) out += (await this.git(repoPath, ["diff", `${base}...HEAD`])).stdout;
    out += (await this.git(repoPath, ["diff", "HEAD"])).stdout;
    return out;
  }

  /** Stage everything and commit. Returns false (not an error) when there is nothing to commit. */
  public async commitAll(repoPath: string, message: string): Promise<{ success: boolean; committed: boolean; message: string }> {
    const st = await this.getGitStatus(repoPath);
    if (st.isClean) return { success: true, committed: false, message: "Nothing to commit." };
    await this.git(repoPath, ["add", "-A"]);
    const r = await this.git(repoPath, [
      "-c", "user.name=CodeSentinel Bot", "-c", "user.email=bot@codesentinel.local",
      "commit", "-m", message,
    ]);
    // Respect a configured identity if the developer has one
    if (r.code !== 0 && /unable to auto-detect|Please tell me who you are/i.test(r.stderr)) {
      return { success: false, committed: false, message: r.stderr.trim() };
    }
    return r.code === 0
      ? { success: true, committed: true, message: r.stdout.trim().split("\n")[0] }
      : { success: false, committed: false, message: r.stderr.trim() || r.stdout.trim() };
  }

  public async pushBranch(repoPath: string, branchName: string, remote = "origin"): Promise<{ success: boolean; message: string }> {
    if (!this.isGitRepo(repoPath)) return { success: false, message: "Target directory is not a Git repository." };
    if (PROTECTED_BRANCHES.includes(branchName.toLowerCase())) {
      return { success: false, message: `Blocked: '${branchName}' is a protected branch. Only feature branches are pushed.` };
    }
    if (!(await this.isValidBranchName(branchName))) return { success: false, message: `Invalid branch name '${branchName}'.` };
    const r = await this.git(repoPath, ["push", "-u", remote, `refs/heads/${branchName}:refs/heads/${branchName}`], 120000);
    return r.code === 0
      ? { success: true, message: (r.stderr || r.stdout).trim() || `Pushed '${branchName}' to '${remote}'.` }
      : { success: false, message: `Git push failed: ${(r.stderr || r.stdout).trim()}` };
  }

  // ---------------------------------------------------------------- worktrees (parallel tickets)
  public getWorktreePath(repoPath: string, key: string): string {
    return path.join(repoPath, ".codesentinel", "worktrees", key.replace(/[^A-Za-z0-9._-]/g, "_"));
  }

  /** Creates (or reuses) an isolated checkout for a branch so several tickets can run at once. */
  public async ensureWorktree(
    repoPath: string,
    key: string,
    branch: string,
    baseBranch: string
  ): Promise<{ success: boolean; path: string; message: string }> {
    const wt = this.getWorktreePath(repoPath, key);
    if (fs.existsSync(path.join(wt, ".git"))) return { success: true, path: wt, message: "Reusing worktree." };
    if (!(await this.isValidBranchName(branch))) return { success: false, path: wt, message: `Invalid branch name '${branch}'.` };
    if (fs.existsSync(wt)) {
      try {
        fs.rmSync(wt, { recursive: true, force: true });
        await this.git(repoPath, ["worktree", "prune"]);
      } catch {}
    }
    ensureSentinelDir(repoPath);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    let r;
    if (await this.branchExists(repoPath, branch)) {
      r = await this.git(repoPath, ["worktree", "add", wt, branch]);
    } else {
      const base = await this.resolveBase(repoPath, baseBranch);
      r = await this.git(repoPath, ["worktree", "add", "-b", branch, wt, ...(base ? [base] : [])]);
    }
    return r.code === 0
      ? { success: true, path: wt, message: `Worktree ready on '${branch}'.` }
      : { success: false, path: wt, message: r.stderr.trim() };
  }

  /** Deletes a LOCAL branch. Refuses protected branches and the branch currently checked out. */
  public async deleteBranch(repoPath: string, branch: string): Promise<{ success: boolean; message: string }> {
    if (PROTECTED_BRANCHES.includes(branch.toLowerCase())) return { success: false, message: `Refusing to delete protected branch '${branch}'.` };
    if (!(await this.isValidBranchName(branch))) return { success: false, message: `Invalid branch name '${branch}'.` };
    if (!(await this.branchExists(repoPath, branch))) return { success: true, message: `Branch '${branch}' does not exist locally.` };
    if ((await this.getCurrentBranch(repoPath)) === branch) return { success: false, message: `'${branch}' is checked out; switch branches first.` };
    const r = await this.git(repoPath, ["branch", "-D", branch]);
    return r.code === 0 ? { success: true, message: `Deleted local branch '${branch}'.` } : { success: false, message: r.stderr.trim() || r.stdout.trim() };
  }

  public async removeWorktree(repoPath: string, key: string): Promise<void> {
    const wt = this.getWorktreePath(repoPath, key);
    if (fs.existsSync(wt)) await this.git(repoPath, ["worktree", "remove", "--force", wt]);
    if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true }); // not registered with git any more, or removal failed
    await this.git(repoPath, ["worktree", "prune"]);
  }

  // ---------------------------------------------------------------- watching
  /** Watches HEAD (branch switch) and the branch ref log (commit/pull/merge/rebase). */
  public watchRepo(repoPath: string): void {
    if (this.headWatchers.has(repoPath) || !this.isGitRepo(repoPath)) return;
    const gitDir = path.join(repoPath, ".git");
    if (!fs.statSync(gitDir).isDirectory()) return; // worktree/submodule pointer file
    const targets = [path.join(gitDir, "HEAD"), path.join(gitDir, "logs", "HEAD")].filter((p) => fs.existsSync(p));
    const watchers: fs.FSWatcher[] = [];

    const check = async () => {
      const branch = await this.getCurrentBranch(repoPath);
      const head = await this.getHeadCommit(repoPath);
      const prev = this.lastKnown.get(repoPath);
      if (prev && prev.branch === branch && prev.head === head) return;
      this.lastKnown.set(repoPath, { branch, head });
      if (!prev) return;
      if (prev.branch !== branch) {
        for (const l of this.branchChangeListeners) try { l(repoPath, branch); } catch {}
      }
      if (this.autoSyncEnabled()) {
        await this.syncCodeGraph(repoPath, branch, prev.branch !== branch ? prev.branch : undefined);
      }
    };
    const schedule = () => {
      clearTimeout(this.debounce.get(repoPath));
      this.debounce.set(repoPath, setTimeout(() => void check().catch(() => {}), 400));
    };

    Promise.all([this.getCurrentBranch(repoPath), this.getHeadCommit(repoPath)]).then(([branch, head]) => {
      if (!this.lastKnown.has(repoPath)) this.lastKnown.set(repoPath, { branch, head });
    });
    for (const t of targets) {
      try { watchers.push(fs.watch(t, schedule)); } catch {}
    }
    this.headWatchers.set(repoPath, watchers);
  }

  public unwatchRepo(repoPath: string): void {
    for (const w of this.headWatchers.get(repoPath) ?? []) try { w.close(); } catch {}
    this.headWatchers.delete(repoPath);
    clearTimeout(this.debounce.get(repoPath));
    this.debounce.delete(repoPath);
    this.lastKnown.delete(repoPath);
  }

  public dispose(): void {
    for (const p of Array.from(this.headWatchers.keys())) this.unwatchRepo(p);
  }

  private async notifyBranchSwitched(repoPath: string, branch: string): Promise<void> {
    const prev = this.lastKnown.get(repoPath);
    for (const l of this.branchChangeListeners) try { l(repoPath, branch); } catch {}
    if (this.autoSyncEnabled()) await this.syncCodeGraph(repoPath, branch, prev?.branch);
    this.lastKnown.set(repoPath, { branch, head: await this.getHeadCommit(repoPath) });
  }

  // ---------------------------------------------------------------- graph sync
  /**
   * Per-repo serialized graph sync:
   *   1. snapshot the outgoing branch's graph
   *   2. restore the incoming branch's snapshot if it exists
   *   3. `atlas sync` (content-hash delta) if a graph exists, otherwise a one-time `atlas index`
   *   4. snapshot the result
   * so only files that actually differ get re-processed.
   */
  public syncCodeGraph(repoPath: string, branch?: string, previousBranch?: string): Promise<GraphSyncResult> {
    const prior = this.queues.get(repoPath) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.doSync(repoPath, branch, previousBranch));
    this.queues.set(repoPath, next);
    return next;
  }

  private async doSync(repoPath: string, branch?: string, previousBranch?: string): Promise<GraphSyncResult> {
    const start = Date.now();
    const effective = branch || (await this.getCurrentBranch(repoPath));
    const sentinelDir = path.join(repoPath, ".codesentinel");
    const branchesDir = path.join(sentinelDir, "branches");
    const activeDb = path.join(sentinelDir, "atlas.db");
    const snap = (b: string) => path.join(branchesDir, `${this.sanitizeBranchName(b)}.db`);

    try {
      fs.mkdirSync(branchesDir, { recursive: true });
      const gi = path.join(sentinelDir, ".gitignore");
      if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n");

      if (previousBranch && previousBranch !== effective && fs.existsSync(activeDb)) {
        fs.copyFileSync(activeDb, snap(previousBranch));
      }
      let restored = false;
      if (previousBranch !== effective && fs.existsSync(snap(effective))) {
        fs.copyFileSync(snap(effective), activeDb);
        restored = true;
      }

      const changed = await this.getModifiedFilesDiff(repoPath);
      const hasGraph = fs.existsSync(activeDb);
      const res = hasGraph ? await this.engine.sync(repoPath) : await this.engine.index(repoPath);

      if (res.success && fs.existsSync(activeDb)) fs.copyFileSync(activeDb, snap(effective));

      const out: GraphSyncResult = {
        repoPath,
        branch: effective,
        success: res.success,
        isDelta: hasGraph,
        restoredSnapshot: restored,
        changedFilesCount: changed.length,
        durationMs: Date.now() - start,
        message: res.success
          ? hasGraph
            ? `Delta-synced '${effective}'${restored ? " from cached branch graph" : ""} (${changed.length} changed file(s)).`
            : `Built initial graph for '${effective}'.`
          : `Graph sync failed: ${res.output}`,
      };
      for (const l of this.listeners) try { l(out); } catch {}
      return out;
    } catch (err: any) {
      const out: GraphSyncResult = {
        repoPath, branch: effective, success: false, isDelta: false, restoredSnapshot: false,
        changedFilesCount: 0, durationMs: Date.now() - start, message: `Graph sync failed: ${err.message}`,
      };
      for (const l of this.listeners) try { l(out); } catch {}
      return out;
    }
  }

  private sanitizeBranchName(branch: string): string {
    return branch.replace(/[\/\\?%*:|"<>]/g, "_");
  }
}
