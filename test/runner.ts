import "./mockVscode";
import { testOpenCodeLauncher } from "./opencodeLauncher.test";
import { testMcpServer } from "./mcpServer.test";
import { testDockerClient } from "./dockerClient.test";
import { testGraphService } from "./graphService.test";
import { testVulnerabilityScanner } from "./vulnerabilityScanner.test";

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
  ];

  for (const suite of suites) {
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
