import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

export function tmpDir(prefix = "cs-test-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A repo on `main` with one commit, plus a bare "origin" so pushes can be tested. */
export function makeRepo(withOrigin = false): { repo: string; origin?: string } {
  const repo = tmpDir("cs-repo-");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  let origin: string | undefined;
  if (withOrigin) {
    origin = tmpDir("cs-origin-");
    git(origin, "init", "--bare", "-b", "main");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-u", "origin", "main");
  }
  return { repo, origin };
}

const mk = (key: string, summary: string, issueType = "Task") => ({
  key, summary, description: `${summary} (fixture)`, status: "To Do", priority: "High", issueType, labels: [], components: [],
});
export const FIXTURE_TICKETS = [
  mk("SEC-101", "Mitigate SSRF Vulnerability in Remote File Ingestion Endpoint", "Vulnerability"),
  mk("AUTH-204", "Enforce IAM boundaries on presigned URL generator", "Bug"),
  mk("API-302", "Rate limiting for auth routes", "Story"),
  mk("FE-405", "Playwright tests for OAuth login"),
];
