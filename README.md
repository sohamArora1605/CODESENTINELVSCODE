# CodeSentinel Security Scanner

Multi-language Static Application Security Testing (SAST) & Agentic Security Auditor with Model Context Protocol (MCP) & OpenCode integration.

CodeSentinel provides a self-contained, zero-Docker security auditing and SAST environment directly inside VS Code.

## Features

- **Multi-Engine SAST Scanning**: Integrated AST vulnerability analysis via Opengrep, secret detection via Gitleaks, and dependency vulnerability scanning via OSV.
- **Agentic Security Auditor**: Seamless integration with OpenCode and MCP for autonomous security investigations, remediation suggestions, and trust boundary mapping.
- **360° Interactive Code Graph**: Codebase architecture mapping powered by Atlas, enabling deep call hierarchy exploration, blast radius analysis, and dependency cycle detection.
- **Zero-Docker Architecture**: Self-contained runtime executing on host system without requiring Docker containers.
- **Real-Time Security Control Center**: Unified sidebar webview for running scans, triaging findings, inspecting blast radius, and interacting with security agents.

## Getting Started

1. Open a workspace folder in VS Code.
2. Open the CodeSentinel view from the Activity Bar (`Security & Agent Control Center`).
3. Click **Run Vulnerability Scan** to analyze the workspace.
4. Launch OpenCode from the sidebar or status bar to perform automated security reviews.

## Commands

- `CodeSentinel: Launch OpenCode in Active Workspace` (`codesentinel.launchOpenCodeTerminal`)
- `CodeSentinel: Focus Security Agent in Extension Sidebar` (`codesentinel.openEmbeddedWeb`)
- `CodeSentinel: Open 360° Interactive Code Graph` (`codesentinel.openCodeGraph`)
- `CodeSentinel: Index Codebase with Atlas Code Graph` (`codesentinel.indexAtlas`)
- `CodeSentinel: Check and Install Host Dependencies (OpenCode & Atlas)` (`codesentinel.installDependencies`)
- `CodeSentinel: Run Cloud Security Audit with OpenCode` (`codesentinel.runCloudSecurityAudit`)
- `CodeSentinel: Provision Security Audit Skills to OpenCode` (`codesentinel.provisionSkills`)
- `CodeSentinel: Switch Backend Mode (Local / Cloud)` (`codesentinel.toggleBackendMode`)

## Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `codesentinel.backendMode` | `string` | `"local"` | Backend execution mode: `"local"` or `"cloud"`. |
| `codesentinel.cloudEndpoint` | `string` | `"https://api.codesentinel.io/v1"` | Remote cloud endpoint when running in cloud mode. |
| `codesentinel.opencodePath` | `string` | `"opencode"` | Executable path for OpenCode CLI. |
| `codesentinel.autoLaunchOpenCode` | `boolean` | `false` | Automatically open OpenCode terminal on folder load. |
| `codesentinel.autoProvisionCloudSecurityAuditSkill` | `boolean` | `true` | Automatically provisions the Cloud Security Audit skill to OpenCode workspace. |

## License

MIT
