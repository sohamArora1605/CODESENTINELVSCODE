import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { buildHeadlessCommand, resolveModel, isValidModel, parseClaudeStreamLine, CliAgentExecutor, resolveEffort, isValidEffort } from "../src/agent/agentRunner";
import { setSettingsOverrides } from "../src/config/settings";
import { tmpDir } from "./helpers";

export async function testAgentRunner(): Promise<void> {
  console.log("▶ Running AgentRunner Tests...");
  setSettingsOverrides({});

  // ---- model resolution: never opus unless asked; override > role > harness > default
  assert.strictEqual(resolveModel("claude-code", "developer"), "sonnet", "default must be sonnet, not opus");
  assert.strictEqual(resolveModel("gemini-antigravity", "developer"), undefined, "agy: harness default when unset");
  setSettingsOverrides({ "agent.model.claude-code": "haiku", "agent.roleModels": { planner: "opus" }, "agent.model.opencode": "anthropic/claude-sonnet-5-5" });
  assert.strictEqual(resolveModel("claude-code", "developer"), "haiku");
  assert.strictEqual(resolveModel("claude-code", "planner"), "opus", "explicit per-stage choice is honored");
  assert.strictEqual(resolveModel("claude-code", "planner", "claude-sonnet-5-5"), "claude-sonnet-5-5", "per-run override wins");
  assert.strictEqual(resolveModel("opencode", "tester"), "anthropic/claude-sonnet-5-5");
  setSettingsOverrides({ "agent.model.claude-code": "--dangerously-skip-permissions" });
  assert.strictEqual(resolveModel("claude-code", "tester"), undefined, "option-looking values are rejected");
  assert.ok(isValidModel("claude-sonnet-5-5") && isValidModel("anthropic/claude-sonnet-5-5") && !isValidModel("a b") && !isValidModel("-x") && !isValidModel("x;rm"));
  setSettingsOverrides({});

  // ---- effort resolution: override > per-stage > per-harness > default; only claude / agy have the flag
  assert.strictEqual(resolveEffort("claude-code", "developer"), "medium");
  assert.strictEqual(resolveEffort("gemini-antigravity", "developer"), "medium");
  assert.strictEqual(resolveEffort("opencode", "developer"), undefined, "opencode has no --effort flag");
  setSettingsOverrides({ "agent.effort.claude-code": "low", "agent.roleEfforts": { planner: "high" } });
  assert.strictEqual(resolveEffort("claude-code", "developer"), "low");
  assert.strictEqual(resolveEffort("claude-code", "planner"), "high");
  assert.strictEqual(resolveEffort("claude-code", "planner", "max"), "max", "per-run override wins");
  setSettingsOverrides({ "agent.effort.claude-code": "turbo", "agent.roleEfforts": { planner: "--evil" } });
  assert.strictEqual(resolveEffort("claude-code", "planner"), undefined, "invalid values are dropped, not passed to the CLI");
  setSettingsOverrides({ "agent.effort.claude-code": "" });
  assert.strictEqual(resolveEffort("claude-code", "developer"), undefined, "empty = the CLI's own default");
  assert.ok(isValidEffort("xhigh") && !isValidEffort("ultra"));
  setSettingsOverrides({});

  // ---- command building per harness
  const c = buildHeadlessCommand("claude-code", "developer", "PROMPT", "sonnet")!;
  assert.deepStrictEqual(c.args.slice(0, 6), ["-p", "--output-format", "stream-json", "--verbose", "--model", "sonnet"]);
  assert.ok(c.args.includes("acceptEdits") && c.input === "PROMPT");
  assert.ok(!buildHeadlessCommand("claude-code", "planner", "p", "sonnet")!.args.includes("Edit"), "planner is read-only");
  assert.ok(buildHeadlessCommand("claude-code", "ticket", "p")!.args.includes("ToolSearch"));
  assert.ok(!buildHeadlessCommand("claude-code", "developer", "p")!.args.includes("--model"), "no --model flag when none resolved");
  assert.deepStrictEqual(buildHeadlessCommand("gemini-antigravity", "planner", "P", "gem-x")!.args, ["-p", "P", "--model", "gem-x", "--mode", "plan"]);
  assert.deepStrictEqual(buildHeadlessCommand("gemini-antigravity", "planner", "P", "gem-x", "high")!.args, ["-p", "P", "--model", "gem-x", "--effort", "high", "--mode", "plan"]);
  const withEffort = buildHeadlessCommand("claude-code", "developer", "p", "sonnet", "high")!.args;
  assert.deepStrictEqual(withEffort.slice(withEffort.indexOf("--model"), withEffort.indexOf("--model") + 4), ["--model", "sonnet", "--effort", "high"]);
  assert.ok(!buildHeadlessCommand("claude-code", "developer", "p", "sonnet")!.args.includes("--effort"), "no --effort when none resolved");
  assert.ok(!buildHeadlessCommand("opencode", "developer", "p", undefined, "high")!.args.includes("--effort"));
  assert.ok(!buildHeadlessCommand("claude-code", "developer", "p", "sonnet", "turbo")!.args.includes("--effort"), "invalid effort never reaches the CLI");
  assert.deepStrictEqual(buildHeadlessCommand("opencode", "developer", "P", "anthropic/x")!.args, ["run", "--model", "anthropic/x", "P"]);
  assert.strictEqual(buildHeadlessCommand("cursor", "developer", "P"), null);
  assert.ok(!buildHeadlessCommand("claude-code", "developer", "p", "bad model")!.args.includes("--model"), "invalid model never reaches the CLI");

  // ---- stream parsing
  assert.deepStrictEqual(parseClaudeStreamLine('{"type":"system","subtype":"init","model":"claude-sonnet-5-5"}'), { model: "claude-sonnet-5-5", activity: "started (claude-sonnet-5-5)" });
  assert.strictEqual(parseClaudeStreamLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"lib/index.js"}}]}}')!.activity, "Read lib/index.js");
  assert.ok(parseClaudeStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"Adding validation"}]}}')!.activity!.includes("Adding validation"));
  assert.deepStrictEqual(parseClaudeStreamLine('{"type":"result","subtype":"success","is_error":false,"result":"DONE"}')!.result, { text: "DONE", isError: false });
  assert.strictEqual(parseClaudeStreamLine('{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}')!.result!.isError, true);
  assert.strictEqual(parseClaudeStreamLine("not json"), null);
  assert.strictEqual(parseClaudeStreamLine('{"type":"rate_limit_event"}'), null);

  // ---- end to end through a fake `claude` binary: args, stdin, streamed activity, final result, reported model
  const bin = tmpDir("cs-fakebin-");
  const argsFile = path.join(bin, "args.txt");
  const stdinFile = path.join(bin, "stdin.txt");
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
cat > "${stdinFile}"
echo '{"type":"system","subtype":"init","model":"claude-sonnet-5-5"}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Grep","input":{"pattern":"maxAge"}}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"all done"}'
`, { mode: 0o755 });
  const seen: string[] = [];
  const res = await new CliAgentExecutor().run({
    role: "developer", harness: "claude-code", cwd: bin, prompt: "do it \"$(whoami)\" `id`", onActivity: (l) => seen.push(l),
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.ok(res.success, res.output);
  assert.strictEqual(res.output, "all done");
  assert.strictEqual(res.model, "claude-sonnet-5-5");
  assert.deepStrictEqual(seen, ["started (claude-sonnet-5-5)", "Grep maxAge"]);
  const args = fs.readFileSync(argsFile, "utf-8").split("\n");
  assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "sonnet");
  assert.ok(args.includes("--effort") && args[args.indexOf("--effort") + 1] === "medium", "default effort passed through");
  assert.strictEqual(res.effort, "medium");
  assert.strictEqual(fs.readFileSync(stdinFile, "utf-8"), "do it \"$(whoami)\" `id`", "prompt goes via stdin, never through a shell");

  // a missing CLI is reported, not thrown
  const nope = await new CliAgentExecutor().run({ role: "planner", harness: "claude-code", cwd: bin, prompt: "x", env: { ...process.env, PATH: "/nonexistent" } });
  assert.ok(!nope.success && /not found/.test(nope.output));
  console.log("✔ AgentRunner OK");
}
