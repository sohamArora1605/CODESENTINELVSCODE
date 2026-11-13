import "./mockVscode";
import { testOpenCodeLauncher } from "./opencodeLauncher.test";
import { testMcpServer } from "./mcpServer.test";
import { testDockerClient } from "./dockerClient.test";
import { testGraphService } from "./graphService.test";
import { testVulnerabilityScanner } from "./vulnerabilityScanner.test";
import { testCegarVerifier } from "./cegarVerifier.test";
import { testGitSync } from "./gitSync.test";
import { testJiraAndVault } from "./jira.test";
import { testTestRunner } from "./testRunner.test";
import { testWorkflowEngine } from "./workflowEngine.test";
import { testMcpProcess } from "./mcpProcess.test";
import { testWorkspaceManager } from "./workspaceManager.test";
import { testMultiRepo } from "./multiRepo.test";
import { testAgentRunner } from "./agentRunner.test";
import { testJiraRouting } from "./jiraRouting.test";
import { testAtlassianMcp } from "./atlassianMcp.test";

async function runAllTests() {
  console.log("==========================================");
  console.log("   CodeSentinel Phase 1 & 2 Test Suite   ");
  console.log("==========================================");

  let passed = 0;
  let failed = 0;

  const suites = [
    { name: "OpenCodeLauncher", fn: testOpenCodeLauncher },
    { name: "CodeSentinelMcpServer", fn: testMcpServer },
    { name: "DockerClient", fn: testDockerClient },
    { name: "GraphService", fn: testGraphService },
    { name: "VulnerabilityScanner", fn: testVulnerabilityScanner },
    { name: "CegarVerifier", fn: testCegarVerifier },
    { name: "GitSyncService", fn: testGitSync },
    { name: "JiraAndVault", fn: testJiraAndVault },
    { name: "TestRunnerService", fn: testTestRunner },
    { name: "WorkflowEngine", fn: testWorkflowEngine },
    { name: "McpProcess", fn: testMcpProcess },
    { name: "WorkspaceManager", fn: testWorkspaceManager },
    { name: "MultiRepo", fn: testMultiRepo },
    { name: "AgentRunner", fn: testAgentRunner },
    { name: "JiraRouting", fn: testJiraRouting },
    { name: "AtlassianMcp", fn: testAtlassianMcp },
  ];

  const only = (process.env.TEST_ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const suite of suites.filter((x) => !only.length || only.includes(x.name))) {
    try {
      await suite.fn();
      passed++;
    } catch (err: any) {
      console.error(`✖ Suite ${suite.name} FAILED:`, err);
      failed++;
    }
  }

  console.log("==========================================");
  console.log(`Results: ${passed} passed, ${failed} failed.`);
  console.log("==========================================");

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log("✔ ALL PHASE 1 INTEGRATION TESTS PASSED!");
  }
}

runAllTests().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
