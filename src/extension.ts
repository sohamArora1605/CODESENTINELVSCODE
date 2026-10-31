import * as vscode from "vscode";
import * as path from "path";
import { WorkspaceManager } from "./workspace/workspaceManager";
import { OpenCodeLauncher } from "./opencode/opencodeLauncher";
import { CodeSentinelMcpServer } from "./mcp/mcpServer";
import { SidebarProvider } from "./ui/sidebarProvider";
import { DependencyManager } from "./services/dependencyManager";
import { SecurityToolManager } from "./scanner/securityToolManager";

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  console.log("CodeSentinel extension activating...");

  // Initialize self-contained extension storage directory
  const storagePath = context.globalStorageUri.fsPath;
  SecurityToolManager.getInstance().setStoragePath(storagePath);
  SecurityToolManager.getInstance().setExtensionPath(context.extensionUri.fsPath);
  DependencyManager.getInstance().setStoragePath(storagePath);

  // Auto-bootstrap host-native dependencies (OpenCode CLI, Atlas Semantic Engine, & SAST tools)
  DependencyManager.getInstance().ensureDependencies(context).catch((err) => {
    console.warn("Dependency auto-check warning:", err?.message);
  });

  const workspaceManager = WorkspaceManager.getInstance();
  workspaceManager.registerWatchers(context);

  const opencodeLauncher = OpenCodeLauncher.getInstance();
  const mcpServer = new CodeSentinelMcpServer("codesentinel-internal", "0.2.2");
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
      sidebarProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
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
      const mcpScriptPath = path.join(context.extensionUri.fsPath, "dist", "mcp-server.js");
      await opencodeLauncher.syncWorkspaceConfig(rootPath, mcpScriptPath, {
        useDocker: false,
        imageName: config.get<string>("dockerImage", "codesentinel/core:latest"),
        extensionPath: context.extensionUri.fsPath,
      });
      lastSyncedRoot = rootPath;
    } catch (e: any) {
      console.warn("Auto-syncing OpenCode MCP config skipped:", e?.message);
    }
  };

  const initialRoot = workspaceManager.getActiveWorkspaceRoot();
  if (initialRoot) {
    autoSyncMcp(initialRoot).then(() => {
      // Automatically launch OpenCode & CodeSentinel MCP service right upon starting extension
      opencodeLauncher.startWebProcess(initialRoot).catch((err) => {
        console.warn("OpenCode MCP runtime auto-start notice:", err?.message);
      });
    });
  }

  workspaceManager.onDidChangeWorkspace(() => {
    updateStatusBar(workspaceManager);
    const root = workspaceManager.getActiveWorkspaceRoot();
    if (root) {
      autoSyncMcp(root).then(() => {
        opencodeLauncher.startWebProcess(root).catch(() => {});
      });
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
        const configPath = await opencodeLauncher.syncWorkspaceConfig(
          activeWorkspace,
          mcpScriptPath,
          {
            useDocker: false,
            imageName: config.get<string>("dockerImage", "codesentinel/core:latest"),
          }
        );
        vscode.window.showInformationMessage(
          `CodeSentinel: Linked MCP server (Self-Contained Local Runtime) in ${configPath}`
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

  // 5. Command: Toggle Backend Mode (local <-> cloud)
  const cmdToggleBackend = vscode.commands.registerCommand(
    "codesentinel.toggleBackendMode",
    async () => {
      const config = vscode.workspace.getConfiguration("codesentinel");
      const current = config.get<string>("backendMode", "local");
      const updated = current === "local" ? "cloud" : "local";
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

  // 6. Command: Deploy / Build Unified Container Image (Deprecated: CodeSentinel is local self-contained)
  const cmdBuildContainer = vscode.commands.registerCommand(
    "codesentinel.buildContainer",
    async () => {
      vscode.window.showInformationMessage(
        "CodeSentinel is running directly as a self-contained extension with zero Docker requirements."
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

  // 9. Command: Install / Verify Host Dependencies (OpenCode & Atlas)
  const cmdInstallDependencies = vscode.commands.registerCommand(
    "codesentinel.installDependencies",
    async () => {
      await DependencyManager.getInstance().ensureDependencies(context);
      vscode.window.showInformationMessage("CodeSentinel: Host dependencies verified and ready.");
    }
  );

  // 10. Command: Run Cloud Security Audit with OpenCode
  const cmdRunCloudSecurityAudit = vscode.commands.registerCommand(
    "codesentinel.runCloudSecurityAudit",
    async () => {
      const activeWorkspace = await ensureWorkspaceFolder();
      if (!activeWorkspace) return;

      // Ensure dependencies & skills are provisioned before triggering audit
      await DependencyManager.getInstance().ensureDependencies(context);
      await opencodeLauncher.provisionSkills(activeWorkspace, context.extensionUri.fsPath);

      const prompt =
        "Run a comprehensive cloud security and trust boundary audit on this repository using the @cloud-security-audit skill. " +
        "Leverage CodeSentinel AST MCP tools (codesentinel_search_symbols, codesentinel_call_hierarchy, codesentinel_find_path) " +
        "to map trust boundaries, audit IAM & cloud SDK calls, verify attack paths, and generate SECURITY-AUDIT-REPORT.md and security-audit-report.json.";

      opencodeLauncher.launchTerminal(activeWorkspace, prompt);
    }
  );

  // 11. Command: Manually Provision Security Audit Skills to OpenCode
  const cmdProvisionSkills = vscode.commands.registerCommand(
    "codesentinel.provisionSkills",
    async () => {
      const activeWorkspace = await ensureWorkspaceFolder();
      if (!activeWorkspace) return;
      const res = await opencodeLauncher.provisionSkills(activeWorkspace, context.extensionUri.fsPath);
      vscode.window.showInformationMessage(
        `CodeSentinel: Cloud Security Audit skill provisioned to ${res.workspaceSkillPath}`
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
    cmdIndexAtlas,
    cmdInstallDependencies,
    cmdRunCloudSecurityAudit,
    cmdProvisionSkills
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

  // Non-blocking background Atlas code graph indexing on extension activation
  setTimeout(async () => {
    try {
      const activeWorkspace = workspaceManager.getActiveWorkspaceRoot();
      if (activeWorkspace) {
        const { GraphService } = await import("./graph/graphService");
        const graphService = GraphService.getInstance();
        if (!graphService.isGraphAvailable(activeWorkspace)) {
          console.log("CodeSentinel: Initiating background Atlas code graph indexing...");
          await opencodeLauncher.indexWithAtlas(activeWorkspace);
          console.log("CodeSentinel: Background Atlas indexing finished.");
          sidebarProvider.notifyGraphReady();
        }
      }
    } catch (e: any) {
      console.warn("Background Atlas code graph indexing notice:", e?.message);
    }
  }, 2000);

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
  launcher.stopWebProcess();
}
