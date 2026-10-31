import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { WorkspaceManager } from "../workspace/workspaceManager";
import { OpenCodeLauncher } from "../opencode/opencodeLauncher";
import { CodeSentinelMcpServer } from "../mcp/mcpServer";
import { DockerClient } from "../docker/dockerClient";
import { GraphService } from "../graph/graphService";
import { VulnerabilityScanner } from "../scanner/vulnerabilityScanner";

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codesentinel.controlCenter";
  private _view?: vscode.WebviewView;
  private _hasContainerImage: boolean = false;
  private _outputChannel?: vscode.OutputChannel;

  private getOutputChannel(): vscode.OutputChannel {
    if (!this._outputChannel) {
      this._outputChannel = vscode.window.createOutputChannel("CodeSentinel: Vulnerability Scanner");
    }
    return this._outputChannel;
  }

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _workspaceManager: WorkspaceManager,
    private readonly _opencodeLauncher: OpenCodeLauncher,
    private readonly _mcpServer: CodeSentinelMcpServer
  ) {
    // Listen to DependencyManager setup progress to notify webview in real-time
    import("../services/dependencyManager").then(({ DependencyManager }) => {
      DependencyManager.getInstance().onProgress((progress) => {
        this._view?.webview.postMessage({
          command: "toolInstallProgress",
          progress,
        });
      });
    }).catch(() => {});

    this._workspaceManager.onDidChangeWorkspace(async () => {
      const workspace = this._workspaceManager.getContext();
      if (workspace) {
        const activeRoot = this._opencodeLauncher.getActiveWorkspaceRoot();
        const rootChanged = !activeRoot ||
          path.normalize(activeRoot).toLowerCase() !== path.normalize(workspace.rootPath).toLowerCase();

        if (rootChanged || !this._opencodeLauncher.isWebRunning()) {
          try {
            const serverUrl = await this._ensureMcpAndStart(workspace.rootPath);
            if (serverUrl && this._view) {
              this._view.webview.postMessage({ command: "setServerUrl", url: serverUrl });
            }
          } catch {}
        }
      }
      this.updateWebviewContent();
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Immediately broadcast any active or recent dependency provisioning progress to the newly opened webview
    import("../services/dependencyManager")
      .then(({ DependencyManager }) => {
        const dm = DependencyManager.getInstance();
        const lastProgress = dm.getLastProgress();
        if (lastProgress) {
          this._view?.webview.postMessage({
            command: "toolInstallProgress",
            progress: lastProgress,
          });
        } else if (dm.isProvisioning()) {
          this._view?.webview.postMessage({
            command: "toolInstallProgress",
            progress: {
              stage: "Installing runtime tools",
              percent: 15,
              detail: "Downloading self-contained OpenCode AI Agent & Atlas Engine...",
            },
          });
        }
      })
      .catch(() => {});

    // Auto-launch OpenCode session for current repository when sidebar opens (after dependencies are ready)
    const workspace = this._workspaceManager.getContext();
    if (workspace) {
      const activeRoot = this._opencodeLauncher.getActiveWorkspaceRoot();
      const rootChanged = !activeRoot ||
        path.normalize(activeRoot).toLowerCase() !== path.normalize(workspace.rootPath).toLowerCase();

      if (rootChanged || !this._opencodeLauncher.isWebRunning()) {
        import("../services/dependencyManager")
          .then(({ DependencyManager }) => DependencyManager.getInstance().waitForDependencies())
          .catch(() => {})
          .then(() => this._ensureMcpAndStart(workspace.rootPath))
          .then((serverUrl) => {
            if (serverUrl && this._view) {
              this._view.webview.postMessage({ command: "setServerUrl", url: serverUrl });
            }
          })
          .catch(() => {});
      }

      // Automatically load previous vulnerability scan results from persistent cache
      try {
        const cachedScan = VulnerabilityScanner.getInstance().getLatestScan(workspace.rootPath);
        if (cachedScan) {
          setTimeout(() => {
            this._view?.webview.postMessage({
              command: "vulScanComplete",
              result: cachedScan,
              fromCache: true,
            });
          }, 350);
        }
      } catch {}
    }

    webviewView.webview.onDidReceiveMessage(async (data) => {
      const workspace = this._workspaceManager.getContext();

      switch (data.command) {
        case "ensureChatStarted":
        case "startChat": {
          if (!workspace) {
            vscode.window.showErrorMessage("CodeSentinel: Please open a project repository folder first.");
            return;
          }
          const activeRoot = this._opencodeLauncher.getActiveWorkspaceRoot();
          const rootChanged = !activeRoot ||
            path.normalize(activeRoot).toLowerCase() !== path.normalize(workspace.rootPath).toLowerCase();

          if (!rootChanged && this._opencodeLauncher.isWebRunning()) {
            return;
          }
          try {
            const serverUrl = await this._ensureMcpAndStart(workspace.rootPath);
            if (serverUrl && this._view) {
              this._view.webview.postMessage({ command: "setServerUrl", url: serverUrl });
            } else {
              this.updateWebviewContent();
            }
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to start OpenCode: ${err.message}`);
          }
          break;
        }

        case "reloadChat": {
          if (!workspace) return;
          try {
            await this._opencodeLauncher.stopWebProcess();
            const serverUrl = await this._ensureMcpAndStart(workspace.rootPath);
            if (serverUrl && this._view) {
              this._view.webview.postMessage({ command: "setServerUrl", url: serverUrl });
            } else {
              this.updateWebviewContent();
            }
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to start OpenCode: ${err.message}`);
          }
          break;
        }

        case "stopChat": {
          await this._opencodeLauncher.stopWebProcess();
          this.updateWebviewContent();
          vscode.window.showInformationMessage("CodeSentinel: Security Agent stopped.");
          break;
        }

        case "launchTerminal": {
          if (!workspace) {
            vscode.window.showErrorMessage("CodeSentinel: Please open a project repository folder first.");
            return;
          }
          this._opencodeLauncher.launchTerminal(workspace.rootPath);
          break;
        }

        case "launchWeb": {
          if (!workspace) {
            vscode.window.showErrorMessage("CodeSentinel: Please open a project repository folder first.");
            return;
          }
          const serverUrl = this._opencodeLauncher.getWebServerUrl();
          if (serverUrl) {
            vscode.env.openExternal(vscode.Uri.parse(serverUrl));
          } else {
            this._opencodeLauncher.launchWeb(workspace.rootPath);
          }
          break;
        }

        case "syncMcpConfig": {
          if (!workspace) {
            vscode.window.showErrorMessage("CodeSentinel: Please open a project repository folder first.");
            return;
          }
          try {
            const config = vscode.workspace.getConfiguration("codesentinel");
            const mcpScript = path.join(this._extensionUri.fsPath, "dist", "mcp-server.js");
            const configPath = await this._opencodeLauncher.syncWorkspaceConfig(workspace.rootPath, mcpScript, {
              useDocker: false,
              imageName: config.get<string>("dockerImage", "codesentinel/core:latest"),
            });
            vscode.window.showInformationMessage(`CodeSentinel: OpenCode MCP linked via host runtime at ${configPath}`);
            this._workspaceManager.refreshContext();
            this.updateWebviewContent();
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to sync OpenCode config: ${err.message}`);
          }
          break;
        }

        case "deployContainer": {
          await vscode.commands.executeCommand("codesentinel.buildContainer");
          await this.refreshContainerStatus();
          break;
        }

        case "indexAtlas": {
          if (!workspace) {
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
              const res = await this._opencodeLauncher.indexWithAtlas(workspace.rootPath);
              if (res.success) {
                vscode.window.showInformationMessage("CodeSentinel: Atlas code graph indexed successfully!");
              } else {
                vscode.window.showErrorMessage(`CodeSentinel: Atlas indexing failed: ${res.output}`);
              }
              this.updateWebviewContent();
            }
          );
          break;
        }

        case "openFolder": {
          vscode.commands.executeCommand("vscode.openFolder");
          break;
        }

        case "startVulnerabilityScan": {
          if (!workspace) {
            vscode.window.showErrorMessage("CodeSentinel: Please open a project repository folder first.");
            return;
          }
          try {
            const out = this.getOutputChannel();
            out.clear();
            out.appendLine(`================================================================================`);
            out.appendLine(`[CodeSentinel] Multi-Tool Vulnerability Scan - ${new Date().toLocaleString()}`);
            out.appendLine(`Target Workspace: ${workspace.rootPath}`);
            out.appendLine(`Engines: Universal SAST, Secret Detector, Atlas AST Graph, Dependency CVE Auditor`);
            out.appendLine(`================================================================================`);

            const scanner = VulnerabilityScanner.getInstance();
            const forceRefresh = Boolean(data.forceRefresh);
            const result = await scanner.scanProject(
              workspace.rootPath,
              (scanned, total, file, log) => {
                this._view?.webview.postMessage({
                  command: "vulScanProgress",
                  scanned,
                  total,
                  file,
                  log,
                });
                if (log) {
                  out.appendLine(`[${log.timestamp}] [${log.engine}] ${log.message}${log.detail ? " -> " + log.detail : ""}`);
                }
              },
              forceRefresh
            );
            this._view?.webview.postMessage({
              command: "vulScanComplete",
              result,
              fromCache: false,
            });
            out.appendLine(`--------------------------------------------------------------------------------`);
            out.appendLine(`Scan Finished: ${result.summary.total} total clubbed findings (Critical: ${result.summary.critical}, High: ${result.summary.high}, Medium: ${result.summary.medium}, Low: ${result.summary.low})`);
            out.appendLine(`Scanned: ${result.scannedFilesCount} files | Skipped/Ignored: ${result.ignoredFilesCount} media/git files`);
            out.appendLine(`================================================================================\n`);
          } catch (err: any) {
            this._view?.webview.postMessage({
              command: "vulScanError",
              message: err.message,
            });
            this.getOutputChannel().appendLine(`[ERROR] Vulnerability scan failed: ${err.message}`);
          }
          break;
        }

        case "showOutputChannel": {
          this.getOutputChannel().show(true);
          break;
        }

        case "traceVulnerabilityGraph": {
          if (!workspace) return;
          try {
            const graphService = GraphService.getInstance();
            let targetSymbol = data.symbolName;
            if (!targetSymbol && data.filePath && data.line) {
              const syms = graphService.searchSymbols(workspace.rootPath, "", 20, "callables", data.filePath);
              const match = syms.find((s) => s.startLine <= data.line && s.endLine >= data.line);
              if (match) targetSymbol = match.name;
            }
            if (!targetSymbol && data.filePath) {
              const fileSyms = graphService.searchSymbols(workspace.rootPath, "", 5, "callables", data.filePath);
              if (fileSyms.length > 0) targetSymbol = fileSyms[0].name;
            }

            if (targetSymbol) {
              const res = graphService.analyzeImpact(workspace.rootPath, targetSymbol, "downstream", 3, 12);
              this._view?.webview.postMessage({
                command: "selectTab",
                tabId: "tab-graph",
              });
              this._view?.webview.postMessage({
                command: "impactResult",
                result: { ...res, isTainted: true },
              });
            } else {
              vscode.window.showWarningMessage(`AST symbol not directly mapped for line ${data.line}. Opening file dependencies in Code Graph.`);
              this._view?.webview.postMessage({
                command: "selectTab",
                tabId: "tab-graph",
              });
              vscode.commands.executeCommand("codesentinel.openCodeGraph");
            }
          } catch (err: any) {
            vscode.window.showErrorMessage(`Blast radius trace failed: ${err.message}`);
          }
          break;
        }

        case "toggleBackendMode": {
          const config = vscode.workspace.getConfiguration("codesentinel");
          const current = config.get<string>("backendMode", "local");
          const updated = current === "local" ? "cloud" : "local";
          await config.update("backendMode", updated, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`CodeSentinel: Backend execution mode switched to ${updated}.`);
          this.updateWebviewContent();
          break;
        }

        case "getGraphData": {
          if (!workspace) return;
          const graphService = GraphService.getInstance();
          const stats = graphService.getStats(workspace.rootPath);
          if (!stats.available) {
            this._view?.webview.postMessage({ command: "graphNotAvailable", stats });
            break;
          }
          const topSymbols = graphService.getTopSymbols(workspace.rootPath, 15);
          const targetName = data.symbolName || (topSymbols.length > 0 ? topSymbols[0].name : null);
          if (targetName) {
            try {
              const hierarchy = graphService.getCallHierarchy(workspace.rootPath, targetName, { maxCallers: 50, maxCallees: 50 });
              this._view?.webview.postMessage({
                command: "graphHierarchy",
                root: hierarchy.root,
                callers: hierarchy.callers,
                callees: hierarchy.callees,
                edges: hierarchy.edges,
                stats,
                topSymbols,
              });
            } catch (err: any) {
              this._view?.webview.postMessage({ command: "graphError", message: err.message, stats, topSymbols });
            }
          } else {
            this._view?.webview.postMessage({ command: "graphNotAvailable", stats });
          }
          break;
        }

        case "expandBranch": {
          if (!workspace) return;
          const graphService = GraphService.getInstance();
          try {
            const limit = data.limit || 60;
            const res = graphService.expandBranch(workspace.rootPath, data.symbolName, data.direction || "callees", limit);
            this._view?.webview.postMessage({
              command: "branchExpanded",
              parentName: data.symbolName,
              direction: data.direction || "callees",
              symbols: res.symbols,
              edges: res.edges,
            });
          } catch (err: any) {
            this._view?.webview.postMessage({ command: "graphError", message: err.message });
          }
          break;
        }

        case "findPath":
        case "findAttackPath": {
          if (!workspace) return;
          const graphService = GraphService.getInstance();
          try {
            const res = graphService.findPath(workspace.rootPath, data.from, data.to, { preferProduction: data.preferProduction });
            this._view?.webview.postMessage({ command: "pathResult", result: res });
          } catch (err: any) {
            this._view?.webview.postMessage({ command: "graphError", message: err.message });
          }
          break;
        }

        case "getImpact": {
          if (!workspace) return;
          const graphService = GraphService.getInstance();
          try {
            const res = graphService.analyzeImpact(workspace.rootPath, data.symbolName, data.direction || "downstream", data.depth || 3, data.limitPerLevel || 12);
            this._view?.webview.postMessage({ command: "impactResult", result: res });
          } catch (err: any) {
            this._view?.webview.postMessage({ command: "graphError", message: err.message });
          }
          break;
        }

        case "getFileDependencies": {
          if (!workspace) return;
          const graphService = GraphService.getInstance();
          try {
            const res = graphService.getFileDependencies(workspace.rootPath, data.fileFilter, data.limit || 50);
            this._view?.webview.postMessage({ command: "fileDependenciesResult", result: res });
          } catch (err: any) {
            this._view?.webview.postMessage({ command: "graphError", message: err.message });
          }
          break;
        }

        case "getGraphStats": {
          if (!workspace) return;
          const graphService = GraphService.getInstance();
          const stats = graphService.getStats(workspace.rootPath);
          this._view?.webview.postMessage({ command: "graphStats", stats });
          break;
        }

        case "searchSymbols": {
          if (!workspace) return;
          const graphService = GraphService.getInstance();
          try {
            const results = graphService.searchSymbols(workspace.rootPath, data.query || "", data.limit || 15, data.category || "callables", data.fileFilter);
            this._view?.webview.postMessage({ command: "searchResults", results, target: data.target, query: data.query });
          } catch (err: any) {
            this._view?.webview.postMessage({ command: "searchResults", results: [], target: data.target, query: data.query });
          }
          break;
        }

        case "getFlowDiagram": {
          if (!workspace) return;
          try {
            const graphService = GraphService.getInstance();
            let flow = graphService.getSavedFlowDiagram(workspace.rootPath);
            if (!flow && data.topic) {
              flow = graphService.explainFlow(workspace.rootPath, data.topic);
            }
            this._view?.webview.postMessage({ command: "flowResult", flow });
          } catch (err: any) {
            this._view?.webview.postMessage({
              command: "flowResult",
              flow: {
                topic: data.topic || "Overview",
                summary: `Flow unavailable: ${err.message}`,
                steps: [],
                mermaidDiagram: "flowchart TD\n  Err[Index Not Ready]",
                graph: { nodes: [], edges: [] },
              },
            });
          }
          break;
        }

        case "runExplainFlow": {
          if (!workspace) return;
          try {
            const graphService = GraphService.getInstance();
            const flow = graphService.explainFlow(workspace.rootPath, data.topic || "login", data.entrySymbol);
            this._view?.webview.postMessage({ command: "flowResult", flow });
          } catch (err: any) {
            this._view?.webview.postMessage({
              command: "flowResult",
              flow: {
                topic: data.topic || "Error",
                summary: `Flow error: ${err.message}`,
                steps: [],
                mermaidDiagram: "flowchart TD\n  Err[Analysis Error]",
                graph: { nodes: [], edges: [] },
              },
            });
          }
          break;
        }

        case "getCodeSnippet": {
          if (!workspace) return;
          const graphService = GraphService.getInstance();
          const snippet = graphService.getCodeSnippet(workspace.rootPath, data.path, data.startLine, data.endLine);
          this._view?.webview.postMessage({
            command: "codeSnippet",
            symbolName: data.name,
            snippet,
            path: data.path,
            startLine: data.startLine,
            endLine: data.endLine,
          });
          break;
        }

        case "openInEditor": {
          if (!workspace || !data.path) return;
          const fullPath = path.isAbsolute(data.path) ? data.path : path.join(workspace.rootPath, data.path);
          if (fs.existsSync(fullPath)) {
            const doc = await vscode.workspace.openTextDocument(fullPath);
            const editor = await vscode.window.showTextDocument(doc, { preview: false });
            const line = Math.max(0, (data.line || 1) - 1);
            const pos = new vscode.Position(line, 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          } else {
            vscode.window.showErrorMessage(`File not found: ${data.path}`);
          }
          break;
        }

        case "askAgentAboutSymbol": {
          if (!workspace) return;
          this._view?.webview.postMessage({ command: "selectTab", tabId: "tab-chat" });
          const prompt = `Audit function "${data.name}" in ${data.path} (lines ${data.startLine}-${data.endLine}) for security vulnerabilities, untrusted input handling, and potential attack paths.`;
          this._opencodeLauncher.launchTerminal(workspace.rootPath, prompt);
          break;
        }
      }
    });

    this.refreshContainerStatus();
  }

  private async _ensureMcpAndStart(rootPath: string): Promise<string> {
    const config = vscode.workspace.getConfiguration("codesentinel");
    const mcpScript = path.join(this._extensionUri.fsPath, "dist", "mcp-server.js");
    await this._opencodeLauncher.syncWorkspaceConfig(rootPath, mcpScript, {
      useDocker: false,
      imageName: config.get<string>("dockerImage", "codesentinel/core:latest"),
    });
    const res = await this._opencodeLauncher.startWebProcess(rootPath);
    return res.url;
  }

  public async refreshContainerStatus(): Promise<void> {
    this._hasContainerImage = false;
  }

  public updateWebviewContent(): void {
    if (this._view) {
      const workspace = this._workspaceManager.getContext();
      const hasAtlasDb = workspace ? fs.existsSync(GraphService.getInstance().getDbPath(workspace.rootPath)) : false;
      this._view.webview.postMessage({
        command: "updateContext",
        workspace: workspace ? {
          name: workspace.name,
          rootPath: workspace.rootPath,
          detectedLanguages: workspace.detectedLanguages,
          hasOpenCodeConfig: workspace.hasOpenCodeConfig,
          hasAtlasDb,
        } : null,
        serverUrl: this._opencodeLauncher.getWebServerUrl(),
        isWebRunning: this._opencodeLauncher.isWebRunning(),
      });
    }
  }

  public notifyGraphReady(): void {
    if (this._view) {
      this.updateWebviewContent();
      this._view.webview.postMessage({ command: "graphReady" });
      this._view.webview.postMessage({ command: "getGraphStats" });
      this._view.webview.postMessage({ command: "getGraphData" });
    }
  }

  public selectTab(tabId: string): void {
    if (this._view) {
      this._view.webview.postMessage({ command: "selectTab", tabId });
    }
  }

  private getHtmlContent(_webview: vscode.Webview): string {
    const workspace = this._workspaceManager.getContext();
    const config = vscode.workspace.getConfiguration("codesentinel");
    const backendMode = config.get<string>("backendMode", "local");
    const tools = this._mcpServer.getRegisteredTools();
    const serverUrl = this._opencodeLauncher.getWebServerUrl();
    const isWebRunning = this._opencodeLauncher.isWebRunning();
    const hasAtlasDb = workspace ? fs.existsSync(GraphService.getInstance().getDbPath(workspace.rootPath)) : false;

    const workspaceHtml = workspace
      ? `
        <div class="card">
          <div class="card-header">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-blue); flex-shrink: 0;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <strong>${this.escapeHtml(workspace.name)}</strong>
          </div>
          <div class="meta-row">
            <span class="label">Path:</span>
            <span class="value path-value" title="${this.escapeHtml(workspace.rootPath)}">${this.escapeHtml(
        workspace.rootPath
      )}</span>
          </div>
          <div class="meta-row">
            <span class="label">Languages:</span>
            <span class="value">${workspace.detectedLanguages.length > 0
        ? workspace.detectedLanguages.map((l) => `<span class="badge lang-badge">${l}</span>`).join(" ")
        : '<span class="text-muted">None detected</span>'
      }</span>
          </div>
          <div class="meta-row">
            <span class="label">OpenCode MCP:</span>
            <span id="badge-mcp-status" class="badge ${workspace.hasOpenCodeConfig ? "badge-success" : "badge-warn"}">
              ${workspace.hasOpenCodeConfig ? "Configured" : "Not Linked"}
            </span>
          </div>
          <div class="meta-row">
            <span class="label">Atlas Graph:</span>
            <span id="badge-atlas-status" class="badge ${hasAtlasDb ? "badge-success" : "badge-warn"}">
              ${hasAtlasDb ? "Indexed" : "Not Indexed"}
            </span>
          </div>
        </div>
      `
      : `
        <div class="card empty-card" style="text-align: center; padding: 18px 12px;">
          <p class="text-muted" style="margin: 0 0 6px 0; font-weight: 600;">No repository workspace open</p>
          <p class="sub-text" style="color: var(--text-muted); font-size: 11px; margin: 0 0 14px 0;">Open any project repository folder to activate OpenCode and MCP security tools.</p>
          <button id="btn-open-folder" class="btn-primary" style="max-width: 160px; margin: 0 auto; display: block;">Open Folder</button>
        </div>
      `;

    const toolsHtml = tools
      .map(
        (t) => `
        <div class="tool-item">
          <div class="tool-title">${this.escapeHtml(t.name)}</div>
          <div class="tool-desc">${this.escapeHtml(t.description || "")}</div>
        </div>
      `
      )
      .join("");

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src http://127.0.0.1:* http://localhost:*; connect-src http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*;">
      <title>CodeSentinel</title>
      <style>
        :root {
          --card-bg: rgba(30, 36, 48, 0.7);
          --card-border: rgba(255, 255, 255, 0.08);
          --accent-blue: #38bdf8;
          --accent-purple: #a855f7;
          --accent-green: #34d399;
          --text-main: #f1f5f9;
          --text-muted: #94a3b8;
          --btn-bg: #2563eb;
          --btn-hover: #1d4ed8;
        }

        * { box-sizing: border-box; }

        html, body {
          height: 100%;
          margin: 0;
          padding: 0;
          font-family: var(--vscode-font-family, sans-serif);
          font-size: var(--vscode-font-size, 13px);
          color: var(--text-main);
          background: transparent;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        /* Instant Ultra-Fast Static Splash Screen */
        .instant-splash {
          position: fixed;
          inset: 0;
          background: #0f1117;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 9999;
          transition: opacity 0.4s ease, visibility 0.4s ease;
        }

        .instant-splash.hidden {
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
        }

        .splash-content {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          padding: 24px 18px;
          max-width: 280px;
        }

        .splash-logo {
          width: 54px;
          height: 54px;
          border-radius: 14px;
          background: rgba(56, 189, 248, 0.1);
          border: 1px solid rgba(56, 189, 248, 0.3);
          display: flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 12px;
          box-shadow: 0 0 20px rgba(56, 189, 248, 0.25);
          animation: pulseGlow 1.8s infinite ease-in-out;
        }

        @keyframes pulseGlow {
          0%, 100% { box-shadow: 0 0 15px rgba(56, 189, 248, 0.2); transform: scale(1); }
          50% { box-shadow: 0 0 28px rgba(56, 189, 248, 0.5); transform: scale(1.04); }
        }

        .splash-title {
          font-size: 15px;
          font-weight: 700;
          color: #f1f5f9;
          letter-spacing: 0.5px;
        }

        .splash-sub {
          font-size: 10px;
          color: #94a3b8;
          margin-top: 3px;
          margin-bottom: 16px;
        }

        .splash-progress-track {
          width: 140px;
          height: 3px;
          background: rgba(255, 255, 255, 0.08);
          border-radius: 2px;
          overflow: hidden;
          margin-bottom: 8px;
          position: relative;
        }

        .splash-progress-bar {
          position: absolute;
          height: 100%;
          width: 50%;
          background: linear-gradient(90deg, #38bdf8, #818cf8);
          border-radius: 2px;
          animation: splashSlide 1.2s infinite ease-in-out;
        }

        @keyframes splashSlide {
          0% { left: -50%; width: 40%; }
          50% { left: 25%; width: 60%; }
          100% { left: 110%; width: 40%; }
        }

        .splash-status {
          font-size: 10px;
          font-family: monospace;
          color: #38bdf8;
        }

        .app-container {
          display: flex;
          flex-direction: column;
          height: 100%;
          width: 100%;
        }

        /* First-Time Setup Live Progress Banner */
        .setup-banner {
          background: linear-gradient(135deg, rgba(30, 41, 59, 0.95), rgba(15, 23, 42, 0.98));
          border-bottom: 1px solid rgba(56, 189, 248, 0.3);
          padding: 8px 10px;
          display: flex;
          flex-direction: column;
          gap: 5px;
          z-index: 100;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        }

        .setup-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .setup-title {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          font-weight: 700;
          color: var(--accent-blue);
        }

        .setup-spinner {
          width: 10px;
          height: 10px;
          border: 2px solid rgba(56, 189, 248, 0.2);
          border-top-color: var(--accent-blue);
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        .setup-pct {
          font-size: 10px;
          font-weight: 800;
          font-family: monospace;
          color: var(--accent-green);
        }

        .setup-bar-track {
          width: 100%;
          height: 4px;
          background: rgba(255, 255, 255, 0.08);
          border-radius: 2px;
          overflow: hidden;
        }

        .setup-bar-fill {
          height: 100%;
          background: linear-gradient(90deg, var(--accent-blue), var(--accent-green));
          transition: width 0.3s ease;
        }

        .setup-detail {
          font-size: 10px;
          color: var(--text-muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* Top 3-Tab Bar */
        .tabs-header {
          display: flex;
          align-items: center;
          padding: 6px 8px;
          background: rgba(18, 20, 26, 0.95);
          border-bottom: 1px solid var(--card-border);
          gap: 4px;
        }

        .tab-btn {
          flex: 1;
          padding: 6px 4px;
          border: none;
          background: transparent;
          color: var(--text-muted);
          font-size: 11px;
          font-weight: 600;
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
        }

        .tab-btn .tab-icon {
          flex-shrink: 0;
          display: inline-block;
          vertical-align: middle;
        }

        .tab-btn:hover {
          color: var(--text-main);
          background: rgba(255, 255, 255, 0.06);
        }

        .tab-btn.active {
          color: var(--accent-blue);
          background: rgba(56, 189, 248, 0.12);
          border: 1px solid rgba(56, 189, 248, 0.25);
        }

        .tab-content {
          flex: 1;
          position: relative;
          overflow: hidden;
          width: 100%;
          height: 100%;
        }

        .tab-pane {
          display: none !important;
          position: absolute;
          inset: 0;
          height: 100%;
          width: 100%;
          overflow-y: auto;
          padding: 10px;
          background: #0f1117;
          z-index: 1;
        }

        .tab-pane.active {
          display: flex !important;
          flex-direction: column;
          z-index: 30;
        }

        /* Persistent iframe container: keep mounted in DOM without display:none so it never unloads or reloads */
        #tab-chat.tab-pane {
          display: flex !important;
          flex-direction: column;
          position: absolute;
          inset: 0;
          padding: 0;
          overflow: hidden;
          visibility: hidden;
          pointer-events: none;
          z-index: 1;
          opacity: 0;
          background: #0f1117;
        }

        #tab-chat.tab-pane.active {
          visibility: visible;
          pointer-events: auto;
          z-index: 50;
          opacity: 1;
        }

        /* Ensure other tab panes stack cleanly above when active */
        #tab-workspace.tab-pane.active,
        #tab-vuls.tab-pane.active,
        #tab-tools.tab-pane.active {
          z-index: 50;
          background: #0f1117;
        }

        /* 360° Code Graph Styles */
        #tab-graph.tab-pane {
          display: none !important;
          padding: 0;
          overflow: hidden;
          position: absolute;
          inset: 0;
          flex-direction: column;
          height: 100%;
          width: 100%;
          background: #0a0c10;
          z-index: 1;
        }

        #tab-graph.tab-pane.active {
          display: flex !important;
          visibility: visible !important;
          pointer-events: auto !important;
          opacity: 1 !important;
          z-index: 50 !important;
        }

        #tab-graph.tab-pane:not(.active) {
          display: none !important;
          visibility: hidden !important;
          pointer-events: none !important;
          opacity: 0 !important;
          z-index: -1 !important;
        }

        .node-lang-pill {
          font-size: 8px;
          color: var(--text-muted);
          text-transform: uppercase;
        }

        .graph-header-bar {
          display: flex;
          flex-direction: column;
          padding: 6px 8px;
          background: rgba(18, 20, 26, 0.95);
          border-bottom: 1px solid var(--card-border);
          gap: 6px;
          z-index: 25;
          position: relative;
        }

        .graph-mode-pills-row {
          display: flex;
          align-items: center;
          gap: 4px;
          overflow-x: auto;
          padding-bottom: 2px;
        }

        .graph-subtoolbar {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }

        .graph-search-row {
          display: flex;
          align-items: center;
          gap: 6px;
          position: relative;
        }

        .graph-search-input {
          flex: 1;
          padding: 5px 8px;
          background: rgba(0, 0, 0, 0.4);
          border: 1px solid var(--card-border);
          border-radius: 4px;
          color: var(--text-main);
          font-size: 11px;
          outline: none;
        }
        .graph-search-input:focus {
          border-color: var(--accent-blue);
        }

        .search-results-dropdown {
          position: absolute;
          top: 100%;
          left: 8px;
          right: 8px;
          background: #161b22;
          border: 1px solid var(--accent-blue);
          border-radius: 6px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.7);
          max-height: 220px;
          overflow-y: auto;
          z-index: 80;
          display: none;
        }
        .search-result-item {
          padding: 6px 10px;
          font-size: 11px;
          cursor: pointer;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .search-result-item:hover {
          background: rgba(56, 189, 248, 0.15);
          color: var(--accent-blue);
        }

        .graph-filter-pills-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 4px;
          font-size: 10px;
        }

        .category-pills, .rings-pills, .direction-toggle {
          display: flex;
          align-items: center;
          gap: 3px;
        }

        .status-indicator {
          font-size: 10px;
          color: var(--text-muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .pill-btn {
          padding: 3px 7px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid var(--card-border);
          color: var(--text-muted);
          cursor: pointer;
          transition: all 0.15s;
          white-space: nowrap;
        }
        .pill-btn:hover {
          background: rgba(255, 255, 255, 0.1);
          color: var(--text-main);
        }
        .pill-btn.active {
          background: rgba(56, 189, 248, 0.18);
          border-color: var(--accent-blue);
          color: var(--accent-blue);
        }
        .pill-btn.btn-action {
          background: var(--accent-blue);
          color: #000000;
          border-color: var(--accent-blue);
          font-weight: 700;
        }
        .pill-btn.btn-action:hover {
          background: #7dd3fc;
        }

        .reverse-banner {
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: rgba(56, 189, 248, 0.15);
          border: 1px solid rgba(56, 189, 248, 0.35);
          border-radius: 4px;
          padding: 4px 8px;
          font-size: 10px;
          color: var(--accent-blue);
          margin-top: 4px;
        }

        .metrics-overlay {
          position: absolute;
          inset: 0;
          background: rgba(10, 12, 16, 0.96);
          z-index: 40;
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          overflow-y: auto;
        }

        .metrics-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }

        .metrics-card {
          background: var(--card-bg);
          border: 1px solid var(--card-border);
          border-radius: 6px;
          padding: 10px;
          text-align: center;
        }
        .metrics-card.full-width {
          text-align: left;
        }

        .metric-num {
          font-size: 20px;
          font-weight: 700;
          color: var(--accent-blue);
          font-family: monospace;
        }
        .metric-label {
          font-size: 10px;
          color: var(--text-muted);
          margin-top: 2px;
        }
        .metric-dbpath {
          font-size: 10px;
          color: var(--text-main);
          font-family: monospace;
          word-break: break-all;
          margin-top: 4px;
          background: rgba(0,0,0,0.3);
          padding: 4px;
          border-radius: 3px;
        }
        .metrics-actions {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-top: 6px;
        }

        .drawer-metrics-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
          margin: 6px 0;
        }
        .drawer-metric-box {
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid var(--card-border);
          border-radius: 4px;
          padding: 6px;
          text-align: center;
          cursor: pointer;
          transition: border-color 0.15s;
        }
        .drawer-metric-box:hover {
          border-color: var(--accent-blue);
        }
        .drawer-metric-num {
          font-size: 14px;
          font-weight: 700;
          color: var(--accent-blue);
          font-family: monospace;
        }
        .drawer-metric-label {
          font-size: 9px;
          color: var(--text-muted);
          margin-top: 1px;
        }
        .checkbox-label {
          display: flex;
          align-items: center;
          gap: 4px;
          cursor: pointer;
          color: var(--text-muted);
          user-select: none;
        }

        .graph-canvas-viewport {
          flex: 1;
          position: relative;
          overflow: hidden;
          background: #0a0c10;
          background-image: radial-gradient(rgba(255, 255, 255, 0.08) 1px, transparent 1px);
          background-size: 20px 20px;
          user-select: none;
          cursor: grab;
        }
        .graph-canvas-viewport:active {
          cursor: grabbing;
        }

        .graph-world {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          transform-origin: 0 0;
        }

        .graph-svg-layer {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          overflow: visible;
        }

        .graph-nodes-layer {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
        }

        .graph-node-card {
          position: absolute;
          pointer-events: auto;
          transform: translate(-50%, -50%);
          background: rgba(22, 27, 34, 0.9);
          border: 1px solid var(--card-border);
          border-radius: 6px;
          padding: 6px 8px;
          min-width: 140px;
          max-width: 200px;
          backdrop-filter: blur(8px);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
          cursor: grab;
          user-select: none;
          transition: transform 0.15s, border-color 0.2s, box-shadow 0.2s;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .graph-node-card:hover {
          transform: translate(-50%, -50%) scale(1.04);
          border-color: var(--accent-blue);
          box-shadow: 0 6px 20px rgba(56, 189, 248, 0.3);
        }
        .graph-node-card.dragging {
          cursor: grabbing !important;
          transform: translate(-50%, -50%) scale(1.06);
          border-color: var(--accent-blue);
          box-shadow: 0 10px 30px rgba(56, 189, 248, 0.5);
          z-index: 100 !important;
          transition: none !important;
        }
        .graph-node-card.root-node {
          border-color: var(--accent-blue);
          background: rgba(26, 35, 52, 0.95);
          box-shadow: 0 0 16px rgba(56, 189, 248, 0.35);
        }
        .graph-node-card.caller-node {
          border-color: rgba(168, 85, 247, 0.5);
        }
        .graph-node-card.callee-node {
          border-color: rgba(52, 211, 153, 0.5);
        }
        .graph-node-card.tainted-node {
          border-color: #f43f5e !important;
          background: rgba(85, 15, 28, 0.96) !important;
          box-shadow: 0 0 22px rgba(244, 63, 94, 0.8) !important;
        }

        .node-top-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 9px;
        }
        .node-kind-badge {
          font-weight: 700;
          text-transform: uppercase;
          padding: 1px 4px;
          border-radius: 3px;
          background: rgba(56, 189, 248, 0.15);
          color: var(--accent-blue);
        }
        .node-symbol-title {
          font-size: 11px;
          font-weight: 600;
          color: #ffffff;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .node-loc-sub {
          font-size: 9px;
          color: var(--text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .node-branch-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-top: 3px;
          padding-top: 3px;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
        }
        .branch-pill {
          padding: 1px 4px;
          border-radius: 3px;
          background: rgba(255, 255, 255, 0.08);
          color: var(--text-muted);
          cursor: pointer;
          transition: all 0.15s;
          font-size: 9px;
          font-weight: 600;
        }
        .branch-pill:hover {
          background: rgba(56, 189, 248, 0.25);
          color: var(--accent-blue);
        }
        .branch-pill.expanded {
          background: rgba(168, 85, 247, 0.25);
          color: var(--accent-purple);
        }

        .graph-edge-path {
          fill: none;
          stroke: rgba(148, 163, 184, 0.4);
          stroke-width: 1.5;
        }
        .graph-edge-path.tainted {
          stroke: #f43f5e;
          stroke-width: 2.2;
        }
        @keyframes dashPulse {
          to { stroke-dashoffset: -30; }
        }
        .graph-edge-path.pulse {
          stroke-dasharray: 5 4;
          animation: dashPulse 1s linear infinite;
        }

        .graph-side-drawer {
          position: absolute;
          top: 0;
          right: 0;
          width: 85%;
          max-width: 280px;
          height: 100%;
          background: rgba(18, 22, 30, 0.98);
          border-left: 1px solid var(--card-border);
          box-shadow: -8px 0 24px rgba(0, 0, 0, 0.6);
          z-index: 50;
          display: flex;
          flex-direction: column;
          transform: translateX(100%);
          transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .graph-side-drawer.open {
          transform: translateX(0);
        }

        .drawer-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 10px;
          border-bottom: 1px solid var(--card-border);
          background: rgba(0, 0, 0, 0.25);
        }
        .drawer-title {
          font-size: 11px;
          font-weight: 700;
          color: var(--accent-blue);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .drawer-body {
          flex: 1;
          overflow-y: auto;
          padding: 10px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .drawer-code-block {
          background: #0d1117;
          border: 1px solid var(--card-border);
          border-radius: 4px;
          padding: 6px;
          font-family: var(--vscode-editor-font-family, monospace);
          font-size: 10px;
          color: #e6edf3;
          overflow-x: auto;
          white-space: pre;
          max-height: 200px;
        }
        .drawer-actions {
          display: flex;
          flex-direction: column;
          gap: 5px;
          padding: 8px 10px;
          border-top: 1px solid var(--card-border);
          background: rgba(0, 0, 0, 0.2);
        }

        .chat-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 4px 10px;
          background: #141720;
          border-bottom: 1px solid var(--card-border);
          font-size: 11px;
        }

        .toolbar-title {
          display: flex;
          align-items: center;
          gap: 6px;
          font-weight: 600;
          color: var(--accent-blue);
        }

        .status-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: ${isWebRunning ? "var(--accent-green)" : "#94a3b8"};
          box-shadow: ${isWebRunning ? "0 0 6px rgba(52, 211, 153, 0.6)" : "none"};
        }

        .toolbar-actions {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .icon-btn {
          width: 24px;
          height: 24px;
          padding: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid var(--card-border);
          border-radius: 4px;
          color: var(--text-main);
          cursor: pointer;
          font-size: 11px;
          transition: background 0.15s;
        }

        .icon-btn:hover {
          background: rgba(255, 255, 255, 0.15);
        }

        .frame-wrapper {
          flex: 1;
          width: 100%;
          height: 100%;
          min-height: 0;
          position: relative;
          background: #0f1117;
          display: flex;
          flex-direction: column;
        }

        iframe {
          flex: 1;
          width: 100%;
          height: 100%;
          min-height: 0;
          border: none;
          background: #0f1117;
          display: block;
        }

        .chat-placeholder {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 24px 16px;
          text-align: center;
          background: rgba(0, 0, 0, 0.15);
        }

        .agent-logo-badge {
          width: 52px;
          height: 52px;
          border-radius: 12px;
          background: rgba(56, 189, 248, 0.08);
          border: 1px solid rgba(56, 189, 248, 0.22);
          display: flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 12px;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
        }

        /* Generic Cards & Buttons */
        .card {
          background: var(--card-bg);
          border: 1px solid var(--card-border);
          border-radius: 8px;
          padding: 12px;
          margin-bottom: 10px;
          backdrop-filter: blur(8px);
        }

        .card-header {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 8px;
          font-size: 12px;
        }

        .meta-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-top: 6px;
          font-size: 11px;
        }

        .label { color: var(--text-muted); }

        .path-value {
          max-width: 160px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          direction: rtl;
          text-align: left;
        }

        .badge {
          display: inline-block;
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
        }

        .badge-success {
          background: rgba(52, 211, 153, 0.15);
          color: #34d399;
          border: 1px solid rgba(52, 211, 153, 0.3);
        }

        .badge-warn {
          background: rgba(251, 191, 36, 0.15);
          color: #fbbf24;
          border: 1px solid rgba(251, 191, 36, 0.3);
        }

        .lang-badge {
          background: rgba(56, 189, 248, 0.15);
          color: #38bdf8;
          border: 1px solid rgba(56, 189, 248, 0.3);
        }

        button.btn-primary {
          width: 100%;
          padding: 8px 12px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 6px;
          background: var(--btn-bg);
          color: #ffffff;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s;
        }

        button.btn-primary:hover:not(:disabled) { background: var(--btn-hover); }

        button:disabled,
        .icon-btn:disabled,
        .pill-btn:disabled {
          opacity: 0.45 !important;
          cursor: not-allowed !important;
          pointer-events: none !important;
          filter: grayscale(55%);
        }

        .provisioning-callout {
          background: rgba(245, 158, 11, 0.12);
          border: 1px solid rgba(245, 158, 11, 0.4);
          border-left: 3px solid #f59e0b;
          border-radius: 6px;
          padding: 10px 12px;
          margin-bottom: 14px;
          max-width: 280px;
          text-align: left;
          font-size: 11px;
          line-height: 1.45;
          color: #fde68a;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
        }

        button.btn-secondary {
          padding: 4px 8px;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid var(--card-border);
          border-radius: 4px;
          color: var(--text-main);
          font-size: 11px;
          cursor: pointer;
        }

        button.btn-secondary:hover { background: rgba(255, 255, 255, 0.15); }

        .section-title {
          font-size: 11px;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin: 8px 0;
        }

        .toggle-card {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 10px;
          background: rgba(0, 0, 0, 0.2);
          border-radius: 6px;
          border: 1px solid var(--card-border);
          margin-top: 6px;
        }

        .tool-item {
          padding: 8px;
          background: rgba(0, 0, 0, 0.2);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 6px;
          margin-bottom: 6px;
        }

        .tool-title {
          font-weight: 600;
          font-size: 11px;
          color: var(--accent-purple);
        }

        .tool-desc {
          font-size: 11px;
          color: var(--text-muted);
          margin-top: 2px;
        }

        /* Vulnerability Scanner Tab Styles */
        #tab-vuls.tab-pane {
          display: none !important;
          flex-direction: column;
          position: absolute;
          inset: 0;
          height: 100%;
          width: 100%;
          overflow-y: auto;
          padding: 8px;
          background: #0d1117;
          z-index: 1;
        }

        #tab-vuls.tab-pane.active {
          display: flex !important;
          z-index: 50;
        }

        /* Vulnerability Scanner Tab Styles (Unified Professional Design System) */
        #tab-vuls.tab-pane {
          display: none !important;
          flex-direction: column;
          position: absolute;
          inset: 0;
          height: 100%;
          width: 100%;
          overflow-y: auto;
          padding: 8px 10px;
          background: #0f1117;
          z-index: 1;
        }

        #tab-vuls.tab-pane.active {
          display: flex !important;
          z-index: 50;
        }

        .vul-header-bar {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 8px 10px;
          background: rgba(18, 20, 26, 0.95);
          border: 1px solid var(--card-border);
          border-radius: 6px;
          margin-bottom: 8px;
        }

        .vul-scan-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }

        .vul-status-wrapper {
          display: flex;
          align-items: center;
          gap: 6px;
          overflow: hidden;
        }

        .vul-metrics-pills-row {
          display: flex;
          align-items: center;
          gap: 4px;
          margin-top: 4px;
          overflow-x: auto;
          padding-bottom: 2px;
        }

        .vul-pill {
          padding: 2px 7px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
          font-family: monospace;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid var(--card-border);
          color: var(--text-muted);
          transition: all 0.15s;
          cursor: pointer;
          user-select: none;
          white-space: nowrap;
        }
        .vul-pill:hover {
          background: rgba(255, 255, 255, 0.08);
          color: var(--text-main);
        }
        .vul-pill.active {
          border-color: var(--accent-blue);
          background: rgba(56, 189, 248, 0.14);
          color: var(--accent-blue);
        }

        .pill-total { color: var(--text-main); }
        .pill-critical { color: #f87171; border-color: rgba(239, 68, 68, 0.25); background: rgba(239, 68, 68, 0.08); }
        .pill-high { color: #fb923c; border-color: rgba(249, 115, 22, 0.25); background: rgba(249, 115, 22, 0.08); }
        .pill-medium { color: #facc15; border-color: rgba(234, 179, 8, 0.25); background: rgba(234, 179, 8, 0.08); }
        .pill-low { color: #38bdf8; border-color: rgba(56, 189, 248, 0.25); background: rgba(56, 189, 248, 0.08); }

        .vul-card {
          background: var(--card-bg);
          border: 1px solid var(--card-border);
          border-radius: 6px;
          padding: 10px 12px;
          margin-bottom: 8px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          cursor: pointer;
          transition: all 0.2s ease;
          backdrop-filter: blur(8px);
        }

        .vul-card:hover {
          border-color: var(--accent-blue);
          transform: translateY(-1px);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
        }

        .vul-card.sev-critical-border { border-left: 3px solid #ef4444; }
        .vul-card.sev-high-border { border-left: 3px solid #f97316; }
        .vul-card.sev-medium-border { border-left: 3px solid #eab308; }
        .vul-card.sev-low-border { border-left: 3px solid #38bdf8; }

        .vul-badge-row {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 4px;
        }

        .vul-badge {
          font-size: 9px;
          font-weight: 700;
          padding: 1px 6px;
          border-radius: 3px;
          text-transform: uppercase;
        }

        .vul-badge.sev-critical { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.35); }
        .vul-badge.sev-high { background: rgba(249, 115, 22, 0.2); color: #fb923c; border: 1px solid rgba(249, 115, 22, 0.35); }
        .vul-badge.sev-medium { background: rgba(234, 179, 8, 0.2); color: #facc15; border: 1px solid rgba(234, 179, 8, 0.35); }
        .vul-badge.sev-low { background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); }

        .vul-badge.cwe-badge {
          background: rgba(168, 85, 247, 0.15);
          color: #c084fc;
          border: 1px solid rgba(168, 85, 247, 0.3);
        }

        .vul-badge.tools-badge {
          background: rgba(255, 255, 255, 0.06);
          color: var(--text-muted);
          border: 1px solid var(--card-border);
          text-transform: none;
        }

        .vul-title {
          font-size: 12px;
          font-weight: 600;
          color: #ffffff;
        }

        .vul-loc {
          font-size: 10px;
          font-family: var(--vscode-editor-font-family, monospace);
          color: var(--accent-blue);
        }

        .vul-code-snippet {
          background: #0d1117;
          border: 1px solid var(--card-border);
          border-radius: 4px;
          padding: 6px 8px;
          font-family: var(--vscode-editor-font-family, monospace);
          font-size: 10px;
          color: #e6edf3;
          white-space: pre-wrap;
          word-break: break-all;
          max-height: 80px;
          overflow-y: auto;
        }

        .vul-desc {
          font-size: 11px;
          color: var(--text-muted);
          line-height: 1.4;
        }

        .vul-remediation {
          font-size: 10px;
          color: #e2e8f0;
          background: rgba(56, 189, 248, 0.06);
          border-left: 2px solid var(--accent-blue);
          padding: 5px 8px;
          border-radius: 0 4px 4px 0;
        }

        .vul-card-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-top: 5px;
          border-top: 1px solid rgba(255, 255, 255, 0.05);
        }

        .vul-dblclick-hint {
          font-size: 9px;
          color: var(--text-muted);
          opacity: 0.8;
        }

        .btn-trace-vul {
          background: rgba(56, 189, 248, 0.12);
          color: var(--accent-blue);
          border: 1px solid rgba(56, 189, 248, 0.3);
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s ease;
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .btn-trace-vul:hover {
          background: rgba(56, 189, 248, 0.25);
          border-color: var(--accent-blue);
          color: #ffffff;
        }

        .badge-count {
          background: #ef4444;
          color: #fff;
          font-size: 9px;
          font-weight: 800;
          padding: 1px 5px;
          border-radius: 10px;
          margin-left: 3px;
        }

        /* 4-Engine Status Chips */
        .vul-tools-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
          margin-top: 6px;
        }

        .vul-tool-chip {
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid var(--card-border);
          border-radius: 4px;
          padding: 6px 8px;
          display: flex;
          flex-direction: column;
          gap: 2px;
          transition: all 0.15s ease;
          cursor: pointer;
          user-select: none;
          position: relative;
        }

        .vul-tool-chip:hover {
          border-color: var(--accent-blue);
          background: rgba(30, 36, 48, 0.6);
        }

        .vul-tool-chip.active {
          border-color: var(--accent-blue);
          background: rgba(56, 189, 248, 0.18);
          box-shadow: 0 0 10px rgba(56, 189, 248, 0.35);
        }

        .vul-tool-chip.active .tool-chip-name {
          color: var(--accent-blue);
          font-weight: 700;
        }

        .vul-tool-chip.active::after {
          content: "✓ Active";
          position: absolute;
          top: 4px;
          right: 5px;
          font-size: 8px;
          font-weight: 700;
          color: var(--accent-blue);
          background: rgba(56, 189, 248, 0.15);
          padding: 1px 4px;
          border-radius: 3px;
        }

        .tool-chip-header {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .tool-chip-icon {
          font-size: 11px;
        }

        .tool-chip-name {
          font-size: 10px;
          font-weight: 600;
          color: var(--text-muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .tool-chip-stat {
          font-size: 11px;
          font-weight: 700;
          font-family: monospace;
          color: var(--accent-blue);
        }

        .tool-chip-stat.has-findings {
          color: #f87171;
        }

        /* Live Tool Execution Logs Console */
        .vul-logs-section {
          background: rgba(18, 22, 30, 0.95);
          border: 1px solid var(--card-border);
          border-radius: 6px;
          margin-top: 8px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .vul-logs-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 6px 8px;
          background: rgba(14, 17, 24, 0.95);
          border-bottom: 1px solid var(--card-border);
          font-size: 10px;
          font-weight: 600;
          cursor: pointer;
          user-select: none;
        }

        .vul-logs-header:hover {
          background: rgba(22, 27, 34, 0.95);
        }

        .vul-logs-terminal {
          max-height: 170px;
          min-height: 80px;
          overflow-y: auto;
          padding: 6px 8px;
          font-family: var(--vscode-editor-font-family, monospace);
          font-size: 10px;
          line-height: 1.45;
          background: #090c10;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }

        .log-entry {
          display: flex;
          align-items: flex-start;
          gap: 5px;
          word-break: break-all;
        }

        .log-time {
          color: var(--text-muted);
          font-size: 9px;
          white-space: nowrap;
          opacity: 0.7;
          flex-shrink: 0;
        }

        .log-engine-badge {
          font-size: 8px;
          font-weight: 800;
          padding: 1px 4px;
          border-radius: 3px;
          text-transform: uppercase;
          flex-shrink: 0;
        }

        .badge-engine-filter, .badge-engine-pre-filter { background: rgba(56, 189, 248, 0.15); color: #38bdf8; }
        .badge-engine-sast { background: rgba(168, 85, 247, 0.2); color: #c084fc; }
        .badge-engine-secrets { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
        .badge-engine-atlas-ast { background: rgba(52, 211, 153, 0.2); color: #34d399; }
        .badge-engine-dependencies { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
        .badge-engine-consensus { background: rgba(244, 63, 94, 0.2); color: #fb7185; }

        .log-msg {
          color: #e2e8f0;
          flex: 1;
        }

        .log-msg.level-warn {
          color: #fbbf24;
        }

        .log-msg.level-error {
          color: #f87171;
        }

        .log-msg.level-success {
          color: #4ade80;
        }
      </style>
    </head>
    <body>
      <!-- Ultra-fast Static Skeleton / Instant Splash Screen -->
      <div id="instant-splash-loader" class="instant-splash">
        <div class="splash-content">
          <div class="splash-logo">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              <path d="M9 12l2 2 4-4"/>
            </svg>
          </div>
          <div class="splash-title">CodeSentinel</div>
          <div class="splash-sub">Zero-False-Positive Security &amp; AST Code Graph</div>
          <div class="splash-progress-track">
            <div class="splash-progress-bar"></div>
          </div>
          <div id="splash-status-text" class="splash-status">Bootstrapping security runtime...</div>
        </div>
      </div>

      <div class="app-container">
        <!-- Live First-Time Setup & Provisioning Progress Banner -->
        <div id="setup-progress-banner" class="setup-banner" style="display: none;">
          <div class="setup-header">
            <div class="setup-title">
              <span class="setup-spinner"></span>
              <span id="setup-progress-title">Setting up runtime tools...</span>
            </div>
            <span id="setup-progress-percent" class="setup-pct">0%</span>
          </div>
          <div class="setup-bar-track">
            <div id="setup-bar-fill" class="setup-bar-fill" style="width: 0%;"></div>
          </div>
          <div id="setup-progress-detail" class="setup-detail">Initializing self-contained environment...</div>
        </div>

        <!-- Exactly 3 Tabs -->
        <div class="tabs-header">
          <button class="tab-btn active" data-tab="tab-chat" title="Security Agent">
            <svg class="tab-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              <path d="M9 12l2 2 4-4"/>
            </svg>
            <span>Security Agent</span>
          </button>
          <button class="tab-btn" data-tab="tab-vuls" title="Vulnerabilities">
            <svg class="tab-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span>Vulnerabilities</span>
            <span id="vul-badge-count" class="badge-count" style="display: none;">0</span>
          </button>
          <button class="tab-btn" data-tab="tab-graph" title="360° Code Graph">
            <svg class="tab-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <circle cx="4" cy="6" r="2"/>
              <circle cx="20" cy="6" r="2"/>
              <circle cx="4" cy="18" r="2"/>
              <circle cx="20" cy="18" r="2"/>
              <line x1="6" y1="7" x2="10" y2="10.5"/>
              <line x1="18" y1="7" x2="14" y2="10.5"/>
              <line x1="6" y1="17" x2="10" y2="13.5"/>
              <line x1="18" y1="17" x2="14" y2="13.5"/>
            </svg>
            <span>Code Graph</span>
          </button>
          <button class="tab-btn" data-tab="tab-workspace" title="Active Workspace">
            <svg class="tab-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span>Workspace</span>
          </button>
          <button class="tab-btn" data-tab="tab-tools" title="Registered MCP Tools">
            <svg class="tab-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
            </svg>
            <span>Tools</span>
          </button>
        </div>

        <div class="tab-content">
          <!-- TAB 1: Security Agent (Embedded OpenCode) -->
          <div id="tab-chat" class="tab-pane active">
            <div class="chat-toolbar">
              <div class="toolbar-title">
                <span class="status-dot"></span>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-blue); flex-shrink: 0;">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  <path d="M9 12l2 2 4-4"/>
                </svg>
                <span>Security Agent</span>
                <span style="font-size: 10px; color: var(--text-muted); font-weight: normal; margin-left: 2px;">
                  ${workspace ? `[${this.escapeHtml(workspace.name)}]` : ""}
                </span>
              </div>
              <div class="toolbar-actions">
                <button class="icon-btn" id="btn-reload-chat" title="Reload OpenCode Session">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
                  </svg>
                </button>
                <button class="icon-btn" id="btn-stop-chat" title="Stop Security Agent" style="color: #f87171;">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="4" y="4" width="16" height="16" rx="2" ry="2"/>
                  </svg>
                </button>
                <button class="icon-btn" id="btn-terminal" title="Open Security Agent Terminal">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="4 17 10 11 4 5"/>
                    <line x1="12" y1="19" x2="20" y2="19"/>
                  </svg>
                </button>
                <button class="icon-btn" id="btn-browser" title="Open in External Browser">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                    <polyline points="15 3 21 3 21 9"/>
                    <line x1="10" y1="14" x2="21" y2="3"/>
                  </svg>
                </button>
              </div>
            </div>

            <div id="frame-wrapper" class="frame-wrapper">
              ${serverUrl && isWebRunning
        ? `<iframe id="opencode-frame" src="${serverUrl}" allow="clipboard-read; clipboard-write;"></iframe>`
        : `
                  <div class="chat-placeholder">
                    <div class="agent-logo-badge">
                      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="var(--accent-blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                        <path d="M9 12l2 2 4-4"/>
                      </svg>
                    </div>
                    <strong style="margin-bottom: 6px; font-size: 13px; font-weight: 600;">Security Agent</strong>
                    <p style="color: var(--text-muted); font-size: 11px; margin-bottom: 16px; max-width: 240px; line-height: 1.4;">
                      Continuous Static &amp; Runtime Security Auditor for ${workspace ? this.escapeHtml(workspace.name) : "workspace"}.
                    </p>
                    <div id="agent-provisioning-notice" class="provisioning-callout" style="display: none;">
                      <div style="font-weight: 700; color: #fbbf24; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                        <span>⚠️ First-Time Dependency Setup</span>
                        <span id="agent-prov-pct" style="font-family: monospace; margin-left: auto;">0%</span>
                      </div>
                      <div id="agent-prov-detail" style="font-size: 10px; color: #fde68a; margin-bottom: 4px;">
                        Downloading OpenCode AI Agent, Atlas AST Graph, and Security Engines...
                      </div>
                      <div style="font-size: 9px; color: var(--text-muted);">
                        Action buttons are temporarily disabled while dependencies install and will unlock automatically once ready.
                      </div>
                    </div>
                    <button id="btn-start-chat" class="btn-primary" style="max-width: 210px;">
                      Launch Security Agent
                    </button>
                  </div>
                `
      }
            </div>
          </div>

          <!-- TAB: Vulnerability Scanner -->
          <div id="tab-vuls" class="tab-pane">
            <div class="vul-header-bar">
              <div class="vul-scan-row">
                <div style="display: flex; align-items: center; gap: 6px;">
                  <button id="btn-start-vul-scan" class="pill-btn btn-action" style="padding: 6px 12px; font-size: 11px; display: flex; align-items: center; gap: 6px; box-shadow: 0 2px 8px rgba(56, 189, 248, 0.25);">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                    </svg>
                    <span>Scan Entire Project</span>
                  </button>
                  <button id="btn-rescan-vul" class="pill-btn" style="display: none; padding: 6px 10px; font-size: 11px; background: rgba(56, 189, 248, 0.15); border-color: var(--accent-blue); color: var(--accent-blue); font-weight: 600;" title="Bypass persistent cache and force a complete fresh multi-engine consensus scan">
                    🔄 Re-scan
                  </button>
                </div>
                <div class="vul-status-wrapper">
                  <span class="status-dot" id="vul-status-dot" style="background: var(--accent-blue); box-shadow: 0 0 6px rgba(56, 189, 248, 0.6);"></span>
                  <div id="vul-scan-status" class="status-indicator">Ready (4 consensus engines)</div>
                </div>
              </div>
              <div id="vul-progress-container" style="display: none; width: 100%; height: 3px; background: rgba(255,255,255,0.08); border-radius: 2px; overflow: hidden; margin-top: 4px;">
                <div id="vul-progress-bar" style="height: 100%; width: 0%; background: linear-gradient(90deg, #38bdf8, #818cf8); transition: width 0.15s;"></div>
              </div>
              
              <!-- Metrics Summary Pills -->
              <div class="vul-metrics-pills-row" id="vul-metrics-row">
                <span class="vul-pill pill-total active" id="metric-vul-total" data-sev="all">Total: 0</span>
                <span class="vul-pill pill-critical" id="metric-vul-critical" data-sev="Critical">Critical: 0</span>
                <span class="vul-pill pill-high" id="metric-vul-high" data-sev="High">High: 0</span>
                <span class="vul-pill pill-medium" id="metric-vul-medium" data-sev="Medium">Medium: 0</span>
                <span class="vul-pill pill-low" id="metric-vul-low" data-sev="Low">Low: 0</span>
              </div>

              <!-- Search & Filter Row -->
              <div class="vul-filter-row" style="display: flex; gap: 6px; margin-top: 4px;">
                <input type="text" id="vul-search-input" class="graph-search-input" placeholder="🔍 Search findings (title, CWE, file path)..." autocomplete="off" />
                <div class="category-pills" id="vul-severity-filters">
                  <button class="pill-btn active" data-sev="all">All</button>
                  <button class="pill-btn" data-sev="Critical">Crit</button>
                  <button class="pill-btn" data-sev="High">High</button>
                  <button class="pill-btn" data-sev="Medium">Med</button>
                </div>
              </div>

              <!-- 4-Engine Activity Status Grid -->
              <div class="vul-tools-grid" id="vul-tools-grid">
                <div class="vul-tool-chip" id="tool-chip-sast" title="Opengrep / Semgrep Multi-Language AST SAST Engine — Click to filter findings (click again to unselect)">
                  <div class="tool-chip-header">
                    <span class="tool-chip-icon">🛡️</span>
                    <span class="tool-chip-name">Opengrep AST</span>
                  </div>
                  <div class="tool-chip-stat" id="stat-sast">Idle (0 findings)</div>
                </div>
                <div class="vul-tool-chip" id="tool-chip-secrets" title="Gitleaks Dedicated Enterprise Secret Detector — Click to filter findings (click again to unselect)">
                  <div class="tool-chip-header">
                    <span class="tool-chip-icon">🔑</span>
                    <span class="tool-chip-name">Gitleaks Secrets</span>
                  </div>
                  <div class="tool-chip-stat" id="stat-secrets">Idle (0 leaks)</div>
                </div>
                <div class="vul-tool-chip" id="tool-chip-atlas" title="Atlas Multi-Language Code Graph AST &amp; Dataflow Security — Click to filter findings (click again to unselect)">
                  <div class="tool-chip-header">
                    <span class="tool-chip-icon">🌐</span>
                    <span class="tool-chip-name">Atlas AST Graph</span>
                  </div>
                  <div class="tool-chip-stat" id="stat-atlas">Idle (0 risks)</div>
                </div>
                <div class="vul-tool-chip" id="tool-chip-manifest" title="Google OSV-Scanner &amp; Supply Chain Auditor — Click to filter findings (click again to unselect)">
                  <div class="tool-chip-header">
                    <span class="tool-chip-icon">📦</span>
                    <span class="tool-chip-name">OSV &amp; Supply Chain</span>
                  </div>
                  <div class="tool-chip-stat" id="stat-manifest">Idle (0 advisories)</div>
                </div>
              </div>

              <!-- Expandable Real-time Tool Execution Logs Console -->
              <div class="vul-logs-section">
                <div class="vul-logs-header" id="btn-toggle-vul-logs">
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span id="vul-logs-toggle-icon">▼</span>
                    <strong>Tool Execution Logs</strong>
                    <span class="badge" id="vul-logs-count-badge" style="background: rgba(56, 189, 248, 0.15); color: var(--accent-blue); font-size: 9px;">0 logs</span>
                  </div>
                  <div style="display: flex; align-items: center; gap: 4px;" onclick="event.stopPropagation();">
                    <button class="pill-btn" id="btn-filter-log-findings" style="font-size: 9px; padding: 2px 5px;" title="Show only warnings & findings">Warnings Only</button>
                    <button class="pill-btn" id="btn-show-output-channel" style="font-size: 9px; padding: 2px 5px;" title="Open in VS Code Output panel">Output Panel ↗</button>
                    <button class="pill-btn" id="btn-clear-vul-logs" style="font-size: 9px; padding: 2px 5px;" title="Clear log window">Clear</button>
                  </div>
                </div>
                <div class="vul-logs-terminal" id="vul-logs-terminal">
                  <div class="log-placeholder" style="color: var(--text-muted); font-size: 10px; font-family: monospace; padding: 6px;">
                    [SYSTEM] Ready. Click 'Scan Entire Project' to start multi-engine security analysis. Execution logs from all 4 tools will stream here in real-time.
                  </div>
                </div>
              </div>
            </div>

            <!-- Findings Card Container -->
            <div id="vul-findings-list" class="vul-findings-list" style="flex: 1; overflow-y: auto; padding: 4px 0;">
              <div class="empty-vul-state" style="text-align: center; padding: 36px 16px; color: var(--text-muted);">
                <div class="agent-logo-badge" style="margin: 0 auto 12px auto; width: 44px; height: 44px; border-radius: 10px;">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="var(--accent-blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    <path d="M9 12l2 2 4-4"/>
                  </svg>
                </div>
                <div style="font-weight: 600; font-size: 13px; color: var(--text-main);">No Vulnerability Scan Run Yet</div>
                <div style="font-size: 11px; margin-top: 6px; max-width: 250px; margin-left: auto; margin-right: auto; line-height: 1.4; color: var(--text-muted);">
                  Click <strong>Scan Entire Project</strong> above to inspect this workspace using all 4 SAST, Secrets, AST, and Supply Chain engines.
                </div>
              </div>
            </div>
          </div>

          <!-- TAB: 360° Interactive Code Graph -->
          <div id="tab-graph" class="tab-pane">
            <div class="graph-header-bar">
              <!-- Top Mode Selector Pills -->
              <div class="graph-mode-pills-row">
                <button class="pill-btn active" id="btn-mode-callgraph">Call Graph</button>
                <button class="pill-btn" id="btn-mode-flow">Flow Explainer</button>
                <button class="pill-btn" id="btn-mode-path">Path Finder</button>
                <button class="pill-btn" id="btn-mode-impact">Blast Radius</button>
                <button class="pill-btn" id="btn-mode-deps">Dependencies</button>
                <button class="pill-btn" id="btn-mode-metrics">Metrics</button>
              </div>

              <!-- Toolbar 1b: Flow Explainer -->
              <div id="toolbar-flow" class="graph-subtoolbar" style="display: none;">
                <div class="graph-search-row">
                  <input type="text" id="flow-topic-input" class="graph-search-input" placeholder="Architecture / Feature topic (e.g. login, auth, payment)..." autocomplete="off" />
                  <button class="pill-btn btn-action" id="btn-run-flow">Explain Flow</button>
                </div>
                <div class="graph-filter-pills-row">
                  <div id="flow-status-label" class="status-indicator">Dataflow &amp; execution sequence</div>
                  <button class="pill-btn" id="btn-reload-saved-flow" title="Load latest diagram">↺ Refresh Diagram</button>
                </div>
              </div>

              <!-- Toolbar 1: Call Graph Explorer -->
              <div id="toolbar-callgraph" class="graph-subtoolbar">
                <div class="graph-search-row">
                  <input type="text" id="graph-search-input" class="graph-search-input" placeholder="🔍 Search callable symbols (login, handle, verify)..." autocomplete="off" />
                  <button class="pill-btn" id="btn-reset-graph" title="Reset Camera">🎯 Fit View</button>
                </div>
                <div class="graph-filter-pills-row">
                  <div class="category-pills">
                    <button class="pill-btn active" data-cat="callables">Callables</button>
                    <button class="pill-btn" data-cat="types">Types</button>
                    <button class="pill-btn" data-cat="all">All (21)</button>
                  </div>
                  <div id="graph-status-label" class="status-indicator">Ready</div>
                </div>
              </div>

              <!-- Toolbar 2: Path Finder -->
              <div id="toolbar-path" class="graph-subtoolbar" style="display: none;">
                <div class="graph-search-row">
                  <input type="text" id="path-from-input" class="graph-search-input" placeholder="From Symbol (e.g. activate)" autocomplete="off" />
                  <button class="icon-btn" id="btn-swap-path" title="Swap From/To" style="width: 26px; height: 26px;">⇄</button>
                  <input type="text" id="path-to-input" class="graph-search-input" placeholder="To Symbol (e.g. checkImageExists)" autocomplete="off" />
                  <button class="pill-btn btn-action" id="btn-run-path">Find Path</button>
                </div>
                <div class="graph-filter-pills-row">
                  <label class="checkbox-label"><input type="checkbox" id="chk-prefer-prod" checked /> Prefer Production</label>
                  <div id="path-status-label" class="status-indicator">Enter 2 symbols</div>
                </div>
                <div id="reverse-path-banner" class="reverse-banner" style="display: none;">
                  <span id="reverse-path-text">Reverse call path detected!</span>
                  <button class="pill-btn" id="btn-reverse-swap" style="background: var(--accent-blue); color: #000; font-weight: 700;">Swap &amp; View</button>
                </div>
              </div>

              <!-- Toolbar 3: Blast Radius -->
              <div id="toolbar-impact" class="graph-subtoolbar" style="display: none;">
                <div class="graph-search-row">
                  <input type="text" id="impact-target-input" class="graph-search-input" placeholder="Target Symbol for Blast Radius..." autocomplete="off" />
                  <div class="direction-toggle">
                    <button class="pill-btn active" id="btn-impact-downstream">Downstream</button>
                    <button class="pill-btn" id="btn-impact-upstream">Upstream</button>
                  </div>
                  <button class="pill-btn btn-action" id="btn-run-impact">Analyze</button>
                </div>
                <div class="graph-filter-pills-row">
                  <div class="rings-pills">
                    <button class="pill-btn active" data-depth="1">1 Ring</button>
                    <button class="pill-btn" data-depth="2">2 Rings</button>
                    <button class="pill-btn" data-depth="3">3 Rings</button>
                    <button class="pill-btn" data-depth="4">4 Rings</button>
                  </div>
                  <div id="impact-status-label" class="status-indicator">Select symbol</div>
                </div>
              </div>

              <!-- Toolbar 4: Dependencies -->
              <div id="toolbar-deps" class="graph-subtoolbar" style="display: none;">
                <div class="graph-search-row">
                  <input type="text" id="deps-filter-input" class="graph-search-input" placeholder="Filter file path (optional, leave empty for all)..." autocomplete="off" />
                  <button class="pill-btn btn-action" id="btn-load-deps">Load Dependencies</button>
                </div>
                <div class="graph-filter-pills-row">
                  <div id="deps-status-label" class="status-indicator">Cross-file import graph</div>
                </div>
              </div>

              <!-- Universal Autocomplete Dropdown -->
              <div id="universal-search-dropdown" class="search-results-dropdown"></div>
            </div>

            <!-- Viewport Canvas -->
            <div class="graph-canvas-viewport" id="graph-viewport">
              <div class="graph-world" id="graph-world">
                <svg class="graph-svg-layer" id="graph-svg">
                  <defs>
                    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 1 L 10 5 L 0 9 z" fill="rgba(56, 189, 248, 0.7)"/>
                    </marker>
                    <marker id="arrow-tainted" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 1 L 10 5 L 0 9 z" fill="#f43f5e"/>
                    </marker>
                    <marker id="arrow-impact" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 1 L 10 5 L 0 9 z" fill="#f97316"/>
                    </marker>
                    <marker id="arrow-deps" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 1 L 10 5 L 0 9 z" fill="#3b82f6"/>
                    </marker>
                  </defs>
                </svg>
                <div class="graph-nodes-layer" id="graph-nodes"></div>
              </div>

              <!-- Metrics View Overlay -->
              <div id="metrics-overlay-view" class="metrics-overlay" style="display: none;">
                <div class="metrics-grid">
                  <div class="metrics-card">
                    <div class="metric-num" id="metric-indexed-files">0</div>
                    <div class="metric-label">Indexed Source Files</div>
                  </div>
                  <div class="metrics-card">
                    <div class="metric-num" id="metric-extracted-symbols">0</div>
                    <div class="metric-label">Extracted AST Symbols</div>
                  </div>
                </div>
                <div class="metrics-card full-width">
                  <div class="metric-label">Local SQLite Facts Store</div>
                  <div class="metric-dbpath" id="metric-db-path">.codesentinel/atlas.db</div>
                </div>
                <div class="metrics-actions">
                  <button id="btn-metrics-sync" class="btn-primary">⚡ Incremental Sync Graph</button>
                  <button id="btn-metrics-rebuild" class="btn-secondary" style="padding: 7px; text-align: center;">🔄 Rebuild Full Graph</button>
                </div>
              </div>

              <!-- Slide-Over Side Drawer Code Inspector -->
              <div class="graph-side-drawer" id="graph-drawer">
                <div class="drawer-header">
                  <div class="drawer-title" id="drawer-symbol-name">Symbol Name</div>
                  <button class="icon-btn" id="btn-close-drawer" style="width: 20px; height: 20px;">✕</button>
                </div>
                <div class="drawer-body">
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span class="node-kind-badge" id="drawer-symbol-kind">Function</span>
                    <span style="font-size: 10px; color: var(--text-muted);" id="drawer-symbol-loc">file.ts:10</span>
                  </div>
                  <div style="font-size: 10px; color: var(--text-muted); font-family: monospace;" id="drawer-symbol-sig">signature()</div>
                  
                  <div class="drawer-metrics-grid">
                    <div class="drawer-metric-box" id="drawer-callers-box">
                      <div class="drawer-metric-num" id="drawer-callers-count">0</div>
                      <div class="drawer-metric-label">Incoming Callers</div>
                    </div>
                    <div class="drawer-metric-box" id="drawer-callees-box">
                      <div class="drawer-metric-num" id="drawer-callees-count">0</div>
                      <div class="drawer-metric-label">Outgoing Callees</div>
                    </div>
                  </div>

                  <div class="section-title" style="margin: 6px 0 2px 0;">Code Snippet</div>
                  <div class="drawer-code-block" id="drawer-code-content">// Clicked node snippet</div>
                </div>
                <div class="drawer-actions">
                  <button class="btn-primary" id="btn-drawer-jump" style="padding: 6px 10px;">🚀 Jump to Editor</button>
                  <button class="btn-secondary" id="btn-drawer-ask" style="padding: 6px 10px; text-align: center;">🤖 Audit with Agent</button>
                </div>
              </div>
            </div>
          </div>

          <!-- TAB: Workspace Details -->
          <div id="tab-workspace" class="tab-pane">
            <div class="section-title">Active Repository</div>
            ${workspaceHtml}

            <div class="card" style="margin-top: 6px;">
              <div class="section-title" style="margin-top: 0;">Backend Execution</div>
              <div class="toggle-card">
                <span style="font-size: 11px; font-weight: 600;">
                  ${backendMode === "local" ? "Local Runtime (Self-Contained)" : "Cloud Endpoint (Remote)"}
                </span>
                <button id="btn-toggle-backend" class="btn-secondary">Switch</button>
              </div>
              <div class="meta-row" style="margin-top: 8px;">
                <span class="label">Runtime:</span>
                <span class="badge badge-success" style="font-family: monospace;">
                  Native Extension Storage (Zero Docker)
                </span>
              </div>
              <div class="meta-row">
                <span class="label">Environment:</span>
                <span class="badge badge-success">Self-Contained Data Directory</span>
              </div>
            </div>

            <button id="btn-sync" class="btn-primary" style="margin-top: 8px;">
              Sync MCP Configuration
            </button>
            <button id="btn-index-atlas" class="btn-secondary" style="width: 100%; margin-top: 6px; padding: 7px 12px; font-weight: 600; text-align: center;">
              ⚡ Index Codebase with Atlas Graph
            </button>
          </div>

          <!-- TAB 3: MCP Tools -->
          <div id="tab-tools" class="tab-pane">
            <div class="section-title">Registered MCP Tools (${tools.length})</div>
            <div>
              ${toolsHtml}
            </div>
          </div>
        </div>
      </div>

      <script>
        const vscode = acquireVsCodeApi();

        function escapeClientHtml(str) {
          if (!str) return '';
          return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
        }

        // Persistent Tab Selection via Webview State
        const savedState = vscode.getState() || { activeTab: 'tab-chat' };

        function selectTab(tabId) {
          document.querySelectorAll('.tab-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === tabId);
          });
          document.querySelectorAll('.tab-pane').forEach(p => {
            const isActive = p.id === tabId;
            p.classList.toggle('active', isActive);
            if (p.id === 'tab-chat') {
              p.style.visibility = isActive ? 'visible' : 'hidden';
              p.style.pointerEvents = isActive ? 'auto' : 'none';
              p.style.opacity = isActive ? '1' : '0';
              p.style.zIndex = isActive ? '50' : '-1';
            } else if (p.id === 'tab-graph') {
              p.style.display = isActive ? 'flex' : 'none';
              p.style.visibility = isActive ? 'visible' : 'hidden';
              p.style.pointerEvents = isActive ? 'auto' : 'none';
              p.style.opacity = isActive ? '1' : '0';
              p.style.zIndex = isActive ? '50' : '-1';
            } else {
              p.style.display = isActive ? 'flex' : 'none';
              p.style.zIndex = isActive ? '50' : '-1';
            }
          });
          // When switching away from Code Graph, forcibly close dropdowns, drawers, and overlay
          if (tabId !== 'tab-graph') {
            const dropdown = document.getElementById('universal-search-dropdown');
            if (dropdown) dropdown.style.display = 'none';
            const drawer = document.getElementById('graph-drawer');
            if (drawer) drawer.classList.remove('open');
            const metrics = document.getElementById('metrics-overlay-view');
            if (metrics) metrics.style.display = 'none';
          }
          vscode.setState({ activeTab: tabId });
        }

        // Restore active tab
        if (savedState && savedState.activeTab) {
          selectTab(savedState.activeTab);
        }

        // Tab Switching Click Handlers (Instant switching, zero iframe reload, zero backend churn)
        document.querySelectorAll('.tab-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            selectTab(btn.dataset.tab);
          });
        });

        // Chat controls (Terminal, Browser, Reload)
        document.getElementById('btn-start-chat')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'startChat' });
        });

        document.getElementById('btn-reload-chat')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'reloadChat' });
        });

        document.getElementById('btn-stop-chat')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'stopChat' });
        });

        document.getElementById('btn-terminal')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'launchTerminal' });
        });

        document.getElementById('btn-browser')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'launchWeb' });
        });

        document.getElementById('btn-open-folder')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'openFolder' });
        });

        // Workspace tab actions
        document.getElementById('btn-sync')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'syncMcpConfig' });
        });

        document.getElementById('btn-deploy-container')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'deployContainer' });
        });

        document.getElementById('btn-index-atlas')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'indexAtlas' });
        });

        document.getElementById('btn-toggle-backend')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'toggleBackendMode' });
        });

        // ==========================================
        // 360° Interactive Branching Code Graph
        // ==========================================
        let graphInitialized = false;
        let graphState = {
          pan: { x: 0, y: 0 },
          zoom: 1,
          isDragging: false,
          dragStart: { x: 0, y: 0 },
          rootSymbol: null,
          nodes: {}, // name -> { data, x, y, el, callersExpanded: bool, calleesExpanded: bool, childCallerNames: [], childCalleeNames: [] }
          edges: [],
          selectedSymbol: null,
          mode: 'tree'
        };

        const viewportEl = document.getElementById('graph-viewport');
        const worldEl = document.getElementById('graph-world');
        const svgEl = document.getElementById('graph-svg');
        const nodesContainerEl = document.getElementById('graph-nodes');
        const drawerEl = document.getElementById('graph-drawer');
        const searchInputEl = document.getElementById('graph-search-input');
        const searchDropdownEl = document.getElementById('search-results-dropdown');
        const statusLabelEl = document.getElementById('graph-status-label');

        function updateWorldTransform() {
          if (worldEl) {
            worldEl.style.transform = 'translate(' + graphState.pan.x + 'px, ' + graphState.pan.y + 'px) scale(' + graphState.zoom + ')';
          }
        }

        function resetGraphCamera() {
          if (!viewportEl) return;
          const rect = viewportEl.getBoundingClientRect();
          const nodeKeys = Object.keys(graphState.nodes);
          if (nodeKeys.length === 0) {
            graphState.zoom = 1;
            graphState.pan = { x: (rect.width || 300) / 2, y: (rect.height || 400) / 2 };
            updateWorldTransform();
            return;
          }

          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          nodeKeys.forEach(k => {
            const n = graphState.nodes[k];
            if (n.x < minX) minX = n.x;
            if (n.x > maxX) maxX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.y > maxY) maxY = n.y;
          });

          minX -= 90; maxX += 90;
          minY -= 40; maxY += 40;

          const contentW = Math.max(maxX - minX, 180);
          const contentH = Math.max(maxY - minY, 180);
          const viewW = rect.width || 380;
          const viewH = rect.height || 450;

          const scaleX = (viewW * 0.92) / contentW;
          const scaleY = (viewH * 0.92) / contentH;
          const zoom = Math.min(Math.max(Math.min(scaleX, scaleY), 0.35), 1.15);

          const midX = (minX + maxX) / 2;
          const midY = (minY + maxY) / 2;

          graphState.zoom = zoom;
          graphState.pan = {
            x: (viewW / 2) - midX * zoom,
            y: (viewH / 2) - midY * zoom
          };
          updateWorldTransform();
        }

        // Node dragging state
        let activeDragNode = null;
        let dragNodeStart = { mouseX: 0, mouseY: 0, initialX: 0, initialY: 0 };
        let nodeHasDragged = false;

        // Viewport Drag to Pan
        viewportEl?.addEventListener('mousedown', (e) => {
          if (e.target === viewportEl || e.target === svgEl || e.target === nodesContainerEl || e.target === worldEl) {
            graphState.isDragging = true;
            graphState.dragStart = { x: e.clientX - graphState.pan.x, y: e.clientY - graphState.pan.y };
          }
        });

        window.addEventListener('mousemove', (e) => {
          if (activeDragNode) {
            const dx = (e.clientX - dragNodeStart.mouseX) / graphState.zoom;
            const dy = (e.clientY - dragNodeStart.mouseY) / graphState.zoom;
            if (Math.abs(e.clientX - dragNodeStart.mouseX) > 3 || Math.abs(e.clientY - dragNodeStart.mouseY) > 3) {
              nodeHasDragged = true;
            }
            activeDragNode.x = Math.round(dragNodeStart.initialX + dx);
            activeDragNode.y = Math.round(dragNodeStart.initialY + dy);
            activeDragNode.el.style.left = activeDragNode.x + 'px';
            activeDragNode.el.style.top = activeDragNode.y + 'px';
            drawEdges();
          } else if (graphState.isDragging) {
            graphState.pan = { x: e.clientX - graphState.dragStart.x, y: e.clientY - graphState.dragStart.y };
            updateWorldTransform();
          }
        });

        window.addEventListener('mouseup', () => {
          if (activeDragNode) {
            activeDragNode.el.classList.remove('dragging');
            activeDragNode = null;
          }
          graphState.isDragging = false;
        });

        // Wheel to Zoom
        viewportEl?.addEventListener('wheel', (e) => {
          e.preventDefault();
          const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
          const newZoom = Math.min(Math.max(graphState.zoom * zoomFactor, 0.35), 2.5);
          graphState.zoom = newZoom;
          updateWorldTransform();
        }, { passive: false });

        document.getElementById('btn-reset-graph')?.addEventListener('click', () => {
          resetGraphCamera();
        });

        // Render Graph Hierarchy
        function renderGraphTree(root, callers, callees, edges) {
          nodesContainerEl.innerHTML = '';
          svgEl.querySelectorAll('path').forEach(p => p.remove());
          graphState.nodes = {};
          graphState.edges = edges || [];
          graphState.rootSymbol = root;

          // 1. Root node at (0, 0)
          createNodeElement(root, 0, 0, 'root-node');

          // Deduplicate callers and callees by unique symbol key (path + line + name)
          const uniqueCallers = [];
          const seenCallers = new Set([root.name]);
          (callers || []).forEach(c => {
            const key = c.name;
            if (!seenCallers.has(key)) {
              seenCallers.add(key);
              uniqueCallers.push(c);
            }
          });

          const uniqueCallees = [];
          const seenCallees = new Set([root.name]);
          (callees || []).forEach(c => {
            const key = c.name;
            if (!seenCallees.has(key)) {
              seenCallees.add(key);
              uniqueCallees.push(c);
            }
          });

          graphState.nodes[root.name].callersExpanded = uniqueCallers.length > 0;
          graphState.nodes[root.name].calleesExpanded = uniqueCallees.length > 0;
          graphState.nodes[root.name].childCallerNames = uniqueCallers.map(c => c.name);
          graphState.nodes[root.name].childCalleeNames = uniqueCallees.map(c => c.name);

          // 2. Callers arranged above in multi-row grid (up to 6 columns per row)
          const callerCount = uniqueCallers.length;
          const maxCols = 6;
          const colSpacing = 185;
          const rowSpacing = 95;
          uniqueCallers.forEach((c, idx) => {
            const row = Math.floor(idx / maxCols);
            const col = idx % maxCols;
            const itemsInThisRow = Math.min(callerCount - row * maxCols, maxCols);
            const rowStartX = -((itemsInThisRow - 1) * colSpacing) / 2;
            const x = rowStartX + col * colSpacing;
            const y = -130 - row * rowSpacing;
            createNodeElement(c, x, y, 'caller-node');
          });

          // 3. Callees arranged below in multi-row grid (up to 6 columns per row)
          const calleeCount = uniqueCallees.length;
          uniqueCallees.forEach((c, idx) => {
            const row = Math.floor(idx / maxCols);
            const col = idx % maxCols;
            const itemsInThisRow = Math.min(calleeCount - row * maxCols, maxCols);
            const rowStartX = -((itemsInThisRow - 1) * colSpacing) / 2;
            const x = rowStartX + col * colSpacing;
            const y = 130 + row * rowSpacing;
            createNodeElement(c, x, y, 'callee-node');
          });

          drawEdges();
          resetGraphCamera();
          if (statusLabelEl) {
            statusLabelEl.textContent = root.name + ' (' + (uniqueCallers.length + uniqueCallees.length) + ' links)';
          }
        }

        function createNodeElement(sym, x, y, extraClass = '') {
          // If a card with this exact symbol name already exists, remove it first
          if (graphState.nodes[sym.name] && graphState.nodes[sym.name].el) {
            graphState.nodes[sym.name].el.remove();
          }

          const card = document.createElement('div');
          card.className = 'graph-node-card ' + extraClass;
          card.style.left = x + 'px';
          card.style.top = y + 'px';
          card.dataset.name = sym.name;

          const hasMoreCallers = sym.callerCount > 0;
          const hasMoreCallees = sym.calleeCount > 0;

          const fileName = sym.path ? sym.path.split('/').pop() : '';
          const isRoot = graphState.rootSymbol && sym.name === graphState.rootSymbol.name;
          const callerActive = isRoot ? 'expanded' : '';
          const calleeActive = isRoot ? 'expanded' : '';

          card.innerHTML = 
            '<div class="node-top-bar">' +
              '<span class="node-kind-badge">' + (sym.kind || 'fn') + '</span>' +
              '<span class="node-lang-pill">' + (sym.language || '') + '</span>' +
            '</div>' +
            '<div class="node-symbol-title" title="' + sym.name + '">' + sym.name + '</div>' +
            '<div class="node-loc-sub" title="' + sym.path + ':' + sym.startLine + '">' + fileName + ':' + sym.startLine + '</div>' +
            '<div class="node-branch-bar">' +
              '<span class="branch-pill branch-caller-pill ' + callerActive + '" title="Toggle incoming callers">▲ ' + sym.callerCount + '</span>' +
              '<span class="branch-pill branch-callee-pill ' + calleeActive + '" title="Toggle outgoing callees">▼ ' + sym.calleeCount + '</span>' +
            '</div>';

          // Dragging mousedown on card
          card.addEventListener('mousedown', (e) => {
            if (e.target.closest('.branch-pill')) return;
            if (e.button !== 0) return; // Left click only
            e.stopPropagation(); // Prevent viewport pan
            const node = graphState.nodes[sym.name];
            activeDragNode = node;
            dragNodeStart = {
              mouseX: e.clientX,
              mouseY: e.clientY,
              initialX: node ? node.x : x,
              initialY: node ? node.y : y
            };
            nodeHasDragged = false;
            card.classList.add('dragging');
          });

          // Single click selects & opens drawer (only if not dragged)
          card.addEventListener('click', (e) => {
            if (nodeHasDragged) {
              nodeHasDragged = false;
              return;
            }
            if (e.target.closest('.branch-pill')) return;
            selectNode(sym);
          });

          // Double click jumps to file
          card.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'openInEditor', path: sym.path, line: sym.startLine });
          });

          // Branch toggle callers
          card.querySelector('.branch-caller-pill')?.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleBranch(sym.name, 'callers');
          });

          // Branch toggle callees
          card.querySelector('.branch-callee-pill')?.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleBranch(sym.name, 'callees');
          });

          nodesContainerEl.appendChild(card);
          graphState.nodes[sym.name] = {
            data: sym,
            x: x,
            y: y,
            el: card,
            callersExpanded: false,
            calleesExpanded: false,
            childCallerNames: [],
            childCalleeNames: []
          };
        }

        function toggleBranch(symbolName, direction) {
          const node = graphState.nodes[symbolName];
          if (!node) return;

          const isExpanded = direction === 'callers' ? node.callersExpanded : node.calleesExpanded;
          const pill = node.el.querySelector(direction === 'callers' ? '.branch-caller-pill' : '.branch-callee-pill');

          if (isExpanded) {
            // Collapse children smoothly
            const childNames = direction === 'callers' ? node.childCallerNames : node.childCalleeNames;
            childNames.forEach(childName => {
              if (graphState.nodes[childName] && childName !== graphState.rootSymbol?.name) {
                graphState.nodes[childName].el.remove();
                delete graphState.nodes[childName];
              }
            });
            if (direction === 'callers') {
              node.callersExpanded = false;
              node.childCallerNames = [];
            } else {
              node.calleesExpanded = false;
              node.childCalleeNames = [];
            }
            if (pill) pill.classList.remove('expanded');
            drawEdges();
          } else {
            // Request expansion from host
            if (statusLabelEl) statusLabelEl.textContent = 'Branching ' + symbolName + '...';
            vscode.postMessage({ command: 'expandBranch', symbolName: symbolName, direction: direction, limit: 60 });
            if (pill) pill.classList.add('expanded');
          }
        }

        function handleBranchExpanded(parentName, direction, newSymbols, newEdges) {
          const parentNode = graphState.nodes[parentName];
          if (!parentNode || !newSymbols || newSymbols.length === 0) {
            if (statusLabelEl) statusLabelEl.textContent = 'No deeper ' + direction + ' found.';
            return;
          }

          // Deduplicate incoming newSymbols
          const uniqueSymbols = [];
          const seenSymbols = new Set();
          newSymbols.forEach(sym => {
            if (sym && sym.name && !seenSymbols.has(sym.name) && !graphState.nodes[sym.name]) {
              seenSymbols.add(sym.name);
              uniqueSymbols.push(sym);
            }
          });

          if (uniqueSymbols.length === 0) {
            if (statusLabelEl) statusLabelEl.textContent = 'All ' + direction + ' already visible on canvas.';
            return;
          }

          const count = uniqueSymbols.length;
          const maxCols = 6;
          const colSpacing = 185;
          const rowSpacing = 95;
          const childNames = [];

          uniqueSymbols.forEach((sym, idx) => {
            const row = Math.floor(idx / maxCols);
            const col = idx % maxCols;
            const itemsInThisRow = Math.min(count - row * maxCols, maxCols);
            const rowStartX = parentNode.x - ((itemsInThisRow - 1) * colSpacing) / 2;
            const x = rowStartX + col * colSpacing;
            const y = direction === 'callers'
              ? parentNode.y - 130 - row * rowSpacing
              : parentNode.y + 130 + row * rowSpacing;
            createNodeElement(sym, x, y, direction === 'callers' ? 'caller-node' : 'callee-node');
            childNames.push(sym.name);
          });

          if (direction === 'callers') {
            parentNode.callersExpanded = true;
            parentNode.childCallerNames = childNames;
          } else {
            parentNode.calleesExpanded = true;
            parentNode.childCalleeNames = childNames;
          }

          if (newEdges) {
            newEdges.forEach(e => {
              if (!graphState.edges.some(existing => existing.id === e.id)) {
                graphState.edges.push(e);
              }
            });
          }

          drawEdges();
          resetGraphCamera();
          if (statusLabelEl) statusLabelEl.textContent = 'Expanded ' + uniqueSymbols.length + ' ' + direction + '.';
        }

        function drawEdges() {
          svgEl.querySelectorAll('path').forEach(p => p.remove());
          const drawnEdges = new Set();

          graphState.edges.forEach(edge => {
            const edgeKey = edge.source + '->' + edge.target;
            if (drawnEdges.has(edgeKey)) return;
            drawnEdges.add(edgeKey);

            const srcNode = graphState.nodes[edge.source];
            const tgtNode = graphState.nodes[edge.target];
            if (!srcNode || !tgtNode) return;

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const dx = tgtNode.x - srcNode.x;
            const dy = tgtNode.y - srcNode.y;
            const cx1 = srcNode.x;
            const cy1 = srcNode.y + dy * 0.45;
            const cx2 = tgtNode.x;
            const cy2 = tgtNode.y - dy * 0.45;

            const d = 'M ' + srcNode.x + ' ' + srcNode.y + ' C ' + cx1 + ' ' + cy1 + ', ' + cx2 + ' ' + cy2 + ', ' + tgtNode.x + ' ' + tgtNode.y;
            path.setAttribute('d', d);
            path.setAttribute('class', 'graph-edge-path pulse ' + (edge.isTainted ? 'tainted' : ''));
            path.setAttribute('marker-end', edge.isTainted ? 'url(#arrow-tainted)' : 'url(#arrow)');

            svgEl.appendChild(path);
          });
        }

        // Side Drawer Node Selection
        function selectNode(sym) {
          graphState.selectedSymbol = sym;
          document.querySelectorAll('.graph-node-card').forEach(c => {
            c.style.borderColor = c.dataset.name === sym.name ? 'var(--accent-blue)' : '';
          });

          document.getElementById('drawer-symbol-name').textContent = sym.name;
          document.getElementById('drawer-symbol-kind').textContent = sym.kind || 'function';
          document.getElementById('drawer-symbol-loc').textContent = sym.path + ':' + sym.startLine;
          document.getElementById('drawer-symbol-sig').textContent = sym.signature || (sym.kind + ' ' + sym.name + '()');
          document.getElementById('drawer-code-content').textContent = '// Loading source snippet...';
          const callersCountEl = document.getElementById('drawer-callers-count');
          if (callersCountEl) callersCountEl.textContent = sym.callerCount != null ? sym.callerCount : '0';
          const calleesCountEl = document.getElementById('drawer-callees-count');
          if (calleesCountEl) calleesCountEl.textContent = sym.calleeCount != null ? sym.calleeCount : '0';

          drawerEl?.classList.add('open');
          vscode.postMessage({
            command: 'getCodeSnippet',
            name: sym.name,
            path: sym.path,
            startLine: sym.startLine,
            endLine: sym.endLine
          });
        }

        document.getElementById('btn-close-drawer')?.addEventListener('click', () => {
          drawerEl?.classList.remove('open');
        });

        document.getElementById('btn-drawer-jump')?.addEventListener('click', () => {
          if (graphState.selectedSymbol) {
            vscode.postMessage({
              command: 'openInEditor',
              path: graphState.selectedSymbol.path,
              line: graphState.selectedSymbol.startLine
            });
          }
        });

        document.getElementById('btn-drawer-ask')?.addEventListener('click', () => {
          if (graphState.selectedSymbol) {
            vscode.postMessage({
              command: 'askAgentAboutSymbol',
              name: graphState.selectedSymbol.name,
              path: graphState.selectedSymbol.path,
              startLine: graphState.selectedSymbol.startLine,
              endLine: graphState.selectedSymbol.endLine
            });
          }
        });

        // Universal Autocomplete Search Routing
        let activeSearchTarget = null;
        let activeSearchCategory = 'callables';
        let searchTimeout = null;
        const universalDropdown = document.getElementById('universal-search-dropdown');

        function triggerSearch(query, target, category) {
          activeSearchTarget = target;
          activeSearchCategory = category || 'callables';
          clearTimeout(searchTimeout);
          if (!query.trim()) {
            if (universalDropdown) universalDropdown.style.display = 'none';
            return;
          }
          searchTimeout = setTimeout(() => {
            vscode.postMessage({
              command: 'searchSymbols',
              query: query.trim(),
              category: activeSearchCategory,
              target: activeSearchTarget
            });
          }, 180);
        }

        // Attach autocomplete to all inputs
        document.getElementById('graph-search-input')?.addEventListener('input', (e) => {
          triggerSearch(e.target.value, 'explorer', activeSearchCategory);
        });
        document.getElementById('path-from-input')?.addEventListener('input', (e) => {
          triggerSearch(e.target.value, 'pathFrom', 'callables');
        });
        document.getElementById('path-to-input')?.addEventListener('input', (e) => {
          triggerSearch(e.target.value, 'pathTo', 'callables');
        });
        document.getElementById('impact-target-input')?.addEventListener('input', (e) => {
          triggerSearch(e.target.value, 'impact', 'all');
        });
        document.getElementById('deps-filter-input')?.addEventListener('input', (e) => {
          triggerSearch(e.target.value, 'deps', 'files');
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
          if (!e.target.closest('.graph-search-row') && !e.target.closest('.search-results-dropdown')) {
            if (universalDropdown) universalDropdown.style.display = 'none';
          }
        });

        // Category pills filter in Call Graph
        document.querySelectorAll('.category-pills .pill-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            document.querySelectorAll('.category-pills .pill-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeSearchCategory = btn.dataset.cat || 'callables';
            const val = document.getElementById('graph-search-input')?.value || '';
            if (val) triggerSearch(val, 'explorer', activeSearchCategory);
          });
        });

        // 6-Mode Switching
        let currentGraphMode = 'callgraph';
        const modeButtons = {
          callgraph: document.getElementById('btn-mode-callgraph'),
          flow: document.getElementById('btn-mode-flow'),
          path: document.getElementById('btn-mode-path'),
          impact: document.getElementById('btn-mode-impact'),
          deps: document.getElementById('btn-mode-deps'),
          metrics: document.getElementById('btn-mode-metrics'),
        };
        const toolbars = {
          callgraph: document.getElementById('toolbar-callgraph'),
          flow: document.getElementById('toolbar-flow'),
          path: document.getElementById('toolbar-path'),
          impact: document.getElementById('toolbar-impact'),
          deps: document.getElementById('toolbar-deps'),
        };
        const metricsOverlay = document.getElementById('metrics-overlay-view');

        function switchGraphMode(mode) {
          currentGraphMode = mode;
          Object.keys(modeButtons).forEach(m => {
            modeButtons[m]?.classList.toggle('active', m === mode);
          });
          Object.keys(toolbars).forEach(t => {
            if (toolbars[t]) toolbars[t].style.display = t === mode ? 'flex' : 'none';
          });
          if (metricsOverlay) {
            metricsOverlay.style.display = mode === 'metrics' ? 'flex' : 'none';
          }
          if (universalDropdown) universalDropdown.style.display = 'none';

          if (mode === 'metrics') {
            vscode.postMessage({ command: 'getGraphStats' });
          } else if (mode === 'flow') {
            vscode.postMessage({ command: 'getFlowDiagram' });
          } else if (mode === 'callgraph' && graphState.rootSymbol) {
            vscode.postMessage({ command: 'getGraphData', symbolName: graphState.rootSymbol.name });
          }
        }

        modeButtons.callgraph?.addEventListener('click', () => switchGraphMode('callgraph'));
        modeButtons.flow?.addEventListener('click', () => switchGraphMode('flow'));
        modeButtons.path?.addEventListener('click', () => switchGraphMode('path'));
        modeButtons.impact?.addEventListener('click', () => switchGraphMode('impact'));
        modeButtons.deps?.addEventListener('click', () => switchGraphMode('deps'));
        modeButtons.metrics?.addEventListener('click', () => switchGraphMode('metrics'));

        // Flow Explainer Actions
        document.getElementById('btn-run-flow')?.addEventListener('click', () => {
          const topic = document.getElementById('flow-topic-input')?.value || 'login';
          const statusEl = document.getElementById('flow-status-label');
          if (statusEl) statusEl.textContent = 'Tracing dataflow for "' + topic + '"...';
          vscode.postMessage({ command: 'runExplainFlow', topic });
        });

        document.getElementById('btn-reload-saved-flow')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'getFlowDiagram' });
        });

        function renderFlowGraph(flow) {
          nodesContainerEl.innerHTML = '';
          svgEl.querySelectorAll('path').forEach(p => p.remove());
          graphState.nodes = {};
          graphState.edges = flow.graph.edges || [];
          graphState.rootSymbol = flow.graph.nodes && flow.graph.nodes[0] ? { name: flow.graph.nodes[0].name } : null;

          const nodes = flow.graph.nodes || [];
          const count = nodes.length;
          const colSpacing = 240;
          const rowOffset = 50;

          nodes.forEach((n, idx) => {
            const x = idx * colSpacing - ((count - 1) * colSpacing) / 2;
            const y = (idx % 2 === 1) ? rowOffset : -rowOffset;
            const card = document.createElement('div');
            card.className = 'graph-node-card root-node';
            card.style.left = x + 'px';
            card.style.top = y + 'px';
            card.dataset.name = n.name;

            const fileName = n.path ? n.path.split('/').pop() : '';
            card.innerHTML = 
              '<div class="node-top-bar">' +
                '<span class="node-kind-badge" style="background: rgba(168, 85, 247, 0.2); color: var(--accent-purple); font-weight: 700;">STEP ' + (n.step || idx + 1) + '</span>' +
                '<span class="node-lang-pill" style="color: var(--accent-blue); font-weight: 600;">' + escapeClientHtml(n.role || 'stage') + '</span>' +
              '</div>' +
              '<div class="node-symbol-title" title="' + escapeClientHtml(n.name) + '">' + escapeClientHtml(n.name) + '</div>' +
              '<div class="node-loc-sub" title="' + escapeClientHtml(n.path) + '">' + escapeClientHtml(fileName ? fileName + ':' + n.startLine : n.path) + '</div>' +
              '<div style="font-size: 9px; color: var(--text-muted); margin-top: 4px; line-height: 1.3; max-height: 38px; overflow: hidden; text-overflow: ellipsis;">' + escapeClientHtml(n.description || '') + '</div>';

            card.addEventListener('click', () => {
              selectNode({
                name: n.name,
                kind: n.kind,
                path: n.path,
                startLine: n.startLine,
                endLine: n.endLine,
                signature: (n.role ? '[' + n.role + '] ' : '') + n.name + '()',
                callerCount: idx > 0 ? 1 : 0,
                calleeCount: idx < count - 1 ? 1 : 0,
              });
            });

            card.addEventListener('dblclick', () => {
              if (n.path) {
                vscode.postMessage({ command: 'openInEditor', path: n.path, line: n.startLine });
              }
            });

            nodesContainerEl.appendChild(card);
            graphState.nodes[n.name] = { data: n, x, y, el: card };
          });

          drawEdges();
          resetGraphCamera();
        }

        // Path Finder Actions
        document.getElementById('btn-swap-path')?.addEventListener('click', () => {
          const fromEl = document.getElementById('path-from-input');
          const toEl = document.getElementById('path-to-input');
          if (fromEl && toEl) {
            const temp = fromEl.value;
            fromEl.value = toEl.value;
            toEl.value = temp;
          }
        });

        document.getElementById('btn-reverse-swap')?.addEventListener('click', () => {
          const fromEl = document.getElementById('path-from-input');
          const toEl = document.getElementById('path-to-input');
          if (fromEl && toEl) {
            const temp = fromEl.value;
            fromEl.value = toEl.value;
            toEl.value = temp;
            document.getElementById('btn-run-path')?.click();
          }
        });

        document.getElementById('btn-run-path')?.addEventListener('click', () => {
          const from = document.getElementById('path-from-input')?.value.trim();
          const to = document.getElementById('path-to-input')?.value.trim();
          const preferProd = document.getElementById('chk-prefer-prod')?.checked !== false;
          if (from && to) {
            const statusEl = document.getElementById('path-status-label');
            if (statusEl) statusEl.textContent = 'Tracing path: ' + from + ' ➔ ' + to + '...';
            document.getElementById('reverse-path-banner').style.display = 'none';
            vscode.postMessage({ command: 'findPath', from, to, preferProduction: preferProd });
          }
        });

        // Blast Radius Actions
        let impactDirection = 'downstream';
        let impactDepth = 1;

        document.getElementById('btn-impact-downstream')?.addEventListener('click', () => {
          impactDirection = 'downstream';
          document.getElementById('btn-impact-downstream')?.classList.add('active');
          document.getElementById('btn-impact-upstream')?.classList.remove('active');
        });
        document.getElementById('btn-impact-upstream')?.addEventListener('click', () => {
          impactDirection = 'upstream';
          document.getElementById('btn-impact-upstream')?.classList.add('active');
          document.getElementById('btn-impact-downstream')?.classList.remove('active');
        });

        document.querySelectorAll('.rings-pills .pill-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            document.querySelectorAll('.rings-pills .pill-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            impactDepth = parseInt(btn.dataset.depth || '1', 10);
          });
        });

        document.getElementById('btn-run-impact')?.addEventListener('click', () => {
          const target = document.getElementById('impact-target-input')?.value.trim();
          if (target) {
            const statusEl = document.getElementById('impact-status-label');
            if (statusEl) statusEl.textContent = 'Calculating ' + impactDirection + ' blast radius...';
            vscode.postMessage({ command: 'getImpact', symbolName: target, direction: impactDirection, depth: impactDepth, limitPerLevel: 12 });
          }
        });

        // Dependencies Actions
        document.getElementById('btn-load-deps')?.addEventListener('click', () => {
          const filter = document.getElementById('deps-filter-input')?.value.trim();
          const statusEl = document.getElementById('deps-status-label');
          if (statusEl) statusEl.textContent = 'Loading file dependency matrix...';
          vscode.postMessage({ command: 'getFileDependencies', fileFilter: filter || undefined, limit: 50 });
        });

        // Metrics View Actions
        document.getElementById('btn-metrics-sync')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'syncMcpConfig' });
        });
        document.getElementById('btn-metrics-rebuild')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'indexAtlas' });
        });

        // Drawer click to expand callers/callees
        document.getElementById('drawer-callers-box')?.addEventListener('click', () => {
          if (graphState.selectedSymbol) {
            toggleBranch(graphState.selectedSymbol.name, 'callers');
          }
        });
        document.getElementById('drawer-callees-box')?.addEventListener('click', () => {
          if (graphState.selectedSymbol) {
            toggleBranch(graphState.selectedSymbol.name, 'callees');
          }
        });

        // Handle Messages from Extension Host
        window.addEventListener('message', (event) => {
          const msg = event.data;
          if (!msg) return;

          switch (msg.command) {
            case 'graphHierarchy': {
              renderGraphTree(msg.root, msg.callers || [], msg.callees || [], msg.edges || []);
              break;
            }
            case 'branchExpanded': {
              handleBranchExpanded(msg.parentName, msg.direction, msg.symbols, msg.edges);
              break;
            }
            case 'searchResults': {
              if (!universalDropdown) break;
              universalDropdown.innerHTML = '';
              const results = msg.results || [];
              if (results.length > 0) {
                results.forEach(res => {
                  const item = document.createElement('div');
                  item.className = 'search-result-item';
                  const loc = res.path ? res.path.split('/').pop() + (res.startLine ? ':' + res.startLine : '') : '';
                  item.innerHTML = 
                    '<div>' +
                      '<strong style="color: var(--text-main); font-family: monospace;">' + escapeClientHtml(res.name) + '</strong>' +
                      '<div style="font-size: 9px; color: var(--text-muted);">' + escapeClientHtml(loc) + '</div>' +
                    '</div>' +
                    '<span class="node-kind-badge">' + escapeClientHtml(res.kind || 'fn') + '</span>';

                  item.addEventListener('click', () => {
                    universalDropdown.style.display = 'none';
                    if (msg.target === 'pathFrom') {
                      const fromEl = document.getElementById('path-from-input');
                      if (fromEl) fromEl.value = res.name;
                    } else if (msg.target === 'pathTo') {
                      const toEl = document.getElementById('path-to-input');
                      if (toEl) toEl.value = res.name;
                    } else if (msg.target === 'impact') {
                      const impEl = document.getElementById('impact-target-input');
                      if (impEl) impEl.value = res.name;
                      document.getElementById('btn-run-impact')?.click();
                    } else if (msg.target === 'deps') {
                      const depEl = document.getElementById('deps-filter-input');
                      if (depEl) depEl.value = res.path || res.name;
                      document.getElementById('btn-load-deps')?.click();
                    } else {
                      const searchEl = document.getElementById('graph-search-input');
                      if (searchEl) searchEl.value = res.name;
                      vscode.postMessage({ command: 'getGraphData', symbolName: res.name });
                    }
                  });
                  universalDropdown.appendChild(item);
                });
                universalDropdown.style.display = 'block';
              } else {
                universalDropdown.style.display = 'none';
              }
              break;
            }
            case 'codeSnippet': {
              const codeEl = document.getElementById('drawer-code-content');
              if (codeEl) codeEl.textContent = msg.snippet || '// No snippet available';
              break;
            }
            case 'pathResult': {
              const res = msg.result;
              const statusEl = document.getElementById('path-status-label');
              const bannerEl = document.getElementById('reverse-path-banner');

              if (res && res.found) {
                renderPathChain(res);
                if (statusEl) statusEl.textContent = 'Path found (' + res.steps.length + ' hops)';
                if (bannerEl) bannerEl.style.display = 'none';
              } else {
                if (statusEl) statusEl.textContent = 'No forward path found in 6 hops.';
                if (res && res.reversePathFound) {
                  if (bannerEl) {
                    const textEl = document.getElementById('reverse-path-text');
                    if (textEl) textEl.textContent = 'Reverse call detected: ' + res.to + ' calls ' + res.from;
                    bannerEl.style.display = 'flex';
                  }
                } else if (bannerEl) {
                  bannerEl.style.display = 'none';
                }
              }
              break;
            }
            case 'impactResult': {
              const res = msg.result;
              const statusEl = document.getElementById('impact-status-label');
              if (res && res.target) {
                renderImpactGraph(res);
                if (statusEl) statusEl.textContent = 'Affected: ' + res.totalAffected + ' symbols across ' + res.levels.length + ' rings';
              }
              break;
            }
            case 'fileDependenciesResult': {
              const res = msg.result;
              const statusEl = document.getElementById('deps-status-label');
              if (res && res.nodes) {
                renderDependenciesGraph(res);
                if (statusEl) {
                  statusEl.textContent = res.totalFiles + ' files, ' + res.totalDependencies + ' links' + (res.hasCycles ? ' (' + res.cycles.length + ' circular loops ⚠️)' : '');
                }
              }
              break;
            }
            case 'flowResult': {
              const flow = msg.flow;
              const statusEl = document.getElementById('flow-status-label');
              if (flow && flow.graph && flow.graph.nodes && flow.graph.nodes.length > 0) {
                renderFlowGraph(flow);
                if (statusEl) statusEl.textContent = flow.topic + ': ' + (flow.steps ? flow.steps.length : flow.graph.nodes.length) + ' stages traced';
              } else {
                if (statusEl) statusEl.textContent = 'No flow diagram found. Enter a topic and click "Explain Flow".';
              }
              break;
            }
            case 'graphStats': {
              const s = msg.stats;
              if (s) {
                const fEl = document.getElementById('metric-indexed-files');
                const symEl = document.getElementById('metric-extracted-symbols');
                const pEl = document.getElementById('metric-db-path');
                if (fEl) fEl.textContent = s.fileCount;
                if (symEl) symEl.textContent = s.symbolCount;
                if (pEl) pEl.textContent = s.dbPath;
              }
              break;
            }
            case 'selectTab': {
              if (msg.tabId) selectTab(msg.tabId);
              break;
            }
            case 'vulScanProgress': {
              const statusEl = document.getElementById('vul-scan-status');
              const barEl = document.getElementById('vul-progress-bar');
              const containerEl = document.getElementById('vul-progress-container');
              if (containerEl) containerEl.style.display = 'block';
              if (statusEl) statusEl.textContent = 'Scanning: ' + msg.file + ' (' + msg.scanned + '/' + msg.total + ')';
              if (barEl && msg.total > 0) {
                const pct = Math.round((msg.scanned / msg.total) * 100);
                barEl.style.width = pct + '%';
              }
              if (msg.log) {
                appendVulLog(msg.log);
              }
              break;
            }
            case 'toolInstallProgress': {
              const p = msg.progress;
              if (!p) break;
              const banner = document.getElementById('setup-progress-banner');
              const titleEl = document.getElementById('setup-progress-title');
              const pctEl = document.getElementById('setup-progress-percent');
              const fillEl = document.getElementById('setup-bar-fill');
              const detailEl = document.getElementById('setup-progress-detail');

              const provNotice = document.getElementById('agent-provisioning-notice');
              const provPct = document.getElementById('agent-prov-pct');
              const provDetail = document.getElementById('agent-prov-detail');
              const startChatBtn = document.getElementById('btn-start-chat');
              const actionBtnIds = [
                'btn-start-chat',
                'btn-reload-chat',
                'btn-stop-chat',
                'btn-terminal',
                'btn-browser',
                'btn-start-vul-scan',
                'btn-rescan-vul',
                'btn-index-atlas',
                'btn-sync',
                'btn-metrics-sync',
                'btn-metrics-rebuild'
              ];

              if (!p.completed) {
                actionBtnIds.forEach(id => {
                  const btn = document.getElementById(id);
                  if (btn) btn.disabled = true;
                });
                if (startChatBtn) {
                  startChatBtn.textContent = '⏳ Installing Dependencies (' + p.percent + '%)...';
                }
                if (provNotice) provNotice.style.display = 'block';
                if (provPct) provPct.textContent = p.percent + '%';
                if (provDetail) provDetail.textContent = (p.stage ? p.stage + ' — ' : '') + (p.detail || '');
              } else {
                actionBtnIds.forEach(id => {
                  const btn = document.getElementById(id);
                  if (btn) btn.disabled = false;
                });
                if (startChatBtn) {
                  startChatBtn.textContent = 'Launch Security Agent';
                }
                if (provNotice) provNotice.style.display = 'none';
                // Automatically launch Security Agent once first-time dependency provisioning completes
                if (!document.getElementById('opencode-frame')) {
                  vscode.postMessage({ command: 'ensureChatStarted' });
                }
              }

              if (banner) {
                banner.style.display = 'flex';
                if (titleEl) titleEl.textContent = p.stage;
                if (pctEl) pctEl.textContent = p.percent + '%';
                if (fillEl) fillEl.style.width = p.percent + '%';
                if (detailEl) detailEl.textContent = p.detail;

                if (p.completed) {
                  if (pctEl) pctEl.textContent = '100%';
                  if (fillEl) fillEl.style.width = '100%';
                  setTimeout(() => {
                    banner.style.transition = 'opacity 0.6s ease';
                    banner.style.opacity = '0';
                    setTimeout(() => {
                      banner.style.display = 'none';
                      banner.style.opacity = '1';
                    }, 600);
                  }, 2000);
                }
              }
              break;
            }
            case 'updateContext': {
              if (msg.workspace) {
                const w = msg.workspace;
                const pathVal = document.querySelector('.path-value');
                if (pathVal) {
                  pathVal.textContent = w.rootPath;
                  pathVal.title = w.rootPath;
                }
                const atlasBadge = document.getElementById('badge-atlas-status');
                if (atlasBadge) {
                  atlasBadge.className = 'badge ' + (w.hasAtlasDb ? 'badge-success' : 'badge-warn');
                  atlasBadge.textContent = w.hasAtlasDb ? 'Indexed' : 'Not Indexed';
                }
                const mcpBadge = document.getElementById('badge-mcp-status');
                if (mcpBadge) {
                  mcpBadge.className = 'badge ' + (w.hasOpenCodeConfig ? 'badge-success' : 'badge-warn');
                  mcpBadge.textContent = w.hasOpenCodeConfig ? 'Configured' : 'Not Linked';
                }
              }
              if (msg.serverUrl) {
                const frame = document.getElementById('opencode-frame');
                if (frame && frame.src !== msg.serverUrl) frame.src = msg.serverUrl;
              }
              break;
            }
            case 'graphReady': {
              const atlasBadge = document.getElementById('badge-atlas-status');
              if (atlasBadge) {
                atlasBadge.className = 'badge badge-success';
                atlasBadge.textContent = 'Indexed';
              }
              break;
            }
            case 'vulScanComplete': {
              const containerEl = document.getElementById('vul-progress-container');
              if (containerEl) containerEl.style.display = 'none';
              const statusEl = document.getElementById('vul-scan-status');
              const rescanBtn = document.getElementById('btn-rescan-vul');
              if (rescanBtn) rescanBtn.style.display = 'inline-flex';
              if (statusEl) {
                if (msg.fromCache) {
                  statusEl.textContent = 'Cached: ' + msg.result.summary.total + ' findings (' + msg.result.scannedFilesCount + ' files)';
                } else {
                  statusEl.textContent = 'Scan complete: ' + msg.result.summary.total + ' findings (' + msg.result.scannedFilesCount + ' files)';
                }
              }
              handleVulScanComplete(msg.result);
              break;
            }
            case 'vulScanError': {
              const containerEl = document.getElementById('vul-progress-container');
              if (containerEl) containerEl.style.display = 'none';
              const statusEl = document.getElementById('vul-scan-status');
              if (statusEl) statusEl.textContent = 'Scan error: ' + msg.message;
              break;
            }
            case 'setServerUrl': {
              const frameWrapper = document.getElementById('frame-wrapper');
              if (frameWrapper && msg.url) {
                const existingFrame = document.getElementById('opencode-frame');
                if (existingFrame) {
                  existingFrame.src = msg.url;
                } else {
                  frameWrapper.innerHTML = '<iframe id="opencode-frame" src="' + msg.url + '" allow="clipboard-read; clipboard-write;"></iframe>';
                }
              }
              const statusDot = document.querySelector('.status-dot');
              if (statusDot) {
                statusDot.style.background = 'var(--accent-green)';
                statusDot.style.boxShadow = '0 0 6px rgba(52, 211, 153, 0.6)';
              }
              break;
            }
          }
        });

        // Renderer 1: Path Finder Chain
        function renderPathChain(result) {
          nodesContainerEl.innerHTML = '';
          svgEl.querySelectorAll('path').forEach(p => p.remove());
          graphState.nodes = {};
          graphState.edges = result.edges || [];

          const steps = result.steps || [];
          const spacing = 190;
          const startX = -((steps.length - 1) * spacing) / 2;

          steps.forEach((step, idx) => {
            const x = startX + idx * spacing;
            const y = 0;
            const extra = idx === 0 ? 'root-node' : idx === steps.length - 1 ? 'callee-node' : 'caller-node';
            createNodeElement(step.symbol, x, y, extra);
          });

          drawEdges();
          resetGraphCamera();
        }

        // Renderer 2: Blast Radius Concentric Graph
        function renderImpactGraph(result) {
          nodesContainerEl.innerHTML = '';
          svgEl.querySelectorAll('path').forEach(p => p.remove());
          graphState.nodes = {};
          graphState.edges = result.edges || [];

          // Center target at (0, 0), marked tainted-node in red if isTainted
          const targetExtra = result.isTainted ? 'root-node tainted-node' : 'root-node';
          createNodeElement(result.target, 0, 0, targetExtra);

          (result.levels || []).forEach(lvl => {
            const nodes = lvl.nodes || [];
            const count = nodes.length;
            const radius = lvl.level * 160;
            const angleStep = (2 * Math.PI) / Math.max(count, 1);

            nodes.forEach((n, idx) => {
              const angle = idx * angleStep - Math.PI / 2;
              const x = Math.round(radius * Math.cos(angle));
              const y = Math.round(radius * Math.sin(angle));
              createNodeElement(n, x, y, 'caller-node');
            });
          });

          drawEdges();
          resetGraphCamera();
        }

        // Renderer 3: File & Module Dependencies Graph
        function renderDependenciesGraph(result) {
          nodesContainerEl.innerHTML = '';
          svgEl.querySelectorAll('path').forEach(p => p.remove());
          graphState.nodes = {};
          graphState.edges = result.edges || [];

          const fileNodes = result.nodes || [];
          const count = fileNodes.length;
          const cols = Math.ceil(Math.sqrt(count));
          const spacingX = 180;
          const spacingY = 120;
          const startX = -((cols - 1) * spacingX) / 2;
          const startY = -((Math.ceil(count / cols) - 1) * spacingY) / 2;

          fileNodes.forEach((fn, idx) => {
            const col = idx % cols;
            const row = Math.floor(idx / cols);
            const x = startX + col * spacingX;
            const y = startY + row * spacingY;
            const extra = fn.isInCycle ? 'tainted-node' : 'callee-node';

            const sym = {
              name: fn.name,
              kind: fn.isInCycle ? 'cycle' : 'file',
              language: fn.language,
              path: fn.path,
              startLine: 1,
              callerCount: fn.inDegree,
              calleeCount: fn.outDegree
            };
            createNodeElement(sym, x, y, extra);
          });

          drawEdges();
          resetGraphCamera();
        }

        // Vulnerability Scanner Client Logic
        let activeScanFindings = [];
        let activeSeverityFilter = 'all';
        let activeToolFilter = null; // 'sast' | 'secrets' | 'atlas' | 'manifest' | null
        let allScanLogs = [];
        let logFilterWarningsOnly = false;

        function appendVulLog(log) {
          if (!log) return;
          allScanLogs.push(log);

          const badgeEl = document.getElementById('vul-logs-count-badge');
          if (badgeEl) badgeEl.textContent = allScanLogs.length + ' logs';

          const terminalEl = document.getElementById('vul-logs-terminal');
          if (!terminalEl) return;

          const placeholder = terminalEl.querySelector('.log-placeholder');
          if (placeholder) placeholder.remove();

          if (logFilterWarningsOnly && log.level !== 'warn' && log.level !== 'error') {
            return;
          }

          const row = document.createElement('div');
          row.className = 'log-entry';

          const engineSlug = (log.engine || 'scan').toLowerCase().replace(/[^a-z0-9]/g, '-');
          const levelClass = 'level-' + (log.level || 'info');

          row.innerHTML = 
            '<span class="log-time">' + escapeClientHtml(log.timestamp || '') + '</span>' +
            '<span class="log-engine-badge badge-engine-' + engineSlug + '">[' + escapeClientHtml(log.engine || 'INFO') + ']</span>' +
            '<span class="log-msg ' + levelClass + '">' + escapeClientHtml(log.message) + (log.detail ? ' <span style="opacity: 0.8; font-size: 9px;">(' + escapeClientHtml(log.detail) + ')</span>' : '') + '</span>';

          terminalEl.appendChild(row);
          terminalEl.scrollTop = terminalEl.scrollHeight;
        }

        function renderAllLogs() {
          const terminalEl = document.getElementById('vul-logs-terminal');
          if (!terminalEl) return;
          terminalEl.innerHTML = '';

          const badgeEl = document.getElementById('vul-logs-count-badge');
          if (badgeEl) badgeEl.textContent = allScanLogs.length + ' logs';

          if (allScanLogs.length === 0) {
            terminalEl.innerHTML = '<div class="log-placeholder" style="color: var(--text-muted); font-size: 10px; font-family: monospace; padding: 6px;">[SYSTEM] Ready. Click \\'Scan Entire Project\\' to start multi-engine security analysis. Execution logs from all 4 tools will stream here in real-time.</div>';
            return;
          }

          const logsToRender = logFilterWarningsOnly
            ? allScanLogs.filter(l => l.level === 'warn' || l.level === 'error')
            : allScanLogs;

          if (logsToRender.length === 0) {
            terminalEl.innerHTML = '<div style="color: var(--text-muted); font-size: 10px; font-family: monospace; padding: 6px;">No warnings or findings in logs.</div>';
            return;
          }

          logsToRender.forEach(log => {
            const row = document.createElement('div');
            row.className = 'log-entry';
            const engineSlug = (log.engine || 'scan').toLowerCase().replace(/[^a-z0-9]/g, '-');
            const levelClass = 'level-' + (log.level || 'info');

            row.innerHTML = 
              '<span class="log-time">' + escapeClientHtml(log.timestamp || '') + '</span>' +
              '<span class="log-engine-badge badge-engine-' + engineSlug + '">[' + escapeClientHtml(log.engine || 'INFO') + ']</span>' +
              '<span class="log-msg ' + levelClass + '">' + escapeClientHtml(log.message) + (log.detail ? ' <span style="opacity: 0.8; font-size: 9px;">(' + escapeClientHtml(log.detail) + ')</span>' : '') + '</span>';
            terminalEl.appendChild(row);
          });
          terminalEl.scrollTop = terminalEl.scrollHeight;
        }

        function updateToolSummaryChips(summary) {
          if (!summary) return;

          const statSast = document.getElementById('stat-sast');
          if (statSast && summary.engine1Sast) {
            statSast.textContent = summary.engine1Sast.findingsCount + ' findings (' + summary.engine1Sast.filesScanned + ' files)';
            statSast.className = 'tool-chip-stat' + (summary.engine1Sast.findingsCount > 0 ? ' has-findings' : '');
          }

          const statSecrets = document.getElementById('stat-secrets');
          if (statSecrets && summary.engine2Secrets) {
            statSecrets.textContent = summary.engine2Secrets.findingsCount + ' leaks (' + summary.engine2Secrets.filesScanned + ' files)';
            statSecrets.className = 'tool-chip-stat' + (summary.engine2Secrets.findingsCount > 0 ? ' has-findings' : '');
          }

          const statAtlas = document.getElementById('stat-atlas');
          if (statAtlas && summary.engine3AtlasAst) {
            statAtlas.textContent = summary.engine3AtlasAst.findingsCount + ' risks (' + summary.engine3AtlasAst.symbolsEvaluated + ' symbols)';
            statAtlas.className = 'tool-chip-stat' + (summary.engine3AtlasAst.findingsCount > 0 ? ' has-findings' : '');
          }

          const statManifest = document.getElementById('stat-manifest');
          if (statManifest && summary.engine4Manifest) {
            statManifest.textContent = summary.engine4Manifest.findingsCount + ' advisories (' + (summary.engine4Manifest.manifestsChecked || []).length + ' manifests)';
            statManifest.className = 'tool-chip-stat' + (summary.engine4Manifest.findingsCount > 0 ? ' has-findings' : '');
          }
        }

        document.getElementById('btn-toggle-vul-logs')?.addEventListener('click', () => {
          const terminal = document.getElementById('vul-logs-terminal');
          const icon = document.getElementById('vul-logs-toggle-icon');
          if (!terminal) return;
          const isHidden = terminal.style.display === 'none';
          terminal.style.display = isHidden ? 'flex' : 'none';
          if (icon) icon.textContent = isHidden ? '▼' : '►';
        });

        document.getElementById('btn-filter-log-findings')?.addEventListener('click', (e) => {
          e.stopPropagation();
          logFilterWarningsOnly = !logFilterWarningsOnly;
          const btn = document.getElementById('btn-filter-log-findings');
          if (btn) btn.classList.toggle('active', logFilterWarningsOnly);
          renderAllLogs();
        });

        document.getElementById('btn-show-output-channel')?.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'showOutputChannel' });
        });

        document.getElementById('btn-clear-vul-logs')?.addEventListener('click', (e) => {
          e.stopPropagation();
          allScanLogs = [];
          renderAllLogs();
        });

        document.getElementById('btn-start-vul-scan')?.addEventListener('click', () => {
          allScanLogs = [];
          const terminalEl = document.getElementById('vul-logs-terminal');
          if (terminalEl) {
            terminalEl.style.display = 'flex';
            terminalEl.innerHTML = '';
          }
          const icon = document.getElementById('vul-logs-toggle-icon');
          if (icon) icon.textContent = '▼';
          appendVulLog({
            timestamp: new Date().toLocaleTimeString(),
            engine: 'PRE-FILTER',
            level: 'info',
            message: 'Starting full-project vulnerability scan with 4 consensus engines...'
          });

          const statusEl = document.getElementById('vul-scan-status');
          if (statusEl) statusEl.textContent = 'Initiating multi-engine vulnerability scan...';
          const containerEl = document.getElementById('vul-progress-container');
          if (containerEl) containerEl.style.display = 'block';
          const barEl = document.getElementById('vul-progress-bar');
          if (barEl) barEl.style.width = '5%';
          vscode.postMessage({ command: 'startVulnerabilityScan', forceRefresh: false });
        });

        document.getElementById('btn-rescan-vul')?.addEventListener('click', () => {
          allScanLogs = [];
          const terminalEl = document.getElementById('vul-logs-terminal');
          if (terminalEl) {
            terminalEl.style.display = 'flex';
            terminalEl.innerHTML = '';
          }
          const icon = document.getElementById('vul-logs-toggle-icon');
          if (icon) icon.textContent = '▼';
          appendVulLog({
            timestamp: new Date().toLocaleTimeString(),
            engine: 'PRE-FILTER',
            level: 'info',
            message: 'Initiating fresh re-scan (bypassing persistent cache)...'
          });

          const statusEl = document.getElementById('vul-scan-status');
          if (statusEl) statusEl.textContent = 'Force re-scanning with 4 consensus engines...';
          const containerEl = document.getElementById('vul-progress-container');
          if (containerEl) containerEl.style.display = 'block';
          const barEl = document.getElementById('vul-progress-bar');
          if (barEl) barEl.style.width = '5%';
          vscode.postMessage({ command: 'startVulnerabilityScan', forceRefresh: true });
        });

        // Live Search Filter
        document.getElementById('vul-search-input')?.addEventListener('input', (e) => {
          applyVulFilters();
        });

        // Severity Pills Filter & Summary Pills Click
        function setSeverityFilter(sev) {
          activeSeverityFilter = sev;
          document.querySelectorAll('#vul-severity-filters .pill-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.sev === sev);
          });
          document.querySelectorAll('#vul-metrics-row .vul-pill').forEach(b => {
            b.classList.toggle('active', b.dataset.sev === sev);
          });
          applyVulFilters();
        }

        document.querySelectorAll('#vul-severity-filters .pill-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            setSeverityFilter(btn.dataset.sev || 'all');
          });
        });

        document.querySelectorAll('#vul-metrics-row .vul-pill').forEach(pill => {
          pill.addEventListener('click', () => {
            setSeverityFilter(pill.dataset.sev || 'all');
          });
        });

        function handleVulScanComplete(result) {
          activeScanFindings = result.findings || [];
          const s = result.summary || { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
          
          if (result.toolExecutionSummary) {
            updateToolSummaryChips(result.toolExecutionSummary);
          }

          if (result.logs && result.logs.length > 0) {
            allScanLogs = result.logs;
            renderAllLogs();
          }

          const dotEl = document.getElementById('vul-status-dot');
          if (dotEl) {
            dotEl.style.background = s.critical > 0 ? '#ef4444' : s.high > 0 ? '#f97316' : '#34d399';
            dotEl.style.boxShadow = s.critical > 0 ? '0 0 8px rgba(239, 68, 68, 0.7)' : '0 0 6px rgba(52, 211, 153, 0.6)';
          }

          const totEl = document.getElementById('metric-vul-total');
          const critEl = document.getElementById('metric-vul-critical');
          const highEl = document.getElementById('metric-vul-high');
          const medEl = document.getElementById('metric-vul-medium');
          const lowEl = document.getElementById('metric-vul-low');
          const badgeEl = document.getElementById('vul-badge-count');

          if (totEl) totEl.textContent = 'Total: ' + s.total;
          if (critEl) critEl.textContent = 'Critical: ' + s.critical;
          if (highEl) highEl.textContent = 'High: ' + s.high;
          if (medEl) medEl.textContent = 'Medium: ' + s.medium;
          if (lowEl) lowEl.textContent = 'Low: ' + s.low;

          if (badgeEl) {
            badgeEl.textContent = s.total;
            badgeEl.style.display = s.total > 0 ? 'inline-block' : 'none';
          }

          applyVulFilters();
        }

        function toggleToolFilter(toolType) {
          if (activeToolFilter === toolType) {
            // Unselect tool filter: restore all tools findings
            activeToolFilter = null;
          } else {
            // Select this tool filter
            activeToolFilter = toolType;
          }

          // Toggle .active class on the 4 chips
          document.getElementById('tool-chip-sast')?.classList.toggle('active', activeToolFilter === 'sast');
          document.getElementById('tool-chip-secrets')?.classList.toggle('active', activeToolFilter === 'secrets');
          document.getElementById('tool-chip-atlas')?.classList.toggle('active', activeToolFilter === 'atlas');
          document.getElementById('tool-chip-manifest')?.classList.toggle('active', activeToolFilter === 'manifest');

          applyVulFilters();
        }

        // Attach click listeners to all 4 tool status chips
        document.getElementById('tool-chip-sast')?.addEventListener('click', () => toggleToolFilter('sast'));
        document.getElementById('tool-chip-secrets')?.addEventListener('click', () => toggleToolFilter('secrets'));
        document.getElementById('tool-chip-atlas')?.addEventListener('click', () => toggleToolFilter('atlas'));
        document.getElementById('tool-chip-manifest')?.addEventListener('click', () => toggleToolFilter('manifest'));

        function applyVulFilters() {
          const query = (document.getElementById('vul-search-input')?.value || '').toLowerCase().trim();
          const filtered = activeScanFindings.filter(f => {
            // 1. Severity filter
            if (activeSeverityFilter !== 'all' && f.severity !== activeSeverityFilter) return false;

            // 2. Interactive Tool Chip Filter (Single tool selection or all tools)
            if (activeToolFilter) {
              const tools = f.tools || [];
              const matchesTool = tools.some(t => {
                const lower = (t || '').toLowerCase();
                if (activeToolFilter === 'sast') {
                  return lower.includes('opengrep') || lower.includes('semgrep') || lower.includes('sast');
                } else if (activeToolFilter === 'secrets') {
                  return lower.includes('gitleaks') || lower.includes('secret');
                } else if (activeToolFilter === 'atlas') {
                  return lower.includes('atlas');
                } else if (activeToolFilter === 'manifest') {
                  return lower.includes('osv') || lower.includes('manifest') || lower.includes('npm') || lower.includes('supply') || lower.includes('depend');
                }
                return false;
              });
              if (!matchesTool) return false;
            }

            // 3. Search query filter
            if (query) {
              const str = (f.title + ' ' + f.filePath + ' ' + f.cwe + ' ' + f.description).toLowerCase();
              if (!str.includes(query)) return false;
            }
            return true;
          });
          renderVulCards(filtered);
        }

        function renderVulCards(findings) {
          const listEl = document.getElementById('vul-findings-list');
          if (!listEl) return;
          listEl.innerHTML = '';

          if (findings.length === 0) {
            if (activeToolFilter) {
              const toolLabel = activeToolFilter === 'sast' ? 'Opengrep AST' :
                                activeToolFilter === 'secrets' ? 'Gitleaks Secrets' :
                                activeToolFilter === 'atlas' ? 'Atlas AST Graph' : 'OSV & Supply Chain';
              listEl.innerHTML = '<div style="text-align: center; padding: 28px 10px; color: var(--text-muted); font-size: 11px;">' +
                'No vulnerabilities detected by <strong>' + escapeClientHtml(toolLabel) + '</strong>.' +
                '<div style="margin-top: 8px;"><button class="pill-btn" id="btn-reset-tool-filter" style="display: inline-block; padding: 3px 8px; font-size: 10px;">Show All Tools Findings</button></div>' +
                '</div>';
              listEl.querySelector('#btn-reset-tool-filter')?.addEventListener('click', () => {
                toggleToolFilter(activeToolFilter);
              });
            } else {
              listEl.innerHTML = '<div style="text-align: center; padding: 32px 10px; color: var(--text-muted); font-size: 11px;">No matching vulnerabilities found.</div>';
            }
            return;
          }

          // If a tool filter is currently active, show a top dismissal banner
          if (activeToolFilter) {
            const toolLabel = activeToolFilter === 'sast' ? 'Opengrep AST' :
                              activeToolFilter === 'secrets' ? 'Gitleaks Secrets' :
                              activeToolFilter === 'atlas' ? 'Atlas AST Graph' : 'OSV & Supply Chain';
            const banner = document.createElement('div');
            banner.className = 'reverse-banner';
            banner.style.marginBottom = '8px';
            banner.innerHTML = 
              '<span>Filtered by <strong>' + escapeClientHtml(toolLabel) + '</strong> (' + findings.length + ' findings)</span>' +
              '<button class="pill-btn" id="btn-clear-active-tool-filter" style="font-size: 9px; padding: 2px 6px; background: rgba(56, 189, 248, 0.2); border-color: var(--accent-blue); color: var(--accent-blue);">✕ Show All Tools</button>';
            banner.querySelector('#btn-clear-active-tool-filter')?.addEventListener('click', () => {
              toggleToolFilter(activeToolFilter);
            });
            listEl.appendChild(banner);
          }

          findings.forEach(f => {
            const card = document.createElement('div');
            const sevClass = 'sev-' + f.severity.toLowerCase();
            card.className = 'vul-card ' + sevClass + '-border';

            const toolsHtml = (f.tools || []).map(t => '<span class="vul-badge tools-badge">' + escapeClientHtml(t) + '</span>').join(' ');

            const cegarBadge = f.cegarVerdict === 'CONFIRMED'
              ? '<span class="vul-badge" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.5);">🛡️ CEGAR: CONFIRMED BUG</span>'
              : f.cegarVerdict === 'DEFENDED'
              ? '<span class="vul-badge" style="background: rgba(52, 211, 153, 0.2); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.5);">🛡️ CEGAR: DEFENDED (FP REFUTED)</span>'
              : f.cegarVerdict === 'CANDIDATE'
              ? '<span class="vul-badge" style="background: rgba(234, 179, 8, 0.2); color: #facc15; border: 1px solid rgba(234, 179, 8, 0.5);">🛡️ CEGAR: CANDIDATE</span>'
              : '';

            card.innerHTML = 
              '<div class="vul-badge-row">' +
                '<span class="vul-badge ' + sevClass + '">' + escapeClientHtml(f.severity) + '</span>' +
                '<span class="vul-badge cwe-badge">' + escapeClientHtml(f.cwe) + '</span>' +
                cegarBadge +
                toolsHtml +
              '</div>' +
              '<div class="vul-title">' + escapeClientHtml(f.title) + '</div>' +
              '<div class="vul-loc">📄 ' + escapeClientHtml(f.filePath) + ':' + f.line + '</div>' +
              (f.snippet ? '<div class="vul-code-snippet">' + escapeClientHtml(f.snippet) + '</div>' : '') +
              (f.cegarProof ? '<div style="margin: 6px 0; padding: 6px 8px; font-size: 10px; border-radius: 4px; background: rgba(56, 189, 248, 0.08); border-left: 3px solid var(--accent-blue); color: var(--text-main);"><strong style="color: var(--accent-blue);">🛡️ Invariant Proof:</strong> ' + escapeClientHtml(f.cegarProof) + '</div>' : '') +
              '<div class="vul-desc">' + escapeClientHtml(f.description) + '</div>' +
              (f.remediation ? '<div class="vul-remediation"><strong>Fix:</strong> ' + escapeClientHtml(f.remediation) + '</div>' : '') +
              '<div class="vul-card-footer">' +
                '<span class="vul-dblclick-hint">💡 Double-click card to jump to line</span>' +
                '<button class="btn-trace-vul" title="Trace blast radius and view contaminated flow in Code Graph">' +
                  '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                    '<circle cx="12" cy="12" r="10"></circle>' +
                    '<line x1="22" y1="12" x2="18" y2="12"></line>' +
                    '<line x1="6" y1="12" x2="2" y2="12"></line>' +
                    '<line x1="12" y1="6" x2="12" y2="2"></line>' +
                    '<line x1="12" y1="22" x2="12" y2="18"></line>' +
                  '</svg>' +
                  '<span>View Blast Radius &amp; Flow</span>' +
                '</button>' +
              '</div>';

            // Double-click jumps to code in editor
            card.addEventListener('dblclick', (e) => {
              vscode.postMessage({ command: 'openInEditor', path: f.filePath, line: f.line });
            });

            // Button jumps to Code Graph blast radius and marks bug node in red
            card.querySelector('.btn-trace-vul')?.addEventListener('click', (e) => {
              e.stopPropagation();
              vscode.postMessage({
                command: 'traceVulnerabilityGraph',
                symbolName: f.symbolName,
                filePath: f.filePath,
                line: f.line
              });
            });

            listEl.appendChild(card);
          });
        }

        // Auto-request graph when Tab 2 is opened
        document.querySelectorAll('.tab-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            if (btn.dataset.tab === 'tab-graph' && !graphInitialized) {
              graphInitialized = true;
              vscode.postMessage({ command: 'getGraphData' });
            }
          });
        });

        if (savedState && savedState.activeTab === 'tab-graph') {
          graphInitialized = true;
          vscode.postMessage({ command: 'getGraphData' });
        }

        // Instantly transition out the static splash screen once initial interactive DOM is ready
        setTimeout(() => {
          const splash = document.getElementById('instant-splash-loader');
          if (splash) splash.classList.add('hidden');
        }, 300);
      </script>
    </body>
    </html>`;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}
