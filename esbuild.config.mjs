import * as esbuild from "esbuild";
import * as fs from "fs";

const shouldMinify = process.argv.includes("--minify");

/**
 * Builds the extension and the standalone MCP server.
 */
async function build() {
  // 1. VS Code Extension bundle
  const extensionCtx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: shouldMinify,
    sourcemap: true,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "info",
  });

  // 2. Standalone MCP Server bundle (runnable by OpenCode or external MCP clients via stdio)
  const mcpServerCtx = await esbuild.context({
    entryPoints: ["src/mcp/cli.ts"],
    bundle: true,
    format: "cjs",
    minify: shouldMinify,
    sourcemap: true,
    sourcesContent: false,
    platform: "node",
    banner: {
      js: "#!/usr/bin/env node\n",
    },
    outfile: "dist/mcp-server.js",
    external: ["vscode"],
    logLevel: "info",
  });

  // 3. Atlas MCP stdio bridge (translates Windows host paths <-> /workspace for Docker)
  const atlasBridgeCtx = await esbuild.context({
    entryPoints: ["src/mcp/atlasBridge.ts"],
    bundle: true,
    format: "cjs",
    minify: shouldMinify,
    sourcemap: true,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/atlas-bridge.js",
    external: ["vscode"],
    logLevel: "info",
  });

  await extensionCtx.rebuild();
  await mcpServerCtx.rebuild();
  await atlasBridgeCtx.rebuild();
  await atlasBridgeCtx.dispose();

  // 4. Optional Test Runner bundle
  if (fs.existsSync("test/runner.ts")) {
    const testCtx = await esbuild.context({
      entryPoints: ["test/runner.ts"],
      bundle: true,
      format: "cjs",
      minify: false,
      sourcemap: true,
      platform: "node",
      outfile: "dist/test/runner.js",
      external: ["vscode"],
      logLevel: "info",
    });
    await testCtx.rebuild();
    await testCtx.dispose();
  }

  await extensionCtx.dispose();
  await mcpServerCtx.dispose();
  console.log("CodeSentinel bundles built successfully.");
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
