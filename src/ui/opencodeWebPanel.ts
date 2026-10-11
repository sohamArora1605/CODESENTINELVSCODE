import * as vscode from "vscode";
import * as path from "path";
import { OpenCodeLauncher } from "../opencode/opencodeLauncher";

export class OpenCodeWebPanel {
  public static currentPanel: OpenCodeWebPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _serverUrl: string | null = null;

  public static async createOrShow(
    extensionUri: vscode.Uri,
    workspaceRoot: string,
    launcher: OpenCodeLauncher
  ): Promise<OpenCodeWebPanel> {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    const repoName = path.basename(workspaceRoot);

    if (OpenCodeWebPanel.currentPanel) {
      OpenCodeWebPanel.currentPanel._panel.reveal(column || vscode.ViewColumn.Beside);
      return OpenCodeWebPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "codesentinel.opencodeWebPanel",
      `OpenCode Agent [${repoName}]`,
      column || vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    OpenCodeWebPanel.currentPanel = new OpenCodeWebPanel(panel, extensionUri);
    await OpenCodeWebPanel.currentPanel.startAndLoad(workspaceRoot, launcher);
    return OpenCodeWebPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case "reload":
            if (this._serverUrl) {
              this._panel.webview.html = this.getHtmlForWebview(this._serverUrl);
            }
            break;
        }
      },
      null,
      this._disposables
    );
  }

  public async startAndLoad(workspaceRoot: string, launcher: OpenCodeLauncher): Promise<void> {
    this._panel.webview.html = this.getLoadingHtml("Starting OpenCode Web service...");

    try {
      const server = await launcher.startWebProcess(workspaceRoot);
      this._serverUrl = server.url;
      this._panel.webview.html = this.getHtmlForWebview(server.url);
    } catch (err: any) {
      this._panel.webview.html = this.getErrorHtml(err.message);
    }
  }

  public dispose(): void {
    OpenCodeWebPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private getLoadingHtml(statusMessage: string): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <style>
        body {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          margin: 0;
          background: #12141a;
          color: #f1f5f9;
          font-family: var(--vscode-font-family, sans-serif);
        }
        .spinner {
          width: 36px;
          height: 36px;
          border: 3px solid rgba(56, 189, 248, 0.2);
          border-top-color: #38bdf8;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          margin-bottom: 16px;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .status {
          font-size: 14px;
          color: #94a3b8;
        }
      </style>
    </head>
    <body>
      <div class="spinner"></div>
      <div class="status">${statusMessage}</div>
    </body>
    </html>`;
  }

  private getErrorHtml(errorMessage: string): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <style>
        body {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          margin: 0;
          background: #12141a;
          color: #f1f5f9;
          font-family: var(--vscode-font-family, sans-serif);
          padding: 24px;
          text-align: center;
        }
        .error-card {
          background: rgba(239, 68, 68, 0.1);
          border: 1px solid rgba(239, 68, 68, 0.3);
          border-radius: 8px;
          padding: 24px;
          max-width: 500px;
        }
        h2 { color: #ef4444; margin-top: 0; font-size: 16px; }
        p { color: #94a3b8; font-size: 13px; line-height: 1.5; }
        button {
          margin-top: 16px;
          padding: 8px 16px;
          background: #2563eb;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
      </style>
    </head>
    <body>
      <div class="error-card">
        <h2>Failed to Launch OpenCode Web</h2>
        <p>${errorMessage}</p>
        <button onclick="vscode.postMessage({ command: 'reload' })">Retry</button>
      </div>
      <script>
        const vscode = acquireVsCodeApi();
      </script>
    </body>
    </html>`;
  }

  private getHtmlForWebview(serverUrl: string): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>OpenCode Web Agent</title>
      <style>
        html, body {
          margin: 0;
          padding: 0;
          width: 100%;
          height: 100%;
          overflow: hidden;
          background: #0f1117;
          display: flex;
          flex-direction: column;
        }

        .header-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 6px 12px;
          background: #181b24;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          font-family: var(--vscode-font-family, sans-serif);
          font-size: 11px;
          color: #94a3b8;
          user-select: none;
        }

        .header-left {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #34d399;
          box-shadow: 0 0 6px rgba(52, 211, 153, 0.6);
        }

        .url-text {
          color: #38bdf8;
          font-family: monospace;
          font-size: 11px;
        }

        .header-actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .btn-action {
          padding: 3px 8px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 4px;
          background: rgba(255, 255, 255, 0.05);
          color: #f1f5f9;
          font-size: 11px;
          cursor: pointer;
          transition: background 0.15s;
        }

        .btn-action:hover {
          background: rgba(255, 255, 255, 0.12);
        }

        .frame-container {
          flex: 1;
          width: 100%;
          height: 100%;
          position: relative;
        }

        iframe {
          width: 100%;
          height: 100%;
          border: none;
          background: #0f1117;
        }
      </style>
    </head>
    <body>
      <div class="header-bar">
        <div class="header-left">
          <div class="status-dot"></div>
          <strong>OpenCode Embedded Session</strong>
          <span class="url-text">${serverUrl}</span>
        </div>
        <div class="header-actions">
          <button class="btn-action" onclick="document.getElementById('opencode-frame').src = '${serverUrl}'">
            ↻ Reload
          </button>
        </div>
      </div>
      <div class="frame-container">
        <iframe
          id="opencode-frame"
          src="${serverUrl}"
          allow="clipboard-read; clipboard-write;"
        ></iframe>
      </div>
    </body>
    </html>`;
  }
}
