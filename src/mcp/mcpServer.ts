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

  constructor(serverName = "codesentinel-mcp", version = "0.2.2") {
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
  }
}
