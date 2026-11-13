import * as http from "http";
import * as crypto from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { SecretVault } from "../security/secretVault";
import { getSetting } from "../config/settings";

const DEFAULT_URL = "https://mcp.atlassian.com/v1/mcp";
const CLIENT_KEY = "atlassian_oauth_client";
const TOKENS_KEY = "atlassian_oauth_tokens";
const OAUTH_PORT = 33418;

/** Operations CodeSentinel needs from Jira; implemented by the Atlassian MCP client and by test fakes. */
export interface AtlassianLike {
  isSignedIn(): Promise<boolean>;
  getIssue(key: string): Promise<any | null>;
  search(jql: string, max?: number): Promise<any[]>;
  transition(key: string, targetStatus: string): Promise<{ ok: boolean; message: string }>;
  comment(key: string, text: string): Promise<{ ok: boolean; message: string }>;
}

/** OAuth state lives in the encrypted vault, so the sidebar, MCP server and terminals share one sign-in. */
export class VaultOAuthProvider implements OAuthClientProvider {
  private verifier = "";
  private oauthState = crypto.randomBytes(16).toString("hex");
  public pendingCode: Promise<string> | null = null;

  constructor(private readonly port: number, private readonly openBrowser: (url: string) => Promise<void>, private readonly interactive = true) {}

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "CodeSentinel",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.oauthState;
  }

  private async read<T>(key: string): Promise<T | undefined> {
    const raw = await SecretVault.getInstance().getSecret(key, "global");
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const info = await this.read<any>(CLIENT_KEY);
    // A registration made for another redirect port is useless; force re-registration
    if (info && Array.isArray(info.redirect_uris) && !info.redirect_uris.includes(this.redirectUrl)) return undefined;
    return info;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await SecretVault.getInstance().setSecret(CLIENT_KEY, JSON.stringify(info), "global", undefined, "Atlassian OAuth client registration");
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return this.read<OAuthTokens>(TOKENS_KEY);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await SecretVault.getInstance().setSecret(TOKENS_KEY, JSON.stringify(tokens), "global", undefined, "Atlassian OAuth tokens");
  }

  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const vault = SecretVault.getInstance();
    if (scope === "all" || scope === "client") await vault.deleteSecret(CLIENT_KEY);
    if (scope === "all" || scope === "tokens") await vault.deleteSecret(TOKENS_KEY);
  }

  /** Starts the loopback listener first, then sends the user to the browser. */
  async redirectToAuthorization(url: URL): Promise<void> {
    // Background lookups must never open a browser; only the explicit Connect button may.
    if (!this.interactive) throw new UnauthorizedError('Atlassian session expired. Click "Connect Jira" in Dev → Settings.');
    this.pendingCode = new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const u = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);
        if (u.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const code = u.searchParams.get("code");
        const ok = Boolean(code) && u.searchParams.get("state") === this.oauthState;
        res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
        res.end(ok
          ? "<h3>CodeSentinel is connected to Atlassian.</h3><p>You can close this tab and return to VS Code.</p>"
          : "<h3>Sign-in failed.</h3><p>Return to VS Code and try again.</p>");
        clearTimeout(timer);
        server.close();
        // A browser keeps the connection alive; drop it so the port is really free for the next sign-in attempt.
        setImmediate(() => (server as any).closeAllConnections?.());
        ok ? resolve(code as string) : reject(new Error(u.searchParams.get("error_description") || "Atlassian sign-in was rejected or the state did not match."));
      });
      const timer = setTimeout(() => {
        server.close();
        reject(new Error("Timed out waiting for the Atlassian sign-in (5 minutes)."));
      }, 5 * 60000);
      server.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`Could not listen on 127.0.0.1:${this.port} for the sign-in callback: ${e.message}`));
      });
      server.listen(this.port, "127.0.0.1", () => {
        void this.openBrowser(url.toString());
      });
    });
    this.pendingCode.catch(() => {}); // surfaced by whoever awaits it
  }
}

export class AtlassianMcp implements AtlassianLike {
  private static instance: AtlassianMcp;
  private opener: (url: string) => Promise<void> = async (url) => {
    console.error(`Open this URL to sign in to Atlassian: ${url}`);
  };
  private cloudId: string | null = null;
  private port = OAUTH_PORT;

  public static getInstance(): AtlassianMcp {
    if (!AtlassianMcp.instance) AtlassianMcp.instance = new AtlassianMcp();
    return AtlassianMcp.instance;
  }

  /** The extension host plugs in vscode.env.openExternal. */
  public setBrowserOpener(fn: (url: string) => Promise<void>): void {
    this.opener = fn;
  }

  public setPort(p: number): void {
    this.port = p;
  }

  private url(): URL {
    return new URL(getSetting<string>("jira.mcpUrl", "") || DEFAULT_URL);
  }

