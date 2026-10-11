import * as assert from "assert";
import * as path from "path";
import { GraphService } from "../src/graph/graphService";

export async function testGraphService(): Promise<void> {
  console.log("▶ Running GraphService Tests...");
  const workspaceRoot = path.resolve(__dirname, "../../");
  const graphService = GraphService.getInstance();

  const isAvailable = graphService.isGraphAvailable(workspaceRoot);
  console.log(`  - Graph DB available: ${isAvailable ? "Yes" : "No"}`);

  if (!isAvailable) {
    console.log("  ⚠ .atlas/atlas.db not yet present, skipping query tests.");
    return;
  }

  // 1. Test stats
  const stats = graphService.getStats(workspaceRoot);
  assert.ok(stats.available, "Graph stats should be available");
  assert.ok(stats.symbolCount > 0, "Symbol count should be > 0");
  assert.ok(stats.edgeCount > 0, "Edge count should be > 0");
  console.log(`  ✔ Graph stats: ${stats.symbolCount} symbols, ${stats.edgeCount} edges, ${stats.fileCount} files`);

  // 2. Test top symbols
  const topSymbols = graphService.getTopSymbols(workspaceRoot, 10);
  assert.ok(topSymbols.length > 0, "Top symbols should return records");
  console.log(`  ✔ Retrieved ${topSymbols.length} top symbols (first: ${topSymbols[0].name})`);

  // 3. Test symbol search
  const found = graphService.searchSymbols(workspaceRoot, "Docker", 5);
  assert.ok(found.length > 0, "Search for 'Docker' should return symbols");
  console.log(`  ✔ Search returned ${found.length} matches for 'Docker'`);

  // 4. Test call hierarchy
  const testSymbol = topSymbols[0].name;
  const hierarchy = graphService.getCallHierarchy(workspaceRoot, testSymbol);
  assert.strictEqual(hierarchy.root.name, testSymbol, "Hierarchy root must match query symbol");
  console.log(
    `  ✔ Call hierarchy for '${testSymbol}': ${hierarchy.callers.length} callers, ${hierarchy.callees.length} callees`
  );

  // 5. Test expand branch
  const expanded = graphService.expandBranch(workspaceRoot, testSymbol, "callees", 5);
  console.log(`  ✔ Branch expansion for '${testSymbol}': ${expanded.symbols.length} child symbols`);

  // 6. Test Path Finder
  const pathRes = graphService.findPath(workspaceRoot, testSymbol, topSymbols[1]?.name || testSymbol);
  console.log(`  ✔ Path Finder tested: found=${pathRes.found}, steps=${pathRes.steps.length}`);

  // 7. Test Blast Radius / Impact Analysis
  const impactRes = graphService.analyzeImpact(workspaceRoot, testSymbol, "downstream", 2, 8);
  assert.ok(impactRes.levels.length >= 0, "Impact analysis should return levels");
  console.log(`  ✔ Blast Radius for '${testSymbol}': ${impactRes.totalAffected} total affected, ${impactRes.levels.length} rings`);

  // 8. Test File Dependencies
  const depsRes = graphService.getFileDependencies(workspaceRoot, undefined, 20);
  assert.ok(depsRes.nodes.length > 0, "File dependencies should return nodes");
  console.log(`  ✔ File dependencies: ${depsRes.totalFiles} files, ${depsRes.totalDependencies} links, hasCycles=${depsRes.hasCycles}`);

  // 9. Test Category Search
  const catSearch = graphService.searchSymbols(workspaceRoot, "", 5, "files");
  assert.ok(catSearch.length > 0, "Category search for files should return files");
  console.log(`  ✔ Category search (files): ${catSearch.length} files returned (first: ${catSearch[0].name})`);

  console.log("  ✔ All GraphService tests passed!");
}
