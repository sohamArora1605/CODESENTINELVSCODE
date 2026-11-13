import * as https from "https";
import * as http from "http";
import { JiraTicket } from "../types";
import { SecretVault } from "../security/secretVault";
import * as os from "os";
import { getSetting, getRepoConfig, getJiraMode, JiraMode } from "../config/settings";
import { AgentExecutor, CliAgentExecutor } from "../agent/agentRunner";
import { AtlassianLike, AtlassianMcp } from "./atlassianMcp";

export class JiraService {
  private static instance: JiraService;
  private localTickets: JiraTicket[] = [];
  private harnessExec: AgentExecutor | null = null;
  private atlassian: AtlassianLike = AtlassianMcp.getInstance();

  private constructor() {}

  public static getInstance(): JiraService {
    if (!JiraService.instance) {
      JiraService.instance = new JiraService();
    }
    return JiraService.instance;
  }

  /** In disabled mode tickets can still exist locally (tests / ad-hoc tasks). Never used in manual or harness mode. */
  public setLocalTickets(tickets: JiraTicket[]): void {
    this.localTickets = tickets.map((t) => ({ ...t }));
  }

  public setHarnessExecutor(e: AgentExecutor | null): void {
    this.harnessExec = e;
  }

  public setAtlassianClient(c: AtlassianLike): void {
    this.atlassian = c;
  }

  public getMode(): JiraMode {
    return getJiraMode();
  }

  /** Manual mode counts as enabled for the REST client; harness mode has no REST credentials. */
  public isEnabled(): boolean {
    return getJiraMode() !== "disabled";
  }

  public async isConfigured(): Promise<boolean> {
    if (getJiraMode() === "harness") return true;
    const host = getSetting<string>("jira.host", "").trim();
    const email = getSetting<string>("jira.email", "").trim();
    const token = await SecretVault.getInstance().getSecret("jira_api_token", "global");
    return Boolean(host && email && token);
  }

  /** True when CodeSentinel itself talks to the Jira REST API. */
  public async isLive(): Promise<boolean> {
    return getJiraMode() === "manual" && (await this.isConfigured());
  }

