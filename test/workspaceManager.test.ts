import * as assert from "assert";
import { WorkspaceManager } from "../src/workspace/workspaceManager";

/** Regression: opening VS Code with no folder crashed the extension host (stack overflow). */
export async function testWorkspaceManager(): Promise<void> {
  console.log("▶ Running WorkspaceManager Tests...");
  const wm = WorkspaceManager.getInstance();
  let fired = 0;
  wm.onDidChangeWorkspace(() => {
    fired++;
    wm.getContext(); // what the sidebar and status bar listeners do
  });
  assert.strictEqual(wm.getContext(), null);
  wm.refreshContext();
  wm.refreshContext();
  assert.ok(fired <= 1, `no-workspace must not re-announce on every refresh (fired ${fired})`);
  console.log("✔ WorkspaceManager OK");
}
