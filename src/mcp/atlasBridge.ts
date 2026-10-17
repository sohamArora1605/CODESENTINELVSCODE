/**
 * Atlas MCP stdio bridge for Windows.
 *
 * OpenCode spawns this script instead of raw `docker run atlas mcp`.
 * This bridge:
 *   1. Spawns the Docker container running `atlas mcp`.
 *   2. Intercepts each JSON-RPC line from OpenCode -> Docker.
 *      If the parsed message is a `tools/call` for the `project` tool with
 *      action `open`, it rewrites `project_path` from any variant of the
 *      host workspace root to `/workspace` (the Docker volume mount point).
 *   3. Rewrites `/workspace` back to the host path in every response line so
 *      OpenCode receives meaningful host-relative file paths.
 *
 * Usage (configured in opencode.json):
 *   node dist/atlas-bridge.js <docker-image> <host-workspace-path>
 *
 * Example:
 *   node dist/atlas-bridge.js codesentinel/core:latest D:/codeioweb
 */

import { spawn } from "child_process";

// --- Args -------------------------------------------------------------------
const [, , dockerImage = "codesentinel/core:latest", rawHostPath = process.cwd()] =
  process.argv;

// Canonical form: forward slashes, no trailing slash
const hostPathNorm = rawHostPath.replace(/\\/g, "/").replace(/\/$/, "");

// --- Buffered line splitter --------------------------------------------------
function makeLineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buf = "";
  return (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      onLine(line);
    }
  };
}

// Spawn host Node.js CodeSentinel MCP Server directly (zero Docker containers)
const path = require("path");
const mcpServerScript = path.join(__dirname, "mcp-server.js");

const proc = spawn(
  process.execPath,
  [mcpServerScript],
  {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODESENTINEL_WORKSPACE: hostPathNorm,
    },
  }
);

// Forward server stderr to our stderr
proc.stderr?.pipe(process.stderr);

// --- Active Project Auto-Load State -----------------------------------------
let isProjectOpened = false;
let autoOpenSent = false;
const pendingToolCalls: string[] = [];

function sendAutoOpen(): void {
  if (autoOpenSent) return;
  autoOpenSent = true;
  const autoOpen = JSON.stringify({
    jsonrpc: "2.0",
    id: "__auto_open__",
    method: "tools/call",
    params: {
      name: "project",
      arguments: {
        action: "open",
        project_path: hostPathNorm,
      },
    },
  });
  proc.stdin?.write(autoOpen + "\n");
}

function flushPendingToolCalls(): void {
  while (pendingToolCalls.length > 0) {
    const item = pendingToolCalls.shift();
    if (item) {
      proc.stdin?.write(item + "\n");
    }
  }
}

// Pass-through request translator
function translateRequest(line: string): string {
  if (!line.trim()) return line;
  try {
    const msg = JSON.parse(line);
    if (msg?.method === "tools/call" && msg?.params?.arguments) {
      const args = msg.params.arguments;
      if (args.project_path) {
        args.project_path = hostPathNorm;
      }
    }
    return JSON.stringify(msg);
  } catch {
    return line;
  }
}

// Pass-through response translator
function translateResponse(line: string): string {
  if (!line.trim()) return line;
  try {
    const parsed = JSON.parse(line);
    if (parsed.id === "__auto_open__") {
      return "";
    }
  } catch {}
  return line;
}

// --- OpenCode -> Host Server ------------------------------------------------
process.stdin.on(
  "data",
  makeLineSplitter((line) => {
    let msg: any = null;
    try {
      msg = JSON.parse(line);
    } catch {}

    const translated = translateRequest(line);

    // Initialization messages flow directly and trigger auto-open
    if (!msg || msg.method === "initialize" || msg.method === "notifications/initialized") {
      proc.stdin?.write(translated + "\n");
      if (msg?.method === "notifications/initialized") {
        sendAutoOpen();
      }
      return;
    }

    // Inspect if this is a tool call
    const isToolCall = msg?.method === "tools/call";
    const toolName = msg?.params?.name ? msg.params.name.replace(/^atlas_/, "") : "";
    const isExplicitProjectOpen = toolName === "project" && msg?.params?.arguments?.action === "open";

    if (isExplicitProjectOpen) {
      isProjectOpened = true;
      proc.stdin?.write(translated + "\n");
      return;
    }

    if (isToolCall) {
      if (!isProjectOpened) {
        // Automatically ensure project is loaded in background and queue tool call
        sendAutoOpen();
        pendingToolCalls.push(translated);
      } else {
        proc.stdin?.write(translated + "\n");
      }
      return;
    }

    // Pass through any other JSON-RPC requests (ping, shutdown, etc.)
    proc.stdin?.write(translated + "\n");
  })
);

process.stdin.on("end", () => proc.stdin?.end());

// --- Host Server -> OpenCode ------------------------------------------------
proc.stdout?.on(
  "data",
  makeLineSplitter((line) => {
    try {
      const parsed = JSON.parse(line);

      // Initialized response: trigger auto-open immediately
      if (parsed.result?.serverInfo?.name) {
        sendAutoOpen();
      }

      // Internal auto-open response: mark active project open and flush pending tool calls
      if (parsed.id === "__auto_open__") {
        isProjectOpened = true;
        flushPendingToolCalls();
        return; // Suppress internal auto-open result from being emitted to client
      }
    } catch {}

    const translated = translateResponse(line);
    if (translated) {
      process.stdout.write(translated + "\n");
    }
  })
);

// --- Lifecycle Cleanup -------------------------------------------------------
function cleanupProcess() {
  try {
    proc.kill("SIGTERM");
  } catch {}
}

proc.on("error", (err) => {
  process.stderr.write(`[atlas-bridge] Server spawn error: ${err.message}\n`);
  cleanupProcess();
  process.exit(1);
});

proc.on("exit", (code, signal) => {
  cleanupProcess();
  process.exit(code ?? (signal ? 1 : 0));
});

process.on("SIGINT", () => {
  cleanupProcess();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupProcess();
  process.exit(0);
});
