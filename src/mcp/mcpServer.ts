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

  constructor(serverName = "codesentinel-mcp", version = "0.1.0") {
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
    inputSchema: Tool["inputSchema"],
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
    };
    try {
      const files = fs.readdirSync(rootPath, { withFileTypes: true });
      for (const f of files) {
        if (f.isFile()) {
          const ext = path.extname(f.name).toLowerCase();
          if (extMap[ext]) exts.add(extMap[ext]);
        }
      }
    } catch {}
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
      "Inspect Atlas code graph database state (.atlas/atlas.db) for the active workspace, reporting whether the graph index is ready.",
      {
        type: "object",
        properties: {},
      },
      async (_args, context) => {
        const ctx = context || this.resolveContext();
        const dbPath = path.join(ctx.rootPath, ".atlas", "atlas.db");
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
  }
}
