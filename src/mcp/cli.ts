import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "path";
import * as fs from "fs";
import { CodeSentinelMcpServer } from "./mcpServer";

async function main() {
  const server = new CodeSentinelMcpServer("codesentinel-standalone", "0.1.0");

  server.setWorkspaceContextResolver(() => {
    const root = process.env.CODESENTINEL_WORKSPACE || process.cwd();
    const resolved = path.resolve(root);
    return {
      rootPath: resolved,
      name: path.basename(resolved),
      detectedLanguages: [],
      hasGit: fs.existsSync(path.join(resolved, ".git")),
      hasOpenCodeConfig: fs.existsSync(path.join(resolved, "opencode.json")),
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error running CodeSentinel MCP server CLI:", error);
  process.exit(1);
});
