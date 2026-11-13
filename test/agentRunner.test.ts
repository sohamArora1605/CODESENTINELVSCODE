import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { buildHeadlessCommand, resolveModel, isValidModel, parseClaudeStreamLine, parseAgyStreamLine, parseOpencodeStreamLine, CliAgentExecutor, resolveEffort, isValidEffort, resolveAgyModelAndEffort } from "../src/agent/agentRunner";
import { buildInteractiveCommand, AgentTerminalLauncher } from "../src/agent/agentTerminalLauncher";
import { run, runShell, runStream } from "../src/util/proc";
import { setSettingsOverrides } from "../src/config/settings";
import { tmpDir } from "./helpers";

export async function testAgentRunner(): Promise<void> {
  console.log("▶ Running AgentRunner Tests...");
  setSettingsOverrides({});

  // ---- model resolution: never opus unless asked; override > role > harness > default
  assert.strictEqual(resolveModel("claude-code", "developer"), "sonnet", "default must be sonnet, not opus");
  assert.strictEqual(resolveModel("gemini-antigravity", "developer"), "gemini-3.8-flash", "agy: default to gemini-3.8-flash");
  assert.strictEqual(resolveModel("opencode", "developer"), "opencode/big-pickle", "opencode: default to big-pickle");
  setSettingsOverrides({ "agent.model.claude-code": "haiku", "agent.roleModels": { planner: "opus" }, "agent.model.opencode": "anthropic/claude-sonnet-5-5" });
  assert.strictEqual(resolveModel("claude-code", "developer"), "haiku");
  assert.strictEqual(resolveModel("claude-code", "planner"), "opus", "explicit per-stage choice is honored");
  assert.strictEqual(resolveModel("claude-code", "planner", "claude-sonnet-5-5"), "claude-sonnet-5-5", "per-run override wins");
  assert.strictEqual(resolveModel("opencode", "tester"), "anthropic/claude-sonnet-5-5");
  setSettingsOverrides({ "agent.model.claude-code": "--dangerously-skip-permissions" });
  assert.strictEqual(resolveModel("claude-code", "tester"), undefined, "option-looking values are rejected");
  assert.ok(isValidModel("claude-sonnet-5-5") && isValidModel("anthropic/claude-sonnet-5-5") && !isValidModel("a b") && !isValidModel("-x") && !isValidModel("x;rm"));
  setSettingsOverrides({});

  // ---- effort resolution: override > per-stage > per-harness > default; claude, agy, opencode all support effort
  assert.strictEqual(resolveEffort("claude-code", "developer"), "medium");
  assert.strictEqual(resolveEffort("gemini-antigravity", "developer"), "medium");
  assert.strictEqual(resolveEffort("opencode", "developer"), "medium", "opencode supports effort via variant");
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
  assert.deepStrictEqual(buildHeadlessCommand("gemini-antigravity", "planner", "P", "gem-x")!.args, ["-p", "P", "--output-format", "stream-json", "--dangerously-skip-permissions", "--model", "gem-x", "--mode", "plan"]);
  assert.deepStrictEqual(buildHeadlessCommand("gemini-antigravity", "planner", "P", "gem-x", "high")!.args, ["-p", "P", "--output-format", "stream-json", "--dangerously-skip-permissions", "--model", "gem-x", "--effort", "high", "--mode", "plan"]);
  assert.ok(buildHeadlessCommand("gemini-antigravity", "developer", "P", "gem-x")!.args.includes("--dangerously-skip-permissions"));
  assert.ok(buildHeadlessCommand("gemini-antigravity", "planner", "P", "gem-x")!.args.includes("--dangerously-skip-permissions"), "agy planner also includes skip-permissions");
  // agy conflict resolution: baked flash effort suffix normalizes to clean base with --effort
  assert.deepStrictEqual(resolveAgyModelAndEffort("gemini-3.8-flash-high", "medium"), { model: "gemini-3.8-flash", effort: "medium" });
  assert.deepStrictEqual(resolveAgyModelAndEffort("gemini-3.8-flash-low", "high"), { model: "gemini-3.8-flash", effort: "high" });
  assert.deepStrictEqual(resolveAgyModelAndEffort("gemini-3.8-flash", "low"), { model: "gemini-3.8-flash", effort: "low" });
  assert.deepStrictEqual(resolveAgyModelAndEffort("gemini-3.8-flash-high", ""), { model: "gemini-3.8-flash-high", effort: undefined });
  assert.deepStrictEqual(resolveAgyModelAndEffort("", ""), { model: undefined, effort: undefined });
  // agy: claude models do not support --effort
  assert.deepStrictEqual(resolveAgyModelAndEffort("claude-sonnet-4-6", "medium"), { model: "claude-sonnet-4-6", effort: undefined });
  assert.deepStrictEqual(resolveAgyModelAndEffort("claude-opus-4-6-thinking", "high"), { model: "claude-opus-4-6-thinking", effort: undefined });
  assert.deepStrictEqual(resolveAgyModelAndEffort("claude-3-7-sonnet", "low"), { model: "claude-3-7-sonnet", effort: undefined });
  // agy: baked suffix models avoid conflicting --effort
  assert.deepStrictEqual(resolveAgyModelAndEffort("gpt-oss-120b-medium", "medium"), { model: "gpt-oss-120b-medium", effort: undefined });
  assert.deepStrictEqual(resolveAgyModelAndEffort("gpt-oss-120b-xhigh", "low"), { model: "gpt-oss-120b-xhigh", effort: undefined });
  assert.deepStrictEqual(resolveAgyModelAndEffort("gemini-3.8-flash-xhigh", "high"), { model: "gemini-3.8-flash", effort: "high" });
  assert.deepStrictEqual(resolveAgyModelAndEffort("gemini-3.8-flash-max", "low"), { model: "gemini-3.8-flash", effort: "low" });
  assert.deepStrictEqual(resolveAgyModelAndEffort("custom-model-low", "high"), { model: "custom-model-low", effort: undefined });
  assert.deepStrictEqual(resolveAgyModelAndEffort("custom-model-max", "medium"), { model: "custom-model-max", effort: undefined });
  // agy: standard models without baked suffix pass through valid effort
  assert.deepStrictEqual(resolveAgyModelAndEffort("gemini-2.5-pro", "high"), { model: "gemini-2.5-pro", effort: "high" });
  assert.deepStrictEqual(resolveAgyModelAndEffort("gemini-2.5-pro", "invalid-effort"), { model: "gemini-2.5-pro", effort: undefined });
  // agy headless command with harmonized claude model drops --effort
  assert.ok(!buildHeadlessCommand("gemini-antigravity", "developer", "P", "claude-sonnet-4-6", "high")!.args.includes("--effort"));
  const withEffort = buildHeadlessCommand("claude-code", "developer", "p", "sonnet", "high")!.args;
  assert.deepStrictEqual(withEffort.slice(withEffort.indexOf("--model"), withEffort.indexOf("--model") + 4), ["--model", "sonnet", "--effort", "high"]);
  assert.ok(!buildHeadlessCommand("claude-code", "developer", "p", "sonnet")!.args.includes("--effort"), "no --effort when none resolved");
  assert.ok(!buildHeadlessCommand("opencode", "developer", "p", undefined, "high")!.args.includes("--effort"));
  assert.ok(buildHeadlessCommand("opencode", "developer", "p", undefined, "high")!.args.includes("--variant"));
  assert.ok(!buildHeadlessCommand("claude-code", "developer", "p", "sonnet", "turbo")!.args.includes("--effort"), "invalid effort never reaches the CLI");
  assert.deepStrictEqual(buildHeadlessCommand("opencode", "developer", "P", "anthropic/x")!.args, ["run", "--model", "anthropic/x", "--auto", "--format", "json", "P"]);
  assert.strictEqual(buildHeadlessCommand("cursor", "developer", "P"), null);
  assert.ok(!buildHeadlessCommand("claude-code", "developer", "p", "bad model")!.args.includes("--model"), "invalid model never reaches the CLI");

  // ---- interactive terminal command building
  assert.strictEqual(
    buildInteractiveCommand("claude-code", "/tmp/p.md", "darwin", { model: "sonnet", effort: "high" }),
    'claude --model sonnet --effort high "$(cat \'/tmp/p.md\')"'
  );
  assert.strictEqual(
    buildInteractiveCommand("gemini-antigravity", "/tmp/p.md", "darwin", { model: "gemini-3.8-flash-high", effort: "medium" }),
    'agy --model gemini-3.8-flash --effort medium -i "$(cat \'/tmp/p.md\')"'
  );
  assert.strictEqual(
    buildInteractiveCommand("opencode", "/tmp/p.md", "darwin", { model: "opencode/big-pickle", effort: "medium" }),
    'opencode --model opencode/big-pickle --variant medium "$(cat \'/tmp/p.md\')"'
  );
  assert.strictEqual(
    buildInteractiveCommand("gemini-antigravity", "C:\\p.md", "win32"),
    "agy -i (Get-Content -Raw -LiteralPath 'C:\\p.md')"
  );
  assert.strictEqual(
    buildInteractiveCommand("gemini-antigravity", "/tmp/p.md", "darwin", { model: "claude-sonnet-4-6", effort: "high" }),
    'agy --model claude-sonnet-4-6 -i "$(cat \'/tmp/p.md\')"',
    "agy interactive drops effort for claude model"
  );
  assert.strictEqual(
    buildInteractiveCommand("cursor", "/tmp/p.md", "darwin", { model: "claude-3-5-sonnet" }),
    'cursor-agent --model claude-3-5-sonnet "$(cat \'/tmp/p.md\')"'
  );
  assert.strictEqual(buildInteractiveCommand("cursor", null, "darwin"), "cursor-agent");
  assert.strictEqual(buildInteractiveCommand("claude-code", null, "darwin"), "claude");
  assert.strictEqual(buildInteractiveCommand("opencode", null, "darwin"), "opencode");
  assert.strictEqual(buildInteractiveCommand("gemini-antigravity", null, "darwin"), "agy");

  // ---- stream parsing
  assert.deepStrictEqual(parseClaudeStreamLine('{"type":"system","subtype":"init","model":"claude-sonnet-5-5"}'), { model: "claude-sonnet-5-5", activity: "started (claude-sonnet-5-5)" });
  assert.strictEqual(parseClaudeStreamLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"lib/index.js"}}]}}')!.activity, "Read lib/index.js");
  assert.ok(parseClaudeStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"Adding validation"}]}}')!.activity!.includes("Adding validation"));
  assert.deepStrictEqual(parseClaudeStreamLine('{"type":"result","subtype":"success","is_error":false,"result":"DONE"}')!.result, { text: "DONE", isError: false });
  assert.strictEqual(parseClaudeStreamLine('{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}')!.result!.isError, true);
  assert.strictEqual(parseClaudeStreamLine("not json"), null);
  assert.strictEqual(parseClaudeStreamLine('{"type":"rate_limit_event"}'), null);

  // ---- agy stream parsing
  assert.deepStrictEqual(parseAgyStreamLine('{"event":"init"}'), { activity: "started (agy session)" });
  assert.strictEqual(parseAgyStreamLine('{"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"npm test"}}}}')!.activity, "run_command npm test");
  assert.strictEqual(parseAgyStreamLine('{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"Updating security config"}}')!.activity, "says: Updating security config");
  assert.deepStrictEqual(parseAgyStreamLine('{"event":"result","result":{"status":"SUCCESS","response":"All tasks completed successfully"}}')!.result, { text: "All tasks completed successfully", isError: false });

  // ---- opencode stream parsing
  assert.deepStrictEqual(parseOpencodeStreamLine('{"type":"step_start"}'), { activity: "started (opencode)" });
  assert.strictEqual(parseOpencodeStreamLine('{"type":"tool_call","part":{"type":"tool","tool":"edit_file","input":{"path":"src/index.ts"}}}')!.activity, "edit_file src/index.ts");
  assert.strictEqual(parseOpencodeStreamLine('{"type":"text","part":{"type":"text","text":"Refactoring done"}}')!.activity, "says: Refactoring done");

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

  // ---- end to end through fake `agy` binary
  fs.writeFileSync(path.join(bin, "agy"), `#!/bin/sh
echo '{"event":"init"}'
echo '{"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"npm test"}}}}'
echo '{"event":"result","result":{"status":"SUCCESS","response":"agy finished ok"}}'
`, { mode: 0o755 });
  const agySeen: string[] = [];
  const agyRes = await new CliAgentExecutor().run({
    role: "developer", harness: "gemini-antigravity", cwd: bin, prompt: "test agy", onActivity: (l) => agySeen.push(l),
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.ok(agyRes.success, agyRes.output);
  assert.strictEqual(agyRes.output, "agy finished ok");
  assert.deepStrictEqual(agySeen, ["started (agy session)", "run_command npm test"]);

  // ---- end to end through fake `opencode` binary
  fs.writeFileSync(path.join(bin, "opencode"), `#!/bin/sh
echo '{"type":"step_start"}'
echo '{"type":"tool_call","part":{"type":"tool","tool":"write_file","input":{"file":"out.txt"}}}'
echo '{"type":"text","part":{"type":"text","text":"opencode done"}}'
`, { mode: 0o755 });
  const ocSeen: string[] = [];
  const ocRes = await new CliAgentExecutor().run({
    role: "developer", harness: "opencode", cwd: bin, prompt: "test opencode", onActivity: (l) => ocSeen.push(l),
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.ok(ocRes.success, ocRes.output);
  assert.strictEqual(ocRes.output, "opencode done");
  assert.deepStrictEqual(ocSeen, ["started (opencode)", "write_file out.txt", "says: opencode done"]);

  // a missing CLI is reported, not thrown
  const nope = await new CliAgentExecutor().run({ role: "planner", harness: "claude-code", cwd: bin, prompt: "x", env: { ...process.env, PATH: "/nonexistent" } });
  assert.ok(!nope.success && /not found/.test(nope.output));

  // ---- proc.ts AbortSignal support
  const preAborted = new AbortController();
  preAborted.abort();
  const shPre = await runShell("echo 1", { signal: preAborted.signal });
  assert.strictEqual(shPre.code, 130, "pre-aborted runShell must exit with code 130");

  const activeSh = new AbortController();
  const shP = runShell('node -e "setTimeout(()=>{},5000)"', { signal: activeSh.signal });
  setTimeout(() => activeSh.abort(), 80);
  const shActive = await shP;
  assert.strictEqual(shActive.code, 130, "running runShell aborted must exit with code 130");

  const streamPre = await runStream(process.execPath, ["-e", "console.log(1)"], { signal: preAborted.signal });
  assert.strictEqual(streamPre.code, 130, "pre-aborted runStream must exit with code 130");

  const activeStream = new AbortController();
  const streamP = runStream(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { signal: activeStream.signal });
  setTimeout(() => activeStream.abort(), 80);
  const streamActive = await streamP;
  assert.strictEqual(streamActive.code, 130, "running runStream aborted must exit with code 130");
  assert.ok(streamActive.stderr.includes("Process aborted by signal."));

  const runPre = await run(process.execPath, ["-e", "console.log(1)"], { signal: preAborted.signal });
  assert.strictEqual(runPre.code, 130, "pre-aborted run must exit with code 130");

  // ---- CliAgentExecutor with AbortSignal
  const slowBin = tmpDir("cs-slowbin-");
  fs.writeFileSync(path.join(slowBin, "claude"), `#!/usr/bin/env node
setTimeout(() => {}, 10000);
`, { mode: 0o755 });

  const agentPreAbort = new AbortController();
  agentPreAbort.abort();
  const agentPreRes = await new CliAgentExecutor().run({
    role: "developer", harness: "claude-code", cwd: slowBin, prompt: "test", signal: agentPreAbort.signal,
    env: { ...process.env, PATH: `${slowBin}${path.delimiter}${process.env.PATH}` },
  });
  assert.strictEqual(agentPreRes.success, false);
  assert.strictEqual(agentPreRes.code, 130);

  const agentLiveAbort = new AbortController();
  const slowAgentP = new CliAgentExecutor().run({
    role: "developer", harness: "claude-code", cwd: slowBin, prompt: "test", signal: agentLiveAbort.signal,
    env: { ...process.env, PATH: `${slowBin}${path.delimiter}${process.env.PATH}` },
  });
  setTimeout(() => agentLiveAbort.abort(), 80);
  const agentLiveRes = await slowAgentP;
  assert.strictEqual(agentLiveRes.success, false);
  assert.strictEqual(agentLiveRes.code, 130);

  // ---- AgentTerminalLauncher: reuse existing terminal without resending startup command
  const launcher = AgentTerminalLauncher.getInstance();
  const mockWorkspace = tmpDir("cs-term-");
  const vscodeMock = require("vscode");
  let shownCount = 0;
  const sentTexts: string[] = [];

  const fakeTerminalInstance = {
    name: "",
    show: () => { shownCount++; },
    sendText: (t: string) => { sentTexts.push(t); },
  };

  const origTerminals = vscodeMock.window.terminals;
  const origCreateTerminal = vscodeMock.window.createTerminal;
  vscodeMock.window.terminals = [];
  vscodeMock.window.createTerminal = (opts: any) => {
    const t = { ...fakeTerminalInstance, name: opts.name };
    vscodeMock.window.terminals.push(t);
    return t;
  };

  try {
    const tFirst = launcher.launchAgentTerminal(
      mockWorkspace,
      "gemini-antigravity",
      "fix bug",
      { key: "BUG-101", summary: "Fix NPE", branch: "fix/npe" },
      {},
      { model: "gemini-3.8-flash-high", effort: "medium" }
    );
    assert.strictEqual(vscodeMock.window.terminals.length, 1);
    assert.strictEqual(sentTexts.length, 1);
    assert.ok(sentTexts[0].includes("agy --model gemini-3.8-flash --effort medium"));

    // Launching the same ticket/repo again brings terminal to front and does NOT call sendText again
    const tSecond = launcher.launchAgentTerminal(
      mockWorkspace,
      "gemini-antigravity",
      "fix bug",
      { key: "BUG-101", summary: "Fix NPE", branch: "fix/npe" }
    );
    assert.strictEqual(tSecond, tFirst);
    assert.strictEqual(shownCount, 2, "terminal shown on creation and brought to front on second launch");
    assert.strictEqual(sentTexts.length, 1, "sendText was not called again for existing terminal");
  } finally {
    vscodeMock.window.terminals = origTerminals;
    vscodeMock.window.createTerminal = origCreateTerminal;
  }

  console.log("✔ AgentRunner OK");
}
