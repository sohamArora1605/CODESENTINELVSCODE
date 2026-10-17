export type BackendMode = "local" | "cloud" | "local-docker";

export interface WorkspaceContext {
  rootPath: string;
  name: string;
  detectedLanguages: string[];
  hasGit: boolean;
  hasOpenCodeConfig: boolean;
  activeFilePath?: string;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
}

export interface OpenCodeMcpConfig {
  $schema?: string;
  mcp: {
    [serverName: string]: {
      type: "local" | "remote";
      command?: string[];
      url?: string;
      enabled: boolean;
      environment?: Record<string, string>;
    };
  };
}
