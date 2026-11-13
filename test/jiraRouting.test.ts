import * as assert from "assert";
import { JiraService } from "../src/jira/jiraService";
import { SecretVault } from "../src/security/secretVault";
import { setSettingsOverrides } from "../src/config/settings";
import { AgentExecutor, AgentRunRequest } from "../src/agent/agentRunner";
import { tmpDir } from "./helpers";

/** "Via agent" mode: direct Atlassian client first when signed in, headless `claude -p` agent otherwise. */
export async function testJiraRouting(): Promise<void> {
  console.log("▶ Running Jira routing Tests...");
  SecretVault.getInstance().init(tmpDir("cs-routevault-"));
  setSettingsOverrides({ "jira.mode": "harness" });
  const jira = JiraService.getInstance();

  const asked: AgentRunRequest[] = [];
  let reply = "";
  let agentOk = true;
  jira.setHarnessExecutor({ async run(req) { asked.push(req); return { success: agentOk, output: reply, code: agentOk ? 0 : 1, harness: "claude-code" }; } } as AgentExecutor);

  const calls: string[] = [];
  const node = (key: string) => ({ key, fields: { summary: "via sign-in", description: "markdown **desc**", status: { name: "To Do" }, priority: { name: "Medium" }, issuetype: { name: "Task" }, labels: ["x"], components: [] } });
  let signedIn = false;
  let directFails = false;
  jira.setAtlassianClient({
    async isSignedIn() { return signedIn; },
    async getIssue(k) { calls.push("get:" + k); if (directFails) throw new Error("401 session expired"); return k === "GONE-1" ? null : node(k); },
    async search(jql) { calls.push("search:" + jql); return [node("S-1"), node("S-2")]; },
    async transition(k, s) { calls.push(`transition:${k}:${s}`); return { ok: true, message: "moved" }; },
    async comment(k, text) { calls.push(`comment:${k}`); return { ok: true, message: "posted" }; },
  });

  // ---- not signed in: the headless agent route; the direct client is not touched
  reply = '{"key":"AGT-1","summary":"from the agent","description":"d","status":"To Do","priority":"High","issueType":"Task","labels":[],"components":[]}';
  assert.strictEqual((await jira.getTicket("AGT-1"))!.summary, "from the agent");
  assert.strictEqual(asked[0].role, "ticket");
  assert.deepStrictEqual(calls, []);

  // prose / failure => an error that points at "Connect Jira" (never fake data)
  reply = "I could not find that issue, sorry.";
  await assert.rejects(jira.getTicket("AGT-4"), /did not return JSON[\s\S]*Connect Jira/);
  agentOk = false; reply = "mcp server not connected";
  await assert.rejects(jira.getTicket("AGT-4"), /could not reach Jira[\s\S]*Connect Jira/);
  const failed = await jira.updateTicketStatus("AGT-5", "Done");
  assert.ok(!failed.success && /Connect Jira/.test(failed.message));
  agentOk = true;

  // ---- signed in: direct client first, the agent is never asked
  signedIn = true;
  const asks = asked.length;
  const direct = await jira.getTicket("AGT-2");
  assert.strictEqual(direct!.summary, "via sign-in");
  assert.strictEqual(direct!.description, "markdown **desc**");
  assert.strictEqual(asked.length, asks, "no agent run when the direct connection works");
  assert.strictEqual(await jira.getTicket("GONE-1"), null, "not found via the direct client is null, not an error");
  assert.deepStrictEqual((await jira.listTickets()).map((x) => x.key), ["S-1", "S-2"]);
  assert.ok((await jira.updateTicketStatus("AGT-2", "In Review", "all gates passed")).success);
  assert.ok(calls.includes("transition:AGT-2:In Review") && calls.includes("comment:AGT-2"));
  assert.strictEqual(asked.length, asks);

  // ---- signed in but the direct call fails: the agent is the backup
  directFails = true;
  reply = '{"key":"AGT-7","summary":"agent backup"}';
  assert.strictEqual((await jira.getTicket("AGT-7"))!.summary, "agent backup");
  assert.ok(asked.length > asks);

  // ---- both fail: one error saying what each route did
  reply = "no json here";
  await assert.rejects(jira.getTicket("AGT-6"), /Direct Atlassian connection failed: 401 session expired[\s\S]*Agent route also failed: [\s\S]*did not return JSON/);

  jira.setHarnessExecutor(null);
  setSettingsOverrides({});
  console.log("✔ Jira routing OK");
}
