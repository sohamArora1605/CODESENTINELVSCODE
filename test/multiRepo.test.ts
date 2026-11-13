import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { MultiRepoManager } from "../src/repo/multiRepoManager";
import { setSettingsOverrides } from "../src/config/settings";
import { makeRepo, tmpDir } from "./helpers";

export async function testMultiRepo(): Promise<void> {
  console.log("▶ Running MultiRepoManager Tests...");
  process.env.CODESENTINEL_VAULT_DIR = tmpDir("cs-reg-");
  setSettingsOverrides({ multiRepoEnabled: true });
  const mr = MultiRepoManager.getInstance();
  const a = makeRepo().repo, b = makeRepo().repo;
  await mr.addRepository(a);
  await mr.addRepository(b);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(process.env.CODESENTINEL_VAULT_DIR!, "repos.json"), "utf-8")).sort(), [a, b].sort());

  // "reload": a fresh process remembers hand-added repos
  (mr as any).repositories.clear();
  await mr.syncWithWorkspace();
  const mine = () => mr.getRepositories().map((r) => r.path).filter((p) => p === a || p === b).sort();
  assert.deepStrictEqual(mine(), [a, b].sort());

  // multi-repo off hides extras without forgetting them
  setSettingsOverrides({ multiRepoEnabled: false });
  await mr.syncWithWorkspace();
  assert.ok(mine().length <= 1, "extras hidden while multi-repo is off");
  await assert.rejects(mr.addRepository(makeRepo().repo), /turned off/);
  setSettingsOverrides({ multiRepoEnabled: true });
  (mr as any).repositories.clear();
  await mr.syncWithWorkspace();
  assert.deepStrictEqual(mine(), [a, b].sort(), "registry survived toggling multi-repo off and on");

  // removal is remembered
  mr.removeRepository(a);
  (mr as any).repositories.clear();
  await mr.syncWithWorkspace();
  assert.deepStrictEqual(mine(), [b]);
  setSettingsOverrides({});
  console.log("✔ MultiRepoManager OK");
}
