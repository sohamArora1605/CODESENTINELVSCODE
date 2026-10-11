import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { OpenCodeLauncher } from "../src/opencode/opencodeLauncher";

export async function testOpenCodeLauncher(): Promise<void> {
  console.log("▶ Running OpenCodeLauncher Tests...");

  const launcher = OpenCodeLauncher.getInstance();

  // Test 1: Singleton instance integrity
  assert.ok(launcher, "Launcher instance should exist");
  assert.strictEqual(launcher, OpenCodeLauncher.getInstance(), "Launcher should follow singleton pattern");

  // Test 2: Detect OpenCode CLI on host
  const check = await launcher.checkOpenCodeInstalled();
  console.log(`  - OpenCode installed check: ${check.installed ? "Yes (v" + check.version + ")" : "No"}`);
  assert.strictEqual(typeof check.installed, "boolean", "check.installed should be boolean");

  // Test 3: getOpencodeCommand fallback
  const cmd = launcher.getOpencodeCommand();
  assert.ok(cmd && cmd.length > 0, "Default opencode command should not be empty");

  // Test 4: syncWorkspaceConfig creates valid opencode.json
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesentinel-test-"));
  try {
    const fakeMcpScript = path.join(tmpDir, "dist", "mcp-server.js");
    const writtenPath = await launcher.syncWorkspaceConfig(tmpDir, fakeMcpScript);

    assert.ok(fs.existsSync(writtenPath), "opencode.json should be created");
    const parsed = JSON.parse(fs.readFileSync(writtenPath, "utf-8"));

    assert.ok(parsed.mcp, "opencode.json must have 'mcp' object");
    assert.ok(parsed.mcp.codesentinel, "opencode.json must register 'codesentinel'");
    assert.strictEqual(parsed.mcp.codesentinel.type, "local", "Type must be local");
    assert.deepStrictEqual(parsed.mcp.codesentinel.command, ["node", fakeMcpScript]);
    assert.strictEqual(parsed.mcp.codesentinel.enabled, true);
    assert.strictEqual(parsed.mcp.codesentinel.environment.CODESENTINEL_WORKSPACE, tmpDir);

    // Verify Atlas MCP registration
    assert.ok(parsed.mcp.atlas, "opencode.json must register 'atlas'");
    assert.strictEqual(parsed.mcp.atlas.type, "local");
    assert.ok(parsed.mcp.atlas.command.includes("codesentinel/core:latest"));
    assert.ok(parsed.mcp.atlas.command.includes("--entrypoint"));
    assert.strictEqual(parsed.mcp.atlas.enabled, true);

    // Test 5: syncWorkspaceConfig preserves existing third-party mcp servers
    parsed.mcp["other-tool"] = { type: "local", command: ["python", "other.py"], enabled: true };
    fs.writeFileSync(writtenPath, JSON.stringify(parsed, null, 2), "utf-8");

    await launcher.syncWorkspaceConfig(tmpDir, fakeMcpScript);
    const updated = JSON.parse(fs.readFileSync(writtenPath, "utf-8"));
    assert.ok(updated.mcp["other-tool"], "Existing third-party tool must be preserved");
    // Test 5b: syncWorkspaceConfig with useDocker sets docker run command
    await launcher.syncWorkspaceConfig(tmpDir, fakeMcpScript, { useDocker: true });
    const dockerParsed = JSON.parse(fs.readFileSync(writtenPath, "utf-8"));
    assert.strictEqual(dockerParsed.mcp.codesentinel.command[0], "docker");
    assert.strictEqual(dockerParsed.mcp.codesentinel.command[1], "run");
    assert.ok(dockerParsed.mcp.codesentinel.command.includes("codesentinel/core:latest"));

    // Test 5c: Verify universal and gitignore exclusion engine
    const universal = launcher.getUniversalExcludes();
    assert.ok(universal.includes("**/node_modules/**"), "Should exclude node_modules");
    assert.ok(universal.includes("**/venv/**"), "Should exclude venv");
    assert.ok(universal.includes("**/*.mp3"), "Should exclude mp3 media files");
    assert.ok(universal.includes("**/*.png"), "Should exclude png images");

    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "custom_build/\n*.secret\n# comment\n", "utf-8");
    const gitignoreExcludes = launcher.getGitignoreExcludes(tmpDir);
    assert.ok(gitignoreExcludes.some(e => e.includes("custom_build")), "Should parse gitignore custom_build");
    assert.ok(gitignoreExcludes.some(e => e.includes("*.secret")), "Should parse gitignore *.secret");

    const excludeArgs = launcher.buildAtlasExcludeArgs(tmpDir);
    assert.ok(excludeArgs.includes("--exclude \"**/node_modules/**\""), "Should format exclude args");
    assert.ok(excludeArgs.includes("--exclude \"**/*.mp3\""), "Should format media exclude args");
    console.log("  ✔ Universal language-agnostic and gitignore exclusion engine passed");
    console.log("  ✔ opencode.json synthesis and non-destructive sync (host & docker) passed");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Test 6: Server status check when stopped
  assert.strictEqual(launcher.isServerRunning(), false, "Server should initially be stopped");

  // Test 7: Verify directory encoding and workspace session URL synthesis
  const sampleDir = "D:\\CODESENTINELVSCODE";
  const encoded = launcher.encodeDirectory(sampleDir);
  assert.strictEqual(encoded, "RDovQ09ERVNFTlRJTkVMVlNDT0RF", "Must encode forward-slashed path in base64url");
  const decoded = Buffer.from(encoded, "base64url").toString("utf-8");
  assert.strictEqual(decoded, "D:/CODESENTINELVSCODE", "Decoded path must be valid forward-slash path");

  const sessionUrl = await launcher.ensureWorkspaceSession(sampleDir, 5123);
  assert.strictEqual(sessionUrl, "http://127.0.0.1:5123/RDovQ09ERVNFTlRJTkVMVlNDT0RF/session");
  console.log("  ✔ Active workspace directory encoding and session routing verified");

  console.log("  ✔ All OpenCodeLauncher tests passed!");
}
