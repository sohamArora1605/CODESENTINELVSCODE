export type BackendMode = "local" | "cloud" | "local-docker";

export interface WorkspaceContext {
  rootPath: string;
  name: string;
  detectedLanguages: string[];
  hasGit: boolean;
  hasOpenCodeConfig: boolean;
  activeFilePath?: string;
  activeBranch?: string;
  isMultiRepo?: boolean;
}

export interface RepositoryInfo {
  id: string;
  path: string;
  name: string;
  currentBranch: string;
  branches: string[];
  isDirty: boolean;
  stagedCount: number;
  unstagedCount: number;
  headCommit?: string;
  isIndexed: boolean;
  lastSyncTime?: number;
  syncStatus: "synced" | "syncing" | "outdated" | "error";
  syncError?: string;
}

export interface GitStatus {
  branch: string;
  isClean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  ahead: number;
  behind: number;
}

export interface JiraTicket {
  key: string;
  summary: string;
  description: string;
  status: "To Do" | "In Progress" | "In Review" | "Done" | string;
  priority: "Lowest" | "Low" | "Medium" | "High" | "Highest" | string;
  issueType: "Bug" | "Task" | "Story" | "Vulnerability" | "Epic" | string;
  assignee?: string;
  labels: string[];
  components: string[];
  created?: string;
  updated?: string;
  branchName?: string;
  baseBranch?: string;
  activeWorkflowStep?: WorkflowStepId;
}

export type WorkflowStepId =
  | "pull_ticket"
  | "cut_branch"
  | "plan"
  | "develop"
  | "diff_scan"
  | "verify_test"
  | "stage_test"
  | "playwright_test"
  | "push_branch";

export interface WorkflowStepState {
  id: WorkflowStepId;
  name: string;
  status: "idle" | "running" | "completed" | "failed" | "skipped";
  startedAt?: number;
  completedAt?: number;
  summary?: string;
  details?: any;
  error?: string;
  /** What the agents of this stage said (tail), one section per agent run */
  output?: string;
  /** Agents that ran in this stage */
  agents?: Array<{ role: string; harness: string; model?: string; effort?: string }>;
}

export interface TicketWorkflow {
  /** `${repoName}:${KEY}` — unique per ticket per repo so one ticket can span several repos */
  id: string;
  ticketKey: string;
  ticketSummary?: string;
  ticketDescription?: string;
  repoPath: string;
  /** Directory the agents actually edit: an isolated git worktree, or repoPath when worktrees are off */
  workDir: string;
  baseBranch: string;
  targetBranch: string;
  harness?: string;
  status: "idle" | "running" | "paused" | "completed" | "failed" | "cancelled";
  /** Why a paused workflow is waiting for the developer */
  awaiting?: "plan_approval" | "push_approval" | "stage_approval";
  /** Agent running right now (for the live view) */
  currentAgent?: { role: string; harness: string; model?: string; effort?: string; startedAt: number };
  /** Live feed: tool calls and messages from the running agent */
  activity?: string[];
  currentStepIndex: number;
  /** scan → verify → fix cycles used so far */
  iteration: number;
  steps: WorkflowStepState[];
  logs: string[];
  plan?: string;
  scanResults?: any;
  verificationResults?: any;
  testResults?: any;
  pushedRef?: string;
  /** OS process driving this run; lets other processes (UI, MCP) tell "running elsewhere" from "crashed" */
  pid?: number;
  startedAt: number;
  updatedAt: number;
}

export interface TestExecutionResult {
  suite: "unit" | "stage_api" | "playwright";
  repoPath: string;
  /** passed = ran and succeeded; failed = ran and failed; skipped = not run (disabled / not configured) */
  status: "passed" | "failed" | "skipped";
  /** Convenience: true unless status === "failed". A skipped suite does not block a workflow. */
  passed: boolean;
  command?: string;
  totalTests: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  durationMs: number;
  output: string;
  timestamp: number;
  error?: string;
}

export interface SecretItem {
  key: string;
  description?: string;
  scope: "ticket" | "repo" | "global";
  scopeId?: string; // ticketKey or repoName
  hasValue: boolean;
  updatedAt: number;
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

