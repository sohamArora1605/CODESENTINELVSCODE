---
name: codesentinel
description: Autonomous Multi-Language Security Auditing and Semantic Code Graph Intelligence
version: 1.0.0
---

# CodeSentinel & Atlas Semantic Graph Intelligence Skill

This skill guides OpenCode when conducting security audits, architectural inspections, taint tracing, and blast radius analysis using CodeSentinel and Atlas MCP tools.

## Available MCP Tools

### 1. Atlas Code Graph Tools (`atlas`)
- **`atlas.search(query, kind?, limit?)`**: Search for symbols (functions, methods, classes, interfaces, routes) across the repository.
- **`atlas.calls(symbol, direction?)`**: Query the interprocedural call graph.
  - `direction: "callers"`: Find functions that invoke this symbol (upstream entry points).
  - `direction: "callees"`: Find functions that this symbol invokes (downstream dependencies & sinks).
- **`atlas.path(from, to)`**: Find the execution and call graph path connecting two symbols.
- **`atlas.impact(symbol)`**: Compute the upstream blast radius (who breaks if this symbol changes) and downstream impact.
- **`atlas.trace(source, sink)`**: Interprocedural dataflow taint trace showing how untrusted input flows to potential sinks.

### 2. CodeSentinel Core Tools (`codesentinel`)
- **`codesentinel.codesentinel_workspace_status()`**: Returns the active workspace root, detected programming languages, git status, and container execution mode.
- **`codesentinel.codesentinel_atlas_graph_status()`**: Returns current `.atlas/atlas.db` statistics: total symbols, total edges, and indexing freshness.
- **`codesentinel.codesentinel_list_tools()`**: Lists all active MCP security and SAST tools.

---

## Standard Security Investigation Workflows

### Workflow 1: Vulnerability & Taint Tracing
When asked to audit an entry point or verify a potential vulnerability:
1. Call `atlas.search(symbol)` to locate the function definition and signature.
2. Call `atlas.calls(symbol, "callees")` to inspect what helper functions and database/system APIs are invoked.
3. Call `atlas.trace(source_param, sink_function)` to track whether unvalidated user input reaches dangerous sinks (`query`, `exec`, `deserialize`, `fetch`).
4. If a vulnerable path is confirmed, pinpoint the exact file and line numbers.

### Workflow 2: Safe Refactoring & Blast Radius Analysis
When asked to modify, rename, or secure an existing function:
1. Call `atlas.impact(symbol)` to discover all direct and indirect callers.
2. Check if any callers are public HTTP routes or RPC entry points.
3. Verify test coverage by locating test files among the callers.
4. Propose non-breaking fixes with backward-compatible parameter signatures.

---

## Visual Canvas Driving Directives

When explaining an execution path or call chain to the developer, you can instruct the CodeSentinel Visual Canvas to spotlight those nodes by including a structured visualization block in your markdown response:

```json:codesentinel-canvas
{
  "action": "highlight_path",
  "path": ["loginController", "validateCredentials", "findUserByUsername", "db.query"],
  "status": "vulnerable",
  "reason": "Unsanitized user input in findUserByUsername reaches raw SQL query"
}
```

Or to focus the 360° branching tree on a specific symbol:

```json:codesentinel-canvas
{
  "action": "focus_symbol",
  "symbol": "authMiddleware"
}
```

The extension intercepts this directive and automatically centers the 360° interactive canvas, expanding the relevant branches with glowing edges.
