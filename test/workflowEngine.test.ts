import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { WorkflowEngine } from "../src/agent/workflowEngine";
import { AgentExecutor, AgentRunRequest } from "../src/agent/agentRunner";
import { GitSyncService } from "../src/git/gitSyncService";
import { setSettingsOverrides, setRepoConfig } from "../src/config/settings";
import { makeRepo, git, FIXTURE_TICKETS } from "./helpers";
import { JiraService } from "../src/jira/jiraService";

/** Scripted agent: developer introduces eval(), tester calls it genuine, fixer removes it. */
function scriptedAgent(opts: { develop?: "vuln" | "nothing"; fixWorks?: boolean } = {}): AgentExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(req: AgentRunRequest) {
      calls.push(req.role);
      req.onActivity?.(`working as ${req.role}`);
      const f = path.join(req.cwd, "feature.js");
      switch (req.role) {
        case "planner": return { success: true, output: "PLAN: add feature.js", code: 0, harness: "claude-code", model: "test-model" };
        case "developer":
          if (opts.develop !== "nothing") fs.writeFileSync(f, "module.exports = (x) => eval(x);\n");
          return { success: true, output: "ok", code: 0, harness: "claude-code" };
        case "tester": {
          const id = /"id": "([^"]+)"/.exec(req.prompt)?.[1];
          return { success: true, output: id ? `triage\n{"findings":[{"id":"${id}","verdict":"genuine","reason":"eval of input"}]}` : "wrote tests", code: 0, harness: "claude-code" };
        }
        case "fixer":
          if (opts.fixWorks !== false) fs.writeFileSync(f, "module.exports = (x) => JSON.parse(x);\n");
          return { success: true, output: "fixed", code: 0, harness: "claude-code" };
      }
    },
  };
}

const scan = async (workDir: string, files: string[]) =>
  files.filter((f) => f === "feature.js" && fs.readFileSync(path.join(workDir, f), "utf-8").includes("eval(")).map((f) => ({
    id: "F1", title: "eval injection", severity: "High", cwe: "CWE-95", category: "Injection", filePath: f, line: 1, endLine: 1,
    snippet: "eval(x)", description: "", remediation: "", tools: ["test"],
  } as any));
const verify = async () => ({ verdict: "CANDIDATE", reason: "undecided" });

