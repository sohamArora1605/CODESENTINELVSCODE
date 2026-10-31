import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "path";
import { CodeSentinelMcpServer } from "./mcpServer";
import { SecurityToolManager } from "../scanner/securityToolManager";
import { DependencyManager } from "../services/dependencyManager";

async function main() {
  const storagePath = process.env.CODESENTINEL_STORAGE_PATH;
  if (storagePath) {
    SecurityToolManager.getInstance().setStoragePath(storagePath);
    DependencyManager.getInstance().setStoragePath(storagePath);
  }

  const extPath =
    process.env.CODESENTINEL_EXTENSION_PATH || path.resolve(__dirname, "..");
  SecurityToolManager.getInstance().setExtensionPath(extPath);

  // Use CodeSentinelMcpServer's built-in resolveContext() which automatically
  // resolves CODESENTINEL_WORKSPACE / process.cwd() and detects project languages.
  const server = new CodeSentinelMcpServer("codesentinel-standalone", "0.2.3");

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
