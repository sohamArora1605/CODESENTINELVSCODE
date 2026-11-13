import * as path from "path";
import * as fs from "fs";
import { TestExecutionResult } from "../types";
import { SecretVault } from "../security/secretVault";
import { getSetting, getRepoConfig, ensureSentinelDir } from "../config/settings";
import { runShell } from "../util/proc";

export interface RepoTestSummary {
  repoPath: string;
  repoName: string;
  overallStatus: "idle" | "running" | "passed" | "failed";
  unit?: TestExecutionResult;
  stageApi?: TestExecutionResult;
  playwright?: TestExecutionResult;
  lastRunTimestamp?: number;
}

export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  parsed: boolean;
}

/** Parses real counts out of common runner output. `parsed` is false when nothing recognizable was found. */
export function parseTestOutput(output: string): TestCounts {
  const out = output.replace(/\x1b\[[0-9;]*m/g, "");
  const n = (re: RegExp) => {
    const m = out.match(re);
    return m ? parseInt(m[1], 10) : 0;
  };
  // Playwright --reporter=json
  const jsonStart = out.indexOf('{"config"');
  if (jsonStart >= 0) {
    try {
      const j = JSON.parse(out.slice(jsonStart, out.lastIndexOf("}") + 1));
      if (j.stats) {
        const passed = j.stats.expected ?? 0;
        const failed = (j.stats.unexpected ?? 0) + (j.stats.flaky ?? 0);
        const skipped = j.stats.skipped ?? 0;
        return { total: passed + failed + skipped, passed, failed, skipped, parsed: true };
      }
    } catch {}
  }
  // Maven surefire: "Tests run: 12, Failures: 1, Errors: 0, Skipped: 2" (last summary line wins)
  const mvn = [...out.matchAll(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)(?:,\s*Skipped:\s*(\d+))?/g)].pop();
  if (mvn) {
    const total = +mvn[1], failed = +mvn[2] + +mvn[3], skipped = +(mvn[4] || 0);
    return { total, passed: total - failed - skipped, failed, skipped, parsed: true };
  }
  // jest / vitest: "Tests:  1 failed, 2 skipped, 3 passed, 6 total"
  const jest = out.match(/Tests:\s+(.*?\d+\s+total)/);
  if (jest) {
    const line = jest[1];
    const g = (w: string) => parseInt(line.match(new RegExp(`(\\d+)\\s+${w}`))?.[1] ?? "0", 10);
    return { total: g("total"), passed: g("passed"), failed: g("failed"), skipped: g("skipped") + g("todo"), parsed: true };
  }
  // mocha: "49 passing (47ms)" / "2 failing" / "1 pending"
  if (/^\s*\d+ passing/m.test(out)) {
    const passed = n(/^\s*(\d+) passing/m), failed = n(/^\s*(\d+) failing/m), skipped = n(/^\s*(\d+) pending/m);
    return { total: passed + failed + skipped, passed, failed, skipped, parsed: true };
  }
  // node:test TAP summary
  if (/^# tests \d+/m.test(out)) {
    return { total: n(/^# tests (\d+)/m), passed: n(/^# pass (\d+)/m), failed: n(/^# fail (\d+)/m), skipped: n(/^# skipped (\d+)/m), parsed: true };
  }
  // pytest: "== 1 failed, 3 passed, 2 skipped in 0.5s =="
  const py = out.match(/=+ (.*?(?:passed|failed|error).*?) in [\d.]+s/);
  if (py) {
    const g = (w: string) => parseInt(py[1].match(new RegExp(`(\\d+)\\s+${w}`))?.[1] ?? "0", 10);
    const failed = g("failed") + g("errors?");
    return { total: g("passed") + failed + g("skipped"), passed: g("passed"), failed, skipped: g("skipped"), parsed: true };
  }
  // go test: count ok/FAIL package lines and "--- FAIL"
  if (/^(ok|FAIL)\s+\S+/m.test(out)) {
    const okPk = (out.match(/^ok\s+\S+/gm) || []).length;
    const failPk = (out.match(/^FAIL\s+\S+/gm) || []).length;
    return { total: okPk + failPk, passed: okPk, failed: failPk, skipped: 0, parsed: true };
  }
  // cargo: "test result: ok. 5 passed; 1 failed; 0 ignored"
  const cargo = out.match(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/);
  if (cargo) return { total: +cargo[1] + +cargo[2] + +cargo[3], passed: +cargo[1], failed: +cargo[2], skipped: +cargo[3], parsed: true };
  return { total: 0, passed: 0, failed: 0, skipped: 0, parsed: false };
}

export class TestRunnerService {
  private static instance: TestRunnerService;
  private summaries: Map<string, RepoTestSummary> = new Map();
  private listeners: Array<(summary: RepoTestSummary) => void> = [];

  private constructor() {}

  public static getInstance(): TestRunnerService {
    if (!TestRunnerService.instance) TestRunnerService.instance = new TestRunnerService();
    return TestRunnerService.instance;
  }

  public onDidUpdateTestResults(listener: (summary: RepoTestSummary) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notify(s: RepoTestSummary): void {
    this.persist(s);
    for (const l of this.listeners) try { l(s); } catch {}
  }

  private storeFile(repoPath: string): string {
    return path.join(repoPath, ".codesentinel", "test-results.json");
  }

  private persist(s: RepoTestSummary): void {
    try {
      ensureSentinelDir(s.repoPath);
      const f = this.storeFile(s.repoPath);
      fs.writeFileSync(f, JSON.stringify(s, null, 2));
    } catch {}
  }

  public getSummary(repoPath: string): RepoTestSummary {
    const cached = this.summaries.get(repoPath);
    if (cached) return cached;
    let initial: RepoTestSummary = { repoPath, repoName: path.basename(repoPath), overallStatus: "idle" };
    try {
      const disk = JSON.parse(fs.readFileSync(this.storeFile(repoPath), "utf-8"));
      initial = { ...initial, ...disk, overallStatus: disk.overallStatus === "running" ? "idle" : disk.overallStatus };
    } catch {}
    this.summaries.set(repoPath, initial);
    return initial;
  }

  public getAllSummaries(): RepoTestSummary[] {
    return Array.from(this.summaries.values());
  }

  // ------------------------------------------------------------------ command detection
  private readPkg(repoPath: string): any | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(repoPath, "package.json"), "utf-8"));
    } catch {
      return null;
    }
  }

  public detectUnitCommand(repoPath: string, configRepo = repoPath): string | null {
    const cfg = getRepoConfig(configRepo).testCommand;
    if (cfg) return cfg;
    const has = (f: string) => fs.existsSync(path.join(repoPath, f));
    const pkg = this.readPkg(repoPath);
    if (pkg) {
      if (pkg.scripts?.["test:unit"]) return "npm run test:unit";
      const t = String(pkg.scripts?.test ?? "");
      if (t && !/no test specified/.test(t)) return "npm test";
    }
    if (has("pom.xml")) return has("mvnw") ? "./mvnw -B test" : "mvn -B test";
    if (has("build.gradle") || has("build.gradle.kts")) return has("gradlew") ? "./gradlew test" : "gradle test";
    if (has("pytest.ini") || has("conftest.py") || has("pyproject.toml") || has("tox.ini")) return "python -m pytest";
    if (has("Cargo.toml")) return "cargo test";
    if (has("go.mod")) return "go test ./...";
    return null;
  }

  public detectApiCommand(repoPath: string, configRepo = repoPath): string | null {
    const cfg = getRepoConfig(configRepo).apiTestCommand;
    if (cfg) return cfg;
    const pkg = this.readPkg(repoPath);
    if (pkg?.scripts?.["test:api"]) return "npm run test:api";
    if (pkg?.scripts?.["test:integration"]) return "npm run test:integration";
    return null;
  }

  public hasPlaywright(repoPath: string): boolean {
    return ["ts", "js", "mjs"].some((e) => fs.existsSync(path.join(repoPath, `playwright.config.${e}`)));
  }

  public detectPlaywrightCommand(repoPath: string, configRepo = repoPath): string {
    const cfg = getRepoConfig(configRepo).playwrightCommand;
    if (cfg) return cfg;
    const pkg = this.readPkg(repoPath);
    // The script's own reporter is unknown, so only the default invocation requests JSON.
    return pkg?.scripts?.["test:e2e"] ? "npm run test:e2e" : "npx --no-install playwright test --reporter=json";
  }

  // ------------------------------------------------------------------ suites
  private finish(
    summary: RepoTestSummary,
    key: "unit" | "stageApi" | "playwright",
    r: Omit<TestExecutionResult, "passed" | "timestamp">
  ): TestExecutionResult {
    const result: TestExecutionResult = { ...r, passed: r.status !== "failed", timestamp: Date.now() };
    summary[key] = result;
    this.updateOverallStatus(summary);
    this.notify(summary);
    return result;
  }

  private async execSuite(
    summary: RepoTestSummary,
    key: "unit" | "stageApi" | "playwright",
    suite: TestExecutionResult["suite"],
    command: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    prefixLog = "",
    secretValues: string[] = []
  ): Promise<TestExecutionResult> {
    const start = Date.now();
    const r = await runShell(command, { cwd: summary.repoPath, env, timeoutMs });
    const output = this.redact(`${prefixLog}${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.slice(-200000), secretValues);
    const c = parseTestOutput(output);
    const ok = r.code === 0;
    let { total, passed, failed, skipped } = c;
    if (!c.parsed) {
      // No recognizable summary: fall back to the exit code, and say so.
      total = 1; passed = ok ? 1 : 0; failed = ok ? 0 : 1; skipped = 0;
    } else if (!ok && failed === 0) {
      failed = 1; total += 1; // runner failed (build error, crash) even though no test failed
    }
    return this.finish(summary, key, {
      suite, repoPath: summary.repoPath, status: ok ? "passed" : "failed", command,
      totalTests: total, passedCount: passed, failedCount: failed, skippedCount: skipped,
      durationMs: Date.now() - start, output,
      error: ok ? undefined : r.timedOut ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : `Exit code ${r.code}`,
    });
  }

  /** Output is persisted and shown in the UI, so vault values are masked. */
  private redact(text: string, secrets: string[]): string {
    let out = text;
    for (const v of secrets) if (v.length >= 4) out = out.split(v).join("***");
    return out;
  }

  private skipped(summary: RepoTestSummary, key: "unit" | "stageApi" | "playwright", suite: TestExecutionResult["suite"], why: string) {
    return this.finish(summary, key, {
      suite, repoPath: summary.repoPath, status: "skipped", totalTests: 0, passedCount: 0, failedCount: 0,
      skippedCount: 0, durationMs: 0, output: why,
    });
  }

  /** `configRepo`: the main repo whose config/secrets apply when `repoPath` is a ticket worktree. */
  public async runUnitTests(repoPath: string, configRepo = repoPath): Promise<TestExecutionResult> {
    const s = this.getSummary(repoPath);
    s.overallStatus = "running";
    this.notify(s);
    const cmd = this.detectUnitCommand(repoPath, configRepo);
    if (!cmd) return this.skipped(s, "unit", "unit", "No unit test command detected. Set one in the repo's CodeSentinel config (testCommand).");
    return this.execSuite(s, "unit", "unit", cmd, { ...process.env, CI: "true" }, 10 * 60000);
  }

  /**
   * Stage deploy (manual | auto | disabled) then the API suite with vault secrets injected as env vars
   * (plus STAGE_API_URL). Nothing is faked: without an API test command the suite is reported as skipped.
   */
  public async runStageApiTests(repoPath: string, ticketKey?: string, configRepo = repoPath): Promise<TestExecutionResult> {
    const s = this.getSummary(repoPath);
    s.overallStatus = "running";
    this.notify(s);
    const rc = getRepoConfig(configRepo);
    if (!(rc.apiTestingEnabled ?? getSetting<boolean>("testing.apiTestingEnabled", true))) {
      return this.skipped(s, "stageApi", "stage_api", "API testing is disabled in settings.");
    }
    const cmd = this.detectApiCommand(repoPath, configRepo);
    if (!cmd) {
      return this.skipped(s, "stageApi", "stage_api", "No API test command found (add a `test:api` npm script or set apiTestCommand in the repo config).");
    }
    const mode = rc.stageDeployMode ?? getSetting<string>("testing.stageDeployMode", "manual");
    const deployCmd = rc.stageDeployCommand ?? getSetting<string>("testing.stageDeployCommand", "");
    const stageUrl = rc.stageApiBaseUrl ?? getSetting<string>("testing.stageApiBaseUrl", "");
    const secrets = await SecretVault.getInstance().resolveEnv(path.basename(configRepo), ticketKey);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...secrets,
      ...(stageUrl ? { STAGE_API_URL: stageUrl } : {}),
      CI: "true",
    };
    let log = "";
    if (mode === "auto") {
      if (!deployCmd) return this.skipped(s, "stageApi", "stage_api", "Stage deploy mode is 'auto' but no stageDeployCommand is configured.");
      const d = await runShell(deployCmd, { cwd: repoPath, env, timeoutMs: 15 * 60000 });
      log += this.redact(`[deploy] ${deployCmd} → exit ${d.code}\n${d.stdout}${d.stderr}\n`, Object.values(secrets));
      if (d.code !== 0) {
        return this.finish(s, "stageApi", {
          suite: "stage_api", repoPath, status: "failed", command: deployCmd, totalTests: 1, passedCount: 0,
          failedCount: 1, skippedCount: 0, durationMs: 0, output: log.slice(-200000), error: "Stage deployment failed",
        });
      }
    } else if (mode === "manual") {
      log += `[deploy] manual mode: assuming stage is already deployed${stageUrl ? ` at ${stageUrl}` : ""}.\n`;
    } else {
      log += "[deploy] disabled.\n";
    }
    return this.execSuite(s, "stageApi", "stage_api", cmd, env, 10 * 60000, log, Object.values(secrets));
  }

  public async runPlaywrightTests(repoPath: string, configRepo = repoPath): Promise<TestExecutionResult> {
    const s = this.getSummary(repoPath);
    s.overallStatus = "running";
    this.notify(s);
    const rc = getRepoConfig(configRepo);
    if (!(rc.playwrightEnabled ?? getSetting<boolean>("testing.playwrightEnabled", true))) {
      return this.skipped(s, "playwright", "playwright", "Playwright testing is disabled in settings.");
    }
    if (!this.hasPlaywright(repoPath)) {
      return this.skipped(s, "playwright", "playwright", "No playwright.config found. Ask the tester agent to scaffold Playwright tests.");
    }
    return this.execSuite(s, "playwright", "playwright", this.detectPlaywrightCommand(repoPath, configRepo), { ...process.env, CI: "true" }, 15 * 60000);
  }

  public async runAllTests(repoPath: string, ticketKey?: string): Promise<RepoTestSummary> {
    await this.runUnitTests(repoPath);
    await this.runStageApiTests(repoPath, ticketKey);
    await this.runPlaywrightTests(repoPath);
    const s = this.getSummary(repoPath);
    s.lastRunTimestamp = Date.now();
    this.updateOverallStatus(s);
    this.notify(s);
    return s;
  }

  private updateOverallStatus(s: RepoTestSummary): void {
    const ran = [s.unit, s.stageApi, s.playwright].filter((x): x is TestExecutionResult => !!x && x.status !== "skipped");
    if (ran.length === 0) s.overallStatus = "idle";
    else s.overallStatus = ran.some((r) => r.status === "failed") ? "failed" : "passed";
  }
}