  public async isSignedIn(): Promise<boolean> {
    return Boolean(await SecretVault.getInstance().getSecret(TOKENS_KEY, "global"));
  }

  public async signOut(): Promise<void> {
    await SecretVault.getInstance().deleteSecret(TOKENS_KEY);
    await SecretVault.getInstance().deleteSecret(CLIENT_KEY);
    this.cloudId = null;
  }

  /** Interactive sign-in: opens the browser once; afterwards tokens refresh on their own. */
  public async signIn(): Promise<void> {
    const c = await this.connect(true);
    await c.close();
  }

  private async connect(interactive: boolean): Promise<Client> {
    if (!interactive && !(await this.isSignedIn())) throw new Error('Not signed in to Atlassian. Click "Connect Jira" in Dev → Settings.');
    const provider = new VaultOAuthProvider(this.port, this.opener, interactive);
    const make = () => new StreamableHTTPClientTransport(this.url(), { authProvider: provider });
    let transport = make();
    const client = new Client({ name: "codesentinel", version: "1.0.0" });
    try {
      await client.connect(transport);
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      if (!interactive || !provider.pendingCode) {
        throw new Error('Atlassian session expired. Click "Connect Jira" in Dev → Settings.');
      }
      const code = await provider.pendingCode;
      await transport.finishAuth(code);
      transport = make();
      await client.connect(transport);
    }
    return client;
  }

  private async withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const client = await this.connect(false);
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => {});
    }
  }

  private parse(result: any): any {
    const text = (result?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
    if (result?.isError) throw new Error(text.slice(0, 400) || "Atlassian tool error");
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  /** Calls a tool directly if the server exposes it, otherwise through the generic executeRead/executeWrite runner. */
  private async op(c: Client, name: string, args: Record<string, unknown>, write = false): Promise<any> {
    const tools = (await c.listTools()).tools.map((t) => t.name);
    if (tools.includes(name)) return this.parse(await c.callTool({ name, arguments: args }));
    const runner = write ? "executeWrite" : "executeRead";
    if (!tools.includes(runner)) throw new Error(`The Atlassian server does not expose '${name}'.`);
    const { cloudId, ...inputs } = args as any;
    return this.parse(await c.callTool({ name: runner, arguments: { name, cloudId, inputs } }));
  }

  private async resolveCloudId(c: Client): Promise<string> {
    if (this.cloudId) return this.cloudId;
    const j = await this.op(c, "getAccessibleAtlassianResources", {});
    const list: any[] = j?.data?.resources ?? j?.resources ?? (Array.isArray(j) ? j : []);
    if (!list.length) throw new Error("No Atlassian site is accessible with this sign-in.");
    const host = getSetting<string>("jira.host", "").replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase();
    const match = host ? list.find((r) => String(r.url || "").toLowerCase().includes(host)) : undefined;
    this.cloudId = String((match ?? list[0]).id ?? (match ?? list[0]).cloudId);
    return this.cloudId;
  }

  private nodes(j: any): any[] {
    return j?.issues?.nodes ?? j?.issues ?? j?.data?.issues?.nodes ?? (j?.key ? [j] : []);
  }

  async getIssue(key: string): Promise<any | null> {
    return this.withClient(async (c) => {
      const cloudId = await this.resolveCloudId(c);
      try {
        return this.nodes(await this.op(c, "getJiraIssue", { cloudId, issueIdOrKey: key }))[0] ?? null;
      } catch (e: any) {
        if (/not found|does not exist|404/i.test(e.message)) return null;
        throw e;
      }
    });
  }

  async search(jql: string, max = 30): Promise<any[]> {
    return this.withClient(async (c) => this.nodes(await this.op(c, "searchJiraIssuesUsingJql", { cloudId: await this.resolveCloudId(c), jql, maxResults: max })));
  }

  async transition(key: string, targetStatus: string): Promise<{ ok: boolean; message: string }> {
    return this.withClient(async (c) => {
      const j = await this.op(c, "transitionJiraIssue", { cloudId: await this.resolveCloudId(c), issueIdOrKey: key, targetStatus }, true);
      return { ok: true, message: `Moved ${key} to '${targetStatus}'${j?.status?.name ? ` (now ${j.status.name})` : ""}.` };
    }).catch((e: any) => ({ ok: false, message: e.message }));
  }

  async comment(key: string, text: string): Promise<{ ok: boolean; message: string }> {
    return this.withClient(async (c) => {
      await this.op(c, "addOrEditJiraIssueComment", { cloudId: await this.resolveCloudId(c), issueIdOrKey: key, commentBody: text }, true);
      return { ok: true, message: `Comment posted to ${key}.` };
    }).catch((e: any) => ({ ok: false, message: e.message }));
  }
}