  /** Branch name from template: per-call template > per-repo config > global setting > default. */
  public generateBranchName(ticket: JiraTicket, template?: string, repoPath?: string): string {
    const tpl =
      template ||
      (repoPath ? getRepoConfig(repoPath).branchTemplate : undefined) ||
      getSetting<string>("branchNamingTemplate", "") ||
      "feature/${ticketKey}-${slug}";
    const key = ticket.key.toUpperCase();
    const type = (ticket.issueType || "feature").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const slug = (ticket.summary || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^(.{1,40})(?:-.*)?$/, "$1") // keep whole words: cut at the last '-' within 40 chars
      .substring(0, 60) // guard: one enormous word with no hyphen
      .replace(/-+$/g, "");
    let branch = tpl
      .replace(/\$\{(ticketKey|key)\}/g, key)
      .replace(/\$\{(issueType|type)\}/g, type)
      .replace(/\$\{slug\}/g, slug);
    branch = branch
      .replace(/[\s~^:?*\[\\"'`$;|&<>(){}]+/g, "-")
      .replace(/\.\.+/g, ".")
      .replace(/\/{2,}/g, "/")
      .replace(/-+/g, "-")
      .replace(/^[-/.]+|[-/.]+$/g, "")
      .replace(/\.lock$/, "");
    return branch || `feature/${key}`;
  }

  /** Lists tickets. Live/harness failures propagate; local data is never substituted for them. */
  public async listTickets(filter?: { status?: string; project?: string; query?: string }): Promise<JiraTicket[]> {
    const mode = getJiraMode();
    if (mode === "harness") return this.harnessList(filter);
    if (mode === "manual") {
      if (!(await this.isConfigured())) throw new Error("Jira is in manual mode but host, email or API token is missing.");
      return this.fetchLiveJiraTickets(filter);
    }
    let list = [...this.localTickets];
    if (filter?.status && filter.status !== "All") list = list.filter((t) => t.status.toLowerCase() === filter.status!.toLowerCase());
    if (filter?.query) {
      const q = filter.query.toLowerCase();
      list = list.filter((t) => `${t.key} ${t.summary} ${t.description}`.toLowerCase().includes(q));
    }
    return list;
  }

  public async getTicket(issueKey: string): Promise<JiraTicket | null> {
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey)) return null;
    const mode = getJiraMode();
    if (mode === "harness") return this.harnessGet(issueKey);
    if (mode === "manual") {
      if (!(await this.isConfigured())) throw new Error("Jira is in manual mode but host, email or API token is missing.");
      try {
        return await this.fetchLiveJiraTicket(issueKey);
      } catch (e: any) {
        if (/HTTP 404/.test(e.message)) return null;
        throw e;
      }
    }
    return this.localTickets.find((t) => t.key.toUpperCase() === issueKey.toUpperCase()) || null;
  }

  public async updateTicketStatus(issueKey: string, newStatus: string, comment?: string): Promise<{ success: boolean; message: string }> {
    const mode = getJiraMode();
    if (mode === "harness") return this.harnessTransition(issueKey, newStatus, comment);
    if (mode === "manual" && (await this.isConfigured())) {
      try {
        return await this.executeLiveStatusTransition(issueKey, newStatus, comment);
      } catch (err: any) {
        return { success: false, message: `Jira transition failed: ${err.message}` };
      }
    }
    const match = this.localTickets.find((t) => t.key.toUpperCase() === issueKey.toUpperCase());
    if (match) {
      match.status = newStatus;
      match.updated = new Date().toISOString();
    }
    return { success: true, message: `Jira ${mode === "manual" ? "not configured" : "disabled"}: ${issueKey} not updated in Jira.` };
  }

  public async addComment(issueKey: string, commentText: string): Promise<{ success: boolean; message: string }> {
    const mode = getJiraMode();
    if (mode === "harness") return this.harnessTransition(issueKey, undefined, commentText);
    if (mode !== "manual" || !(await this.isConfigured())) return { success: true, message: `Jira ${mode}: comment not posted.` };
    try {
      const { host, auth } = await this.getJiraConfig();
      await this.httpRequest(host, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, "POST", auth, { body: this.toAdf(commentText) });
      return { success: true, message: `Comment posted to ${issueKey}.` };
    } catch (err: any) {
      return { success: false, message: `Failed to post comment to Jira: ${err.message}` };
    }
  }

  // ------------------------------------------------------------------ harness mode
  /** Runs one instruction through the agent harness (Claude Code / agy), which uses its own Jira connection. */
  private async harnessAsk(prompt: string): Promise<string> {
    const exec = this.harnessExec ?? (this.harnessExec = new CliAgentExecutor());
    const r = await exec.run({ role: "ticket", cwd: os.tmpdir(), prompt, timeoutMs: 5 * 60000 });
    if (!r.success) {
      throw new Error(
        `The agent harness could not reach Jira: ${r.output.split("\n")[0] || "no output"}. ` +
          `Make sure the Atlassian/Jira MCP server is connected in ${r.harness} (or switch Jira to "manual").`
      );
    }
    return r.output;
  }

  /** Returns the last complete top-level JSON value of the requested kind in free-form agent output. */
  private extractJson(text: string, open: "{" | "["): any {
    const close = open === "{" ? "}" : "]";
    const found: any[] = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== open) continue;
      let depth = 0, inStr = false, esc = false;
      for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") {
          depth--;
          if (depth === 0) {
            if (c === close) { try { found.push(JSON.parse(text.slice(i, j + 1))); i = j; } catch {} }
            break;
          }
        }
      }
    }
    if (!found.length) {
      throw new Error(`The agent did not return JSON. It said: "${text.replace(/\s+/g, " ").trim().slice(0, 240)}"`);
    }
    return found[found.length - 1];
  }

  /** Maps the agent's {"error": ...} replies to precise problems instead of guessing. */
  private checkAgentError(j: any): void {
    if (j && typeof j === "object" && !Array.isArray(j) && j.error) {
      if (String(j.error) === "no_jira_tools") {
        throw new Error(
          "The agent has no Jira/Atlassian tools. Headless agent runs (claude -p) do not load claude.ai connectors; register the server locally: " +
            "`claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp`, then run `claude` and authenticate with /mcp. " +
            'Or switch Jira to "manual" mode (API token).'
        );
      }
    }
  }

  private normalizeTicket(j: any): JiraTicket {
    const key = String(j.key || "").toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw new Error(`The agent returned an invalid ticket key '${j.key}'.`);
    const arr = (v: any) => (Array.isArray(v) ? v.map(String) : []);
    return {
      key, summary: String(j.summary || "No summary"), description: String(j.description || j.summary || ""),
      status: String(j.status || "To Do"), priority: String(j.priority || "Medium"), issueType: String(j.issueType || j.type || "Task"),
      assignee: j.assignee ? String(j.assignee) : undefined, labels: arr(j.labels), components: arr(j.components),
    };
  }

  private static readonly FIELDS = '{"key","summary","description" (plain text),"status","priority","issueType","labels":[],"components":[]}';

  /**
   * Routing for "via agent" mode.
   *  - Signed in to Atlassian: the direct client first (fast, no terminal); the agent only as a backup.
   *  - Not signed in: the agent (headless `claude -p`).
   * Failures are always reported with what each route tried; never fake data.
   */
  private async agentThenSignIn<T>(viaAgent: () => Promise<T>, viaSignIn: (c: AtlassianLike) => Promise<T>): Promise<T> {
    if (await this.atlassian.isSignedIn()) {
      let directError: Error;
      try {
        return await viaSignIn(this.atlassian);
      } catch (e: any) {
        directError = e;
      }
      try {
        return await viaAgent();
      } catch (e: any) {
        throw new Error(`Direct Atlassian connection failed: ${directError.message}\nAgent route also failed: ${e.message}`);
      }
    }
    try {
      return await viaAgent();
    } catch (e: any) {
      throw new Error(`${e.message}\nFix: click "Connect Jira" in Dev → Settings (one browser sign-in). CodeSentinel then reads Jira directly, with no terminal or agent involved.`);
    }
  }

  private async harnessGet(key: string): Promise<JiraTicket | null> {
    return this.agentThenSignIn(
      async () => {
        const out = await this.harnessAsk(
          `Using your Jira/Atlassian tools, read Jira issue ${key}. Do not change anything. ` +
            `Reply with ONLY one JSON object with the fields ${JiraService.FIELDS}. ` +
            `If the issue does not exist reply with {"error":"not_found"}. If you have no Jira/Atlassian tools at all reply with {"error":"no_jira_tools"}.`
        );
        const j = this.extractJson(out, "{");
        this.checkAgentError(j);
        return j.error ? null : this.normalizeTicket(j);
      },
      async (c) => {
        const n = await c.getIssue(key);
        return n ? this.mapIssue(n) : null;
      }
    );
  }

  private async harnessList(filter?: { status?: string; project?: string; query?: string }): Promise<JiraTicket[]> {
    const jql = this.buildJql(filter);
    return this.agentThenSignIn(
      async () => {
        const out = await this.harnessAsk(
          `Using your Jira/Atlassian tools, run this JQL search and return at most 30 issues: ${jql}\n` +
            `Do not change anything. Reply with ONLY a JSON array of objects with the fields ${JiraService.FIELDS}. ` +
            `If you have no Jira/Atlassian tools at all reply with {"error":"no_jira_tools"}.`
        );
        if (/no_jira_tools/.test(out) && !/\[\s*\{/.test(out)) this.checkAgentError({ error: "no_jira_tools" });
        return (this.extractJson(out, "[") as any[]).map((j) => this.normalizeTicket(j));
      },
      async (c) => (await c.search(jql, 30)).map((n) => this.mapIssue(n))
    );
  }

  private async harnessTransition(key: string, status?: string, comment?: string): Promise<{ success: boolean; message: string }> {
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key)) return { success: false, message: "Invalid ticket key." };
    if (!status && !comment) return { success: true, message: "Nothing to do." };
    const cleanStatus = status?.replace(/["\n\r]/g, " ");
    try {
      return await this.agentThenSignIn(
        async () => {
          const parts: string[] = [];
          if (cleanStatus) parts.push(`transition it to the status "${cleanStatus}" (pick the matching workflow transition)`);
          if (comment) parts.push(`add this comment verbatim:\n<<<\n${comment}\n>>>`);
          const out = await this.harnessAsk(`Using your Jira/Atlassian tools, on issue ${key}: ${parts.join(" and ")}. Reply with only "OK" on success, or "ERROR: <reason>".`);
          if (/^\s*OK\b/i.test(out) || /\bOK\s*$/i.test(out.trim())) return { success: true, message: `Updated ${key} via the agent harness.` };
          throw new Error(out.split("\n")[0] || "The agent did not confirm the update.");
        },
        async (c) => {
          const parts: Array<{ ok: boolean; message: string }> = [];
          if (cleanStatus) parts.push(await c.transition(key, cleanStatus));
          if (comment) parts.push(await c.comment(key, comment));
          const bad = parts.find((p) => !p.ok);
          if (bad) throw new Error(bad.message);
          return { success: true, message: parts.map((p) => p.message).join(" ") };
        }
      );
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  /** Verifies credentials against /myself. Used by the UI "Test connection" button. */
  public async testConnection(): Promise<{ success: boolean; message: string }> {
    const mode = getJiraMode();
    if (mode === "disabled") return { success: false, message: "Jira is disabled." };
    if (mode === "harness") {
      try {
        await this.harnessAsk('Using your Jira/Atlassian tools, look up the current Jira user. Reply with only "OK <display name>".');
        return { success: true, message: "The agent harness can reach Jira." };
      } catch (e: any) {
        return { success: false, message: e.message };
      }
    }
    try {
      const { host, auth } = await this.getJiraConfig();
      const me = await this.httpRequest(host, "/rest/api/3/myself", "GET", auth);
      return { success: true, message: `Connected to ${host} as ${me.displayName || me.emailAddress || "user"}.` };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  // ------------------------------------------------------------------ helpers
  /** JQL string-literal escaping (backslash and double quote). */
  public jqlQuote(v: string): string {
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  public buildJql(filter?: { status?: string; project?: string; query?: string }): string {
    const custom = getSetting<string>("jira.jqlFilter", "").trim();
    const project = (filter?.project || getSetting<string>("jira.projectKey", "")).trim();
    const parts: string[] = [];
    // ORDER BY must be last, so strip it from a user-supplied filter and re-append
    let order = "ORDER BY updated DESC";
    if (custom) {
      const m = custom.match(/\border\s+by\b[\s\S]*$/i);
      if (m) order = m[0];
      const base = custom.replace(/\border\s+by\b[\s\S]*$/i, "").trim();
      if (base) parts.push(`(${base})`);
    } else if (project) {
      parts.push(`project = ${this.jqlQuote(project)}`);
    } else {
      parts.push("assignee = currentUser()");
      parts.push("resolution = Unresolved");
    }
    if (filter?.status && filter.status !== "All") parts.push(`status = ${this.jqlQuote(filter.status)}`);
    if (filter?.query) parts.push(`text ~ ${this.jqlQuote(filter.query)}`);
    return `${parts.join(" AND ")} ${order}`.trim();
  }

  /** Atlassian Document Format → plain text. */
  public adfToText(node: any): string {
    if (node == null) return "";
    if (typeof node === "string") return node;
    const kids = (n: any) => (Array.isArray(n.content) ? n.content.map((c: any) => this.adfToText(c)).join("") : "");
    switch (node.type) {
      case "text": return node.text || "";
      case "hardBreak": return "\n";
      case "mention": return node.attrs?.text || "";
      case "inlineCard": return node.attrs?.url || "";
      case "paragraph": case "heading": case "codeBlock": return kids(node) + "\n";
      case "listItem": return "- " + kids(node).replace(/\n$/, "") + "\n";
      default: return kids(node);
    }
  }

  public toAdf(text: string): any {
    return {
      type: "doc",
      version: 1,
      content: text.split(/\n{2,}/).map((para) => ({
        type: "paragraph",
        content: para.split("\n").flatMap((line, i) => [
          ...(i ? [{ type: "hardBreak" }] : []),
          ...(line ? [{ type: "text", text: line }] : []),
        ]),
      })).filter((p) => p.content.length),
    };
  }

  private mapIssue(i: any): JiraTicket {
    const f = i.fields || {};
    return {
      key: i.key,
      summary: f.summary || "No summary",
      description: this.adfToText(f.description).trim() || f.summary || "",
      status: f.status?.name || "To Do",
      priority: f.priority?.name || "Medium",
      issueType: f.issuetype?.name || "Task",
      assignee: f.assignee?.displayName || "Unassigned",
      labels: f.labels || [],
      components: (f.components || []).map((c: any) => c.name),
      created: f.created,
      updated: f.updated,
    };
  }

  private async getJiraConfig(): Promise<{ host: string; auth: string }> {
    const rawHost = getSetting<string>("jira.host", "").trim();
    const email = getSetting<string>("jira.email", "").trim();
    const token = await SecretVault.getInstance().getSecret("jira_api_token", "global");
    if (!rawHost || !email || !token) {
      throw new Error("Jira credentials not fully configured (host, email and API token required).");
    }
    return { host: rawHost.replace(/\/+$/, ""), auth: Buffer.from(`${email}:${token}`).toString("base64") };
  }

  private async fetchLiveJiraTickets(filter?: { status?: string; project?: string; query?: string }): Promise<JiraTicket[]> {
    const { host, auth } = await this.getJiraConfig();
    const json = await this.httpRequest(host, "/rest/api/3/search/jql", "POST", auth, {
      jql: this.buildJql(filter),
      maxResults: 50,
      fields: ["summary", "description", "status", "priority", "issuetype", "assignee", "labels", "components", "created", "updated"],
    });
    return Array.isArray(json.issues) ? json.issues.map((i: any) => this.mapIssue(i)) : [];
  }

  private async fetchLiveJiraTicket(issueKey: string): Promise<JiraTicket> {
    const { host, auth } = await this.getJiraConfig();
    return this.mapIssue(await this.httpRequest(host, `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, "GET", auth));
  }

  private async executeLiveStatusTransition(issueKey: string, targetStatus: string, comment?: string): Promise<{ success: boolean; message: string }> {
    const { host, auth } = await this.getJiraConfig();
    const url = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`;
    const transitions = (await this.httpRequest(host, url, "GET", auth)).transitions || [];
    const want = targetStatus.toLowerCase();
    const match = transitions.find((t: any) => t.name?.toLowerCase() === want || t.to?.name?.toLowerCase() === want);
    if (!match) {
      return { success: false, message: `No transition to '${targetStatus}'. Available: ${transitions.map((t: any) => t.to?.name || t.name).join(", ")}` };
    }
    const payload: any = { transition: { id: match.id } };
    if (comment) payload.update = { comment: [{ add: { body: this.toAdf(comment) } }] };
    await this.httpRequest(host, url, "POST", auth, payload);
    return { success: true, message: `Transitioned ${issueKey} to '${match.to?.name || match.name}'.` };
  }

  /** `hostname` may be a bare host (https assumed) or a full URL such as http://127.0.0.1:8080 for tests. */
  private httpRequest(hostOrUrl: string, urlPath: string, method: "GET" | "POST", basicAuth: string, body?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const u = new URL(/^https?:\/\//.test(hostOrUrl) ? hostOrUrl : `https://${hostOrUrl}`);
      const lib = u.protocol === "http:" ? http : https;
      const data = body ? JSON.stringify(body) : "";
      const req = lib.request(
        {
          hostname: u.hostname,
          port: u.port || undefined,
          path: urlPath,
          method,
          timeout: 20000,
          headers: {
            Authorization: `Basic ${basicAuth}`,
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
          },
        },
        (res) => {
          let chunks = "";
          res.on("data", (c) => (chunks += c));
          res.on("end", () => {
            const code = res.statusCode || 0;
            if (code >= 200 && code < 300) {
              try { resolve(chunks ? JSON.parse(chunks) : {}); } catch { resolve({ raw: chunks }); }
            } else {
              // never echo the auth header; body is Jira's error text only
              reject(new Error(`HTTP ${code}: ${chunks.slice(0, 300)}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Jira API request timed out after 20s")); });
      if (data) req.write(data);
      req.end();
    });
  }
}
