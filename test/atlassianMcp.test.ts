import * as assert from "assert";
import * as http from "http";
import * as net from "net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AtlassianMcp, VaultOAuthProvider } from "../src/jira/atlassianMcp";
import { SecretVault } from "../src/security/secretVault";
import { setSettingsOverrides } from "../src/config/settings";
import { tmpDir } from "./helpers";

const ISSUE = { key: "KAN-4", fields: { summary: "cors: validate maxAge", description: "md **text**", status: { name: "To Do" }, priority: { name: "Medium" }, issuetype: { name: "Task" }, labels: ["a"], components: [] } };

function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });
}

/** A stateless Streamable-HTTP MCP server standing in for Atlassian. `style` selects direct tools vs the executeRead/Write runner. */
async function mockAtlassian(style: "direct" | "runner", log: any[]): Promise<{ url: string; close: () => void }> {
  const direct = ["getAccessibleAtlassianResources", "getJiraIssue", "searchJiraIssuesUsingJql", "transitionJiraIssue", "addOrEditJiraIssueComment"];
  const names = style === "direct" ? direct : ["executeRead", "executeWrite"];
  const handle = (name: string, args: any) => {
    log.push({ name, args });
    switch (name) {
      case "getAccessibleAtlassianResources": return { data: { resources: [{ id: "cloud-other", url: "https://other.atlassian.net" }, { id: "cloud-sandbox", url: "https://soham-sandbox.atlassian.net" }] } };
      case "getJiraIssue": return args.issueIdOrKey === "KAN-4" ? { issues: { nodes: [ISSUE] } } : { __error: "Issue does not exist (404)" };
      case "searchJiraIssuesUsingJql": return { issues: { nodes: [ISSUE, { ...ISSUE, key: "KAN-5" }] } };
      case "transitionJiraIssue": return { status: { name: args.targetStatus } };
      case "addOrEditJiraIssueComment": return { commentId: "1" };
    }
    return { __error: "unknown " + name };
  };
  const server = http.createServer(async (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const s = new Server({ name: "mock-atlassian", version: "1" }, { capabilities: { tools: {} } });
      s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: names.map((n) => ({ name: n, description: n, inputSchema: { type: "object", properties: {}, additionalProperties: true } })) }));
      s.setRequestHandler(CallToolRequestSchema, async (r) => {
        let name = r.params.name, args: any = r.params.arguments ?? {};
        if (style === "runner") { name = args.name; args = { cloudId: args.cloudId, ...(args.inputs ?? {}) }; }
        const out: any = handle(name, args);
        return out.__error ? { isError: true, content: [{ type: "text", text: out.__error }] } : { content: [{ type: "text", text: JSON.stringify(out) }] };
      });
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { t.close(); s.close(); });
      await s.connect(t);
      await t.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as any).port}/mcp`, close: () => server.close() };
}

export async function testAtlassianMcp(): Promise<void> {
  console.log("▶ Running Atlassian MCP client Tests...");
  const vault = SecretVault.getInstance();
  vault.init(tmpDir("cs-atl-"));
  const client = AtlassianMcp.getInstance();

  // ---- not signed in => explicit error, and never a browser
  let opened = 0;
  client.setBrowserOpener(async () => { opened++; });
  assert.strictEqual(await client.isSignedIn(), false);
  await assert.rejects(client.getIssue("KAN-4"), /Not signed in/);
  assert.strictEqual(opened, 0, "background lookups never open a browser");

  // a (fake) saved token marks us signed in
  await vault.setSecret("atlassian_oauth_tokens", JSON.stringify({ access_token: "t", token_type: "Bearer" }));
  assert.strictEqual(await client.isSignedIn(), true);

  for (const style of ["direct", "runner"] as const) {
    const log: any[] = [];
    const srv = await mockAtlassian(style, log);
    setSettingsOverrides({ "jira.mcpUrl": srv.url, "jira.host": "https://soham-sandbox.atlassian.net" });
    (client as any).cloudId = null;
    try {
      const issue = await client.getIssue("KAN-4");
      assert.strictEqual(issue.key, "KAN-4");
      assert.strictEqual(log.find((l) => l.name === "getJiraIssue").args.cloudId, "cloud-sandbox", `[${style}] cloud picked by jira.host, not the first site`);
      assert.strictEqual(await client.getIssue("NOPE-1"), null, `[${style}] 404 => null`);
      assert.strictEqual((await client.search("project = KAN", 5)).length, 2);
      const tr = await client.transition("KAN-4", "In Review");
      assert.ok(tr.ok, tr.message);
      assert.strictEqual(log.filter((l) => l.name === "transitionJiraIssue").pop().args.targetStatus, "In Review");
      assert.ok((await client.comment("KAN-4", "hello **md**")).ok);
      assert.strictEqual(log.filter((l) => l.name === "addOrEditJiraIssueComment").pop().args.commentBody, "hello **md**");
    } finally {
      srv.close();
    }
  }
  setSettingsOverrides({});

  // ---- OAuth provider: persistence in the vault, redirect-port binding, loopback callback
  const port = await freePort();
  const p = new VaultOAuthProvider(port, async () => {});
  assert.strictEqual(p.redirectUrl, `http://127.0.0.1:${port}/callback`);
  assert.strictEqual(p.clientMetadata.token_endpoint_auth_method, "none", "public client: no secret to leak");
  await p.saveClientInformation({ client_id: "abc", redirect_uris: [`http://127.0.0.1:${port}/callback`] } as any);
  assert.strictEqual((await p.clientInformation())!.client_id, "abc");
  const other = new VaultOAuthProvider(port + 1, async () => {});
  assert.strictEqual(await other.clientInformation(), undefined, "registration for another redirect port is not reused");
  await p.saveTokens({ access_token: "A", refresh_token: "R", token_type: "Bearer" } as any);
  assert.strictEqual((await p.tokens())!.refresh_token, "R");
  await p.invalidateCredentials("tokens");
  assert.strictEqual(await p.tokens(), undefined);

  // background provider refuses to redirect (token expired and refresh failed)
  await assert.rejects(new VaultOAuthProvider(port, async () => { opened++; }, false).redirectToAuthorization(new URL("https://auth.example/authorize")), /session expired/);
  assert.strictEqual(opened, 0);

  // interactive: the callback must carry the right state; the code is handed back
  const ok = new VaultOAuthProvider(port, async () => {
    await new Promise((r) => setTimeout(r, 50));
    await new Promise<void>((resolve) => http.get(`http://127.0.0.1:${port}/callback?code=THE_CODE&state=${(ok as any).state()}`, { agent: false }, (res) => { res.resume(); res.on("end", () => resolve()); }));
  });
  await ok.redirectToAuthorization(new URL("https://auth.example/authorize"));
  assert.strictEqual(await ok.pendingCode, "THE_CODE");

  const bad = new VaultOAuthProvider(port, async () => {
    await new Promise((r) => setTimeout(r, 50));
    await new Promise<void>((resolve) => http.get(`http://127.0.0.1:${port}/callback?code=EVIL&state=wrong`, { agent: false }, (res) => { res.resume(); res.on("end", () => resolve()); }));
  });
  await bad.redirectToAuthorization(new URL("https://auth.example/authorize"));
  await assert.rejects(bad.pendingCode!, /state did not match|rejected/);

  await client.signOut();
  assert.strictEqual(await client.isSignedIn(), false);
  console.log("✔ Atlassian MCP client OK");
}
