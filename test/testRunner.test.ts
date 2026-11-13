import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { TestRunnerService, parseTestOutput } from "../src/testing/testRunnerService";
import { SecretVault } from "../src/security/secretVault";
import { setSettingsOverrides, setRepoConfig } from "../src/config/settings";
import { tmpDir } from "./helpers";

function repoWith(scripts: Record<string, string>): string {
  const d = tmpDir("cs-tr-");
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "x", scripts }));
  return d;
}

export async function testTestRunner(): Promise<void> {
  console.log("▶ Running TestRunnerService Tests...");
  SecretVault.getInstance().init(tmpDir("cs-vault2-"));
  setSettingsOverrides({});
  const svc = TestRunnerService.getInstance();

  // ---- parsers
  assert.deepStrictEqual(parseTestOutput("Tests:       1 failed, 2 skipped, 3 passed, 6 total"), { total: 6, passed: 3, failed: 1, skipped: 2, parsed: true });
  assert.deepStrictEqual(parseTestOutput("[INFO] Tests run: 10, Failures: 1, Errors: 1, Skipped: 2"), { total: 10, passed: 6, failed: 2, skipped: 2, parsed: true });
  assert.deepStrictEqual(parseTestOutput("===== 1 failed, 3 passed, 2 skipped in 0.50s ====="), { total: 6, passed: 3, failed: 1, skipped: 2, parsed: true });
  assert.deepStrictEqual(parseTestOutput('{"config":{},"stats":{"expected":4,"unexpected":1,"skipped":1,"flaky":0}}'), { total: 6, passed: 4, failed: 1, skipped: 1, parsed: true });
  assert.deepStrictEqual(parseTestOutput("  49 passing (47ms)\n  2 failing\n  1 pending"), { total: 52, passed: 49, failed: 2, skipped: 1, parsed: true });
  assert.strictEqual(parseTestOutput("hello").parsed, false);

  // ---- unit: pass / fail / not configured
  const ok = repoWith({ test: `node -e "console.log('Tests: 3 passed, 3 total')"` });
  const r1 = await svc.runUnitTests(ok);
  assert.strictEqual(r1.status, "passed");
  assert.strictEqual(r1.passedCount, 3);

  const bad = repoWith({ test: `node -e "console.log('Tests: 1 failed, 2 passed, 3 total');process.exit(1)"` });
  const r2 = await svc.runUnitTests(bad);
  assert.strictEqual(r2.status, "failed");
  assert.strictEqual(r2.failedCount, 1);
  assert.strictEqual(svc.getSummary(bad).overallStatus, "failed");

  const crash = repoWith({ test: `node -e "process.exit(2)"` });
  const r3 = await svc.runUnitTests(crash);
  assert.strictEqual(r3.status, "failed", "a crash with no parsable output must still fail");

  const none = tmpDir("cs-none-");
  const r4 = await svc.runUnitTests(none);
  assert.strictEqual(r4.status, "skipped");
  assert.strictEqual(r4.passed, true);
  assert.strictEqual(svc.getSummary(none).overallStatus, "idle", "skipped-only must not read as passed");

  // default npm placeholder is not a real test script
  const placeholder = repoWith({ test: `echo "Error: no test specified" && exit 1` });
  assert.strictEqual((await svc.runUnitTests(placeholder)).status, "skipped");

  // ---- stage/api: honest skip, then secrets injected with ticket > repo > global
  const apiNone = repoWith({});
  assert.strictEqual((await svc.runStageApiTests(apiNone)).status, "skipped");

  const api = repoWith({ "test:api": `node -e "process.exit(process.env.STAGE_KEY==='ticket-secret'&&process.env.STAGE_API_URL==='http://stage.test'?0:3)"` });
  setRepoConfig(api, { stageApiBaseUrl: "http://stage.test" });
  const v = SecretVault.getInstance();
  await v.setSecret("STAGE_KEY", "repo-secret", "repo", path.basename(api));
  assert.strictEqual((await svc.runStageApiTests(api)).status, "failed", "repo secret must not satisfy ticket check");
  await v.setSecret("STAGE_KEY", "ticket-secret", "ticket", "T-7");
  const r5 = await svc.runStageApiTests(api, "T-7");
  assert.strictEqual(r5.status, "passed", r5.output);
  assert.ok(!r5.output.includes("ticket-secret") || r5.output.includes("***"));
  const leak = repoWith({ "test:api": `node -e "console.log('key='+process.env.STAGE_KEY)"` });
  const r5b = await svc.runStageApiTests(leak, "T-7");
  assert.ok(r5b.output.includes("key=***") && !r5b.output.includes("key=ticket-secret"), "secret values must be masked in output");

  // auto deploy failure stops the suite
  setRepoConfig(api, { stageDeployMode: "auto", stageDeployCommand: `node -e "process.exit(5)"` });
  const r6 = await svc.runStageApiTests(api, "T-7");
  assert.strictEqual(r6.status, "failed");
  assert.match(r6.error || "", /deploy/i);
  setRepoConfig(api, { stageDeployMode: "disabled", apiTestingEnabled: false });
  assert.strictEqual((await svc.runStageApiTests(api, "T-7")).status, "skipped");

  // ---- playwright: skipped without config, never simulated
  const pw = await svc.runPlaywrightTests(ok);
  assert.strictEqual(pw.status, "skipped");
  assert.strictEqual(pw.totalTests, 0);

  // ---- results persist for other processes (MCP / UI)
  const disk = JSON.parse(fs.readFileSync(path.join(bad, ".codesentinel", "test-results.json"), "utf-8"));
  assert.strictEqual(disk.unit.status, "failed");
  console.log("✔ TestRunnerService OK");
}
