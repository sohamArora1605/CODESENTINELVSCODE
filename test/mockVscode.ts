import Module from "module";

// Install vscode mock into Node module system so unit tests can run outside VS Code
const originalLoad = (Module as any)._load;
let cached: any = null;

(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request === "vscode") {
    if (cached) return cached;
    cached = {
      workspace: {
        getConfiguration: () => ({
          get: (_key: string, defaultValue: any) => defaultValue,
        }),
        workspaceFolders: [],
        onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      },
      window: {
        terminals: [],
        createTerminal: (options: any) => ({
          name: options.name,
          show: () => {},
          sendText: () => {},
          dispose: () => {},
        }),
        showInformationMessage: () => {},
        showErrorMessage: () => {},
        onDidChangeActiveTextEditor: () => ({ dispose() {} }),
        registerWebviewViewProvider: () => ({ dispose() {} }),
        createStatusBarItem: () => ({
          show() {},
          dispose() {},
          text: "",
          tooltip: "",
        }),
      },
      env: { openExternal: async () => true },
      StatusBarAlignment: { Right: 2, Left: 1 },
      ViewColumn: { Beside: 2, One: 1, Active: -1 },
      EventEmitter: class {
        private listeners: Array<(e: any) => void> = [];
        event = (l: (e: any) => void) => {
          this.listeners.push(l);
          return { dispose: () => { this.listeners = this.listeners.filter((x) => x !== l); } };
        };
        fire(e?: any) { for (const l of [...this.listeners]) l(e); }
      },
      Uri: {
        file: (p: string) => ({ fsPath: p }),
        parse: (u: string) => ({ toString: () => u }),
        joinPath: (b: any, ...p: string[]) => ({ fsPath: [b.fsPath, ...p].join("/") }),
      },
    };
    return cached;
  }
  return originalLoad.apply(this, arguments);
};
