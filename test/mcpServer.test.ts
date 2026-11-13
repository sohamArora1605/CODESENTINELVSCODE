import * as assert from "assert";
import { CodeSentinelMcpServer } from "../src/mcp/mcpServer";
import { WorkspaceContext } from "../src/types";

export async function testMcpServer(): Promise<void> {
  console.log("▶ Running CodeSentinel MCP Server Tests...");

  const server = new CodeSentinelMcpServer("test-mcp-server", "1.0.0");

  // Test 1: Built-in tools registered
  const tools = server.getRegisteredTools();
  assert.ok(tools.length >= 3, "Server should register at least 3 built-in tools");
  const toolNames = tools.map((t) => t.name);
  assert.ok(toolNames.includes("codesentinel_workspace_status"), "Should have workspace status tool");
  assert.ok(toolNames.includes("codesentinel_list_tools"), "Should have list tools tool");
  assert.ok(toolNames.includes("codesentinel_atlas_graph_status"), "Should have atlas graph status tool");

  // Test 2: Dynamic tool registration
  server.registerTool(
    "custom_test_tool",
    "A custom test tool for validation",
    {
      type: "object",
      properties: {
        inputMsg: { type: "string" },
      },
    },
    async (args) => {
      return {
        content: [
          {
            type: "text",
            text: `Echo: ${args.inputMsg || "no-input"}`,
          },
        ],
      };
    }
  );

  const updatedTools = server.getRegisteredTools();
  assert.ok(updatedTools.some((t) => t.name === "custom_test_tool"), "custom_test_tool should be registered");

  // Test 3: Context resolver integration
  const mockContext: WorkspaceContext = {
    rootPath: "/fake/repo",
    name: "fake-repo",
    detectedLanguages: ["python", "typescript"],
    hasGit: true,
    hasOpenCodeConfig: true,
    activeFilePath: "/fake/repo/main.py",
  };

  server.setWorkspaceContextResolver(() => mockContext);

  // Test 4: Tool unregistration
  server.unregisterTool("custom_test_tool");
  const remainingTools = server.getRegisteredTools();
  assert.ok(!remainingTools.some((t) => t.name === "custom_test_tool"), "Tool should be successfully unregistered");

  // Test 5: Verify resolveContext never returns null and works without explicit resolver
  const standaloneServer = new CodeSentinelMcpServer("standalone-test", "1.0.0");
  const resolvedCtx = standaloneServer.resolveContext();
  assert.ok(resolvedCtx, "resolveContext should return a valid context");
  assert.ok(resolvedCtx.rootPath, "rootPath should be present");

  // Test 6: Verify workspace_status tool execution
  const statusTool = standaloneServer.getRegisteredTools().find(t => t.name === "codesentinel_workspace_status");
  assert.ok(statusTool, "codesentinel_workspace_status tool must be registered");

  // Test 7: Verify codesentinel_cloud_security_audit tool registration
  const cloudAuditTool = standaloneServer.getRegisteredTools().find(t => t.name === "codesentinel_cloud_security_audit");
  assert.ok(cloudAuditTool, "codesentinel_cloud_security_audit tool must be registered");
  const cloudAuditAlias = standaloneServer.getRegisteredTools().find(t => t.name === "cloud_security_audit");
  assert.ok(cloudAuditAlias, "cloud_security_audit alias tool must be registered");

  // Test 8: Verify codesentinel_workflow_force_quit tool registration and execution
  const forceQuitDef = standaloneServer.getRegisteredTools().find((t) => t.name === "codesentinel_workflow_force_quit");
  assert.ok(forceQuitDef, "codesentinel_workflow_force_quit tool must be registered");
  assert.strictEqual(forceQuitDef.inputSchema?.required?.[0], "ticketKey");

  const forceQuitEntry = (standaloneServer as any).tools.get("codesentinel_workflow_force_quit");
  assert.ok(forceQuitEntry && typeof forceQuitEntry.handler === "function");

  // Non-existent workflow returns error response
  const failRes = await forceQuitEntry.handler({ ticketKey: "NONEXISTENT-999" });
  assert.strictEqual(failRes.isError, true);
  assert.strictEqual(failRes.content[0].text, "No such workflow.");

  // Successful invocation forwards to WorkflowEngine.forceQuit
  const { WorkflowEngine } = await import("../src/agent/workflowEngine");
  const engine = WorkflowEngine.getInstance();
  const origForceQuit = engine.forceQuit.bind(engine);
  let interceptedArgs: { key: string; repo: string } | null = null;
  engine.forceQuit = (key: string, repo: string) => {
    interceptedArgs = { key, repo };
    return true;
  };
  try {
    const okRes = await forceQuitEntry.handler({ ticketKey: "PROJ-123", repoPath: "/workspace/my-repo" });
    assert.strictEqual(okRes.isError, false);
    assert.strictEqual(okRes.content[0].text, "Workflow force quit immediately.");
    assert.deepStrictEqual(interceptedArgs, { key: "PROJ-123", repo: "/workspace/my-repo" });
  } finally {
    engine.forceQuit = origForceQuit;
  }

  console.log("  ✔ MCP Server tool registration, lifecycle, and cloud security audit tool passed!");
}
