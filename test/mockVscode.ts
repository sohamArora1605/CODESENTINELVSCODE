import Module from "module";

// Install vscode mock into Node module system so unit tests can run outside VS Code
const originalLoad = (Module as any)._load;

(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request === "vscode") {
    return {
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
      StatusBarAlignment: { Right: 2, Left: 1 },
      ViewColumn: { Beside: 2, One: 1, Active: -1 },
      EventEmitter: class {
        event = () => ({ dispose() {} });
        fire() {}
      },
      Uri: {
        file: (p: string) => ({ fsPath: p }),
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
