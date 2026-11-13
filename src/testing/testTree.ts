import * as fs from "fs";
import * as path from "path";
import { shQuote } from "../util/proc";

export interface TestNode {
  name: string;
  /** repo-relative, forward slashes; "" is the repo root */
  path: string;
  kind: "dir" | "file";
  /** number of test files under this node (1 for a file) */
  files: number;
  children?: TestNode[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "target", ".gradle", ".venv", "venv", "__pycache__", ".codesentinel", ".idea", ".vscode", "coverage", ".next", "vendor"]);
const MAX_FILES = 4000;

/** A file counts as a test file by the conventions of the common ecosystems. */
export function isTestFile(rel: string): boolean {
  const base = path.posix.basename(rel);
  const parts = rel.split("/");
  const inTestDir = parts.slice(0, -1).some((d) => ["test", "tests", "__tests__", "spec", "specs"].includes(d));
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true; // jest / vitest / mocha
  if (/\.[cm]?[jt]sx?$/.test(base) && inTestDir && !/\.d\.ts$/.test(base) && !/^(setup|support|helper|helpers|fixture|fixtures|env)\b/i.test(base)) return true;
  if (/^(Test.*|.*Tests?|.*IT)\.java$/.test(base) && /(^|\/)src\/test\//.test(rel)) return true; // JUnit
  if (/^(Test.*|.*Tests?)\.(kt|scala)$/.test(base) && /(^|\/)src\/test\//.test(rel)) return true;
  if ((/^test_.*\.py$/.test(base) || /_test\.py$/.test(base)) || (base.endsWith(".py") && inTestDir && !/^(conftest|__init__)\.py$/.test(base))) return true; // pytest
  if (/_test\.go$/.test(base)) return true; // go
  return false;
}

export function discoverTestFiles(repoPath: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string) => {
    if (found.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= MAX_FILES) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name), childRel);
      } else if (e.isFile() && isTestFile(childRel)) {
        found.push(childRel);
      }
    }
  };
  walk(repoPath, "");
  return found.sort();
}

/** Nested folder tree of test files; single-child directory chains are collapsed (a/b/c) like an IDE's compact folders. */
export function buildTestTree(repoName: string, files: string[]): TestNode {
  const root: TestNode = { name: repoName, path: "", kind: "dir", files: 0, children: [] };
  for (const f of files) {
    const parts = f.split("/");
    let cur = root;
    parts.forEach((part, i) => {
      const rel = parts.slice(0, i + 1).join("/");
      const isFile = i === parts.length - 1;
      let next = cur.children!.find((c) => c.path === rel);
      if (!next) {
        next = isFile ? { name: part, path: rel, kind: "file", files: 1 } : { name: part, path: rel, kind: "dir", files: 0, children: [] };
        cur.children!.push(next);
      }
      cur = next;
    });
  }
  const finish = (n: TestNode): number => {
    if (n.kind === "file") return 1;
    n.children!.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    n.files = n.children!.reduce((sum, c) => sum + finish(c), 0);
    // collapse dir -> single dir chains (never the root)
    n.children = n.children!.map((c) => {
      let node = c;
      while (node.kind === "dir" && node.children!.length === 1 && node.children![0].kind === "dir") {
        const only = node.children![0];
        node = { ...only, name: `${node.name}/${only.name}` };
      }
      return node;
    });
    return n.files;
  };
  finish(root);
  return root;
}

/** Validates a UI-supplied scope: repo-relative, no traversal, and it exists. Returns the normalized path or null. */
export function safeScope(repoPath: string, rel: string): string | null {
  if (typeof rel !== "string" || rel.includes("\0") || path.isAbsolute(rel)) return null;
  const norm = path.posix.normalize(rel.replace(/\\/g, "/")).replace(/^\.\/?/, "").replace(/\/$/, "");
  if (norm.startsWith("..") || norm.split("/").includes("..")) return null;
  const abs = path.join(repoPath, norm);
  if (!abs.startsWith(path.resolve(repoPath)) || !fs.existsSync(abs)) return null;
  return norm;
}

const PROJECT_MARKERS = ["pom.xml", "build.gradle", "build.gradle.kts", "package.json", "pyproject.toml", "pytest.ini", "setup.py", "go.mod", "Cargo.toml"];

