import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import type * as vscodeTypes from "vscode";
import { SecretItem } from "../types";

function getVscode(): typeof vscodeTypes | null {
  try {
    return require("vscode");
  } catch {
    return null;
  }
}

export type SecretScope = "ticket" | "repo" | "global";

interface VaultFile {
  version: 1;
  entries: Record<string, { v: string; meta: SecretItem }>;
}

/**
 * Encrypted secret store shared by the extension host, the MCP server process and agent terminals
 * (VS Code SecretStorage is unreachable from those, so a file vault is the common denominator).
 *
 *  - AES-256-GCM, random 32-byte master key in `<dir>/vault.key` (mode 0600)
 *  - vault in `<dir>/secrets.vault.json` (mode 0600); default dir is ~/.codesentinel (outside any repo)
 *  - resolution order: ticket → repo → global
 */
export class SecretVault {
  private static instance: SecretVault;
  private dir: string | null = null;
  private key: Buffer | null = null;

  private constructor() {}

  public static getInstance(): SecretVault {
    if (!SecretVault.instance) SecretVault.instance = new SecretVault();
    return SecretVault.instance;
  }

  /** Override storage location (tests, custom deployments). */
  public init(dir?: string): void {
    this.dir = dir ?? null;
    this.key = null;
  }

  private getDir(): string {
    const d = this.dir || process.env.CODESENTINEL_VAULT_DIR || path.join(os.homedir(), ".codesentinel");
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  private getKey(): Buffer {
    if (this.key) return this.key;
    const kp = path.join(this.getDir(), "vault.key");
    if (fs.existsSync(kp)) {
      this.key = Buffer.from(fs.readFileSync(kp, "utf-8").trim(), "hex");
    } else {
      this.key = crypto.randomBytes(32);
      fs.writeFileSync(kp, this.key.toString("hex"), { mode: 0o600 });
    }
    if (this.key.length !== 32) throw new Error("Corrupt vault.key (expected 32 bytes).");
    return this.key;
  }

  private file(): string {
    return path.join(this.getDir(), "secrets.vault.json");
  }

  private load(): VaultFile {
    try {
      const v = JSON.parse(fs.readFileSync(this.file(), "utf-8"));
      if (v && v.entries) return v as VaultFile;
    } catch {}
    return { version: 1, entries: {} };
  }

  private save(v: VaultFile): void {
    const tmp = `${this.file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file());
  }

  private enc(plain: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.getKey(), iv);
    const body = Buffer.concat([c.update(plain, "utf-8"), c.final()]);
    return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${body.toString("hex")}`;
  }

  private dec(blob: string): string | undefined {
    try {
      const [iv, tag, body] = blob.split(":");
      const d = crypto.createDecipheriv("aes-256-gcm", this.getKey(), Buffer.from(iv, "hex"));
      d.setAuthTag(Buffer.from(tag, "hex"));
      return Buffer.concat([d.update(Buffer.from(body, "hex")), d.final()]).toString("utf-8");
    } catch {
      return undefined;
    }
  }

  private composite(key: string, scope: SecretScope, scopeId?: string): string {
    return scope === "global" || !scopeId ? `global:${key}` : `${scope}:${scopeId}:${key}`;
  }

  public async setSecret(
    key: string,
    value: string,
    scope: SecretScope = "global",
    scopeId?: string,
    description?: string
  ): Promise<void> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid secret name '${key}' (use letters, digits, underscore; it becomes an env var).`);
    }
    const effScope: SecretScope = scope !== "global" && !scopeId ? "global" : scope;
    const v = this.load();
    v.entries[this.composite(key, scope, scopeId)] = {
      v: this.enc(value),
      meta: { key, scope: effScope, scopeId: effScope === "global" ? undefined : scopeId, description, hasValue: true, updatedAt: Date.now() },
    };
    this.save(v);
  }

  /** Resolves ticket → repo → global. `repoId` is consulted when scope is "ticket". */
  public async getSecret(key: string, scope: SecretScope = "global", scopeId?: string, repoId?: string): Promise<string | undefined> {
    const v = this.load();
    const chain: string[] = [];
    if (scope === "ticket" && scopeId) chain.push(this.composite(key, "ticket", scopeId));
    if (scope === "ticket" && repoId) chain.push(this.composite(key, "repo", repoId));
    if (scope === "repo" && scopeId) chain.push(this.composite(key, "repo", scopeId));
    chain.push(this.composite(key, "global"));
    for (const c of chain) {
      const e = v.entries[c];
      if (e) {
        const plain = this.dec(e.v);
        if (plain !== undefined) return plain;
      }
    }
    return undefined;
  }

  public async deleteSecret(key: string, scope: SecretScope = "global", scopeId?: string): Promise<void> {
    const v = this.load();
    delete v.entries[this.composite(key, scope, scopeId)];
    this.save(v);
  }

  /** Metadata only; values are never returned. */
  public async listSecrets(scope?: SecretScope, scopeId?: string): Promise<SecretItem[]> {
    return Object.values(this.load().entries)
      .map((e) => e.meta)
      .filter((m) => !scope || (m.scope === scope && (!scopeId || m.scopeId === scopeId)));
  }

  /** Every secret visible to (repo, ticket) merged global < repo < ticket, ready to inject as env vars. */
  public async resolveEnv(repoId?: string, ticketKey?: string): Promise<Record<string, string>> {
    const v = this.load();
    const out: Record<string, string> = {};
    const apply = (match: (m: SecretItem) => boolean) => {
      for (const e of Object.values(v.entries)) {
        if (!match(e.meta)) continue;
        const p = this.dec(e.v);
        if (p !== undefined) out[e.meta.key] = p;
      }
    };
    apply((m) => m.scope === "global");
    if (repoId) apply((m) => m.scope === "repo" && m.scopeId === repoId);
    if (ticketKey) apply((m) => m.scope === "ticket" && m.scopeId === ticketKey);
    return out;
  }

  public async promptUserForSecret(
    key: string,
    promptTitle: string,
    scope: SecretScope = "global",
    scopeId?: string
  ): Promise<string | undefined> {
    const vscode = getVscode();
    if (!vscode) return undefined;
    const value = await vscode.window.showInputBox({
      title: `CodeSentinel Secret Vault: ${key}`,
      prompt: `${promptTitle} (scope: ${scope}${scopeId ? ` / ${scopeId}` : ""})`,
      password: true,
      ignoreFocusOut: true,
    });
    if (value && value.trim()) {
      await this.setSecret(key, value.trim(), scope, scopeId, promptTitle);
      return value.trim();
    }
    return undefined;
  }
}
