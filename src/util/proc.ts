import { execFile, spawn } from "child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Data written to the child's stdin. */
  input?: string;
  maxBuffer?: number;
}

/**
 * Runs a program without a shell, so arguments (branch names, ticket text, paths)
 * can never be interpreted as shell syntax. Never rejects: failures are reported via `code`.
 */
export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? 120000,
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        windowsHide: true,
      },
      (err: any, stdout, stderr) => {
        const timedOut = Boolean(err && err.killed && err.signal);
        let code = 0;
        if (err) {
          code = typeof err.code === "number" ? err.code : 1;
          if (err.code === "ENOENT") {
            stderr = `${stderr}\ncommand not found: ${file}`.trim();
          }
        }
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut });
      }
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    }
  });
}

/**
 * Runs a user-authored command line (e.g. a configured test or deploy script) through the
 * platform shell, streaming output lines to `onLine`. Only use for strings the developer wrote
 * in their own config, never for strings that embed ticket/branch content.
 */
export function runShell(
  commandLine: string,
  opts: RunOptions & { onLine?: (line: string) => void } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(commandLine, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: true,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, opts.timeoutMs ?? 120000);

    const cap = opts.maxBuffer ?? 8 * 1024 * 1024;
    const feed = (which: "o" | "e") => (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      if (which === "o") {
        if (stdout.length < cap) stdout += text;
      } else if (stderr.length < cap) {
        stderr += text;
      }
      if (opts.onLine) {
        for (const l of text.split(/\r?\n/)) if (l.trim()) opts.onLine(l);
      }
    };
    child.stdout.on("data", feed("o"));
    child.stderr.on("data", feed("e"));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${e.message}`.trim(), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code ?? 1, stdout, stderr, timedOut });
    });
  });
}

/** POSIX single-quote escaping for embedding a value in a shell command line. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Like run(), but streams stdout line by line while the process is running (no shell).
 * Used for agent processes whose progress should be visible live.
 */
export function runStream(
  file: string,
  args: string[],
  opts: RunOptions & { onLine?: (line: string) => void } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let carry = "";
    let timedOut = false;
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, opts.timeoutMs ?? 120000);
    const cap = opts.maxBuffer ?? 32 * 1024 * 1024;
    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString("utf-8");
      if (stdout.length < cap) stdout += text;
      carry += text;
      let i: number;
      while ((i = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, i);
        carry = carry.slice(i + 1);
        if (line.trim() && opts.onLine) opts.onLine(line);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < cap) stderr += d.toString("utf-8");
    });
    child.on("error", (e: any) => {
      clearTimeout(timer);
      resolve({ code: e.code === "ENOENT" ? 127 : 1, stdout, stderr: e.code === "ENOENT" ? `command not found: ${file}` : `${stderr}\n${e.message}`.trim(), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (carry.trim() && opts.onLine) opts.onLine(carry);
      resolve({ code: timedOut ? 124 : code ?? 1, stdout, stderr, timedOut });
    });
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input ?? "");
    }
  });
}
