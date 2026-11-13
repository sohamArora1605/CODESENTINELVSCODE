import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { MultiRepoManager } from "../repo/multiRepoManager";
import { GitSyncService } from "../git/gitSyncService";
import { JiraService } from "../jira/jiraService";
import { SecretVault } from "../security/secretVault";
import { JiraTicket } from "../types";
import { AtlassianMcp } from "../jira/atlassianMcp";
import { TestRunnerService } from "../testing/testRunnerService";
import { WorkflowEngine, TOGGLEABLE_STAGES } from "../agent/workflowEngine";
import { AgentTerminalLauncher } from "../agent/agentTerminalLauncher";
import { AgentHarnessType, isValidModel, isValidEffort } from "../agent/agentRunner";
import { SETTING_KEYS, getRepoConfig, setRepoConfig, getSetting, writeSettingsSnapshot, RepoConfig } from "../config/settings";
import { VulnerabilityScanner } from "../scanner/vulnerabilityScanner";

const HARNESSES = ["claude-code", "gemini-antigravity", "opencode"];
const TICKET_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SETTING_DEFAULTS: Record<string, unknown> = {
  openCodeEnabled: true, multiRepoEnabled: true, gitAutoSyncEnabled: true, defaultAgentHarness: "claude-code",
  branchNamingTemplate: "feature/${ticketKey}-${slug}", "jira.mode": "disabled", "jira.mcpUrl": "", "jira.harnessAllowedTools": ["mcp__claude_ai_Atlassian", "mcp__atlassian", "mcp__jira"], "jira.host": "", "jira.email": "",
  "jira.projectKey": "", "jira.jqlFilter": "", "testing.playwrightEnabled": true, "testing.apiTestingEnabled": true,
  "testing.stageDeployMode": "manual", "testing.stageDeployCommand": "", "testing.stageApiBaseUrl": "",
  "workflow.useWorktrees": true, "workflow.maxFixIterations": 3, "workflow.autoPush": false,
  "workflow.requirePlanApproval": false, "workflow.agentTimeoutMinutes": 30, "workflow.pauseMode": "gates", "workflow.jiraStageComments": true,
  "agent.model.claude-code": "sonnet", "agent.model.gemini-antigravity": "gemini-3.8-flash", "agent.model.opencode": "opencode/big-pickle", "agent.roleModels": {}, "workflow.stages": {},
  "agent.effort.claude-code": "medium", "agent.effort.gemini-antigravity": "medium", "agent.effort.opencode": "medium", "agent.roleEfforts": {}, "workflow.baseBranches": ["main", "develop"],
};

/** Host side of the Developer tab: validates every message from the webview and pushes state back. */
export class DevPanelController {
  private post: (msg: any) => void = () => {};
  private timer: NodeJS.Timeout | undefined;
  private disposables: Array<() => void> = [];

