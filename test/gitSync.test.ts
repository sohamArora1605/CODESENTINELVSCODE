import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { GitSyncService, GraphEngine, AtlasEngine } from "../src/git/gitSyncService";
import { makeRepo, git } from "./helpers";

export async function testGitSync(): Promise<void> {
  console.log("▶ Running GitSyncService Tests...");
  const svc = GitSyncService.getInstance();
  const { repo, origin } = makeRepo(true);

  const calls: string[] = [];
  const engine: GraphEngine = {
    async index(r) { calls.push("index"); fs.mkdirSync(path.join(r, ".codesentinel"), { recursive: true }); fs.writeFileSync(path.join(r, ".codesentinel", "atlas.db"), "graph@" + git(r, "rev-parse", "--abbrev-ref", "HEAD").trim()); return { success: true, output: "" }; },
    async sync(r) { calls.push("sync"); return { success: true, output: "" }; },
  };
  svc.setGraphEngine(engine);

  // branch validation blocks option / shell injection
  assert.strictEqual(await svc.isValidBranchName("feature/SEC-1-x"), true);
  assert.strictEqual(await svc.isValidBranchName("--upload-pack=evil"), false);
  assert.strictEqual(await svc.isValidBranchName("a b"), false);
  assert.strictEqual(await svc.isValidBranchName('x";touch pwned;"'), false);
  svc.setAutoSyncPredicate(() => false);
  await svc.createAndCheckoutBranch(repo, 'x";touch pwned;"', "main"); // legal ref chars, inert without a shell
  assert.ok(!fs.existsSync(path.join(repo, "pwned")), "branch name must never be shell-interpreted");
  await svc.checkoutBranch(repo, "main");
  svc.setAutoSyncPredicate(() => true);

  // first sync = full index, later = delta
  const first = await svc.syncCodeGraph(repo);
  assert.ok(first.success && !first.isDelta);
  const second = await svc.syncCodeGraph(repo);
  assert.ok(second.isDelta, "second sync must be incremental");
  assert.deepStrictEqual(calls, ["index", "sync"]);

  // creating a branch snapshots main's graph and delta-syncs
  const mk = await svc.createAndCheckoutBranch(repo, "feature/T-1-demo", "main");
  assert.ok(mk.success, mk.message);
  assert.strictEqual(await svc.getCurrentBranch(repo), "feature/T-1-demo");
  assert.ok(fs.existsSync(path.join(repo, ".codesentinel", "branches", "feature_T-1-demo.db")));

  // diff covers committed-on-branch + untracked + unstaged
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  git(repo, "add", "b.txt"); git(repo, "commit", "-m", "b");
  fs.writeFileSync(path.join(repo, "c.txt"), "c\n");
  fs.appendFileSync(path.join(repo, "a.txt"), "more\n");
  const files = (await svc.getModifiedFilesDiff(repo, "main")).sort();
  assert.deepStrictEqual(files, ["a.txt", "b.txt", "c.txt"]);

  // commitAll + push; protected branches never pushed
  const c = await svc.commitAll(repo, "work");
  assert.ok(c.committed);
  assert.ok(!(await svc.pushBranch(repo, "main")).success);
  const push = await svc.pushBranch(repo, "feature/T-1-demo");
  assert.ok(push.success, push.message);
  assert.ok(git(origin!, "branch", "--list", "feature/T-1-demo").includes("feature/T-1-demo"));
  assert.ok((await svc.commitAll(repo, "noop")).committed === false);

  // switching back restores main's snapshot then delta-syncs
  const before = calls.length;
  await svc.checkoutBranch(repo, "main");
  assert.ok(calls.slice(before).every((c) => c === "sync"));

  // auto-sync off => checkout does not touch the graph
  svc.setAutoSyncPredicate(() => false);
  const n = calls.length;
  await svc.checkoutBranch(repo, "feature/T-1-demo");
  assert.strictEqual(calls.length, n);
  svc.setAutoSyncPredicate(() => true);

  // parallel tickets get isolated worktrees
  const wt = await svc.ensureWorktree(repo, "T-2", "feature/T-2-other", "main");
  assert.ok(wt.success, wt.message);
  assert.strictEqual(await svc.getCurrentBranch(wt.path), "feature/T-2-other");
  assert.strictEqual(await svc.getCurrentBranch(repo), "feature/T-1-demo");
  await svc.removeWorktree(repo, "T-2");
  assert.ok(!fs.existsSync(wt.path));

  // concurrent syncs are serialized, not dropped
  const rs = await Promise.all([svc.syncCodeGraph(repo), svc.syncCodeGraph(repo)]);
  assert.ok(rs.every((r) => r.success));
  svc.setAutoSyncPredicate(() => true);

  // ---- optional: the real Atlas binary (set CODESENTINEL_TEST_ATLAS=/path/to/atlas)
  const atlasBin = process.env.CODESENTINEL_TEST_ATLAS;
  if (atlasBin && fs.existsSync(atlasBin)) {
    svc.setGraphEngine(new AtlasEngine(atlasBin));
    const { repo: r2 } = makeRepo();
    fs.writeFileSync(path.join(r2, "x.js"), "function a(){return b()}\nfunction b(){return 1}\n");
    git(r2, "add", "-A"); git(r2, "commit", "-m", "x");
    const g1 = await svc.syncCodeGraph(r2);
    assert.ok(g1.success && !g1.isDelta, g1.message);
    assert.ok(fs.existsSync(path.join(r2, ".codesentinel", "atlas.db")) && !fs.existsSync(path.join(r2, ".atlas")), "graph lives in .codesentinel only");
    await svc.createAndCheckoutBranch(r2, "feature/graph", "main");
    fs.writeFileSync(path.join(r2, "y.js"), "function c(){return a()}\n");
    git(r2, "add", "-A"); git(r2, "commit", "-m", "y");
    const g2 = await svc.syncCodeGraph(r2, "feature/graph", "feature/graph");
    assert.ok(g2.success && g2.isDelta, g2.message);
    const { GraphService } = await import("../src/graph/graphService");
    const has = (q: string) => GraphService.getInstance().searchSymbols(r2, q, 5, "callables").some((x: any) => x.name === q);
    assert.ok(has("c"), "new branch symbol indexed by delta sync");
    await svc.checkoutBranch(r2, "main");
    assert.ok(!has("c"), "main's graph restored: branch-only symbol is gone");
    assert.ok(has("a"));
    await svc.checkoutBranch(r2, "feature/graph");
    assert.ok(has("c"), "feature graph restored again");
    console.log("  ✔ real Atlas delta-sync + branch snapshots verified");
  }
  console.log("✔ GitSyncService OK");
}