export async function testWorkflowEngine(): Promise<void> {
  console.log("▶ Running WorkflowEngine Tests...");
  JiraService.getInstance().setLocalTickets(FIXTURE_TICKETS as any);
  const engine = WorkflowEngine.getInstance();
  const git_ = GitSyncService.getInstance();
  git_.setGraphEngine({ index: async () => ({ success: true, output: "" }), sync: async () => ({ success: true, output: "" }) });
  engine.setSecurityHooks({ scan, verify });
  setSettingsOverrides({ "jira.mode": "disabled", "workflow.useWorktrees": true, "workflow.autoPush": false, "workflow.pauseMode": "none", "workflow.maxFixIterations": 2 });

  const { repo, origin } = makeRepo(true);
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: `node -e "console.log('Tests: 2 passed, 2 total')"` } }));
  git(repo, "add", "-A"); git(repo, "commit", "-m", "pkg"); git(repo, "push", "origin", "main");

  // ---- happy path with a scan → triage → fix loop and a push-approval gate
  const agent = scriptedAgent();
  engine.setAgentExecutor(agent);
  const wf = await engine.start("SEC-101", repo, { baseBranch: "main" });
  assert.strictEqual(wf.status, "paused", wf.logs.join("\n"));
  assert.strictEqual(wf.awaiting, "push_approval");
  assert.strictEqual(wf.iteration, 1, "one fix iteration");
  assert.deepStrictEqual(agent.calls, ["planner", "developer", "tester", "fixer"]);
  assert.ok(wf.workDir.includes(path.join(".codesentinel", "worktrees")), "ticket runs in an isolated worktree");
  assert.strictEqual(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main", "user's checkout untouched");
  assert.ok(!fs.existsSync(path.join(repo, "feature.js")));
  assert.strictEqual(wf.verificationResults.genuineCount, 0);
  assert.ok(fs.readFileSync(path.join(wf.workDir, "feature.js"), "utf-8").includes("JSON.parse"));
  assert.ok(wf.steps.find((s) => s.id === "stage_test")!.status === "skipped", "unconfigured suites are skipped, not faked");
  assert.ok(git(wf.workDir, "log", "-1", "--format=%s").includes("SEC-101"), "committed locally");
  assert.ok(!git(origin!, "branch", "--list").includes(wf.targetBranch), "nothing pushed before approval");

  // persisted for UI / MCP / other windows
  assert.ok(fs.existsSync(path.join(repo, ".codesentinel", "workflows", "SEC-101.json")));

  const done = await engine.resume("SEC-101", repo);
  assert.strictEqual(done.status, "completed", done.logs.join("\n"));
  assert.ok(git(origin!, "branch", "--list").includes(wf.targetBranch));
  assert.strictEqual((await (await import("../src/jira/jiraService")).JiraService.getInstance().getTicket("SEC-101"))!.status, "In Review");

  // ---- two tickets in parallel, same repo
  const a2 = scriptedAgent({ fixWorks: true });
  engine.setAgentExecutor(a2);
  setSettingsOverrides({ "jira.mode": "disabled", "workflow.useWorktrees": true, "workflow.autoPush": true, "workflow.pauseMode": "none", "workflow.maxFixIterations": 2 });
  const [w1, w2] = await Promise.all([engine.start("AUTH-204", repo, { baseBranch: "main" }), engine.start("API-302", repo, { baseBranch: "main" })]);
  assert.strictEqual(w1.status, "completed", w1.logs.join("\n"));
  assert.strictEqual(w2.status, "completed", w2.logs.join("\n"));
  assert.notStrictEqual(w1.workDir, w2.workDir);
  const remote = git(origin!, "branch", "--list");
  assert.ok(remote.includes(w1.targetBranch) && remote.includes(w2.targetBranch));

  // ---- developer that changes nothing fails honestly
  engine.setAgentExecutor(scriptedAgent({ develop: "nothing" }));
  const w3 = await engine.start("FE-405", repo, { baseBranch: "main" });
  assert.strictEqual(w3.status, "failed");
  assert.match(w3.steps.find((s) => s.id === "develop")!.error || "", /without changing any files/);
  await engine.discard("FE-405", repo);

  // ---- fix loop gives up after max iterations and does not push
  engine.setAgentExecutor(scriptedAgent({ fixWorks: false }));
  setRepoConfig(repo, { baseBranches: ["main"] });
  const w4 = await engine.start("SEC-101", repo, { targetBranch: "feature/SEC-101-retry", maxIterations: 1 });
  assert.strictEqual(w4.status, "failed");
  assert.match(w4.steps.find((s) => s.id === "verify_test")!.error || "", /needs a developer/);
  assert.ok(!git(origin!, "branch", "--list").includes("feature/SEC-101-retry"));

  // ---- cancel while paused for plan approval
  engine.setAgentExecutor(scriptedAgent());
  const w5 = await engine.start("API-302", repo, { targetBranch: "feature/API-302-approve", requirePlanApproval: true });
  assert.strictEqual(w5.awaiting, "plan_approval");
  assert.ok(engine.cancel("API-302", repo));
  assert.strictEqual(engine.getWorkflow("API-302", repo)!.status, "cancelled");

  // ---- custom task (Jira disabled): no lookup, runs from the supplied description
  setSettingsOverrides({ "jira.mode": "disabled", "workflow.useWorktrees": true, "workflow.autoPush": true, "workflow.pauseMode": "none", "workflow.maxFixIterations": 2 });
  engine.setAgentExecutor(scriptedAgent());
  const custom = { key: "TASK-42", summary: "Add input validation", description: "validate ids", status: "To Do", priority: "Medium", issueType: "Task", labels: [], components: [] };
  const w6 = await engine.start("TASK-42", repo, { baseBranch: "main", ticket: custom });
  assert.strictEqual(w6.status, "completed", w6.logs.join("\n"));
  assert.ok(w6.targetBranch.startsWith("feature/TASK-42-add-input-validation"), w6.targetBranch);
  assert.strictEqual(w6.ticketDescription, "validate ids");

  // ---- activity, agent/model per stage and stage output are recorded for the UI
  const w1b = engine.getWorkflow("AUTH-204", repo)!;
  assert.ok((w1b.activity ?? []).some((l) => l.includes("[developer] working as developer")), "live activity captured");
  const planStep = w1b.steps.find((x) => x.id === "plan")!;
  assert.deepStrictEqual(planStep.agents, [{ role: "planner", harness: "claude-code", model: "test-model", effort: "medium" }], "role, harness, model and effort recorded per stage");
  assert.ok((planStep.output ?? "").includes("PLAN: add feature.js"));
  assert.strictEqual(w1b.currentAgent, undefined, "no agent running after completion");

  // ---- default pause mode ("gates"): stops for plan approval, then before push
  setSettingsOverrides({ "jira.mode": "disabled", "workflow.useWorktrees": true, "workflow.autoPush": false, "workflow.maxFixIterations": 2 });
  engine.setAgentExecutor(scriptedAgent());
  const g = await engine.start("KG-1", repo, { baseBranch: "main", targetBranch: "feature/KG-1-gates", ticket: { ...custom, key: "KG-1" } });
  assert.strictEqual(g.awaiting, "plan_approval", "default is to pause after the plan");
  assert.ok(!g.steps.find((x) => x.id === "develop")!.startedAt, "no code written before approval");
  const g2 = await engine.resume("KG-1", repo);
  assert.strictEqual(g2.awaiting, "push_approval");

  // ---- every_stage: pauses between stages until told to continue
  const es = await engine.start("KG-2", repo, { baseBranch: "main", targetBranch: "feature/KG-2-stages", pauseMode: "every_stage", ticket: { ...custom, key: "KG-2" } });
  const gates: string[] = [es.awaiting!];
  let cur = es;
  for (let i = 0; i < 12 && cur.status === "paused" && cur.awaiting !== "push_approval"; i++) {
    cur = await engine.resume("KG-2", repo);
    gates.push(cur.awaiting ?? cur.status);
  }
  assert.strictEqual(cur.awaiting, "push_approval");
  assert.ok(gates.filter((x) => x === "stage_approval").length >= 3, `expected several stage pauses, got ${gates.join(",")}`);

  // ---- stages can be switched off per run and via settings
  setSettingsOverrides({ "jira.mode": "disabled", "workflow.useWorktrees": true, "workflow.autoPush": false, "workflow.pauseMode": "none", "workflow.maxFixIterations": 2 });
  const ag = scriptedAgent();
  engine.setAgentExecutor(ag);
  const noPlan = await engine.start("ST-1", repo, { baseBranch: "main", targetBranch: "feature/ST-1-noplan", stages: { plan: false, diff_scan: false }, ticket: { ...custom, key: "ST-1" } });
  assert.strictEqual(noPlan.steps.find((x) => x.id === "plan")!.status, "skipped");
  assert.strictEqual(noPlan.steps.find((x) => x.id === "diff_scan")!.status, "skipped");
  assert.match(noPlan.steps.find((x) => x.id === "plan")!.summary || "", /Disabled/);
  assert.ok(!ag.calls.includes("planner"), "a disabled stage never runs its agent");
  assert.ok(ag.calls.includes("developer"));
  setSettingsOverrides({ "jira.mode": "disabled", "workflow.useWorktrees": true, "workflow.autoPush": false, "workflow.pauseMode": "none", "workflow.stages": { develop: false, push_branch: false } });
  const noDev = await engine.start("ST-2", repo, { baseBranch: "main", targetBranch: "feature/ST-2-nodev", ticket: { ...custom, key: "ST-2" } });
  assert.strictEqual(noDev.steps.find((x) => x.id === "develop")!.status, "skipped", "settings switch stages off too");
  assert.strictEqual(noDev.status, "completed", "with push disabled the workflow just ends");
  setSettingsOverrides({ "jira.mode": "disabled", "workflow.useWorktrees": true, "workflow.autoPush": false, "workflow.pauseMode": "none", "workflow.maxFixIterations": 2 });

  // ---- skip: a failed developer step can be skipped and the workflow carries on
  engine.setAgentExecutor(scriptedAgent({ develop: "nothing" }));
  const stuck = await engine.start("SK-1", repo, { baseBranch: "main", targetBranch: "feature/SK-1-skip", ticket: { ...custom, key: "SK-1" } });
  assert.strictEqual(stuck.status, "failed");
  const skipped = await engine.skip("SK-1", repo);
  assert.strictEqual(skipped.steps.find((x) => x.id === "develop")!.status, "skipped");
  assert.match(skipped.steps.find((x) => x.id === "develop")!.summary || "", /Skipped by developer/);
  assert.strictEqual(skipped.awaiting, "push_approval", "continued through the remaining stages to the push gate");
  await assert.rejects(engine.skip("SK-1", repo), /Nothing to skip/, "skipping must never approve a push");
  await assert.rejects(engine.skip("TASK-42", repo), /There is no failed/i);
  await assert.rejects(engine.skip("NO-SUCH-1", repo), /no workflow/i);

  // ---- nextStep: advance to the next step when a stage failed or was stopped
  const stuck2 = await engine.start("NX-1", repo, { baseBranch: "main", targetBranch: "feature/NX-1-next", ticket: { ...custom, key: "NX-1" } });
  assert.strictEqual(stuck2.status, "failed");
  const advanced = await engine.nextStep("NX-1", repo);
  assert.strictEqual(advanced.steps.find((x) => x.id === "develop")!.status, "completed");
  assert.match(advanced.steps.find((x) => x.id === "develop")!.summary || "", /Continued by/);
  assert.strictEqual(advanced.awaiting, "push_approval");
  await engine.discard("NX-1", repo);

  // ---- stages: pull_ticket and cut_branch can also be switched off
  const noCut = await engine.start("ST-3", repo, { baseBranch: "main", targetBranch: "feature/ST-3-nocut", stages: { pull_ticket: false, cut_branch: false }, ticket: { ...custom, key: "ST-3" } });
  assert.strictEqual(noCut.steps.find((x) => x.id === "pull_ticket")!.status, "skipped");
  assert.strictEqual(noCut.steps.find((x) => x.id === "cut_branch")!.status, "skipped");
  await engine.discard("ST-3", repo);

  // ---- discard: worktree, local branch and record are gone; remote and Jira untouched
  const keep = git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
  const sk = engine.getWorkflow("SK-1", repo)!;
  assert.ok(fs.existsSync(sk.workDir) && git(repo, "branch", "--list", sk.targetBranch).includes(sk.targetBranch));
  const gone = await engine.discard("SK-1", repo);
  assert.ok(gone.removed.some((x) => x.startsWith("worktree")) && gone.removed.some((x) => x.includes(sk.targetBranch)));
  assert.ok(!fs.existsSync(sk.workDir), "worktree directory removed");
  assert.strictEqual(git(repo, "branch", "--list", sk.targetBranch).trim(), "", "local branch deleted");
  assert.ok(!fs.existsSync(path.join(repo, ".codesentinel", "workflows", "SK-1.json")), "record deleted");
  assert.strictEqual(engine.getWorkflow("SK-1", repo), undefined);
  assert.strictEqual(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim(), keep, "main checkout untouched");
  assert.ok(gone.notes.some((n) => /Jira ticket/.test(n)));
  await assert.rejects(engine.discard("SK-1", repo), /No workflow/);
  // a pushed branch: remote copy is reported, not deleted
  const pushedWf = engine.getWorkflow("AUTH-204", repo)!;
  const pushedRes = await engine.discard("AUTH-204", repo);
  assert.ok(pushedRes.notes.some((n) => /NOT deleted there/.test(n)), "remote branch is never deleted automatically");
  assert.ok(git(origin!, "branch", "--list", pushedWf.targetBranch).includes(pushedWf.targetBranch), "remote branch still there");

  // ---- discard in place: refuses when the user's own checkout has uncommitted work, works when clean
  setSettingsOverrides({ "jira.mode": "disabled", "workflow.useWorktrees": false, "workflow.autoPush": false, "workflow.pauseMode": "none", "workflow.maxFixIterations": 2 });
  engine.setAgentExecutor(scriptedAgent());
  const inPlace = await engine.start("IP-1", repo, { baseBranch: "main", targetBranch: "feature/IP-1-inplace", ticket: { ...custom, key: "IP-1" } });
  assert.strictEqual(inPlace.awaiting, "push_approval");
  assert.strictEqual(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim(), "feature/IP-1-inplace");
  fs.writeFileSync(path.join(repo, "mine.txt"), "my own uncommitted work\n");
  await assert.rejects(engine.discard("IP-1", repo), /uncommitted changes/);
  assert.ok(fs.existsSync(path.join(repo, "mine.txt")), "nothing deleted when refusing");
  fs.unlinkSync(path.join(repo, "mine.txt"));
  const ipRes = await engine.discard("IP-1", repo);
  assert.ok(ipRes.notes.some((n) => /Switched back to 'main'/.test(n)));
  assert.strictEqual(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main");
  assert.strictEqual(git(repo, "branch", "--list", "feature/IP-1-inplace").trim(), "");
  setSettingsOverrides({ "jira.mode": "disabled", "workflow.useWorktrees": true, "workflow.autoPush": true, "workflow.pauseMode": "none", "workflow.maxFixIterations": 2 });

  // ---- invalid input is rejected before touching git
  await assert.rejects(engine.start("NOPE-1", repo), /not found/);
  await assert.rejects(engine.start("SEC-101", repo, { targetBranch: "bad branch name" }), /not a valid git branch/);

  // ---- state survives a restart (fresh load from disk)
  const loaded = engine.loadRepo(repo);
  assert.ok(loaded.find((w) => w.ticketKey === "ST-2")!.status === "completed");

  // ---- another process's running workflow is shown as running; a dead one is shown as interrupted
  const { spawnSync, spawn } = await import("child_process");
  const base = JSON.parse(fs.readFileSync(path.join(repo, ".codesentinel", "workflows", "ST-2.json"), "utf-8"));
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" });
  const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid!;
  const write = (key: string, pid: number) => fs.writeFileSync(path.join(repo, ".codesentinel", "workflows", `${key}.json`),
    JSON.stringify({ ...base, id: `${path.basename(repo)}:${key}`, ticketKey: key, status: "running", pid, steps: base.steps.map((s: any, i: number) => (i === 4 ? { ...s, status: "running" } : s)) }));
  write("ELSE-1", sleeper.pid!);
  write("GONE-1", deadPid);
  const seenWf = engine.loadRepo(repo);
  assert.strictEqual(seenWf.find((w) => w.ticketKey === "ELSE-1")!.status, "running", "live foreign process => still running");
  assert.strictEqual(seenWf.find((w) => w.ticketKey === "GONE-1")!.status, "paused", "dead process => interrupted");
  assert.ok(engine.hasActive([repo]));
  sleeper.kill();

  // ---- Antigravity model & effort harmonization in workflow execution
  let observedAgentDuringRun: any;
  engine.setAgentExecutor({
    async run(req) {
      const activeWf = engine.getWorkflow("AGY-1", repo);
      observedAgentDuringRun = activeWf?.currentAgent ? { ...activeWf.currentAgent } : undefined;
      return { success: true, output: "ok", code: 0, harness: "gemini-antigravity" };
    },
  });
  const agyWf = await engine.start("AGY-1", repo, {
    baseBranch: "main",
    harness: "gemini-antigravity",
    model: "gemini-3.8-flash-high",
    effort: "medium",
    ticket: { ...custom, key: "AGY-1", summary: "test agy model harmonization" },
  });
  assert.ok(observedAgentDuringRun, "currentAgent was populated during step");
  assert.strictEqual(observedAgentDuringRun.harness, "gemini-antigravity");
  assert.strictEqual(observedAgentDuringRun.model, "gemini-3.8-flash", "baked flash suffix was harmonized to base");
  assert.strictEqual(observedAgentDuringRun.effort, "medium");
  assert.ok(agyWf.logs.some((l) => l.includes("gemini-antigravity · gemini-3.8-flash · effort medium")));

  // ---- Force quit tests at various stages (running, paused, failed)
  let agentAborted = false;
  let slowAgentStartedResolve: () => void;
  const slowAgentStarted = new Promise<void>((r) => { slowAgentStartedResolve = r; });
  engine.setAgentExecutor({
    async run(req) {
      slowAgentStartedResolve();
      if (req.signal) {
        if (req.signal.aborted) agentAborted = true;
        else req.signal.addEventListener("abort", () => { agentAborted = true; });
      }
      // Simulate long-running agent
      await new Promise((r) => setTimeout(r, 2000));
      return { success: true, output: "done", code: 0, harness: "claude-code" };
    },
  });

  // 1. Force quit while running
  const runningWf = await engine.start("QUIT-1", repo, {
    baseBranch: "main",
    ticket: { ...custom, key: "QUIT-1", summary: "test force quit running" },
  }, false);
  await slowAgentStarted;
  assert.strictEqual(runningWf.status, "running");
  const quitOk = engine.forceQuit("QUIT-1", repo);
  assert.ok(quitOk, "forceQuit returned true");
  assert.strictEqual(runningWf.status, "cancelled", "status immediately cancelled");
  assert.strictEqual(runningWf.awaiting, undefined, "awaiting cleared");
  assert.ok(agentAborted, "AbortSignal triggered on running agent executor");
  const failedStep = runningWf.steps.find((s) => s.error === "Force quit by user.");
  assert.ok(failedStep, "step marked failed with force quit reason");

  // 2. Force quit on paused workflow
  const pausedWf = await engine.start("QUIT-2", repo, {
    baseBranch: "main",
    pauseMode: "every_stage",
    ticket: { ...custom, key: "QUIT-2", summary: "test force quit paused" },
  });
  assert.strictEqual(pausedWf.status, "paused");
  assert.strictEqual(pausedWf.awaiting, "stage_approval");
  assert.ok(engine.forceQuit("QUIT-2", repo));
  assert.strictEqual(pausedWf.status, "cancelled");
  assert.strictEqual(pausedWf.awaiting, undefined);

  // 3. Force quit on failed workflow
  engine.setAgentExecutor({
    async run() { throw new Error("Agent crash"); },
  });
  const failedWf = await engine.start("QUIT-3", repo, {
    baseBranch: "main",
    ticket: { ...custom, key: "QUIT-3", summary: "test force quit failed" },
  });
  assert.strictEqual(failedWf.status, "failed");
  assert.ok(engine.forceQuit("QUIT-3", repo));
  assert.strictEqual(failedWf.status, "cancelled");

  // ---- Stage chat & guidance test
  let capturedPrompt = "";
  engine.setAgentExecutor({
    async run(req) {
      capturedPrompt = req.prompt;
      return { success: true, output: "chat guidance received", code: 0, harness: "claude-code" };
    },
  });
  const chatWf = await engine.start("CHAT-1", repo, {
    baseBranch: "main",
    pauseMode: "every_stage",
    ticket: { ...custom, key: "CHAT-1", summary: "test stage chat" },
  });
  const resChat = engine.addStageChat("CHAT-1", repo, "develop", "Please check CORS maxAge validation");
  assert.strictEqual(resChat.wf.stageChats?.develop?.length, 1);
  assert.strictEqual(resChat.wf.stageChats.develop[0].text, "Please check CORS maxAge validation");
  assert.strictEqual(resChat.wf.stageGuidance?.develop, "Please check CORS maxAge validation");
  assert.ok(chatWf.activity?.some((a) => a.includes("Please check CORS maxAge validation")));

  // Resuming step incorporates guidance into agent prompt
  await engine.resume("CHAT-1", repo);
  assert.ok(capturedPrompt.includes("User developer chat & guidance for this stage:\nPlease check CORS maxAge validation"));

  setSettingsOverrides({});
  console.log("✔ WorkflowEngine OK");
}