  public attach(post: (msg: any) => void): void {
    this.post = post;
    if (this.disposables.length) return;
    const push = () => this.schedulePush();
    this.disposables.push(
      WorkflowEngine.getInstance().onDidUpdateWorkflow(push),
      TestRunnerService.getInstance().onDidUpdateTestResults(push),
      MultiRepoManager.getInstance().onDidChangeRepositories(push),
      MultiRepoManager.getInstance().onDidChangeActiveRepo(push),
      GitSyncService.getInstance().onDidSyncGraph(push)
    );
    const cfg = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codesentinel")) {
        writeSettingsSnapshot();
        push();
      }
    });
    this.disposables.push(() => cfg.dispose());
    // Workflows may be running in another process (MCP server, CLI), which fires no events here: poll while any is active.
    const poll = setInterval(() => {
      const repos = MultiRepoManager.getInstance().getRepositories().map((r) => r.path);
      if (WorkflowEngine.getInstance().hasActive(repos)) this.schedulePush();
    }, 3000);
    this.disposables.push(() => clearInterval(poll));
  }

  public dispose(): void {
    this.disposables.forEach((d) => d());
    this.disposables = [];
    if (this.timer) clearTimeout(this.timer);
  }

  private schedulePush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pushState();
    }, 250);
  }

  private toast(text: string, kind: "info" | "ok" | "bad" = "info"): void {
    this.post({ command: "dev:toast", text, kind });
  }

  private knownRepo(p: unknown): string | null {
    if (typeof p !== "string") return null;
    const resolved = path.resolve(p);
    return MultiRepoManager.getInstance().getRepositories().find((r) => r.path === resolved)?.path ?? null;
  }

  private slimTests(repoPath: string) {
    const s = TestRunnerService.getInstance().getSummary(repoPath);
    const cut = (r: any) => r && { ...r, output: String(r.output || "").slice(-6000) };
    return { overallStatus: s.overallStatus, unit: cut(s.unit), stageApi: cut(s.stageApi), playwright: cut(s.playwright) };
  }

  private slimWorkflow(w: any) {
    return {
      ...w,
      logs: w.logs.slice(-200),
      activity: (w.activity ?? []).slice(-120),
      steps: w.steps.map((st: any) => ({ ...st, output: st.output ? String(st.output).slice(-4000) : undefined, details: undefined })),
    };
  }

  public async pushState(): Promise<void> {
    const mr = MultiRepoManager.getInstance();
    const engine = WorkflowEngine.getInstance();
    const settings: Record<string, unknown> = {};
    for (const k of SETTING_KEYS) settings[k] = getSetting(k, SETTING_DEFAULTS[k] as any);
    const active = mr.getActiveRepoPath();
    const repos = mr.getRepositories().map((r) => ({
      ...r,
      config: getRepoConfig(r.path),
      tests: this.slimTests(r.path),
      workflows: engine.loadRepo(r.path).map((w) => this.slimWorkflow(w)),
    }));
    const vault = SecretVault.getInstance();
    this.post({
      command: "dev:state",
      state: {
        settings, repos, activeRepo: active,
        secrets: (await vault.listSecrets()).filter((s) => s.key !== "jira_api_token" && !s.key.startsWith("atlassian_oauth_")),
        atlassianSignedIn: await AtlassianMcp.getInstance().isSignedIn(),
        jiraTokenSet: Boolean(await vault.getSecret("jira_api_token", "global")),
      },
    });
  }

  private withBranches(t: JiraTicket) {
    const jira = JiraService.getInstance();
    return { ...t, branches: Object.fromEntries(MultiRepoManager.getInstance().getRepositories().map((r) => [r.path, jira.generateBranchName(t, undefined, r.path)])) };
  }

  public async handle(msg: any): Promise<void> {
    try {
      await this.dispatch(msg);
    } catch (e: any) {
      this.toast(e?.message || String(e), "bad");
    }
  }

  private async dispatch(msg: any): Promise<void> {
    const mr = MultiRepoManager.getInstance();
    const git = GitSyncService.getInstance();
    switch (msg.command) {
      case "dev:getState": {
        await mr.syncWithWorkspace();
        for (const r of mr.getRepositories()) WorkflowEngine.getInstance().loadRepo(r.path);
        return this.pushState();
      }

      case "dev:setSetting": {
        const key = String(msg.key);
        if (!SETTING_KEYS.includes(key)) throw new Error(`Unknown setting '${key}'.`);
        const def = SETTING_DEFAULTS[key];
        let value = msg.value;
        if (typeof def === "boolean") value = Boolean(value);
        else if (typeof def === "number") { value = Number(value); if (!Number.isFinite(value) || value < 0) throw new Error("Invalid number."); }
        else if (typeof def === "string") value = String(value);
        else if (Array.isArray(def)) {
          if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) throw new Error("Expected a list of strings.");
          value = value.map((x: string) => x.trim()).filter(Boolean);
        }
        if (key === "workflow.stages") {
          const out: Record<string, boolean> = {};
          for (const [k, v] of Object.entries(msg.value && typeof msg.value === "object" ? msg.value : {})) {
            if (!(TOGGLEABLE_STAGES as string[]).includes(k)) throw new Error(`Unknown stage '${k}'.`);
            out[k] = Boolean(v);
          }
          value = out;
        } else if (key === "agent.roleModels") {
          // agent.roleModels: { planner|developer|tester|fixer|ticket: model }
          const out: Record<string, string> = {};
          for (const [r, m] of Object.entries(value && typeof value === "object" ? value : {})) {
            if (!["planner", "developer", "tester", "fixer", "ticket"].includes(r)) throw new Error(`Unknown stage '${r}'.`);
            const mv = String(m ?? "").trim();
            if (mv && !isValidModel(mv)) throw new Error(`Invalid model name '${mv}'.`);
            if (mv) out[r] = mv;
          }
          value = out;
        }
        if (key === "agent.roleEfforts") {
          const eo: Record<string, string> = {};
          for (const [r, v] of Object.entries(msg.value && typeof msg.value === "object" ? msg.value : {})) {
            if (!["planner", "developer", "tester", "fixer", "ticket"].includes(r)) throw new Error(`Unknown stage '${r}'.`);
            const ev = String(v ?? "").trim().toLowerCase();
            if (ev && !isValidEffort(ev)) throw new Error(`Invalid effort '${ev}'.`);
            if (ev) eo[r] = ev;
          }
          value = eo;
        }
        if (key.startsWith("agent.effort.")) {
          value = String(value ?? "").trim().toLowerCase();
          if (value && !isValidEffort(value)) throw new Error("Invalid effort level.");
        }
        if (key.startsWith("agent.model.")) {
          value = String(value ?? "").trim();
          if (value && !isValidModel(value)) throw new Error("Invalid model name (letters, digits, . _ : / - only).");
        }
        if (key === "workflow.pauseMode" && !["gates", "every_stage", "none"].includes(value)) throw new Error("Invalid pause mode.");
        if (key === "jira.mode" && !["disabled", "manual", "harness"].includes(value)) throw new Error("Invalid Jira mode.");
        if (key === "defaultAgentHarness" && !HARNESSES.includes(value)) throw new Error("Unknown harness.");
        if (key === "testing.stageDeployMode" && !["manual", "auto", "disabled"].includes(value)) throw new Error("Invalid deploy mode.");
        await vscode.workspace.getConfiguration("codesentinel").update(key, value, vscode.ConfigurationTarget.Global);
        writeSettingsSnapshot();
        if (key === "multiRepoEnabled" || key === "gitAutoSyncEnabled") await mr.syncWithWorkspace();
        return this.pushState();
      }

      case "dev:listTickets": {
        const jira = JiraService.getInstance();
        const mode = jira.getMode();
        if (mode === "disabled") {
          this.post({ command: "dev:tickets", mode, tickets: [], live: false });
          return;
        }
        try {
          const tickets = await jira.listTickets({ status: msg.status, query: msg.query || undefined });
          this.post({ command: "dev:tickets", mode, live: mode === "manual", tickets: tickets.map((t) => this.withBranches(t)) });
        } catch (e: any) {
          this.post({ command: "dev:tickets", mode, tickets: [], live: mode === "manual", error: e.message });
        }
        return;
      }

      case "dev:getTicket": {
        const key = String(msg.ticketKey || "").trim().toUpperCase();
        if (!TICKET_RE.test(key)) throw new Error("Enter a ticket key like SEC-101.");
        const t = await JiraService.getInstance().getTicket(key);
        if (!t) throw new Error(`Ticket ${key} not found.`);
        this.post({ command: "dev:ticket", ticket: this.withBranches(t) });
        return;
      }

      case "dev:branchNames": {
        const t = TICKET_RE.test(String(msg.ticketKey)) ? await JiraService.getInstance().getTicket(msg.ticketKey) : null;
        if (!t) return;
        const jira = JiraService.getInstance();
        this.post({ command: "dev:branchNames", ticketKey: t.key, branches: Object.fromEntries(mr.getRepositories().map((r) => [r.path, jira.generateBranchName(t, undefined, r.path)])) });
        return;
      }

      case "dev:startTicket": return this.startTicket(msg);

      case "dev:resume":
      case "dev:cancel":
      case "dev:forceQuit": {
        const repo = this.knownRepo(msg.repoPath);
        if (!repo || !TICKET_RE.test(String(msg.ticketKey))) throw new Error("Unknown workflow.");
        const engine = WorkflowEngine.getInstance();
        if (msg.command === "dev:forceQuit") {
          const ok = engine.forceQuit(msg.ticketKey, repo);
          if (ok) this.toast(`${msg.ticketKey}: Workflow force quit immediately.`, "info");
          else this.toast(`${msg.ticketKey}: Workflow not found.`, "bad");
        } else if (msg.command === "dev:cancel") engine.cancel(msg.ticketKey, repo);
        else void engine.resume(msg.ticketKey, repo).catch((e) => this.toast(e.message, "bad"));
        return;
      }

      case "dev:resumeAll": {
        const engine = WorkflowEngine.getInstance();
        const paused = engine.getAllWorkflows().filter((w) => w.status === "paused");
        if (!paused.length) {
          this.toast("No paused workflows.", "info");
          return;
        }
        for (const w of paused) {
          void engine.resume(w.ticketKey, w.repoPath).catch((e) => this.toast(`${w.ticketKey}: ${e.message}`, "bad"));
        }
        this.toast(`Resuming ${paused.length} workflow(s)…`, "ok");
        return;
      }

      case "dev:skip": {
        const repo = this.knownRepo(msg.repoPath);
        if (!repo || !TICKET_RE.test(String(msg.ticketKey))) throw new Error("Unknown workflow.");
        void WorkflowEngine.getInstance().skip(msg.ticketKey, repo).catch((e) => this.toast(e.message, "bad"));
        return;
      }

      case "dev:nextStep": {
        const repo = this.knownRepo(msg.repoPath);
        if (!repo || !TICKET_RE.test(String(msg.ticketKey))) throw new Error("Unknown workflow.");
        void WorkflowEngine.getInstance().nextStep(msg.ticketKey, repo).catch((e) => this.toast(e.message, "bad"));
        return;
      }

      case "dev:discard": {
        const repo = this.knownRepo(msg.repoPath);
        if (!repo || !TICKET_RE.test(String(msg.ticketKey))) throw new Error("Unknown workflow.");
        const wf = WorkflowEngine.getInstance().getWorkflow(msg.ticketKey, repo);
        if (!wf) throw new Error("Unknown workflow.");
        // webviews cannot show confirm(); ask from the extension host
        const choice = await vscode.window.showWarningMessage(
          `Discard ${wf.ticketKey} in ${path.basename(repo)}?`,
          { modal: true, detail: `This stops the workflow, removes its worktree and deletes the local branch '${wf.targetBranch}' with everything the agents changed.\nA remote branch (if you pushed) and the Jira ticket are not touched.` },
          "Discard and delete branch"
        );
        if (choice !== "Discard and delete branch") return;
        const res = await WorkflowEngine.getInstance().discard(msg.ticketKey, repo);
        this.toast(`Discarded: ${res.removed.join(", ") || "nothing to remove"}. ${res.notes.join(" ")}`, "ok");
        await mr.refreshRepo(repo);
        return this.pushState();
      }

      case "dev:openTerminal": {
        const repo = this.knownRepo(msg.repoPath);
        if (!repo || !TICKET_RE.test(String(msg.ticketKey))) throw new Error("Unknown workflow.");
        const wf = WorkflowEngine.getInstance().getWorkflow(msg.ticketKey, repo);
        if (!wf) throw new Error("Unknown workflow.");
        const harness = (wf.harness as AgentHarnessType | undefined) ?? getSetting<AgentHarnessType>("defaultAgentHarness", "claude-code");
        AgentTerminalLauncher.getInstance().launchAgentTerminal(
          wf.workDir,
          harness,
          undefined,
          {
            key: wf.ticketKey, summary: wf.ticketSummary || "", branch: wf.targetBranch, plan: wf.plan,
          },
          undefined,
          {
            model: wf.currentAgent?.model,
            effort: wf.currentAgent?.effort,
          }
        );
        return;
      }

      case "dev:addRepo": {
        const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Add repository" });
        if (!pick?.[0]) return;
        const info = await mr.addRepository(pick[0].fsPath);
        if (!git.isGitRepo(info.path)) this.toast(`${info.name} is not a git repository: branch workflows are unavailable.`, "info");
        void git.syncCodeGraph(info.path);
        return this.pushState();
      }
      case "dev:removeRepo": { const r = this.knownRepo(msg.repoPath); if (r) mr.removeRepository(r); return; }
      case "dev:setActiveRepo": { const r = this.knownRepo(msg.repoPath); if (r) mr.setActiveRepo(r); return; }

      case "dev:syncRepo": {
        const r = this.knownRepo(msg.repoPath); if (!r) return;
        const res = await git.syncCodeGraph(r);
        await mr.refreshRepo(r);
        this.toast(res.message, res.success ? "ok" : "bad");
        return this.pushState();
      }

      case "dev:checkout": {
        const r = this.knownRepo(msg.repoPath); if (!r) return;
        const res = await git.checkoutBranch(r, String(msg.branch));
        this.toast(res.message, res.success ? "ok" : "bad");
        await mr.refreshRepo(r);
        return this.pushState();
      }

      case "dev:setRepoConfig": {
        const r = this.knownRepo(msg.repoPath); if (!r) return;
        const allowed: Array<keyof RepoConfig> = ["branchTemplate", "baseBranches", "branchMode", "jiraProjectKey", "setupCommand", "testCommand", "apiTestCommand",
          "playwrightCommand", "stageDeployMode", "stageDeployCommand", "stageApiBaseUrl", "playwrightEnabled", "apiTestingEnabled"];
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(msg.patch || {})) {
          if (!allowed.includes(k as keyof RepoConfig)) throw new Error(`Unknown repo setting '${k}'.`);
          patch[k] = v === null ? undefined : v;
        }
        if (typeof patch.branchTemplate === "string" && !/\$\{(ticketKey|key|slug)\}/.test(patch.branchTemplate)) {
          throw new Error("Branch template must contain ${ticketKey} or ${slug} so branches are unique per ticket.");
        }
        setRepoConfig(r, patch as Partial<RepoConfig>);
        return this.pushState();
      }

      case "dev:runTests": {
        const r = this.knownRepo(msg.repoPath); if (!r) return;
        const t = TestRunnerService.getInstance();
        const suite = String(msg.suite);
        const run = suite === "unit" ? t.runUnitTests(r) : suite === "stage_api" ? t.runStageApiTests(r) : suite === "playwright" ? t.runPlaywrightTests(r) : t.runAllTests(r);
        this.toast(`Running ${suite} tests in ${path.basename(r)}…`);
        void run.then(() => this.toast(`${suite} tests finished for ${path.basename(r)}.`, "ok")).catch((e) => this.toast(e.message, "bad"));
        return;
      }

      case "dev:scanDiff": {
        const r = this.knownRepo(msg.repoPath); if (!r) return;
        const base = getRepoConfigBase(r);
        const files = (await git.getModifiedFilesDiff(r, base)).filter((f) => !f.startsWith(".codesentinel/"));
        if (!files.length) return this.toast("No changed files to scan.", "info");
        this.toast(`Scanning ${files.length} changed file(s)…`);
        const res = await VulnerabilityScanner.getInstance().scanProject(r, undefined, true, { onlyFiles: files });
        this.toast(`Changed-files scan: ${res.findings.length} finding(s) in ${files.length} file(s).`, res.findings.length ? "bad" : "ok");
        return;
      }

      case "dev:setJiraToken": {
        const v = await vscode.window.showInputBox({ title: "Jira API token", prompt: "Create one at id.atlassian.com → Security → API tokens", password: true, ignoreFocusOut: true });
        if (!v) return;
        await SecretVault.getInstance().setSecret("jira_api_token", v.trim(), "global", undefined, "Atlassian API token");
        this.toast("Jira API token saved (encrypted).", "ok");
        return this.pushState();
      }
      case "dev:jiraConnect": {
        this.toast("Opening your browser to sign in to Atlassian…");
        await AtlassianMcp.getInstance().signIn();
        this.toast("Connected to Atlassian.", "ok");
        return this.pushState();
      }
      case "dev:jiraDisconnect": {
        await AtlassianMcp.getInstance().signOut();
        this.toast("Disconnected from Atlassian.", "ok");
        return this.pushState();
      }
      case "dev:testJira": {
        const r = await JiraService.getInstance().testConnection();
        return this.toast(r.message, r.success ? "ok" : "bad");
      }

      case "dev:addSecret": {
        const key = String(msg.key || "").trim();
        const scope = ["global", "repo", "ticket"].includes(msg.scope) ? msg.scope : "global";
        const scopeId = String(msg.scopeId || "").trim() || undefined;
        if (!SECRET_NAME_RE.test(key)) throw new Error("Secret name must be an env-var style name (letters, digits, underscore).");
        if (scope !== "global" && !scopeId) throw new Error(`Enter a ${scope === "repo" ? "repository name" : "ticket key"} for this scope.`);
        const v = await vscode.window.showInputBox({ title: `Secret ${key}`, prompt: `Value (scope: ${scope}${scopeId ? ` / ${scopeId}` : ""})`, password: true, ignoreFocusOut: true });
        if (!v) return;
        await SecretVault.getInstance().setSecret(key, v, scope, scopeId);
        this.toast(`Secret ${key} saved.`, "ok");
        return this.pushState();
      }
      case "dev:deleteSecret": {
        const scope = ["global", "repo", "ticket"].includes(msg.scope) ? msg.scope : "global";
        await SecretVault.getInstance().deleteSecret(String(msg.key), scope, msg.scopeId ? String(msg.scopeId) : undefined);
        return this.pushState();
      }
    }
  }

  private async startTicket(msg: any): Promise<void> {
    const key = String(msg.ticketKey);
    if (!TICKET_RE.test(key)) throw new Error("Invalid ticket key.");
    const harness: AgentHarnessType = HARNESSES.includes(msg.harness) ? msg.harness : getSetting<AgentHarnessType>("defaultAgentHarness", "claude-code");
    const repos: string[] = (Array.isArray(msg.repos) ? msg.repos : []).map((p: string) => this.knownRepo(p)).filter(Boolean) as string[];
    if (!repos.length) throw new Error("Select at least one known repository.");
    if (repos.length > 1 && !getSetting<boolean>("multiRepoEnabled", true)) throw new Error("Multi-repo is turned off.");
    const jira = JiraService.getInstance();
    let ticket: JiraTicket | null;
    if (msg.custom) {
      // Custom task: no Jira involved. Key is generated client-side as TASK-<n>.
      const summary = String(msg.custom.summary || "").trim().slice(0, 200);
      if (!summary) throw new Error("Describe the task first.");
      if (!/^TASK-\d+$/.test(key)) throw new Error("Invalid custom task key.");
      ticket = { key, summary, description: String(msg.custom.description || "").slice(0, 8000), status: "To Do", priority: "Medium", issueType: "Task", labels: [], components: [] };
    } else {
      ticket = await jira.getTicket(key);
    }
    if (!ticket) throw new Error(`Ticket ${key} not found.`);
    const git = GitSyncService.getInstance();

    for (const repo of repos) {
      const base = String(msg.bases?.[repo] || "") || undefined;
      const branch = String(msg.branches?.[repo] || "").trim() || jira.generateBranchName(ticket, undefined, repo);
      if (msg.mode === "terminal") {
        const useWt = getSetting<boolean>("workflow.useWorktrees", true);
        let dir = repo;
        if (useWt) {
          const wt = await git.ensureWorktree(repo, key, branch, base || (await git.getCurrentBranch(repo)));
          if (!wt.success) { this.toast(`${path.basename(repo)}: ${wt.message}`, "bad"); continue; }
          dir = wt.path;
        } else {
          const r = await git.createAndCheckoutBranch(repo, branch, base || "main");
          if (!r.success) { this.toast(`${path.basename(repo)}: ${r.message}`, "bad"); continue; }
        }
        void jira.updateTicketStatus(key, "In Progress", `CodeSentinel: started on branch ${branch}.`);
        AgentTerminalLauncher.getInstance().launchAgentTerminal(
          dir,
          harness,
          undefined,
          { key, summary: ticket.summary, branch, description: ticket.description },
          undefined,
          {
            model: typeof msg.model === "string" && msg.model.trim() && isValidModel(msg.model.trim()) ? msg.model.trim() : undefined,
            effort: typeof msg.effort === "string" && isValidEffort(msg.effort.trim().toLowerCase()) ? msg.effort.trim().toLowerCase() : undefined,
          }
        );
        this.toast(`${path.basename(repo)}: ${harness} terminal opened on ${branch}.`, "ok");
      } else {
        try {
          await WorkflowEngine.getInstance().start(key, repo,
            { baseBranch: base, targetBranch: branch, harness, autoPush: Boolean(msg.autoPush), ticket,
              model: typeof msg.model === "string" && msg.model.trim() && isValidModel(msg.model.trim()) ? msg.model.trim() : undefined,
              stages: msg.stages && typeof msg.stages === "object" ? Object.fromEntries(Object.entries(msg.stages).filter(([k, v]) => (TOGGLEABLE_STAGES as string[]).includes(k) && typeof v === "boolean")) : undefined,
              effort: typeof msg.effort === "string" && isValidEffort(msg.effort.trim().toLowerCase()) ? msg.effort.trim().toLowerCase() : undefined,
              pauseMode: ["gates", "every_stage", "none"].includes(msg.pauseMode) ? msg.pauseMode : undefined }, false);
        } catch (e: any) {
          this.toast(`${path.basename(repo)}: ${e.message}`, "bad");
        }
      }
    }
    await this.pushState();
  }
}

function getRepoConfigBase(repo: string): string {
  return getRepoConfig(repo).baseBranches?.[0] || getSetting<string[]>("workflow.baseBranches", ["main"])[0] || "main";
}
