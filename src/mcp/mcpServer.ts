import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as fs from "fs";
import * as path from "path";
import { WorkspaceContext } from "../types";
import { GraphService } from "../graph/graphService";
import { VulnerabilityScanner, ClubbedFinding } from "../scanner/vulnerabilityScanner";
import { CegarVerifier } from "../scanner/cegarVerifier";
import { MultiRepoManager } from "../repo/multiRepoManager";
import { GitSyncService } from "../git/gitSyncService";
import { JiraService } from "../jira/jiraService";
import { SecretVault } from "../security/secretVault";
import { TestRunnerService } from "../testing/testRunnerService";
import { WorkflowEngine } from "../agent/workflowEngine";
import { getRepoConfig, setRepoConfig } from "../config/settings";
import { AgentTerminalLauncher, AgentHarnessType } from "../agent/agentTerminalLauncher";

export type McpToolHandler = (args: any, context?: WorkspaceContext | null) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

export interface RegisteredTool {
  definition: Tool;
  handler: McpToolHandler;
}

export class CodeSentinelMcpServer {
  private server: Server;
  private tools: Map<string, RegisteredTool> = new Map();
  private getActiveWorkspaceFn?: () => WorkspaceContext | null;

  constructor(serverName = "codesentinel-mcp", version = "0.3.3") {
    this.server = new Server(
      {
        name: serverName,
        version,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    this.registerBuiltinTools();
  }

  public setWorkspaceContextResolver(fn: () => WorkspaceContext | null): void {
    this.getActiveWorkspaceFn = fn;
  }

  public registerTool(
    name: string,
    description: string,
    inputSchema: any,
    handler: McpToolHandler
  ): void {
    this.tools.set(name, {
      definition: {
        name,
        description,
        inputSchema: inputSchema || { type: "object", properties: {} },
      },
      handler,
    });
  }

  public unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  public getRegisteredTools(): Tool[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  public async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  public async close(): Promise<void> {
    await this.server.close();
  }

  private detectLanguages(rootPath: string): string[] {
    const exts = new Set<string>();
    const extMap: Record<string, string> = {
      ".ts": "typescript",
      ".tsx": "typescript",
      ".js": "javascript",
      ".jsx": "javascript",
      ".py": "python",
      ".go": "go",
      ".rs": "rust",
      ".java": "java",
      ".c": "c",
      ".cpp": "cpp",
      ".cs": "csharp",
      ".kt": "kotlin",
      ".swift": "swift",
      ".scala": "scala",
    };
    const ignoredDirs = new Set([
      "node_modules",
      ".git",
      ".atlas",
      "target",
      "build",
      ".gradle",
      "dist",
      "out",
      "bin",
      "obj",
      "vendor",
      ".venv",
      "venv",
      "env",
      "__pycache__",
    ]);

    const scanDir = (dir: string, depth: number) => {
      if (depth > 4) return;
      try {
        const files = fs.readdirSync(dir, { withFileTypes: true });
        for (const f of files) {
          if (f.isFile()) {
            const ext = path.extname(f.name).toLowerCase();
            if (extMap[ext]) exts.add(extMap[ext]);
          } else if (f.isDirectory() && !f.name.startsWith(".") && !ignoredDirs.has(f.name)) {
            scanDir(path.join(dir, f.name), depth + 1);
          }
        }
      } catch {}
    };

    scanDir(rootPath, 0);
    return Array.from(exts);
  }

  public resolveContext(): WorkspaceContext {
    if (this.getActiveWorkspaceFn) {
      try {
        const ctx = this.getActiveWorkspaceFn();
        if (ctx && ctx.rootPath) return ctx;
      } catch {}
    }

    const envRoot = process.env.CODESENTINEL_WORKSPACE || process.cwd();
    const resolvedRoot = path.resolve(envRoot || ".");
    const name = path.basename(resolvedRoot) || "workspace";
    const hasGit = fs.existsSync(path.join(resolvedRoot, ".git"));
    const hasOpenCodeConfig =
      fs.existsSync(path.join(resolvedRoot, "opencode.json")) ||
      fs.existsSync(path.join(resolvedRoot, ".opencode"));

    return {
      rootPath: resolvedRoot,
      name,
      detectedLanguages: this.detectLanguages(resolvedRoot),
      hasGit,
      hasOpenCodeConfig,
    };
  }

  private setupHandlers(): void {
    // 1. List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: this.getRegisteredTools(),
      };
    });

    // 2. Call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const registered = this.tools.get(toolName);

      if (!registered) {
        return {
          content: [
            {
              type: "text",
              text: `Tool '${toolName}' not found in CodeSentinel MCP registry.`,
            },
          ],
          isError: true,
        };
      }

      const activeContext = this.resolveContext();

      try {
        return await registered.handler(request.params.arguments || {}, activeContext);
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error executing tool '${toolName}': ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private registerBuiltinTools(): void {
    // Builtin tool 1: Workspace context introspection
    this.registerTool(
      "codesentinel_workspace_status",
      "Inspect current active workspace repository path, detected programming languages, git status, and OpenCode state.",
      {
        type: "object",
        properties: {},
      },
      async (_args, context) => {
        const ctx = context || this.resolveContext();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "OK",
                  workspaceRoot: ctx.rootPath,
                  workspaceName: ctx.name,
                  detectedLanguages: ctx.detectedLanguages,
                  hasGit: ctx.hasGit,
                  hasOpenCodeConfig: ctx.hasOpenCodeConfig,
                  activeFile: ctx.activeFilePath || null,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Builtin tool 2: List registered tools
    this.registerTool(
      "codesentinel_list_tools",
      "List all MCP tools currently registered in CodeSentinel.",
      {
        type: "object",
        properties: {},
      },
      async () => {
        const toolsList = this.getRegisteredTools().map((t) => ({
          name: t.name,
          description: t.description,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ registeredTools: toolsList }, null, 2),
            },
          ],
        };
      }
    );

    // Builtin tool 3: Atlas Code Graph Status
    this.registerTool(
      "codesentinel_atlas_graph_status",
      "Inspect Atlas code graph database state (.codesentinel/atlas.db) for the active workspace, reporting whether the graph index is ready.",
      {
        type: "object",
        properties: {},
      },
      async (_args, context) => {
        const ctx = context || this.resolveContext();
        const dbPath = GraphService.getInstance().getDbPath(ctx.rootPath);
        const exists = fs.existsSync(dbPath);
        let sizeBytes = 0;
        let stats: any = null;
        if (exists) {
          try {
            sizeBytes = fs.statSync(dbPath).size;
            stats = GraphService.getInstance().getStats(ctx.rootPath);
          } catch {}
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "OK",
                  workspaceRoot: ctx.rootPath,
                  atlasDatabasePath: dbPath,
                  isIndexed: exists,
                  sizeBytes,
                  stats: stats || { available: false, symbolCount: 0, edgeCount: 0, fileCount: 0, dbPath },
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Builtin tool 4: Search symbols
    this.registerTool(
      "codesentinel_search_symbols",
      "Search functions, methods, classes, and types in the active workspace using the AST code graph.",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query for symbol name or qualified name" },
          limit: { type: "number", description: "Maximum number of symbols to return (default: 25)" },
          category: {
            type: "string",
            enum: ["callables", "types", "data", "containers", "all", "files"],
            description: "Category filter (default: callables)",
          },
        },
        required: ["query"],
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        try {
          const graphService = GraphService.getInstance();
          const results = graphService.searchSymbols(
            ctx.rootPath,
            args.query || "",
            args.limit || 25,
            args.category || "callables"
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ query: args.query, count: results.length, symbols: results }, null, 2),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Search error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    // Builtin tool 5: Call hierarchy
    this.registerTool(
      "codesentinel_call_hierarchy",
      "Inspect incoming callers and outgoing callees of a function/method in the active workspace.",
      {
        type: "object",
        properties: {
          symbolName: { type: "string", description: "Symbol name (e.g. login, verifyToken, activate)" },
          maxCallers: { type: "number", description: "Max callers to return (default: 50)" },
          maxCallees: { type: "number", description: "Max callees to return (default: 50)" },
        },
        required: ["symbolName"],
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        try {
          const graphService = GraphService.getInstance();
          const hierarchy = graphService.getCallHierarchy(ctx.rootPath, args.symbolName, {
            maxCallers: args.maxCallers || 50,
            maxCallees: args.maxCallees || 50,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(hierarchy, null, 2),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Call hierarchy error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    // Builtin tool 6: Find path
    this.registerTool(
      "codesentinel_find_path",
      "Find call execution or attack paths between two symbols (from -> to) in the active workspace.",
      {
        type: "object",
        properties: {
          from: { type: "string", description: "Starting symbol name" },
          to: { type: "string", description: "Target sink symbol name" },
          maxDepth: { type: "number", description: "Maximum hops to trace (default: 6)" },
        },
        required: ["from", "to"],
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        try {
          const graphService = GraphService.getInstance();
          const result = graphService.findPath(ctx.rootPath, args.from, args.to, {
            maxDepth: args.maxDepth || 6,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Path analysis error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    // Builtin tool 7: Analyze impact (Blast radius)
    this.registerTool(
      "codesentinel_analyze_impact",
      "Calculate the blast radius of a symbol across concentric caller/callee rings in the active workspace.",
      {
        type: "object",
        properties: {
          symbolName: { type: "string", description: "Target symbol name" },
          direction: { type: "string", enum: ["downstream", "upstream"], description: "Direction (default: downstream)" },
          maxDepth: { type: "number", description: "Concentric rings depth (1-4, default: 3)" },
        },
        required: ["symbolName"],
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        try {
          const graphService = GraphService.getInstance();
          const result = graphService.analyzeImpact(
            ctx.rootPath,
            args.symbolName,
            args.direction || "downstream",
            args.maxDepth || 3
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Impact analysis error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    // Builtin tool 8: File dependencies
    this.registerTool(
      "codesentinel_file_dependencies",
      "Inspect cross-file dependencies and detect circular import loops in the active workspace.",
      {
        type: "object",
        properties: {
          fileFilter: { type: "string", description: "Optional path substring filter" },
          limit: { type: "number", description: "Maximum files to return (default: 50)" },
        },
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        try {
          const graphService = GraphService.getInstance();
          const result = graphService.getFileDependencies(ctx.rootPath, args.fileFilter, args.limit || 50);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Dependencies error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    // Builtin tool 9: Code snippet
    this.registerTool(
      "codesentinel_code_snippet",
      "Retrieve exact source code snippet from a file in the active workspace given start and end lines.",
      {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          startLine: { type: "number", description: "1-indexed start line" },
          endLine: { type: "number", description: "1-indexed end line" },
        },
        required: ["path", "startLine", "endLine"],
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        try {
          const graphService = GraphService.getInstance();
          const snippet = graphService.getCodeSnippet(ctx.rootPath, args.path, args.startLine, args.endLine);
          return {
            content: [
              {
                type: "text",
                text: snippet,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Code snippet error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    // Builtin tool 10: Explain architecture, dataflow & generate diagram
    this.registerTool(
      "codesentinel_explain_flow",
      "Explain the architecture, dataflow, and security sequence of an application feature (e.g. login, payment, authentication) in natural language, generating both a Mermaid diagram and an interactive visual node graph in the Code Graph tab.",
      {
        type: "object",
        properties: {
          topic: { type: "string", description: "Feature or architectural flow to explain (e.g. 'login', 'authentication', 'payment', 'signup')" },
          entrySymbol: { type: "string", description: "Optional specific entrypoint symbol name (e.g. 'login', 'handleSubmit', 'verifyToken')" },
          maxSteps: { type: "number", description: "Maximum execution flow stages to trace (default: 8)" },
        },
        required: ["topic"],
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        try {
          const graphService = GraphService.getInstance();
          const flow = graphService.explainFlow(ctx.rootPath, args.topic, args.entrySymbol, args.maxSteps || 8);
          
          let responseText = `### Architecture & Dataflow Explanation: ${args.topic.toUpperCase()}\n\n`;
          responseText += `${flow.summary}\n\n`;
          responseText += `#### Sequence & Stages:\n`;
          flow.steps.forEach(st => {
            responseText += `${st.step}. **\`${st.name}\`** (\`${st.role}\` in \`${st.path}:${st.startLine}\`): ${st.description}\n`;
          });
          responseText += `\n#### Visual Diagram:\n\`\`\`mermaid\n${flow.mermaidDiagram}\n\`\`\`\n\n`;
          responseText += `> 💡 *Interactive graph nodes have been automatically rendered into the **Code Graph** tab.*`;

          return {
            content: [
              {
                type: "text",
                text: responseText,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Flow explanation error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    // Builtin tool 11: Render custom graphical diagram in Code Graph tab
    this.registerTool(
      "codesentinel_render_diagram",
      "Render a custom architectural or dataflow diagram with graphical nodes and links directly in the CodeSentinel Code Graph tab.",
      {
        type: "object",
        properties: {
          title: { type: "string", description: "Title of the diagram flow" },
          nodes: {
            type: "array",
            description: "List of visual flow nodes",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                kind: { type: "string" },
                path: { type: "string" },
                line: { type: "number" },
                role: { type: "string" },
                description: { type: "string" },
              },
              required: ["name"],
            },
          },
          edges: {
            type: "array",
            description: "Connections between nodes",
            items: {
              type: "object",
              properties: {
                source: { type: "string" },
                target: { type: "string" },
                label: { type: "string" },
              },
              required: ["source", "target"],
            },
          },
          mermaid: { type: "string", description: "Optional Mermaid diagram markdown string" },
        },
        required: ["title", "nodes", "edges"],
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        try {
          const graphService = GraphService.getInstance();
          const flowNodes = (args.nodes || []).map((n: any, idx: number) => ({
            id: n.name,
            name: n.name,
            kind: n.kind || "function",
            path: n.path || "",
            startLine: n.line || 1,
            endLine: n.line || 1,
            role: n.role || "service",
            description: n.description || "",
            step: idx + 1,
          }));

          const flowEdges = (args.edges || []).map((e: any, idx: number) => ({
            id: `flow_edge_${idx}_${e.source}_${e.target}`,
            source: e.source,
            target: e.target,
            label: e.label || "executes",
            kind: "flow",
          }));

          const mermaidDiagram = args.mermaid || "flowchart TD\n" + flowEdges.map((e: any) => `  ${e.source} --> ${e.target}`).join("\n");

          const flow: any = {
            topic: args.title,
            summary: `Custom diagram "${args.title}" with ${flowNodes.length} nodes and ${flowEdges.length} connections.`,
            entryPoint: flowNodes[0]?.name,
            steps: flowNodes.map((fn: any) => ({
              step: fn.step,
              name: fn.name,
              kind: fn.kind,
              path: fn.path,
              startLine: fn.startLine,
              endLine: fn.endLine,
              role: fn.role,
              description: fn.description,
            })),
            mermaidDiagram,
            graph: { nodes: flowNodes, edges: flowEdges },
          };

          graphService.saveFlowDiagram(ctx.rootPath, flow);

          return {
            content: [
              {
                type: "text",
                text: `Diagram "${args.title}" successfully saved and rendered into the Code Graph tab (${flowNodes.length} nodes, ${flowEdges.length} edges).\n\n\`\`\`mermaid\n${mermaidDiagram}\n\`\`\``,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Render diagram error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    // =========================================================================
    // Native Atlas Compatibility Tools (Direct host SQLite, zero Docker)
    // =========================================================================

    // Atlas Project Handler
    const projectHandler: McpToolHandler = async (args, context) => {
      const ctx = context || this.resolveContext();
      const graphService = GraphService.getInstance();
      const stats = graphService.getStats(ctx.rootPath);
      const action = args?.action || "status";

      if (action === "files") {
        const fileSyms = graphService.searchSymbols(ctx.rootPath, "", args?.limit || 100, "files");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  project_path: ctx.rootPath,
                  files_count: fileSyms.length,
                  files: fileSyms.map((f) => f.path),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                active_project: ctx.rootPath,
                db_path: stats.dbPath,
                is_indexed: stats.available,
                symbols_count: stats.symbolCount,
                edges_count: stats.edgeCount,
                files_count: stats.fileCount,
                message: "Project graph loaded directly from host .atlas/atlas.db (zero Docker overhead)",
              },
              null,
              2
            ),
          },
        ],
      };
    };

    const projectSchema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "open", "files"], description: "Action to perform" },
        project_path: { type: "string", description: "Workspace project path" },
      },
    };
    this.registerTool("atlas_project", "Inspect Atlas project status or open workspace directly from host .atlas/atlas.db", projectSchema, projectHandler);
    this.registerTool("project", "Inspect Atlas project status or open workspace directly from host .atlas/atlas.db", projectSchema, projectHandler);

    // Atlas Search Handler
    const searchHandler: McpToolHandler = async (args, context) => {
      const ctx = context || this.resolveContext();
      try {
        const graphService = GraphService.getInstance();
        const results = graphService.searchSymbols(
          ctx.rootPath,
          args.query || "",
          args.limit || 25,
          args.category || "callables",
          args.in || args.fileFilter
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ query: args.query, count: results.length, symbols: results }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Search error: ${err.message}` }],
          isError: true,
        };
      }
    };
    const searchSchema = {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results" },
        in: { type: "string", description: "File path filter" },
      },
      required: ["query"],
    };
    this.registerTool("atlas_search", "Search functions, methods, classes, and types in the active workspace using the AST code graph.", searchSchema, searchHandler);
    this.registerTool("search", "Search functions, methods, classes, and types in the active workspace using the AST code graph.", searchSchema, searchHandler);

    // Atlas Calls Handler
    const callsHandler: McpToolHandler = async (args, context) => {
      const ctx = context || this.resolveContext();
      try {
        const graphService = GraphService.getInstance();
        const sym = args.symbol || args.symbolName || "";
        const hierarchy = graphService.getCallHierarchy(ctx.rootPath, sym, {
          maxCallers: args.maxCallers || 50,
          maxCallees: args.maxCallees || 50,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(hierarchy, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Call hierarchy error: ${err.message}` }],
          isError: true,
        };
      }
    };
    const callsSchema = {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol name" },
        direction: { type: "string", enum: ["callers", "callees", "both"] },
      },
      required: ["symbol"],
    };
    this.registerTool("atlas_calls", "Inspect incoming callers and outgoing callees of a function/method in the active workspace.", callsSchema, callsHandler);
    this.registerTool("calls", "Inspect incoming callers and outgoing callees of a function/method in the active workspace.", callsSchema, callsHandler);

    // Atlas Symbol Handler
    const symbolHandler: McpToolHandler = async (args, context) => {
      const ctx = context || this.resolveContext();
      try {
        const graphService = GraphService.getInstance();
        const sym = args.name || args.symbol || args.symbolName || "";
        const hierarchy = graphService.getCallHierarchy(ctx.rootPath, sym);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  symbol: hierarchy.root,
                  callers_count: hierarchy.callers.length,
                  callees_count: hierarchy.callees.length,
                  callers: hierarchy.callers.slice(0, 10).map((c) => ({ name: c.name, path: c.path, line: c.startLine })),
                  callees: hierarchy.callees.slice(0, 10).map((c) => ({ name: c.name, path: c.path, line: c.startLine })),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Symbol error: ${err.message}` }],
          isError: true,
        };
      }
    };
    const symbolSchema = {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name" },
      },
      required: ["name"],
    };
    this.registerTool("atlas_symbol", "Inspect symbol details, definition location, callers and callees in the active workspace.", symbolSchema, symbolHandler);
    this.registerTool("symbol", "Inspect symbol details, definition location, callers and callees in the active workspace.", symbolSchema, symbolHandler);

    // Atlas Impact Handler
    const impactHandler: McpToolHandler = async (args, context) => {
      const ctx = context || this.resolveContext();
      try {
        const graphService = GraphService.getInstance();
        const sym = args.symbol || args.symbolName || "";
        const dir = args.direction === "upstream" ? "upstream" : "downstream";
        const result = graphService.analyzeImpact(ctx.rootPath, sym, dir, args.depth || args.maxDepth || 3);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Impact error: ${err.message}` }],
          isError: true,
        };
      }
    };
    const impactSchema = {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol name" },
        direction: { type: "string", enum: ["downstream", "upstream", "both"] },
        depth: { type: "number", description: "Max rings depth" },
      },
      required: ["symbol"],
    };
    this.registerTool("atlas_impact", "Calculate blast radius of a symbol across concentric caller/callee rings.", impactSchema, impactHandler);
    this.registerTool("impact", "Calculate blast radius of a symbol across concentric caller/callee rings.", impactSchema, impactHandler);

    // Atlas File Dependencies Handler
    const fileDepHandler: McpToolHandler = async (args, context) => {
      const ctx = context || this.resolveContext();
      try {
        const graphService = GraphService.getInstance();
        const filter = args.file_path || args.fileFilter || args.filter || "";
        const result = graphService.getFileDependencies(ctx.rootPath, filter, args.limit || 50);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `File dependencies error: ${err.message}` }],
          isError: true,
        };
      }
    };
    const fileDepSchema = {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Optional file path filter" },
        limit: { type: "number", description: "Maximum files" },
      },
    };
    this.registerTool("atlas_file_dependencies", "Inspect cross-file dependencies and circular loops in the active workspace.", fileDepSchema, fileDepHandler);
    this.registerTool("file_dependencies", "Inspect cross-file dependencies and circular loops in the active workspace.", fileDepSchema, fileDepHandler);

    // Atlas Trace Handler
    const traceHandler: McpToolHandler = async (args, context) => {
      const ctx = context || this.resolveContext();
      try {
        const graphService = GraphService.getInstance();
        if (args.from && args.to) {
          const pathRes = graphService.findPath(ctx.rootPath, args.from, args.to);
          return {
            content: [{ type: "text", text: JSON.stringify(pathRes, null, 2) }],
          };
        }
        const sym = args.symbol || args.symbolName || "";
        if (sym) {
          const hierarchy = graphService.getCallHierarchy(ctx.rootPath, sym);
          return {
            content: [{ type: "text", text: JSON.stringify(hierarchy, null, 2) }],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, message: "Trace target evaluated" }) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Trace error: ${err.message}` }],
          isError: true,
        };
      }
    };
    const traceSchema = {
      type: "object",
      properties: {
        symbol: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
      },
    };
    this.registerTool("atlas_trace", "Trace execution calls or paths between symbols in the active workspace.", traceSchema, traceHandler);
    this.registerTool("trace", "Trace execution calls or paths between symbols in the active workspace.", traceSchema, traceHandler);

    // Atlas Tasks & Domain Rules Stubs (no external database needed)
    this.registerTool("atlas_tasks", "List Atlas tasks", { type: "object", properties: {} }, async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true, tasks: [] }) }],
    }));
    this.registerTool("tasks", "List Atlas tasks", { type: "object", properties: {} }, async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true, tasks: [] }) }],
    }));
    this.registerTool("atlas_domain_rules", "List Atlas domain rules", { type: "object", properties: {} }, async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true, rules: [] }) }],
    }));
    this.registerTool("domain_rules", "List Atlas domain rules", { type: "object", properties: {} }, async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true, rules: [] }) }],
    }));

    // =========================================================================
    // Cloud Security Audit MCP Tool for OpenCode & AI Agent
    // =========================================================================
    const cloudAuditHandler: McpToolHandler = async (args, context) => {
      const ctx = context || this.resolveContext();
      const rootPath = ctx.rootPath;
      const graphService = GraphService.getInstance();
      const stats = graphService.getStats(rootPath);
      const fileFilter = typeof args?.fileFilter === "string" ? args.fileFilter.trim().toLowerCase() : "";

      // 1. Detect Cloud Footprint & Frameworks across all ecosystems (Node, Python, Go, Rust, Java, IaC)
      const detectedCloudProviders: string[] = [];
      const detectedFrameworks: string[] = [];

      const pkgJsonPath = path.join(rootPath, "package.json");
      if (fs.existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          const depKeys = Object.keys(allDeps);
          if (depKeys.some((d) => d.startsWith("@aws-sdk/") || d === "aws-sdk")) detectedCloudProviders.push("AWS");
          if (depKeys.some((d) => d.startsWith("@google-cloud/") || d.includes("firebase"))) detectedCloudProviders.push("GCP");
          if (depKeys.some((d) => d.startsWith("@azure/"))) detectedCloudProviders.push("Azure");
          if (depKeys.some((d) => d.includes("cloudflare") || d === "wrangler")) detectedCloudProviders.push("Cloudflare");
          if (depKeys.some((d) => ["express", "fastify", "koa", "next", "@nestjs/core", "hono"].includes(d))) {
            detectedFrameworks.push("Node Web Framework");
          }
        } catch {}
      }

      const checkTextManifest = (relFile: string, checks: Array<{ match: RegExp; cloud?: string; framework?: string }>) => {
        const p = path.join(rootPath, relFile);
        if (!fs.existsSync(p)) return;
        try {
          const txt = fs.readFileSync(p, "utf-8");
          for (const c of checks) {
            if (c.match.test(txt)) {
              if (c.cloud) detectedCloudProviders.push(c.cloud);
              if (c.framework) detectedFrameworks.push(c.framework);
            }
          }
        } catch {}
      };

      for (const pyFile of ["requirements.txt", "pyproject.toml", "Pipfile"]) {
        checkTextManifest(pyFile, [
          { match: /\b(boto3|botocore|aiobotocore)\b/i, cloud: "AWS" },
          { match: /\bgoogle-cloud-[a-z0-9_-]+/i, cloud: "GCP" },
          { match: /\bazure-[a-z0-9_-]+/i, cloud: "Azure" },
          { match: /\b(fastapi|django|flask|starlette|tornado)\b/i, framework: "Python Web Framework" },
        ]);
      }

      checkTextManifest("go.mod", [
        { match: /aws-sdk-go/i, cloud: "AWS" },
        { match: /cloud\.google\.com\/go/i, cloud: "GCP" },
        { match: /Azure\/azure-sdk-for-go/i, cloud: "Azure" },
        { match: /\b(gin-gonic\/gin|gofiber\/fiber|labstack\/echo|go-chi\/chi)\b/i, framework: "Go Web Framework" },
      ]);

      checkTextManifest("Cargo.toml", [
        { match: /\b(aws-sdk-|aws-config|rusoto_)/i, cloud: "AWS" },
        { match: /\bgoogle-cloud-/i, cloud: "GCP" },
        { match: /\bazure_/i, cloud: "Azure" },
        { match: /\b(actix-web|axum|rocket|warp)\b/i, framework: "Rust Web Framework" },
      ]);

      for (const jvmFile of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
        checkTextManifest(jvmFile, [
          { match: /\b(software\.amazon\.awssdk|com\.amazonaws)\b/i, cloud: "AWS" },
          { match: /\bcom\.google\.cloud\b/i, cloud: "GCP" },
          { match: /\bcom\.azure\b/i, cloud: "Azure" },
          { match: /\b(spring-boot|quarkus|micronaut)\b/i, framework: "JVM Web Framework" },
        ]);
      }

      if (fs.existsSync(path.join(rootPath, "Dockerfile")) || fs.existsSync(path.join(rootPath, "docker-compose.yml"))) {
        detectedCloudProviders.push("Docker Container");
      }
      if (fs.existsSync(path.join(rootPath, "serverless.yml")) || fs.existsSync(path.join(rootPath, "serverless.ts")) || fs.existsSync(path.join(rootPath, "template.yaml"))) {
        detectedCloudProviders.push("Serverless Framework");
      }
      if (fs.existsSync(path.join(rootPath, "wrangler.toml")) || fs.existsSync(path.join(rootPath, "wrangler.json"))) {
        detectedCloudProviders.push("Cloudflare Workers");
      }

      // Collect candidate files from both Atlas code graph AND filesystem walk (for IaC/configs or unindexed repos)
      const candidateFileSet = new Set<string>(
        graphService.searchSymbols(rootPath, "", 200, "files").map((f) => f.path.replace(/\\/g, "/"))
      );
      const ignoredAuditDirs = new Set([
        "node_modules", ".git", ".opencode", ".codesentinel", ".atlas",
        "dist", "build", "out", "vendor", ".venv", "venv", "__pycache__",
        "target", ".gradle", "coverage",
      ]);
      const scannableExts = new Set([
        ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".cs", ".rb", ".php",
        ".tf", ".tfvars", ".yaml", ".yml", ".json", ".toml", ".env", ".sh", ".dockerfile",
      ]);

      const walkWorkspace = (dir: string, depth: number) => {
        if (depth > 5 || candidateFileSet.size >= 300) return;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (candidateFileSet.size >= 300) break;
            if (entry.isDirectory()) {
              if (!ignoredAuditDirs.has(entry.name)) {
                walkWorkspace(path.join(dir, entry.name), depth + 1);
              }
            } else if (entry.isFile()) {
              const rel = path.relative(rootPath, path.join(dir, entry.name)).replace(/\\/g, "/");
              if (rel.startsWith("resources/rules/")) continue;
              const ext = path.extname(entry.name).toLowerCase();
              if (ext === ".tf") detectedCloudProviders.push("Terraform IaC");
              if (scannableExts.has(ext) || entry.name === "Dockerfile" || entry.name.startsWith(".env")) {
                candidateFileSet.add(rel);
              }
            }
          }
        } catch {}
      };
      walkWorkspace(rootPath, 0);

      // 2. Scan for Hardcoded Secrets, Cloud Keys & Misconfigurations
      const findings: Array<{
        id: string;
        title: string;
        severity: "Critical" | "High" | "Medium" | "Low" | "Informational";
        cvssScore: number;
        cvssVector: string;
        cwe: string;
        category: string;
        affectedFile: string;
        startLine: number;
        endLine: number;
        source?: string;
        sink?: string;
        description: string;
        exploitScenario: string;
        remediation: string;
        remediationDiff?: string;
      }> = [];

      let findingCounter = 1;
      const candidateFiles = Array.from(candidateFileSet).filter((relPath) =>
        fileFilter ? relPath.toLowerCase().includes(fileFilter) : true
      );
      const secretRegexes: Array<{ pattern: RegExp; title: string; severity: "Critical" | "High" | "Medium"; cwe: string; category: string; desc: string; remediation: string }> = [
        {
          pattern: /AKIA[0-9A-Z]{16}/,
          title: "Hardcoded AWS Access Key ID",
          severity: "Critical",
          cwe: "CWE-798",
          category: "Hardcoded Secrets & Infrastructure",
          desc: "Hardcoded AWS Access Key ID detected in source code, risking full AWS account takeover.",
          remediation: "Move credentials to AWS Secrets Manager or IAM Roles and rotate the exposed key immediately.",
        },
        {
          pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
          title: "Hardcoded Private Key",
          severity: "Critical",
          cwe: "CWE-798",
          category: "Hardcoded Secrets & Infrastructure",
          desc: "Unencrypted private cryptographic key block embedded in plaintext source file.",
          remediation: "Remove the private key from source control, revoke the key pair, and load keys from a secure vault at runtime.",
        },
        {
          pattern: /ghp_[A-Za-z0-9_]{36}/,
          title: "Hardcoded GitHub Personal Access Token",
          severity: "High",
          cwe: "CWE-798",
          category: "Hardcoded Secrets & Infrastructure",
          desc: "GitHub personal access token exposed in source code.",
          remediation: "Revoke the GitHub token and use short-lived GITHUB_TOKEN or OIDC federation.",
        },
        {
          pattern: /(?:https:\/\/hooks\.slack\.com\/services\/T[0-9A-Za-z]+\/B[0-9A-Za-z]+\/[0-9A-Za-z]+)/,
          title: "Hardcoded Slack Incoming Webhook",
          severity: "Medium",
          cwe: "CWE-200",
          category: "Hardcoded Secrets & Infrastructure",
          desc: "Slack incoming webhook URL exposed in source code.",
          remediation: "Store webhook URLs in environment variables or secret managers and rotate the webhook.",
        },
        {
          pattern: /(?:aws_secret_access_key|secretAccessKey|AWS_SECRET_ACCESS_KEY)["']?\s*[:=]\s*["'][A-Za-z0-9/+=]{40}["']/,
          title: "Hardcoded AWS Secret Access Key",
          severity: "Critical",
          cwe: "CWE-798",
          category: "Hardcoded Secrets & Infrastructure",
          desc: "AWS secret access key literal embedded in source.",
          remediation: "Rotate the key immediately and load credentials from the SDK default chain / IAM roles.",
        },
        {
          pattern: /["']?ACL["']?\s*[:=]\s*["']public-read(?:-write)?["']|acl\s*=\s*"public-read(?:-write)?"|block_public_(?:acls|policy)\s*=\s*false|AllUsers/,
          title: "Publicly Accessible Storage (public ACL / public access block disabled)",
          severity: "High",
          cwe: "CWE-732",
          category: "Storage & Data Exposure",
          desc: "Storage object or bucket is made world-readable/writable via a public ACL or by disabling the public access block.",
          remediation: "Use private ACLs, enable S3 Block Public Access, and serve content through signed URLs or CloudFront OAC.",
        },
        {
          pattern: /\b(?:fetch|axios(?:\.(?:get|post|put|request))?|got|requests\.(?:get|post|put)|urlopen|http\.Get|HttpClient\.[A-Za-z]+)\s*\(\s*(?:req(?:uest)?\.(?:query|body|params)|params|ctx\.query|c\.Query|input\.url)/,
          title: "User-Controlled Outbound Request (SSRF)",
          severity: "High",
          cwe: "CWE-918",
          category: "SSRF & Metadata Abuse",
          desc: "An outbound HTTP request is made with a destination taken directly from request input, allowing access to internal services and cloud metadata endpoints.",
          remediation: "Validate scheme and host against an allowlist, resolve DNS and reject private/link-local ranges (10/8, 172.16/12, 192.168/16, 169.254/16, loopback).",
        },
        {
          pattern: /["']?Action["']?\s*[:=]\s*["']\*["']|actions\s*=\s*\[\s*"\*"\s*\]/,
          title: "Wildcard IAM Action",
          severity: "High",
          cwe: "CWE-269",
          category: "IAM & Privilege",
          desc: "IAM policy grants every action (\"*\"), violating least privilege.",
          remediation: "Enumerate only the required actions and scope Resource to specific ARNs.",
        },
        {
          pattern: /169\.254\.169\.254|metadata\.google\.internal/,
          title: "Direct Cloud Instance Metadata Service (IMDS) Reference",
          severity: "Medium",
          cwe: "CWE-918",
          category: "SSRF & Metadata Abuse",
          desc: "Direct reference to cloud instance metadata endpoint detected. Ensure IMDSv2 hop-limit=1 and strict request authentication are enforced.",
          remediation: "Require IMDSv2 session tokens (X-aws-ec2-metadata-token) and block user-controlled URLs from reaching link-local 169.254.169.254.",
        },
      ];

      for (const relPath of candidateFiles) {
        const normRel = relPath.replace(/\\/g, "/");
        if (
          normRel.includes("node_modules/") ||
          normRel.includes(".git/") ||
          normRel.includes("dist/") ||
          normRel.includes("resources/rules/") ||
          normRel.endsWith("mcpServer.ts") ||
          normRel.endsWith("security-audit-report.json") ||
          normRel.endsWith("SECURITY-AUDIT-REPORT.md")
        ) {
          continue;
        }
        const absPath = path.isAbsolute(relPath) ? relPath : path.join(rootPath, relPath);
        if (!fs.existsSync(absPath)) continue;
        try {
          const content = fs.readFileSync(absPath, "utf-8");
          const lines = content.split(/\r?\n/);
          if (/aws-sdk|@aws-sdk|boto3|botocore|amazonaws\.com/.test(content)) detectedCloudProviders.push("AWS");
          if (/@google-cloud|google\.cloud|googleapis\.com|firebase-admin/.test(content)) detectedCloudProviders.push("GCP");
          if (/@azure\/|azure\.(?:storage|identity|mgmt)|windows\.net/.test(content)) detectedCloudProviders.push("Azure");
          for (let i = 0; i < lines.length; i++) {
            const lineStr = lines[i];
            for (const sec of secretRegexes) {
              if (sec.pattern.test(lineStr)) {
                findings.push({
                  id: `CS-CLOUD-${String(findingCounter++).padStart(2, "0")}`,
                  title: sec.title,
                  severity: sec.severity,
                  cvssScore: sec.severity === "Critical" ? 9.8 : sec.severity === "High" ? 7.5 : 5.3,
                  cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
                  cwe: sec.cwe,
                  category: sec.category,
                  affectedFile: normRel,
                  startLine: i + 1,
                  endLine: i + 1,
                  description: sec.desc,
                  exploitScenario: "An adversary reviewing repo history or leaked artifacts can exploit this exposure to compromise cloud infrastructure.",
                  remediation: sec.remediation,
                });
              }
            }
          }
        } catch {}
      }

      // 3. Scan for Potential SSRF & Metadata Endpoints in AST Symbols (up to 15 findings, no premature break)
      const allSyms = graphService.searchSymbols(rootPath, "", 150, "callables");
      let ssrfCount = 0;
      for (const s of allSyms) {
        if (ssrfCount >= 15) break;
        if (fileFilter && !s.path.toLowerCase().includes(fileFilter)) continue;
        if (/proxy|download|fetch|request|webhook|forward/i.test(s.name)) {
          try {
            const hierarchy = graphService.getCallHierarchy(rootPath, s.name);
            if (hierarchy.callers.length > 0 || /handler|controller|api|route/i.test(s.path)) {
              ssrfCount++;
              findings.push({
                id: `CS-CLOUD-${String(findingCounter++).padStart(2, "0")}`,
                title: `Potential SSRF / Cloud Metadata Exfiltration Vector in '${s.name}'`,
                severity: "High",
                cvssScore: 8.6,
                cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:N/A:N",
                cwe: "CWE-918",
                category: "SSRF & Metadata Abuse",
                affectedFile: s.path,
                startLine: s.startLine,
                endLine: s.endLine,
                source: `Input parameters to ${s.name}`,
                sink: "Outbound Network Client",
                description: `Function '${s.name}' handles outbound HTTP requests. If the destination URL is user-controlled without strict IP validation, attackers can query internal cloud metadata endpoints (e.g. AWS IMDS 169.254.169.254) to dump instance IAM credentials.`,
                exploitScenario: "Send a request with URL parameter pointing to 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' to extract instance role tokens.",
                remediation: "Enforce a strict domain allowlist and resolve IPs to verify they do not belong to private CIDRs (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.169.254).",
              });
            }
          } catch {}
        }
      }

      const summary = {
        totalFindings: findings.length,
        critical: findings.filter((f) => f.severity === "Critical").length,
        high: findings.filter((f) => f.severity === "High").length,
        medium: findings.filter((f) => f.severity === "Medium").length,
        low: findings.filter((f) => f.severity === "Low").length,
      };

      // 4. Optionally write report files to workspace
      if (args.generateReport !== false) {
        try {
          const reportJson = {
            version: "1.0.0",
            target: {
              workspaceName: ctx.name,
              rootPath: ctx.rootPath,
              detectedLanguages: ctx.detectedLanguages,
              cloudProviders: [...new Set(detectedCloudProviders)],
            },
            timestamp: new Date().toISOString(),
            summary,
            findings,
          };

          fs.writeFileSync(
            path.join(rootPath, "security-audit-report.json"),
            JSON.stringify(reportJson, null, 2),
            "utf-8"
          );

          let md = `# Cloud Security Audit Report\n\n`;
          md += `**Target Workspace**: \`${ctx.name}\` (${ctx.rootPath})\n`;
          md += `**Audit Date**: ${new Date().toLocaleDateString()}\n`;
          md += `**Auditor**: CodeSentinel Agentic Security Auditor\n\n`;
          md += `## Executive Summary\n\n`;
          md += `- **Detected Cloud Footprint**: ${detectedCloudProviders.length > 0 ? detectedCloudProviders.join(", ") : "Standard / Hybrid Cloud"}\n`;
          md += `- **AST Indexed Symbols**: ${stats.symbolCount} symbols across ${stats.fileCount} files\n`;
          md += `- **Total Security Findings**: ${summary.totalFindings} (Critical: ${summary.critical}, High: ${summary.high}, Medium: ${summary.medium}, Low: ${summary.low})\n\n`;
          md += `## Findings Summary Table\n\n`;
          md += `| ID | Title | Severity | CVSS | CWE | Location |\n`;
          md += `|:---|:---|:---|:---|:---|:---|\n`;
          findings.forEach((f) => {
            md += `| ${f.id} | ${f.title} | **${f.severity}** | ${f.cvssScore} | ${f.cwe} | \`${f.affectedFile}:${f.startLine}\` |\n`;
          });
          md += `\n---\n\n## Detailed Findings\n\n`;
          findings.forEach((f) => {
            md += `### [${f.id}] ${f.title}\n\n`;
            md += `- **Severity**: ${f.severity} (CVSS ${f.cvssScore})\n`;
            md += `- **CWE**: ${f.cwe} (${f.category})\n`;
            md += `- **Location**: \`${f.affectedFile}:${f.startLine}-${f.endLine}\`\n\n`;
            md += `#### Description\n${f.description}\n\n`;
            md += `#### Exploit Scenario\n${f.exploitScenario}\n\n`;
            md += `#### Recommended Remediation\n${f.remediation}\n\n`;
            md += `---\n\n`;
          });

          fs.writeFileSync(path.join(rootPath, "SECURITY-AUDIT-REPORT.md"), md, "utf-8");
        } catch (e: any) {
          console.warn("Could not generate report files:", e.message);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                workspace: ctx.name,
                cloudFootprint: [...new Set(detectedCloudProviders)],
                frameworks: detectedFrameworks,
                astGraphStats: {
                  indexed: stats.available,
                  symbols: stats.symbolCount,
                  files: stats.fileCount,
                  edges: stats.edgeCount,
                },
                summary,
                findings,
                reportsGenerated: {
                  markdown: path.join(rootPath, "SECURITY-AUDIT-REPORT.md"),
                  json: path.join(rootPath, "security-audit-report.json"),
                },
                guidance:
                  "OpenCode AI Agent can investigate individual findings with `codesentinel_find_path` for dataflow taint tracing, `codesentinel_call_hierarchy` to verify middleware, and `codesentinel_explain_flow` to generate visual attack diagrams in the Code Graph tab.",
              },
              null,
              2
            ),
          },
        ],
      };
    };

    const cloudAuditSchema = {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["all", "iam", "storage", "ssrf", "injection", "secrets", "serverless", "recon"],
          description: "Audit scope filter (default: all)",
        },
        fileFilter: { type: "string", description: "Optional path or directory filter" },
        generateReport: { type: "boolean", description: "Whether to write SECURITY-AUDIT-REPORT.md and JSON files (default: true)" },
      },
    };

    this.registerTool(
      "codesentinel_cloud_security_audit",
      "Perform an autonomous, evidence-backed security audit of the workspace codebase for cloud architectures (AWS, GCP, Azure, Cloudflare), IAM policies, storage buckets, SSRF/metadata endpoints, hardcoded credentials, and trust boundaries. Returns structured findings, CVSS scores, affected AST symbols, and optionally generates SECURITY-AUDIT-REPORT.md.",
      cloudAuditSchema,
      cloudAuditHandler
    );
    this.registerTool(
      "cloud_security_audit",
      "Perform an autonomous, evidence-backed security audit of the workspace codebase for cloud architectures (AWS, GCP, Azure, Cloudflare), IAM policies, storage buckets, SSRF/metadata endpoints, hardcoded credentials, and trust boundaries.",
      cloudAuditSchema,
      cloudAuditHandler
    );

    // =========================================================================
    // Multi-Tool Universal Vulnerability Scanner for OpenCode & AI Agent
    // =========================================================================
    const scanVulHandler: McpToolHandler = async (args, context) => {
      const ctx = context || this.resolveContext();
      const rootPath = args?.workspacePath || ctx.rootPath;
      const forceRefresh = Boolean(args?.forceRefresh);
      try {
        const scanner = VulnerabilityScanner.getInstance();
        const result = await scanner.scanProject(rootPath, undefined, forceRefresh);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Vulnerability scan error: ${err.message}` }],
          isError: true,
        };
      }
    };

    const scanVulSchema = {
      type: "object",
      properties: {
        workspacePath: { type: "string", description: "Optional project folder path (defaults to active workspace)" },
        forceRefresh: { type: "boolean", description: "Set true to bypass cache and force a complete fresh multi-engine rescan. If omitted/false, returns previous scan results from cache instantly if available." },
      },
    };

    this.registerTool(
      "codesentinel_run_vulnerability_scan",
      "Scan entire active project directory for security vulnerabilities using 4 consensus engines (Universal SAST, High-Entropy Secret Detector, Atlas AST Code Graph Dataflow, and Dependency Manifest CVE Auditor). Deeply respects .gitignore and filters media/binary files. Returns structured findings, severity counts, and tool execution breakdown.",
      scanVulSchema,
      scanVulHandler
    );
    this.registerTool(
      "run_vulnerability_scan",
      "Scan entire active project directory for security vulnerabilities using 4 consensus engines.",
      scanVulSchema,
      scanVulHandler
    );
    this.registerTool(
      "codesentinel_scan_vulnerabilities",
      "Scan entire active project directory for security vulnerabilities using 4 consensus engines (Universal SAST, High-Entropy Secret Detector, Atlas AST Code Graph Dataflow, and Dependency Manifest CVE Auditor). Deeply respects .gitignore and filters media/binary files.",
      scanVulSchema,
      scanVulHandler
    );
    this.registerTool(
      "scan_vulnerabilities",
      "Scan entire active project directory for security vulnerabilities using 4 consensus engines.",
      scanVulSchema,
      scanVulHandler
    );
    this.registerTool(
      "codesentinel_vulnerability_scan",
      "Scan entire active project directory for security vulnerabilities using 4 consensus engines.",
      scanVulSchema,
      scanVulHandler
    );
    this.registerTool(
      "analyze_security_vulnerabilities",
      "Scan entire active workspace for security vulnerabilities across 4 consensus engines (Opengrep AST SAST, Gitleaks secrets detector, Atlas AST dataflow, and OSV supply chain auditor) and automatically verify each alert with CEGAR mathematical invariant checking.",
      scanVulSchema,
      scanVulHandler
    );
    this.registerTool(
      "codesentinel_analyze_security_vulnerabilities",
      "Scan entire active workspace for security vulnerabilities across 4 consensus engines (Opengrep AST SAST, Gitleaks secrets detector, Atlas AST dataflow, and OSV supply chain auditor) and automatically verify each alert with CEGAR mathematical invariant checking.",
      scanVulSchema,
      scanVulHandler
    );

    // =========================================================================
    // Dedicated Standalone CEGAR Invariant Verification MCP Tool
    // =========================================================================
    const cegarVerifyHandler: McpToolHandler = async (args, context) => {
      const ctx = context || this.resolveContext();
      const rootPath = args?.workspacePath || ctx.rootPath;
      if (!args?.filePath || !args?.line) {
        return {
          content: [{ type: "text", text: "Error: Both 'filePath' and 'line' are required arguments for CEGAR verification." }],
          isError: true,
        };
      }
      try {
        const candidateFinding: ClubbedFinding = {
          id: args.id || `CANDIDATE-${Date.now()}`,
          title: args.title || `Vulnerability Alert at ${args.filePath}:${args.line}`,
          severity: args.severity || "High",
          cwe: args.cwe || "CWE-20",
          category: args.category || "Security",
          filePath: args.filePath,
          line: Number(args.line),
          endLine: Number(args.endLine || args.line),
          snippet: args.snippet || "",
          description: args.description || "Candidate security finding submitted for CEGAR verification",
          remediation: args.remediation || "",
          tools: ["OpenCode CEGAR Query"],
          symbolName: args.symbolName,
        };
        const verifier = CegarVerifier.getInstance();
        const result = await verifier.verifyFinding(candidateFinding, rootPath);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  target: `${args.filePath}:${args.line}`,
                  cwe: candidateFinding.cwe,
                  cegarVerdict: result.verdict,
                  confidence: result.confidence,
                  reason: result.reason,
                  mathematicalProof: result.proof,
                  invariantLearned: result.invariantLearned || null,
                  trace: result.trace || [],
                  guidance:
                    result.verdict === "DEFENDED"
                      ? "ALERT IS A PROVEN FALSE POSITIVE: Refuted by mathematical invariant or bounded sanitizer. Do not alter production code."
                      : result.verdict === "CONFIRMED"
                      ? "VULNERABILITY IS MATHEMATICALLY CONFIRMED: Proceed to remediation. Use Atlas Code Graph to trace tainted parameters."
                      : "CANDIDATE REQUIREMENT: Preserved under Fail-Open safety guarantee. Manually inspect reachability using Atlas Code Graph.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `CEGAR verification error: ${err.message}` }],
          isError: true,
        };
      }
    };

    const cegarVerifySchema = {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Relative or absolute file path of the candidate finding" },
        line: { type: "number", description: "1-indexed line number of the candidate vulnerability sink/source" },
        endLine: { type: "number", description: "Optional 1-indexed end line number" },
        cwe: { type: "string", description: "CWE identifier (e.g. CWE-22, CWE-78, CWE-798, CWE-89)" },
        title: { type: "string", description: "Optional vulnerability title or check identifier" },
        snippet: { type: "string", description: "Optional code snippet at the vulnerability location" },
        category: { type: "string", description: "Optional category (e.g. Command Injection, Path Traversal, Secrets)" },
        symbolName: { type: "string", description: "Optional function or method name containing the finding" },
        workspacePath: { type: "string", description: "Optional workspace root path (defaults to active workspace)" },
      },
      required: ["filePath", "line"],
    };

    this.registerTool(
      "codesentinel_verify_vulnerability_cegar",
      "Mathematically verify or refute a security alert or candidate code vulnerability using Counterexample-Guided Abstraction Refinement (CEGAR). Evaluates deterministic fast-path invariants, Opengrep Generic AST taint flow, and Atlas Code Graph reachability. Returns CONFIRMED, DEFENDED, or CANDIDATE verdict with proof.",
      cegarVerifySchema,
      cegarVerifyHandler
    );
    this.registerTool(
      "verify_vulnerability_cegar",
      "Mathematically verify or refute a security alert or candidate code vulnerability using Counterexample-Guided Abstraction Refinement (CEGAR). Returns CONFIRMED, DEFENDED, or CANDIDATE verdict with proof.",
      cegarVerifySchema,
      cegarVerifyHandler
    );

    // =========================================================================
    // Autonomous Multi-Repo & Git Code Graph Synchronization Tools
    // =========================================================================

    // Tool: Multi-repo status
    this.registerTool(
      "codesentinel_multi_repo_status",
      "Inspect all managed repositories, active workspace, current Git branches, working tree dirty status, and Atlas Code Graph index state.",
      {
        type: "object",
        properties: {},
      },
      async (_args, context) => {
        const multiRepo = MultiRepoManager.getInstance();
        await multiRepo.syncWithWorkspace();
        const repos = multiRepo.getRepositories();
        const active = multiRepo.getActiveRepo() || context;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  activeRepository: active ? (typeof active === "object" && "path" in active ? active.path : (active as any).rootPath) : null,
                  totalRepositories: repos.length,
                  repositories: repos,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Tool: Switch active repository
    this.registerTool(
      "codesentinel_switch_repo",
      "Switch the active repository context for CodeSentinel, code graph navigation, scans, and AI agent commands.",
      {
        type: "object",
        properties: {
          repoPath: { type: "string", description: "Absolute path or directory name of repository to activate" },
        },
        required: ["repoPath"],
      },
      async (args) => {
        const multiRepo = MultiRepoManager.getInstance();
        const switched = multiRepo.setActiveRepo(args.repoPath);
        if (!switched) {
          try {
            const added = await multiRepo.addRepository(args.repoPath);
            return {
              content: [{ type: "text", text: `Added and activated repository: ${added.name} (${added.path})` }],
            };
          } catch (e: any) {
            return {
              content: [{ type: "text", text: `Failed to switch repository: ${e.message}` }],
              isError: true,
            };
          }
        }
        return {
          content: [{ type: "text", text: `Switched active repository to: ${switched.name} (${switched.path}) [Branch: ${switched.currentBranch}]` }],
        };
      }
    );

    // Tool: Git Code Graph Auto-Sync
    this.registerTool(
      "codesentinel_git_sync_graph",
      "Synchronize Atlas Code Graph with current Git branch changes. Fast-restores branch graph snapshots when available and delta-indexes newly modified files.",
      {
        type: "object",
        properties: {
          repoPath: { type: "string", description: "Optional repository path (defaults to active repository)" },
          branch: { type: "string", description: "Optional target branch name" },
        },
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        const gitSync = GitSyncService.getInstance();
        const res = await gitSync.syncCodeGraph(repoPath, args?.branch);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(res, null, 2),
            },
          ],
        };
      }
    );

    // =========================================================================
    // Atlassian Jira Integration Tools
    // =========================================================================

    // Tool: List Jira tickets
    this.registerTool(
      "codesentinel_jira_list_tickets",
      "List Jira tickets assigned or available for development. Supports status filters ('To Do', 'In Progress', 'In Review', 'Done') and text queries.",
      {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by ticket status (e.g. 'To Do', 'In Progress', 'All')" },
          query: { type: "string", description: "Optional search query" },
        },
      },
      async (args) => {
        const jira = JiraService.getInstance();
        const tickets = await jira.listTickets({ status: args?.status, query: args?.query });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  jiraMode: jira.getMode(),
                  note: jira.getMode() === "disabled" ? "Jira is disabled (codesentinel.jira.mode). Start work from a custom task or enable manual/harness mode." : undefined,
                  count: tickets.length,
                  tickets,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Tool: Get single Jira ticket
    this.registerTool(
      "codesentinel_jira_get_ticket",
      "Retrieve full details, acceptance criteria, components, and suggested branch name for a specific Jira ticket.",
      {
        type: "object",
        properties: {
          ticketKey: { type: "string", description: "Jira ticket key (e.g. SEC-101, AUTH-204)" },
        },
        required: ["ticketKey"],
      },
      async (args) => {
        const jira = JiraService.getInstance();
        const ticket = await jira.getTicket(args.ticketKey);
        if (!ticket) {
          return {
            content: [{ type: "text", text: `Ticket '${args.ticketKey}' not found.` }],
            isError: true,
          };
        }
        const suggestedBranch = jira.generateBranchName(ticket);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...ticket, suggestedBranch }, null, 2),
            },
          ],
        };
      }
    );

    // Tool: Update Jira ticket status & comment
    this.registerTool(
      "codesentinel_jira_update_ticket",
      "Update a Jira ticket status (e.g. 'In Progress', 'In Review', 'Done') and append work log comments.",
      {
        type: "object",
        properties: {
          ticketKey: { type: "string", description: "Jira ticket key (e.g. SEC-101)" },
          status: { type: "string", description: "Target status name" },
          comment: { type: "string", description: "Optional comment or work summary to post" },
        },
        required: ["ticketKey", "status"],
      },
      async (args) => {
        const jira = JiraService.getInstance();
        const res = await jira.updateTicketStatus(args.ticketKey, args.status, args.comment);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(res, null, 2),
            },
          ],
        };
      }
    );

    // =========================================================================
    // Autonomous Developer & Security Workflow Orchestration Tools
    // =========================================================================

    // Tool: Start Ticket Workflow (runs in the background; poll with codesentinel_workflow_status)
    this.registerTool(
      "codesentinel_workflow_start_ticket",
      "Start the autonomous ticket workflow in the background: cut a feature branch (isolated worktree), planner agent, developer agent, changed-files security scan, tester/fix loop, stage+API and Playwright tests, then commit and (after approval or when autoPush is on) push the branch. Returns immediately; poll codesentinel_workflow_status. Several tickets can run in parallel.",
      {
        type: "object",
        properties: {
          ticketKey: { type: "string", description: "Jira ticket key (e.g. SEC-101)" },
          repoPath: { type: "string", description: "Repository path (defaults to the active repository)" },
          baseBranch: { type: "string", description: "Branch to cut from (defaults to the repo's first configured base branch)" },
          branchName: { type: "string", description: "Exact branch name; overrides the template" },
          branchTemplate: { type: "string", description: "Branch naming template, e.g. feature/${ticketKey}-${slug}" },
          harness: { type: "string", enum: ["claude-code", "gemini-antigravity", "opencode"], description: "Agent harness for headless steps" },
          taskSummary: { type: "string", description: "Custom task: when set, no Jira lookup is done. Use a key like TASK-1 for ticketKey." },
          taskDescription: { type: "string", description: "Custom task details / acceptance criteria" },
          requirePlanApproval: { type: "boolean", description: "Pause after the plan until codesentinel_workflow_resume" },
          autoPush: { type: "boolean", description: "Push automatically when all gates pass (default: wait for approval)" },
        },
        required: ["ticketKey"],
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        try {
          const wf = await WorkflowEngine.getInstance().start(
            args.ticketKey, repoPath,
            { baseBranch: args.baseBranch, targetBranch: args.branchName, branchTemplate: args.branchTemplate,
              harness: args.harness, requirePlanApproval: args.requirePlanApproval, autoPush: args.autoPush,
              ticket: args.taskSummary ? { key: String(args.ticketKey).toUpperCase(), summary: String(args.taskSummary).slice(0, 200), description: String(args.taskDescription || "").slice(0, 8000), status: "To Do", priority: "Medium", issueType: "Task", labels: [], components: [] } : undefined },
            false
          );
          return { content: [{ type: "text", text: JSON.stringify({ started: true, id: wf.id, branch: wf.targetBranch, base: wf.baseBranch, note: "Poll codesentinel_workflow_status for progress." }, null, 2) }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Could not start workflow: ${e.message}` }], isError: true };
        }
      }
    );

    this.registerTool(
      "codesentinel_workflow_status",
      "Status of ticket workflows: step states, logs, plan, scan/test results, and what (if anything) is awaiting approval. Omit ticketKey to list all workflows of the repository.",
      {
        type: "object",
        properties: {
          ticketKey: { type: "string" },
          repoPath: { type: "string" },
        },
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        const engine = WorkflowEngine.getInstance();
        const list = args?.ticketKey ? [engine.getWorkflow(args.ticketKey, repoPath)].filter(Boolean) : engine.loadRepo(repoPath);
        if (list.length === 0) return { content: [{ type: "text", text: "No workflows found." }] };
        const out = list.map((w: any) => args?.ticketKey ? w : {
          id: w.id, status: w.status, awaiting: w.awaiting, branch: w.targetBranch, iteration: w.iteration,
          steps: w.steps.map((s: any) => `${s.name}: ${s.status}${s.summary ? ` - ${s.summary}` : ""}`),
        });
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
    );

    this.registerTool(
      "codesentinel_workflow_resume",
      "Approve a paused workflow (plan approval or push approval) or retry a failed one from its failed step.",
      { type: "object", properties: { ticketKey: { type: "string" }, repoPath: { type: "string" } }, required: ["ticketKey"] },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        try {
          const engine = WorkflowEngine.getInstance();
          const wf = engine.getWorkflow(args.ticketKey, repoPath);
          if (!wf) return { content: [{ type: "text", text: "No such workflow." }], isError: true };
          void engine.resume(args.ticketKey, repoPath);
          return { content: [{ type: "text", text: `Resumed ${wf.id} (was ${wf.status}${wf.awaiting ? `, awaiting ${wf.awaiting}` : ""}). Poll codesentinel_workflow_status.` }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: e.message }], isError: true };
        }
      }
    );

    this.registerTool(
      "codesentinel_workflow_cancel",
      "Cancel a running or paused ticket workflow.",
      { type: "object", properties: { ticketKey: { type: "string" }, repoPath: { type: "string" } }, required: ["ticketKey"] },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        const ok = WorkflowEngine.getInstance().cancel(args.ticketKey, repoPath);
        return { content: [{ type: "text", text: ok ? "Cancel requested." : "No such workflow." }], isError: !ok };
      }
    );

    this.registerTool(
      "codesentinel_workflow_skip",
      "Skip the failed stage of a ticket workflow (for example a stuck developer step) and continue with the next stage. Not allowed at the push gate.",
      { type: "object", properties: { ticketKey: { type: "string" }, repoPath: { type: "string" } }, required: ["ticketKey"] },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        try {
          void WorkflowEngine.getInstance().skip(args.ticketKey, repoPath).catch(() => {});
          return { content: [{ type: "text", text: "Skipping the failed stage and continuing. Poll codesentinel_workflow_status." }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: e.message }], isError: true };
        }
      }
    );

    this.registerTool(
      "codesentinel_workflow_next_step",
      "Advance a stopped, paused, or failed ticket workflow to the next step. If a step failed (e.g. developer agent finished without changing files), marks it completed and moves to the next stage.",
      { type: "object", properties: { ticketKey: { type: "string" }, repoPath: { type: "string" } }, required: ["ticketKey"] },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        try {
          void WorkflowEngine.getInstance().nextStep(args.ticketKey, repoPath).catch(() => {});
          return { content: [{ type: "text", text: "Advancing to the next step. Poll codesentinel_workflow_status." }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: e.message }], isError: true };
        }
      }
    );

    this.registerTool(
      "codesentinel_workflow_discard",
      "Undo a ticket workflow: stop it, remove its worktree, delete the LOCAL feature branch and the workflow record. Destructive: requires confirm=true. Never deletes remote branches, protected branches, or uncommitted work in the main checkout.",
      { type: "object", properties: { ticketKey: { type: "string" }, repoPath: { type: "string" }, confirm: { type: "boolean", description: "Must be true" } }, required: ["ticketKey", "confirm"] },
      async (args, context) => {
        if (args?.confirm !== true) return { content: [{ type: "text", text: "Refusing: pass confirm=true to discard the workflow and delete its branch." }], isError: true };
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        try {
          const r = await WorkflowEngine.getInstance().discard(args.ticketKey, repoPath);
          return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: e.message }], isError: true };
        }
      }
    );

    // Tool: Plan Ticket (Planner Agent, read-only)
    this.registerTool(
      "codesentinel_workflow_plan_ticket",
      "Planner agent only: reads the ticket and the code graph and returns an implementation plan. Makes no branch and no edits.",
      {
        type: "object",
        properties: {
          ticketKey: { type: "string", description: "Jira ticket key (e.g. SEC-101)" },
          repoPath: { type: "string", description: "Optional repository folder path" },
        },
        required: ["ticketKey"],
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        try {
          return { content: [{ type: "text", text: await WorkflowEngine.getInstance().planOnly(args.ticketKey, repoPath) }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: e.message }], isError: true };
        }
      }
    );

    this.registerTool(
      "codesentinel_repo_config",
      "Read or update per-repository CodeSentinel configuration: branch naming template, allowed base branches, branch mode (auto/ask), test commands, stage deploy mode/command/base URL, and Playwright/API testing toggles.",
      {
        type: "object",
        properties: {
          repoPath: { type: "string" },
          set: { type: "object", description: "Fields to update (omit to just read)" },
        },
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        const cfg = args?.set ? setRepoConfig(repoPath, args.set) : getRepoConfig(repoPath);
        return { content: [{ type: "text", text: JSON.stringify({ repoPath, config: cfg }, null, 2) }] };
      }
    );

    this.registerTool(
      "codesentinel_test_status",
      "Last recorded unit / stage-API / Playwright results for a repository (pass, fail, skipped counts) without running anything.",
      { type: "object", properties: { repoPath: { type: "string" } } },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        const s = TestRunnerService.getInstance().getSummary(repoPath);
        const slim = (r: any) => r && { status: r.status, passed: r.passedCount, failed: r.failedCount, skipped: r.skippedCount, total: r.totalTests, ms: r.durationMs, note: r.status === "passed" ? undefined : (r.error || r.output?.slice(0, 200)) };
        return { content: [{ type: "text", text: JSON.stringify({ repo: s.repoName, overall: s.overallStatus, unit: slim(s.unit), stageApi: slim(s.stageApi), playwright: slim(s.playwright), lastRun: s.lastRunTimestamp }, null, 2) }] };
      }
    );

    // Tool: Incremental Diff Security Scan
    this.registerTool(
      "codesentinel_scan_git_diff",
      "Scan ONLY the files modified on the current branch / git diff against base branch for static security vulnerabilities (SAST, secrets, AST dataflow). Lightning fast compared to full repository scan.",
      {
        type: "object",
        properties: {
          repoPath: { type: "string", description: "Optional repository folder path" },
          baseBranch: { type: "string", description: "Base branch to diff against (default: main)" },
        },
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        const gitSync = GitSyncService.getInstance();
        const base = args?.baseBranch || "main";
        const modifiedFiles = (await gitSync.getModifiedFilesDiff(repoPath, base)).filter((f) => !f.startsWith(".codesentinel/"));
        const scanner = VulnerabilityScanner.getInstance();
        // File-scoped, always fresh: never served from the full-scan cache
        const result = modifiedFiles.length
          ? await scanner.scanProject(repoPath, undefined, true, { onlyFiles: modifiedFiles })
          : { findings: [] as ClubbedFinding[] };
        const diffFindings = result.findings;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { baseBranch: base, modifiedFilesCount: modifiedFiles.length, modifiedFiles, diffFindingsCount: diffFindings.length, findings: diffFindings },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Tool: Verify Candidate Finding with CEGAR & Generate Unit Tests
    this.registerTool(
      "codesentinel_verify_and_test_finding",
      "Evaluate a candidate security finding: evaluates False Positive vs Genuine using CEGAR formal proof, refutes false alarms, and generates unit test assertions for genuine vulnerabilities.",
      {
        type: "object",
        properties: {
          filePath: { type: "string", description: "File path containing the vulnerability" },
          line: { type: "number", description: "Line number" },
          cwe: { type: "string", description: "CWE identifier (e.g. CWE-78, CWE-89, CWE-918)" },
          title: { type: "string", description: "Vulnerability title" },
          snippet: { type: "string", description: "Code snippet" },
          symbolName: { type: "string", description: "Function or method name" },
          repoPath: { type: "string", description: "Optional repository path" },
        },
        required: ["filePath", "line"],
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        const finding: ClubbedFinding = {
          id: `FIND-${Date.now()}`,
          title: args.title || `Vulnerability check at ${args.filePath}:${args.line}`,
          severity: "High",
          cwe: args.cwe || "CWE-20",
          category: "Security",
          filePath: args.filePath,
          line: Number(args.line),
          endLine: Number(args.line),
          snippet: args.snippet || "",
          description: "Candidate security finding for formal verification",
          remediation: "",
          tools: ["CodeSentinel CEGAR Tester"],
          symbolName: args.symbolName,
        };

        const verifier = CegarVerifier.getInstance();
        const ver = await verifier.verifyFinding(finding, repoPath);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  verdict: ver.verdict,
                  isFalsePositive: ver.verdict === "DEFENDED",
                  isGenuine: ver.verdict === "CONFIRMED",
                  confidence: ver.confidence,
                  proof: ver.proof,
                  reason: ver.reason,
                  trace: ver.trace,
                  testGuidance: ver.verdict === "CONFIRMED" ? `Write a regression test that feeds attacker-controlled input to the code at ${finding.filePath}:${finding.line} (${finding.cwe}) and asserts it is rejected or neutralized; it must fail before the fix and pass after.` : undefined,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Tool: Manage Secrets for Stage & API Testing
    this.registerTool(
      "codesentinel_secrets_manage",
      "Store, check existence of, list, or delete stage API testing secrets (values are never returned; prefer the CodeSentinel UI to enter them so they stay out of chat history), tokens, and deployment credentials (scoped per ticket, per repo, or globally).",
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get", "set", "list", "delete"], description: "Action to perform" },
          key: { type: "string", description: "Secret identifier (e.g. stage_api_key, auth_token)" },
          value: { type: "string", description: "Secret value (required for 'set')" },
          scope: { type: "string", enum: ["ticket", "repo", "global"], description: "Secret scope (default: global)" },
          scopeId: { type: "string", description: "Scope identifier (ticket key like SEC-101 or repo name)" },
          description: { type: "string", description: "Optional description" },
        },
        required: ["action"],
      },
      async (args) => {
        const vault = SecretVault.getInstance();
        const scope = args?.scope || "global";
        const scopeId = args?.scopeId;

        switch (args.action) {
          case "get": {
            if (!args.key) return { content: [{ type: "text", text: "Key required for 'get'" }], isError: true };
            // Existence only: secret values are never returned to an agent.
            const val = await vault.getSecret(args.key, scope, scopeId);
            return { content: [{ type: "text", text: val ? `Secret '${args.key}' exists (value hidden).` : "Secret not found." }] };
          }
          case "set": {
            if (!args.key || !args.value) return { content: [{ type: "text", text: "Both key and value required for 'set'" }], isError: true };
            await vault.setSecret(args.key, args.value, scope, scopeId, args.description);
            return {
              content: [{ type: "text", text: `Secret '${args.key}' stored securely in scope '${scope}${scopeId ? `:${scopeId}` : ""}'.` }],
            };
          }
          case "delete": {
            if (!args.key) return { content: [{ type: "text", text: "Key required for 'delete'" }], isError: true };
            await vault.deleteSecret(args.key, scope, scopeId);
            return {
              content: [{ type: "text", text: `Secret '${args.key}' deleted from scope '${scope}'.` }],
            };
          }
          case "list":
          default: {
            const list = await vault.listSecrets(scope, scopeId);
            return {
              content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
            };
          }
        }
      }
    );

    // Tool: Run Tests (Unit, Stage API, Playwright)
    this.registerTool(
      "codesentinel_run_tests",
      "Run unit tests, stage API endpoint validation, or Playwright frontend E2E browser tests for a repository, reporting pass/fail stats and durations.",
      {
        type: "object",
        properties: {
          suite: { type: "string", enum: ["all", "unit", "stage_api", "playwright"], description: "Test suite to execute" },
          repoPath: { type: "string", description: "Optional repository path" },
          ticketKey: { type: "string", description: "Optional ticket key context for stage testing secrets" },
        },
        required: ["suite"],
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        const testRunner = TestRunnerService.getInstance();

        switch (args.suite) {
          case "unit": {
            const res = await testRunner.runUnitTests(repoPath);
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
          }
          case "stage_api": {
            const res = await testRunner.runStageApiTests(repoPath, args?.ticketKey);
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
          }
          case "playwright": {
            const res = await testRunner.runPlaywrightTests(repoPath);
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
          }
          case "all":
          default: {
            const summary = await testRunner.runAllTests(repoPath, args?.ticketKey);
            return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
          }
        }
      }
    );

    // Tool: Push Ticket Branch
    this.registerTool(
      "codesentinel_push_ticket_branch",
      "Safely push a feature branch to remote (blocking main/production release branches) and append PR link & test audit to Jira.",
      {
        type: "object",
        properties: {
          ticketKey: { type: "string", description: "Jira ticket key" },
          branchName: { type: "string", description: "Branch name to push" },
          repoPath: { type: "string", description: "Optional repository path" },
        },
        required: ["ticketKey", "branchName"],
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        const gitSync = GitSyncService.getInstance();
        const res = await gitSync.pushBranch(repoPath, args.branchName);

        if (res.success) {
          await JiraService.getInstance().updateTicketStatus(
            args.ticketKey,
            "In Review",
            `Branch '${args.branchName}' pushed to remote. Ready for code review.`
          );
        }

        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
          isError: !res.success,
        };
      }
    );

    // Tool: Launch Agent Terminal
    this.registerTool(
      "codesentinel_launch_agent_terminal",
      "Launch an interactive AI coding terminal (Claude Code, Antigravity / Gemini CLI, or OpenCode) configured with workspace MCP tools and ticket context.",
      {
        type: "object",
        properties: {
          harness: { type: "string", enum: ["claude-code", "gemini-antigravity", "opencode"], description: "AI coding harness to launch" },
          repoPath: { type: "string", description: "Optional repository folder path" },
          ticketKey: { type: "string", description: "Optional Jira ticket key context" },
          prompt: { type: "string", description: "Initial instruction/prompt to send to the agent" },
        },
      },
      async (args, context) => {
        const ctx = context || this.resolveContext();
        const repoPath = args?.repoPath || MultiRepoManager.getInstance().getActiveRepoPath() || ctx.rootPath;
        const harness = (args?.harness as AgentHarnessType) || "claude-code";

        try {
          const launcher = AgentTerminalLauncher.getInstance();
          let ticketCtx: any = undefined;
          if (args?.ticketKey) {
            const ticket = await JiraService.getInstance().getTicket(args.ticketKey);
            if (ticket) {
              const currentBranch = await GitSyncService.getInstance().getCurrentBranch(repoPath);
              ticketCtx = { key: ticket.key, summary: ticket.summary, branch: currentBranch };
            }
          }

          launcher.launchAgentTerminal(repoPath, harness, args?.prompt, ticketCtx);
          return {
            content: [{ type: "text", text: `Launched ${harness} terminal in ${repoPath}` }],
          };
        } catch (e: any) {
          return {
            content: [{ type: "text", text: `Failed to launch agent terminal (requires the CodeSentinel VS Code extension host): ${e.message}` }],
            isError: true,
          };
        }
      }
    );
  }
}