/** Nearest directory at or above `rel` that holds a build file; tests must run from there (e.g. complete/ in gs-rest-service). */
export function projectRootFor(repoPath: string, rel: string): string {
  let dir = rel && fs.statSync(path.join(repoPath, rel)).isFile() ? path.posix.dirname(rel) : rel;
  for (;;) {
    const abs = path.join(repoPath, dir);
    if (PROJECT_MARKERS.some((m) => fs.existsSync(path.join(abs, m)))) return dir;
    if (!dir || dir === ".") return "";
    const up = path.posix.dirname(dir);
    dir = up === "." ? "" : up;
  }
}

export interface ScopedCommand {
  /** repo-relative directory to run in ("" = repo root) */
  cwd: string;
  command: string;
  runner: string;
}

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * The command that runs only `rel` (a test file or a folder of tests), from the right project root.
 * Returns null when the stack is unknown, so the UI can say so instead of guessing.
 */
export function buildScopedCommand(repoPath: string, rel: string, template?: string): ScopedCommand | null {
  const root = projectRootFor(repoPath, rel);
  const abs = path.join(repoPath, root);
  const target = root ? path.posix.relative(root, rel) || "." : rel || ".";
  const isFile = rel !== "" && fs.statSync(path.join(repoPath, rel)).isFile();
  const has = (f: string) => fs.existsSync(path.join(abs, f));

  if (template) return { cwd: root, runner: "custom", command: template.split("{path}").join(shQuote(target)) };

  if (has("pom.xml")) {
    const wrapper = has("mvnw") ? "./mvnw" : "mvn";
    const rootRelToJava = rel.includes("src/test/java/") ? rel.split("src/test/java/")[1] : "";
    if (isFile && rootRelToJava) {
      const cls = path.posix.basename(rootRelToJava).replace(/\.[^.]+$/, "");
      return { cwd: root, runner: "maven", command: `${wrapper} -B test -Dtest=${shQuote(cls)} -Dsurefire.failIfNoSpecifiedTests=false` };
    }
    if (rootRelToJava) return { cwd: root, runner: "maven", command: `${wrapper} -B test -Dtest=${shQuote(rootRelToJava.replace(/\/$/, "") + "/**/*")} -Dsurefire.failIfNoSpecifiedTests=false` };
    return { cwd: root, runner: "maven", command: `${wrapper} -B test` };
  }
  if (has("build.gradle") || has("build.gradle.kts")) {
    const wrapper = has("gradlew") ? "./gradlew" : "gradle";
    const sub = rel.includes("src/test/") ? rel.split(/src\/test\/[^/]+\//)[1] || "" : "";
    const pat = isFile ? path.posix.basename(sub).replace(/\.[^.]+$/, "") : sub.replace(/\//g, ".") + ".*";
    return { cwd: root, runner: "gradle", command: sub ? `${wrapper} test --tests ${shQuote(pat)}` : `${wrapper} test` };
  }
  if (has("package.json")) {
    const pkg = readJson(path.join(abs, "package.json")) ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const testScript = String(pkg.scripts?.test ?? "");
    if (deps.vitest || /vitest/.test(testScript)) return { cwd: root, runner: "vitest", command: `npx --no-install vitest run ${shQuote(target)}` };
    if (deps.jest || /\bjest\b/.test(testScript)) return { cwd: root, runner: "jest", command: `npx --no-install jest ${shQuote(target)}` };
    if (deps.mocha || /mocha/.test(testScript)) {
      // keep the project's own mocha flags (--require, --reporter ...) but replace its default spec paths with ours
      const flags = (testScript.match(/mocha\s+([^&|;]*)/)?.[1] ?? "").split(/\s+/).filter((t) => t.startsWith("-") || (t && !/^[\w./*-]+$/.test(t))).filter((t) => t.startsWith("-"));
      const dirTarget = isFile ? target : `${target.replace(/\/$/, "")}/`;
      return { cwd: root, runner: "mocha", command: `npx --no-install mocha ${flags.join(" ")} ${shQuote(dirTarget)} ${isFile ? "" : "--recursive"}`.trim() };
    }
    return { cwd: root, runner: "node:test", command: `node --test ${shQuote(target)}` };
  }
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.py")) return { cwd: root, runner: "pytest", command: `python3 -m pytest ${shQuote(target)}` };
  if (has("go.mod")) {
    const dir = isFile ? path.posix.dirname(target) : target;
    return { cwd: root, runner: "go", command: `go test ${shQuote(dir === "." ? "./..." : `./${dir.replace(/\/$/, "")}/...`)}` };
  }
  return null;
}
