import * as assert from "assert";
import { DockerClient } from "../src/docker/dockerClient";

export async function testDockerClient(): Promise<void> {
  console.log("▶ Running DockerClient Tests...");

  const client = DockerClient.getInstance();

  // Test 1: Singleton pattern
  assert.ok(client, "DockerClient instance should exist");
  assert.strictEqual(client, DockerClient.getInstance(), "Should follow singleton pattern");

  // Test 2: Check docker availability
  const check = await client.checkDockerAvailability();
  console.log(`  - Docker installed check: ${check.available ? "Yes (" + check.version + ")" : "No (" + check.error + ")"}`);
  assert.strictEqual(typeof check.available, "boolean", "check.available must be boolean");

  // Test 3: Cloud backend routing (should dispatch without executing local docker)
  const cloudResult = await client.runContainer(
    {
      workspacePath: "C:\\fake\\workspace",
      imageName: "codesentinel/core:latest",
    },
    "cloud"
  );

  assert.strictEqual(cloudResult.exitCode, 0, "Cloud run should exit with 0");
  assert.ok(cloudResult.stdout.includes("Cloud Cluster"), "Should route to cloud endpoint");

  // Test 4: getDockerMcpCommand generates correct hermetic CLI arguments
  const mcpCmd = client.getDockerMcpCommand("/mock/project", "codesentinel/core:latest");
  assert.strictEqual(mcpCmd[0], "docker", "Command must start with docker");
  assert.strictEqual(mcpCmd[1], "run", "Must be run action");
  assert.ok(mcpCmd.includes("-i"), "Must include -i for stdio streaming");
  assert.ok(mcpCmd.includes("/mock/project:/workspace:ro"), "Must mount workspace read-only");
  assert.ok(mcpCmd.includes("codesentinel/core:latest"), "Must use core image");

  // Test 5: checkImageExists detects built image
  const exists = await client.checkImageExists("codesentinel/core:latest");
  console.log(`  - codesentinel/core:latest local image check: ${exists ? "Found" : "Not Found"}`);
  assert.strictEqual(typeof exists, "boolean", "checkImageExists must return boolean");

  console.log("  ✔ DockerClient singleton, availability check, cloud dispatch, and image inspection passed!");
}
