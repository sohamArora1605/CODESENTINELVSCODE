import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { makeRepo, tmpDir } from "./helpers";

/** Spawns the real bundled stdio server (no vscode module available, like under OpenCode/Claude). */
export async function testMcpProcess(): Promise<void> {
  console.log("▶ Running standalone MCP process Tests...");
  const bundle = path.resolve(__dirname, "..", "mcp-server.js");
  if (!fs.existsSync(bundle)) { console.log("  (skipped: dist/mcp-server.js not built)"); return; }
  const { repo } = makeRepo();
  const child = spawn(process.execPath, [bundle], {
    cwd: repo,
    env: { ...process.env, CODESENTINEL_WORKSPACE: repo, CODESENTINEL_VAULT_DIR: tmpDir("cs-mcpvault-") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiters = new Map<number, (m: any) => void>();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); waiters.get(m.id)?.(m); } catch {}
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  let nextId = 1;
  const rpc = (method: string, params?: any) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`MCP timeout on ${method}\n${stderr}`)), 20000);
    waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.ok(init.result, `server failed to start: ${stderr}`);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await rpc("tools/list");
    const names: string[] = list.result.tools.map((t: any) => t.name);
    for (const n of ["codesentinel_workflow_start_ticket", "codesentinel_workflow_status", "codesentinel_workflow_resume",
      "codesentinel_repo_config", "codesentinel_test_status", "codesentinel_secrets_manage", "codesentinel_git_sync_graph",
      "codesentinel_jira_list_tickets", "codesentinel_scan_git_diff", "codesentinel_multi_repo_status"]) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
    const call = (name: string, args: any) => rpc("tools/call", { name, arguments: args }).then((r) => r.result);

    const set = await call("codesentinel_repo_config", { repoPath: repo, set: { baseBranches: ["main", "develop"], branchMode: "ask" } });
    assert.ok(JSON.parse(set.content[0].text).config.branchMode === "ask");
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(repo, ".codesentinel", "repo-config.json"), "utf-8")).baseBranches[1], "develop");

    const jira = await call("codesentinel_jira_list_tickets", {});
    const jl = JSON.parse(jira.content[0].text);
    assert.strictEqual(jl.jiraMode, "disabled");
    assert.strictEqual(jl.count, 0, "disabled Jira must not return invented tickets");

    await call("codesentinel_secrets_manage", { action: "set", key: "STAGE_KEY", value: "s3cr3t-value", scope: "repo", scopeId: "r" });
    const got = await call("codesentinel_secrets_manage", { action: "get", key: "STAGE_KEY", scope: "repo", scopeId: "r" });
    assert.ok(!got.content[0].text.includes("s3c"), "secret value must never be returned to the agent");

    // cloud security audit works without an indexed graph and reports the common mistakes
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "up.js"),
      'const AWS = require("aws-sdk");\nconst s3 = new AWS.S3({ secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" });\n' +
      'app.get("/f", async (req, res) => { res.send(await fetch(req.query.url)); });\n' +
      's3.putObject({ Bucket: "b", ACL: "public-read" });\n' +
      'const policy = { "Effect": "Allow", "Action": "*" };\n');
    const audit = JSON.parse((await call("codesentinel_cloud_security_audit", {})).content[0].text);
    const titles: string[] = audit.findings.map((f: any) => f.title);
    for (const want of [/Secret Access Key/, /Publicly Accessible/, /SSRF/, /Wildcard IAM/]) {
      assert.ok(titles.some((x) => want.test(x)), `audit missed ${want}: ${titles.join(" | ")}`);
    }
    assert.ok(audit.cloudFootprint.includes("AWS"));
    assert.ok(fs.existsSync(path.join(repo, "SECURITY-AUDIT-REPORT.md")));

    const st = await call("codesentinel_workflow_status", { repoPath: repo });
    assert.match(st.content[0].text, /No workflows/);
    const noConfirm = await call("codesentinel_workflow_discard", { ticketKey: "KAN-1", repoPath: repo });
    assert.ok(noConfirm.isError && /confirm=true/.test(noConfirm.content[0].text), "discard needs explicit confirmation");
    const bad = await call("codesentinel_workflow_start_ticket", { ticketKey: "NOPE-9", repoPath: repo });
    assert.ok(bad.isError);
  } finally {
    child.kill();
  }
  console.log("✔ standalone MCP process OK");
}
