import * as vscode from "vscode";
import * as path from "path";
import { WorkspaceManager } from "./workspace/workspaceManager";
import { OpenCodeLauncher } from "./opencode/opencodeLauncher";
import { CodeSentinelMcpServer } from "./mcp/mcpServer";
import { SidebarProvider } from "./ui/sidebarProvider";
import { DockerClient } from "./docker/dockerClient";

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  console.log("CodeSentinel extension activating...");

  const workspaceManager = WorkspaceManager.getInstance();
  workspaceManager.registerWatchers(context);

  const opencodeLauncher = OpenCodeLauncher.getInstance();
  const mcpServer = new CodeSentinelMcpServer("codesentinel-internal", "0.1.0");
  mcpServer.setWorkspaceContextResolver(() => workspaceManager.getContext());

  // Register Webview View Provider for Activity Bar Sidebar
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    workspaceManager,
    opencodeLauncher,
    mcpServer
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewType,
      sidebarProvider
    )
  );

  // Status Bar Indicator
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "codesentinel.launchOpenCodeTerminal";
  context.subscriptions.push(statusBarItem);
  // Auto-sync MCP configuration for OpenCode
  let lastSyncedRoot: string | null = null;
  const autoSyncMcp = async (rootPath: string) => {
    if (lastSyncedRoot === rootPath) {
      return;
    }
    try {
      const config = vscode.workspace.getConfiguration("codesentinel");
      const backendMode = config.get<string>("backendMode", "local-docker");
      const mcpScriptPath = path.join(context.extensionUri.fsPath, "dist", "mcp-server.js");
      await opencodeLauncher.syncWorkspaceConfig(rootPath, mcpScriptPath, {
        useDocker: backendMode === "local-docker",
        imageName: config.get<string>("dockerImage", "codesentinel/core:latest"),
      });
      lastSyncedRoot = rootPath;
    } catch (e: any) {
      console.warn("Auto-syncing OpenCode MCP config skipped:", e?.message);
    }
  };

  const initialRoot = workspaceManager.getActiveWorkspaceRoot();
  if (initialRoot) {
    autoSyncMcp(initialRoot);
  }

  workspaceManager.onDidChangeWorkspace(() => {
    updateStatusBar(workspaceManager);
    const root = workspaceManager.getActiveWorkspaceRoot();
    if (root) {
      autoSyncMcp(root);
    }
  });

  const ensureWorkspaceFolder = async (): Promise<string | null> => {
    const activeWorkspace = workspaceManager.getActiveWorkspaceRoot();
    if (activeWorkspace) {
      return activeWorkspace;
    }
    const action = "Open Folder";
    const selection = await vscode.window.showErrorMessage(
      "CodeSentinel: Open a project folder before launching OpenCode.",
      action
    );
    if (selection === action) {
      await vscode.commands.executeCommand("vscode.openFolder");
    }
    return null;
  };

  // 1. Command: Launch OpenCode in Active Workspace
  const cmdLaunchTerminal = vscode.commands.registerCommand(
    "codesentinel.launchOpenCodeTerminal",
    async () => {
      const activeWorkspace = await ensureWorkspaceFolder();
      if (!activeWorkspace) return;
      opencodeLauncher.launchTerminal(activeWorkspace);
    }
  );

  // 2. Command: Launch OpenCode Web UI (External Browser)
  const cmdLaunchWeb = vscode.commands.registerCommand(
    "codesentinel.launchOpenCodeWeb",
    async () => {
      const activeWorkspace = await ensureWorkspaceFolder();
      if (!activeWorkspace) return;
      const serverUrl = opencodeLauncher.getWebServerUrl();
      if (serverUrl) {
        vscode.env.openExternal(vscode.Uri.parse(serverUrl));
      } else {
        opencodeLauncher.launchWeb(activeWorkspace);
      }
    }
  );

  // 2b. Command: Focus Security Agent inside Sidebar (Never opens separate editor tab)
  const cmdOpenEmbeddedWeb = vscode.commands.registerCommand(
    "codesentinel.openEmbeddedWeb",
    async () => {
      const activeWorkspace = await ensureWorkspaceFolder();
      if (!activeWorkspace) return;
      await vscode.commands.executeCommand("codesentinel.controlCenter.focus");
      if (!opencodeLauncher.isWebRunning()) {
        await opencodeLauncher.startWebProcess(activeWorkspace);
        sidebarProvider.updateWebviewContent();
      }
    }
  );

  // 2c. Command Alias: codeSentinel.openOpenCode
  const cmdOpenOpenCode = vscode.commands.registerCommand(
    "codeSentinel.openOpenCode",
    async () => {
      const activeWorkspace = await ensureWorkspaceFolder();
      if (!activeWorkspace) return;
      await vscode.commands.executeCommand("codesentinel.controlCenter.focus");
      if (!opencodeLauncher.isWebRunning()) {
        await opencodeLauncher.startWebProcess(activeWorkspace);
        sidebarProvider.updateWebviewContent();
      }
    }
  );

  // 3. Command: Start OpenCode Headless Server
  const cmdStartServer = vscode.commands.registerCommand(
    "codesentinel.startOpenCodeServer",
    async () => {
      const activeWorkspace = workspaceManager.getActiveWorkspaceRoot();
      if (!activeWorkspace) {
        vscode.window.showErrorMessage(
          "CodeSentinel: No active workspace found. Open a repository folder first."
        );
        return;
      }
      const result = await opencodeLauncher.startHeadlessServer(activeWorkspace);
      vscode.window.showInformationMessage(
        `CodeSentinel: OpenCode headless server started on port ${result.port}.`
      );
      sidebarProvider.updateWebviewContent();
    }
  );

  // 4. Command: Sync OpenCode MCP Configuration
  const cmdSyncConfig = vscode.commands.registerCommand(
    "codesentinel.syncOpenCodeConfig",
    async () => {
      const activeWorkspace = workspaceManager.getActiveWorkspaceRoot();
      if (!activeWorkspace) {
        vscode.window.showErrorMessage(
          "CodeSentinel: No active workspace found. Open a repository folder first."
        );
        return;
      }
      const mcpScriptPath = path.join(
        context.extensionUri.fsPath,
        "dist",
        "mcp-server.js"
      );
      try {
        const config = vscode.workspace.getConfiguration("codesentinel");
        const backendMode = config.get<string>("backendMode", "local-docker");
        const configPath = await opencodeLauncher.syncWorkspaceConfig(
          activeWorkspace,
          mcpScriptPath,
          {
            useDocker: backendMode === "local-docker",
            imageName: config.get<string>("dockerImage", "codesentinel/core:latest"),
          }
        );
        const modeDesc = backendMode === "local-docker" ? "Docker container" : "Host runtime";
        vscode.window.showInformationMessage(
          `CodeSentinel: Linked MCP server (${modeDesc}) in ${configPath}`
        );
        workspaceManager.refreshContext();
        sidebarProvider.updateWebviewContent();
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Failed to sync OpenCode configuration: ${err.message}`
        );
      }
    }
  );

  // 5. Command: Toggle Backend Mode
  const cmdToggleBackend = vscode.commands.registerCommand(
    "codesentinel.toggleBackendMode",
    async () => {
      const config = vscode.workspace.getConfiguration("codesentinel");
      const current = config.get<string>("backendMode", "local-docker");
      const updated = current === "local-docker" ? "cloud" : "local-docker";
      await config.update(
        "backendMode",
        updated,
        vscode.ConfigurationTarget.Global
      );
      vscode.window.showInformationMessage(
        `CodeSentinel: Backend execution mode switched to ${updated}.`
      );
      sidebarProvider.updateWebviewContent();
    }
  );

  // 6. Command: Deploy / Build Unified Container Image
  const cmdBuildContainer = vscode.commands.registerCommand(
    "codesentinel.buildContainer",
    async () => {
      const dockerClient = DockerClient.getInstance();
      const avail = await dockerClient.checkDockerAvailability();
      if (!avail.available) {
        vscode.window.showErrorMessage(
          `CodeSentinel: Docker is not running or not installed. Error: ${avail.error}`
        );
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "CodeSentinel: Deploying unified container (codesentinel/core:latest)...",
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "Packaging Atlas engine, OpenCode, and MCP tools..." });
          const res = await dockerClient.buildBackendImage(
            context.extensionUri.fsPath,
            "codesentinel/core:latest"
          );
          if (res.success) {
            vscode.window.showInformationMessage(
              "CodeSentinel: Unified container image (codesentinel/core:latest) deployed successfully!"
            );
          } else {
            vscode.window.showErrorMessage(
              `CodeSentinel: Container deployment failed: ${res.output}`
            );
          }
          sidebarProvider.updateWebviewContent();
        }
      );
    }
  );

  // 7. Command: Focus 360° Code Graph in Sidebar
  const cmdOpenGraph = vscode.commands.registerCommand(
    "codesentinel.openCodeGraph",
    async () => {
      await vscode.commands.executeCommand("codesentinel.controlCenter.focus");
      sidebarProvider.selectTab("tab-graph");
    }
  );

  // 8. Command: Index Codebase with Atlas
  const cmdIndexAtlas = vscode.commands.registerCommand(
    "codesentinel.indexAtlas",
    async () => {
      const activeWorkspace = workspaceManager.getActiveWorkspaceRoot();
      if (!activeWorkspace) {
        vscode.window.showErrorMessage("CodeSentinel: Please open a project repository folder first.");
        return;
      }
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "CodeSentinel: Indexing codebase with Atlas...",
          cancellable: false,
        },
        async () => {
          const res = await opencodeLauncher.indexWithAtlas(activeWorkspace);
          if (res.success) {
            vscode.window.showInformationMessage("CodeSentinel: Atlas code graph indexed successfully!");
          } else {
            vscode.window.showErrorMessage(`CodeSentinel: Atlas indexing failed: ${res.output}`);
          }
          sidebarProvider.updateWebviewContent();
          sidebarProvider.selectTab("tab-graph");
        }
      );
    }
  );

  context.subscriptions.push(
    cmdLaunchTerminal,
    cmdLaunchWeb,
    cmdOpenEmbeddedWeb,
    cmdOpenOpenCode,
    cmdStartServer,
    cmdSyncConfig,
    cmdToggleBackend,
    cmdBuildContainer,
    cmdOpenGraph,
    cmdIndexAtlas
  );

  // Auto-launch OpenCode if user configured it
  const autoLaunch = vscode.workspace
    .getConfiguration("codesentinel")
    .get<boolean>("autoLaunchOpenCode", false);

  if (autoLaunch) {
    const root = workspaceManager.getActiveWorkspaceRoot();
    if (root) {
      opencodeLauncher.launchTerminal(root);
    }
  }

  console.log("CodeSentinel extension activated successfully.");
}

function updateStatusBar(workspaceManager: WorkspaceManager): void {
  const ctx = workspaceManager.getContext();
  if (ctx) {
    statusBarItem.text = `$(shield) CodeSentinel: ${ctx.name}`;
    statusBarItem.tooltip = `Active Workspace: ${ctx.rootPath}\nClick to launch OpenCode terminal`;
    statusBarItem.show();
  } else {
    statusBarItem.text = `$(shield) CodeSentinel (No Workspace)`;
    statusBarItem.tooltip = "Open a repository workspace folder to begin";
    statusBarItem.show();
  }
}

export function deactivate() {
  const launcher = OpenCodeLauncher.getInstance();
  launcher.stopHeadlessServer();
}
