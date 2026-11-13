/* CodeSentinel Developer tab. Runs inside the sidebar webview next to the main script, so it reuses
 * its `vscode` API handle and `escapeClientHtml`. Everything rendered from data goes through esc(). */
(function () {
  "use strict";
  var root = document.getElementById("dev-root");
  if (!root) return;

  var esc = function (s) { return escapeClientHtml(s == null ? "" : String(s)); };
  var post = function (command, extra) { vscode.postMessage(Object.assign({ command: "dev:" + command }, extra || {})); };

  var S = {
    sub: (vscode.getState() || {}).devSub || "tickets",
    state: null,
    tickets: [], ticketsLive: false, ticketsError: "", ticketsLoading: false,
    startFor: null, // ticket key whose start form is open
    openLogs: {}, openOutput: {}, openCfg: {}, toast: null,
    filter: { status: "All", query: "" },
  };

  var STAGES = [["plan", "Planner agent"], ["develop", "Developer agent"], ["diff_scan", "Security scan of changed files"], ["verify_test", "Tester agent, unit tests and fix loop"], ["stage_test", "Stage & API tests"], ["playwright_test", "Playwright E2E tests"], ["push_branch", "Commit & push"]];
  var EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  function effortSelect(attrs, cur, blankLabel) {
    return '<select ' + attrs + '><option value=""' + (!cur ? " selected" : "") + ">" + blankLabel + "</option>" + EFFORTS.map(function (e) {
      return '<option value="' + e + '"' + (cur === e ? " selected" : "") + ">" + e + "</option>";
    }).join("") + "</select>";
  }

  var STEP_ICON = { completed: "✓", running: "◔", failed: "✕", skipped: "–", idle: "○" };

  function toast(text, kind) {
    S.toast = { text: text, kind: kind || "info" };
    render();
    setTimeout(function () { if (S.toast && S.toast.text === text) { S.toast = null; render(); } }, 6000);
  }

  // ------------------------------------------------------------------ small view helpers
  function pill(text, kind) { return '<span class="dv-pill dv-' + esc(kind || "muted") + '">' + esc(text) + "</span>"; }
  function btn(label, action, data, cls) {
    var attrs = "";
    Object.keys(data || {}).forEach(function (k) { attrs += " data-" + k + '="' + esc(data[k]) + '"'; });
    return '<button class="dv-btn ' + (cls || "") + '" data-act="' + esc(action) + '"' + attrs + ">" + esc(label) + "</button>";
  }
  function toggle(key, on, label, hint) {
    return '<label class="dv-toggle"><input type="checkbox" data-setting="' + esc(key) + '"' + (on ? " checked" : "") + ">" +
      "<span><b>" + esc(label) + "</b>" + (hint ? "<em>" + esc(hint) + "</em>" : "") + "</span></label>";
  }
  function statusKind(s) {
    return { completed: "ok", passed: "ok", running: "run", paused: "warn", failed: "bad", cancelled: "muted", skipped: "muted", idle: "muted", synced: "ok", syncing: "run", outdated: "warn", error: "bad" }[s] || "muted";
  }
  function allWorkflows() {
    var out = [];
    ((S.state && S.state.repos) || []).forEach(function (r) { (r.workflows || []).forEach(function (w) { out.push(w); }); });
    return out.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }

  // ------------------------------------------------------------------ views
  function defaultModelFor(h) {
    var m = S.state && S.state.settings["agent.model." + h];
    return m ? m : "harness default";
  }

  function jiraMode() { return (S.state && S.state.settings["jira.mode"]) || "disabled"; }

  function customCard() {
    var open = S.startFor === (S.custom && S.custom.key);
    var h = '<div class="dv-card"><div class="dv-card-h"><b>Custom task</b>' + pill("no Jira needed", "muted") + "</div>" +
      '<input id="dv-custom-summary" placeholder="What should be built or fixed?" value="' + esc((S.custom && S.custom.summary) || "") + '">' +
      '<textarea id="dv-custom-desc" rows="3" placeholder="Details / acceptance criteria (optional)">' + esc((S.custom && S.custom.description) || "") + "</textarea>" +
      '<div class="dv-actions">' + btn(open ? "Cancel" : "Start custom task", "customForm", {}, open ? "" : "dv-primary") + "</div>";
    if (open) h += startForm(S.custom);
    return h + "</div>";
  }

  function viewTickets() {
    var mode = jiraMode(), h = "";
    var modePill = { disabled: pill("Jira off", "muted"), manual: pill("Jira: manual (REST)", S.ticketsLive || S.state.jiraTokenSet ? "ok" : "warn"), harness: pill("Jira: via agent harness", "ok") }[mode];
    h += '<div class="dv-note">' + modePill + " <a href='#' data-act='goto' data-sub='settings'>change</a></div>";
    if (mode === "manual") {
      h += '<div class="dv-row"><select data-filter="status">' + ["All", "To Do", "In Progress", "In Review", "Done"].map(function (s) {
        return "<option" + (S.filter.status === s ? " selected" : "") + ">" + s + "</option>";
      }).join("") + '</select><input data-filter="query" placeholder="Search tickets…" value="' + esc(S.filter.query) + '">' +
        btn(S.ticketsLoading ? "Loading…" : "Pull tickets", "pull") + "</div>";
    } else if (mode === "harness") {
      if (!S.state.atlassianSignedIn) {
        h += '<div class="dv-card dv-live"><div class="dv-card-h"><b>Connect Jira</b>' + pill("recommended", "ok") + "</div>" +
          '<div class="dv-muted">One browser sign-in lets CodeSentinel read and update tickets directly, The login is stored encrypted and refreshes by itself.</div>' +
          '<div class="dv-actions">' + btn("Connect Jira (browser)", "jiraConnect", {}, "dv-primary") + "</div></div>";
      }
      h += '<div class="dv-row"><input id="dv-ticket-key" placeholder="Ticket key, e.g. SEC-101" value="' + esc(S.ticketKeyInput || "") + '">' + btn("Fetch ticket", "fetchTicket", {}, "dv-primary") + "</div>" +
        '<div class="dv-row">' + btn(S.ticketsLoading ? "Asking agent…" : "List my tickets", "pull") + '<span class="dv-muted">Your agent (' + esc(S.state.settings.defaultAgentHarness) + ") reads Jira with its own connection; this can take a minute.</span></div>";
    } else {
      h += '<div class="dv-note">Jira is disabled. Use a custom task below, or choose <b>manual</b> / <b>harness</b> in <a href="#" data-act="goto" data-sub="settings">Settings</a>.</div>';
    }
    if (S.ticketsError) h += '<div class="dv-err">' + esc(S.ticketsError) + "</div>";
    S.tickets.forEach(function (t) {
      var open = S.startFor === t.key;
      h += '<div class="dv-card"><div class="dv-card-h"><b>' + esc(t.key) + "</b>" + pill(t.status, "muted") + pill(t.priority, t.priority === "Highest" || t.priority === "High" ? "bad" : "muted") +
        pill(t.issueType, "muted") + '</div><div class="dv-title">' + esc(t.summary) + "</div>" +
        '<div class="dv-desc">' + esc((t.description || "").slice(0, 220)) + "</div>" +
        '<div class="dv-actions">' + btn(open ? "Cancel" : "Start working", "startForm", { key: t.key }, open ? "" : "dv-primary") + "</div>";
      if (open) h += startForm(t);
      h += "</div>";
    });
    return h + customCard();
  }

  function startForm(t) {
    var repos = S.state.repos, h = '<div class="dv-form" data-ticket="' + esc(t.key) + '">';
    h += '<div class="dv-label">Repositories <em>(' + (S.state.settings.multiRepoEnabled ? "tick several to run the ticket across repos" : "multi-repo is off") + ")</em></div>";
    repos.forEach(function (r) {
      var checked = r.path === S.state.activeRepo || repos.length === 1;
      var bases = baseOptions(r);
      h += '<div class="dv-repo-pick"><label><input type="checkbox" class="dv-repo" value="' + esc(r.path) + '"' + (checked ? " checked" : "") +
        (!S.state.settings.multiRepoEnabled && r.path !== S.state.activeRepo ? " disabled" : "") + "> <b>" + esc(r.name) + "</b></label>" +
        '<select class="dv-base" data-repo="' + esc(r.path) + '" title="Branch to cut from">' + bases.map(function (b) { return "<option>" + esc(b) + "</option>"; }).join("") + "</select>" +
        '<input class="dv-branch" data-repo="' + esc(r.path) + '" value="' + esc((t.branches && t.branches[r.path]) || "") + '" title="New branch name"></div>';
    });
    h += '<div class="dv-row"><select class="dv-mode"><option value="auto">Autonomous agents (plan → develop → scan → test)</option><option value="terminal">Interactive terminal</option></select>' +
      '<select class="dv-harness">' + [["claude-code", "Claude Code"], ["gemini-antigravity", "Antigravity"], ["opencode", "OpenCode"]].map(function (o) {
        return '<option value="' + o[0] + '"' + (S.state.settings.defaultAgentHarness === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
      }).join("") + "</select></div>";
    h += '<div class="dv-row"><label class="dv-field" style="flex:1"><span>Model (blank = settings default)</span><input class="dv-model" placeholder="' + esc(defaultModelFor(S.state.settings.defaultAgentHarness)) + '"></label>' +
      '<label class="dv-field" style="flex:1"><span>Effort</span><select class="dv-effort"><option value="">settings default</option>' + EFFORTS.map(function (e) { return '<option value="' + e + '">' + e + "</option>"; }).join("") + "</select></label>" +
      '<label class="dv-field" style="flex:1"><span>Pause</span><select class="dv-pause">' + [["gates", "Plan + before push"], ["every_stage", "After every stage"], ["none", "Only before push"]].map(function (o) {
        return '<option value="' + o[0] + '"' + ((S.state.settings["workflow.pauseMode"] || "gates") === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
      }).join("") + "</select></label></div>" +
      '<label class="dv-check" style="display:none"><input type="checkbox" class="dv-planappr"></label>' +
      '<label class="dv-check"><input type="checkbox" class="dv-autopush"' + (S.state.settings["workflow.autoPush"] ? " checked" : "") + "> Push automatically when all gates pass</label>";
    h += '<details class="dv-stages"><summary>Stages</summary>' + STAGES.map(function (st) {
      var on = !(((S.state.settings["workflow.stages"] || {})[st[0]]) === false);
      return '<label class="dv-check"><input type="checkbox" class="dv-stage" data-id="' + st[0] + '"' + (on ? " checked" : "") + "> " + st[1] + "</label>";
    }).join("") + "</details>";
    h += btn("Start", "start", { key: t.key }, "dv-primary") + "</div>";
    return h;
  }

  function baseOptions(r) {
    var cfg = (r.config && r.config.baseBranches) || S.state.settings["workflow.baseBranches"] || [];
    var seen = {}, out = [];
    cfg.concat([r.currentBranch], r.branches).forEach(function (b) { if (b && !seen[b]) { seen[b] = 1; out.push(b); } });
    return out;
  }

  function agentChip(a) {
    return '<span class="dv-chip" title="' + esc(a.harness) + '">' + esc(a.role) + " · " + esc(a.harness) + (a.model ? " · " + esc(a.model) : "") + (a.effort ? " · " + esc(a.effort) : "") + "</span>";
  }

  function elapsed(ms) { var s = Math.max(0, Math.round(ms / 1000)); return s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s"; }

  function viewWorkflows() {
    var list = allWorkflows();
    if (!list.length) return '<div class="dv-empty">No workflows yet. Start a ticket from the Tickets view.<br><span class="dv-muted">Workflows run by the MCP server or CLI appear here too, as long as their repository is listed under Repos &amp; Tests.</span></div>';
    return list.map(function (w) {
      var cur = w.steps.filter(function (x) { return x.status === "running"; })[0];
      var h = '<div class="dv-card' + (w.status === "running" ? " dv-live" : "") + '"><div class="dv-card-h"><b>' + esc(w.ticketKey) + "</b>" + pill(w.status, statusKind(w.status)) +
        (w.awaiting ? pill("awaiting " + w.awaiting.replace(/_/g, " "), "warn") : "") + "<span class=\"dv-muted\">" + esc(w.id.split(":")[0]) + " · " + esc(w.targetBranch) + "</span></div>";
      if (w.ticketSummary) h += '<div class="dv-title">' + esc(w.ticketSummary) + "</div>";
      if (w.status === "running" && cur) {
        h += '<div class="dv-now"><span class="dv-spin"></span><b>' + esc(cur.name) + "</b>" +
          (w.currentAgent ? " " + agentChip(w.currentAgent) + ' <span class="dv-muted">' + elapsed(Date.now() - w.currentAgent.startedAt) + "</span>" : ' <span class="dv-muted">running a check…</span>') + "</div>";
      }
      h += '<ol class="dv-steps">' + w.steps.map(function (st) {
        var key = w.id + "#" + st.id;
        return '<li class="dv-step dv-' + statusKind(st.status) + '"><i>' + (STEP_ICON[st.status] || "○") + "</i><span><b>" + esc(st.name) + "</b>" +
          (st.agents && st.agents.length ? '<span class="dv-chips">' + st.agents.map(agentChip).join("") + "</span>" : "") +
          (st.summary ? "<em>" + esc(st.summary) + "</em>" : "") + (st.error ? '<em class="dv-bad-t">' + esc(st.error) + "</em>" : "") +
          (st.output ? '<a href="#" class="dv-link" data-act="toggleLog" data-id="' + esc(key) + '">' + (S.openLogs[key] ? "hide agent output" : "agent output") + "</a>" : "") +
          (S.openLogs[key] && st.output ? '<pre class="dv-pre">' + esc(st.output) + "</pre>" : "") + "</span></li>";
      }).join("") + "</ol>";
      if (w.iteration) h += '<div class="dv-note">Fix iterations used: ' + w.iteration + "</div>";
      if (w.activity && w.activity.length && (w.status === "running" || S.openLogs[w.id + "#live"])) {
        h += '<div class="dv-label">Live activity</div><pre class="dv-pre dv-feed" data-feed="' + esc(w.id) + '">' + esc(w.activity.slice(-40).join("\n")) + "</pre>";
      }
      h += '<div class="dv-actions">';
      if (w.status === "paused" || w.status === "failed") {
        var label = w.awaiting === "plan_approval" ? "Approve plan" : w.awaiting === "push_approval" ? "Approve & push" : w.awaiting === "stage_approval" ? "Continue to next stage" : "Retry from failed step";
        h += btn(label, "resume", { key: w.ticketKey, repo: w.repoPath }, "dv-primary");
      }
      if (w.status === "failed" || w.awaiting === "stage_approval") h += btn("Skip this step", "skip", { key: w.ticketKey, repo: w.repoPath });
      if (w.status === "running" || w.status === "paused") h += btn("Cancel", "cancel", { key: w.ticketKey, repo: w.repoPath });
      h += btn("Open agent terminal", "terminal", { key: w.ticketKey, repo: w.repoPath }) +
        btn(S.openLogs[w.id] ? "Hide log" : "Log", "toggleLog", { id: w.id }) +
        (w.activity && w.activity.length && w.status !== "running" ? btn(S.openLogs[w.id + "#live"] ? "Hide activity" : "Activity", "toggleLog", { id: w.id + "#live" }) : "") +
        (w.plan ? btn(S.openLogs[w.id + "#plan"] ? "Hide plan" : "Plan", "toggleLog", { id: w.id + "#plan" }) : "") +
        btn("Discard & delete branch", "discard", { key: w.ticketKey, repo: w.repoPath }, "dv-danger") + "</div>";
      if (S.openLogs[w.id]) h += "<pre class=\"dv-pre\">" + esc(w.logs.join("\n")) + "</pre>";
      if (S.openLogs[w.id + "#plan"]) h += "<pre class=\"dv-pre\">" + esc(w.plan || "") + "</pre>";
      return h + "</div>";
    }).join("");
  }

  function suiteCell(label, r, repo, suite) {
    var st = r ? r.status : "idle";
    var counts = r && r.status !== "skipped" ? r.passedCount + " pass · " + r.failedCount + " fail · " + r.skippedCount + " skip" : (r ? "skipped" : "not run");
    var key = repo + "#" + suite;
    return '<div class="dv-suite dv-' + statusKind(st === "idle" ? "idle" : st) + '"><div><b>' + esc(label) + "</b> " + pill(st, statusKind(st)) + "</div><div class=\"dv-muted\">" + esc(counts) +
      (r && r.durationMs ? " · " + (r.durationMs / 1000).toFixed(1) + "s" : "") + "</div><div class=\"dv-actions\">" + btn("Run", "runTests", { repo: repo, suite: suite }) +
      (r ? btn(S.openOutput[key] ? "Hide output" : "View output", "toggleOutput", { id: key }) : "") + "</div>" +
      (S.openOutput[key] && r ? "<pre class=\"dv-pre\">" + esc(r.output || "") + "</pre>" : "") + "</div>";
  }

  function cfgInput(r, key, label, placeholder, val) {
    return '<label class="dv-field"><span>' + esc(label) + '</span><input data-cfg="' + esc(key) + '" data-repo="' + esc(r.path) + '" placeholder="' + esc(placeholder || "") + '" value="' + esc(val == null ? "" : val) + '"></label>';
  }

  function viewRepos() {
    var st = S.state, h = '<div class="dv-row">' + btn("Add repository", "addRepo", {}, "dv-primary") + btn("Sync all graphs", "syncAll") + btn("Run all tests", "runAllRepos") + "</div>";
    if (!st.settings.multiRepoEnabled) h += '<div class="dv-note">' + pill("Multi-repo off", "warn") + " Only the workspace repository is managed. Turn it on in Settings.</div>";
    if (!st.repos.length) return h + '<div class="dv-empty">No repositories detected. Open a folder or add one.</div>';
    st.repos.forEach(function (r) {
      var active = r.path === st.activeRepo, t = r.tests || {}, c = r.config || {};
      h += '<div class="dv-card' + (active ? " dv-active" : "") + '"><div class="dv-card-h"><b>' + esc(r.name) + "</b>" + (active ? pill("active", "ok") : "") +
        pill(r.syncStatus === "synced" ? "graph synced" : "graph " + r.syncStatus, statusKind(r.syncStatus)) + (r.isDirty ? pill("uncommitted changes", "warn") : "") + "</div>" +
        '<div class="dv-muted dv-path" title="' + esc(r.path) + '">' + esc(r.path) + "</div>" +
        '<div class="dv-row"><label class="dv-inline">Branch <select data-act-change="checkout" data-repo="' + esc(r.path) + '">' +
        r.branches.map(function (b) { return "<option" + (b === r.currentBranch ? " selected" : "") + ">" + esc(b) + "</option>"; }).join("") + "</select></label>" +
        btn("Sync graph", "syncRepo", { repo: r.path }) + (!active ? btn("Make active", "setActive", { repo: r.path }) : "") + btn("Remove", "removeRepo", { repo: r.path }) + "</div>" +
        (r.lastSyncTime ? '<div class="dv-muted">Last graph sync ' + new Date(r.lastSyncTime).toLocaleTimeString() + (r.syncError ? ' · <span class="dv-bad-t">' + esc(r.syncError) + "</span>" : "") + "</div>" : "");
      h += '<div class="dv-label">Tests ' + (t.overallStatus && t.overallStatus !== "idle" ? pill(t.overallStatus, statusKind(t.overallStatus)) : "") + "</div>" +
        '<div class="dv-suites">' + suiteCell("Unit", t.unit, r.path, "unit") + suiteCell("Stage / API", t.stageApi, r.path, "stage_api") + suiteCell("Playwright", t.playwright, r.path, "playwright") + "</div>" +
        '<div class="dv-actions">' + btn("Run all", "runTests", { repo: r.path, suite: "all" }, "dv-primary") + btn("Scan changed files", "scanDiff", { repo: r.path }) +
        btn(S.openCfg[r.path] ? "Hide repo settings" : "Repo settings", "toggleCfg", { repo: r.path }) + "</div>";
      if (S.openCfg[r.path]) {
        h += '<div class="dv-form">' +
          cfgInput(r, "branchTemplate", "Branch name template", "feature/${ticketKey}-${slug}", c.branchTemplate) +
          cfgInput(r, "baseBranches", "Base branches (comma separated, first is default)", "main, develop", (c.baseBranches || []).join(", ")) +
          '<label class="dv-field"><span>Branch selection</span><select data-cfg="branchMode" data-repo="' + esc(r.path) + '"><option value="auto"' + (c.branchMode !== "ask" ? " selected" : "") + '>Auto: cut from the default base</option><option value="ask"' + (c.branchMode === "ask" ? " selected" : "") + ">Ask me each time</option></select></label>" +
          cfgInput(r, "setupCommand", "Worktree setup command (runs once per ticket)", "auto: npm ci", c.setupCommand) +
          cfgInput(r, "testCommand", "Unit test command", "auto-detected", c.testCommand) +
          cfgInput(r, "apiTestCommand", "API test command", "npm run test:api", c.apiTestCommand) +
          cfgInput(r, "playwrightCommand", "Playwright command", "npx playwright test", c.playwrightCommand) +
          '<label class="dv-field"><span>Stage deploy</span><select data-cfg="stageDeployMode" data-repo="' + esc(r.path) + '">' + ["manual", "auto", "disabled"].map(function (m) {
            return "<option" + ((c.stageDeployMode || st.settings["testing.stageDeployMode"]) === m ? " selected" : "") + ">" + m + "</option>";
          }).join("") + "</select></label>" +
          cfgInput(r, "stageDeployCommand", "Stage deploy command (auto mode)", "npm run deploy:stage", c.stageDeployCommand) +
          cfgInput(r, "stageApiBaseUrl", "Stage API base URL", "https://stage.example.com", c.stageApiBaseUrl) +
          '<label class="dv-check"><input type="checkbox" data-cfg="playwrightEnabled" data-repo="' + esc(r.path) + '"' + (c.playwrightEnabled !== false ? " checked" : "") + "> Playwright tests enabled</label>" +
          '<label class="dv-check"><input type="checkbox" data-cfg="apiTestingEnabled" data-repo="' + esc(r.path) + '"' + (c.apiTestingEnabled !== false ? " checked" : "") + "> Stage & API tests enabled</label>" +
          '<div class="dv-muted">Secrets for this repo: manage under Settings → Secrets (scope “repo”, id “' + esc(r.name) + "”).</div></div>";
      }
      h += "</div>";
    });
    return h;
  }

  function viewSettings() {
    var s = S.state.settings, h = "";
    h += '<div class="dv-card"><div class="dv-card-h"><b>Features</b></div>' +
      toggle("openCodeEnabled", s.openCodeEnabled, "OpenCode harness", "Embedded OpenCode agent and web server in the Security Agent tab") +
      toggle("multiRepoEnabled", s.multiRepoEnabled, "Multi-repo", "Track, scan, test and run tickets across several repositories") +
      toggle("gitAutoSyncEnabled", s.gitAutoSyncEnabled, "Git auto-sync of code graph", "On branch switch, commit, pull or merge, only changed files are re-indexed") +
      '<label class="dv-field"><span>Default agent harness</span><select data-setting="defaultAgentHarness">' + [["claude-code", "Claude Code"], ["gemini-antigravity", "Antigravity (agy)"], ["opencode", "OpenCode"]].map(function (o) {
        return '<option value="' + o[0] + '"' + (s.defaultAgentHarness === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
      }).join("") + "</select></label>" +
      '<label class="dv-field"><span>Default branch template</span><input data-setting="branchNamingTemplate" value="' + esc(s.branchNamingTemplate) + '"></label></div>';

    var jm = jiraMode();
    h += '<div class="dv-card"><div class="dv-card-h"><b>Atlassian Jira</b>' + pill(jm, jm === "disabled" ? "muted" : "ok") + "</div>" +
      '<label class="dv-field"><span>Integration</span><select data-setting="jira.mode">' + [
        ["disabled", "Disabled: custom tasks only"],
        ["harness", "Via agent (claude -p) or direct Atlassian sign-in"],
        ["manual", "Manual: CodeSentinel uses host + email + API token"]].map(function (o) {
        return '<option value="' + o[0] + '"' + (jm === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
      }).join("") + "</select></label>";
    if (jm === "harness") {
      h += '<div class="dv-muted">Signed in: CodeSentinel talks to Jira directly. Not signed in: the agent reads Jira headlessly with <code>claude -p</code>, which needs an Atlassian MCP server registered locally (<code>claude mcp add</code>). Connecting is recommended:</div>' +
        '<div class="dv-note">' + (S.state.atlassianSignedIn ? pill("signed in to Atlassian", "ok") : pill("fallback not connected", "warn")) + "</div>" +
        '<div class="dv-actions">' + btn(S.state.atlassianSignedIn ? "Reconnect Jira" : "Connect Jira (browser)", "jiraConnect", {}, S.state.atlassianSignedIn ? "" : "dv-primary") +
        (S.state.atlassianSignedIn ? btn("Disconnect", "jiraDisconnect") : "") + btn("Test lookup", "jiraTest") + "</div>" +
        '<label class="dv-field"><span>Allowed Jira tool prefixes (comma separated)</span><input data-setting-list="jira.harnessAllowedTools" value="' + esc((s["jira.harnessAllowedTools"] || []).join(", ")) + '"></label>';
    } else if (jm === "manual") {
      h += '<label class="dv-field"><span>Host</span><input data-setting="jira.host" placeholder="https://company.atlassian.net" value="' + esc(s["jira.host"]) + '"></label>' +
        '<label class="dv-field"><span>Email</span><input data-setting="jira.email" value="' + esc(s["jira.email"]) + '"></label>' +
        '<label class="dv-field"><span>Project key</span><input data-setting="jira.projectKey" value="' + esc(s["jira.projectKey"]) + '"></label>' +
        '<label class="dv-field"><span>JQL filter (optional)</span><input data-setting="jira.jqlFilter" placeholder="assignee = currentUser() AND resolution = Unresolved" value="' + esc(s["jira.jqlFilter"]) + '"></label>' +
        '<div class="dv-actions">' + btn(S.state.jiraTokenSet ? "Replace API token" : "Set API token", "jiraToken", {}, "dv-primary") + btn("Test connection", "jiraTest") + "</div>" +
        '<div class="dv-muted">The API token is stored encrypted on this machine and never shown again.</div>';
    }
    h += "</div>";

    var rm = s["agent.roleModels"] || {};
    var CLAUDE_PRESETS = [["sonnet", "Sonnet (default)"], ["haiku", "Haiku (fastest, cheapest)"], ["opus", "Opus (most capable, most expensive)"], ["", "CLI default"]];
    var cm = s["agent.model.claude-code"] || "";
    var known = CLAUDE_PRESETS.some(function (o) { return o[0] === cm; });
    h += '<div class="dv-card"><div class="dv-card-h"><b>AI models</b></div><div class="dv-muted">Used by the autonomous agents. CodeSentinel never picks Opus unless you do.</div>' +
      '<label class="dv-field"><span>Claude Code model</span><select data-setting="agent.model.claude-code">' + CLAUDE_PRESETS.map(function (o) {
        return '<option value="' + o[0] + '"' + (cm === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
      }).join("") + (known ? "" : '<option value="' + esc(cm) + '" selected>' + esc(cm) + " (custom)</option>") + "</select></label>" +
      '<label class="dv-field"><span>…or a specific Claude model ID</span><input data-setting="agent.model.claude-code" placeholder="e.g. claude-sonnet-5-5" value="' + (known ? "" : esc(cm)) + '"></label>' +
      '<label class="dv-field"><span>Antigravity (agy) model</span><input data-setting="agent.model.gemini-antigravity" placeholder="blank = Antigravity default" value="' + esc(s["agent.model.gemini-antigravity"] || "") + '"></label>' +
      '<label class="dv-field"><span>OpenCode model (provider/model)</span><input data-setting="agent.model.opencode" placeholder="e.g. anthropic/claude-sonnet-5-5" value="' + esc(s["agent.model.opencode"] || "") + '"></label>' +
      '<div class="dv-label">Reasoning effort <em>(higher = slower and more expensive)</em></div>' +
      '<label class="dv-field"><span>Claude Code effort</span>' + effortSelect('data-setting="agent.effort.claude-code"', s["agent.effort.claude-code"], "CLI default") + "</label>" +
      '<label class="dv-field"><span>Antigravity (agy) effort</span>' + effortSelect('data-setting="agent.effort.gemini-antigravity"', s["agent.effort.gemini-antigravity"], "CLI default") + "</label>" +
      '<div class="dv-muted">OpenCode has no effort flag, so it is not offered.</div>' +
      '<div class="dv-label">Per-stage override <em>(optional; applies to the harness above)</em></div>' +
      ["planner", "developer", "tester", "fixer"].map(function (r) {
        return '<label class="dv-field"><span>' + r + '</span><div class="dv-row" style="margin:0"><input data-rolemodel="' + r + '" placeholder="model: same as above" value="' + esc(rm[r] || "") + '">' +
          effortSelect('data-roleeffort="' + r + '"', (s["agent.roleEfforts"] || {})[r], "effort: same") + "</div></label>";
      }).join("") + "</div>";

    h += '<div class="dv-card"><div class="dv-card-h"><b>Workflow</b></div>' +
      '<label class="dv-field"><span>Pause</span><select data-setting="workflow.pauseMode">' + [["gates", "Plan approval + before push (default)"], ["every_stage", "After every stage"], ["none", "Only before push"]].map(function (o) {
        return '<option value="' + o[0] + '"' + ((s["workflow.pauseMode"] || "gates") === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
      }).join("") + "</select></label>" +
      '<div class="dv-label">Stages <em>(switch off to skip)</em></div>' + STAGES.map(function (st) {
        var on = !((s["workflow.stages"] || {})[st[0]] === false);
        return '<label class="dv-toggle"><input type="checkbox" data-stage="' + st[0] + '"' + (on ? " checked" : "") + "><span><b>" + st[1] + "</b></span></label>";
      }).join("") +
      toggle("workflow.jiraStageComments", s["workflow.jiraStageComments"] !== false, "Post stage updates to Jira", "A comment after plan, development, tests and push (when Jira is enabled)") +
      toggle("workflow.useWorktrees", s["workflow.useWorktrees"], "Isolated worktree per ticket", "Lets several tickets/agents work on one repo in parallel without touching your checkout") +
      toggle("workflow.autoPush", s["workflow.autoPush"], "Auto-push when all gates pass", "Off = wait for your approval. main/master/develop/release are never pushed") +
      '<label class="dv-field"><span>Max scan → fix iterations</span><input type="number" min="0" max="10" data-setting="workflow.maxFixIterations" value="' + esc(s["workflow.maxFixIterations"]) + '"></label>' +
      '<label class="dv-field"><span>Agent step timeout (minutes)</span><input type="number" min="1" data-setting="workflow.agentTimeoutMinutes" value="' + esc(s["workflow.agentTimeoutMinutes"]) + '"></label></div>';

    h += '<div class="dv-card"><div class="dv-card-h"><b>Testing defaults</b></div>' +
      toggle("testing.playwrightEnabled", s["testing.playwrightEnabled"], "Playwright frontend tests") +
      toggle("testing.apiTestingEnabled", s["testing.apiTestingEnabled"], "Stage & API tests") +
      '<label class="dv-field"><span>Stage deploy</span><select data-setting="testing.stageDeployMode">' + ["manual", "auto", "disabled"].map(function (m) {
        return "<option" + (s["testing.stageDeployMode"] === m ? " selected" : "") + ">" + m + "</option>";
      }).join("") + "</select></label>" +
      '<label class="dv-field"><span>Stage deploy command</span><input data-setting="testing.stageDeployCommand" value="' + esc(s["testing.stageDeployCommand"]) + '"></label>' +
      '<label class="dv-field"><span>Stage API base URL</span><input data-setting="testing.stageApiBaseUrl" value="' + esc(s["testing.stageApiBaseUrl"]) + '"></label>' +
      '<div class="dv-muted">Per-repo overrides live under Repos → Repo settings.</div></div>';

    h += '<div class="dv-card"><div class="dv-card-h"><b>Secrets</b></div><div class="dv-muted">Injected as environment variables into stage/API tests. Resolution order: ticket → repo → global. Values are encrypted on disk, masked in test output, and never sent to agents.</div>';
    (S.state.secrets || []).forEach(function (x) {
      h += '<div class="dv-secret"><code>' + esc(x.key) + "</code>" + pill(x.scope + (x.scopeId ? ": " + x.scopeId : ""), "muted") +
        btn("Delete", "delSecret", { key: x.key, scope: x.scope, id: x.scopeId || "" }) + "</div>";
    });
    h += '<div class="dv-row"><input id="dv-sec-key" placeholder="NAME (e.g. STAGE_API_KEY)"><select id="dv-sec-scope"><option value="global">global</option><option value="repo">repo</option><option value="ticket">ticket</option></select>' +
      '<input id="dv-sec-id" placeholder="repo name / ticket key"></div>' + btn("Add secret…", "addSecret", {}, "dv-primary") + "</div>";
    return h;
  }

  var SUBS = [["tickets", "Tickets"], ["workflows", "Workflows"], ["repos", "Repos & Tests"], ["settings", "Settings"]];

  function render() {
    if (!S.state) { root.innerHTML = '<div class="dv-empty">Loading…</div>'; return; }
    var active = document.activeElement, keep = active && active.getAttribute && (active.getAttribute("data-filter") || active.id);
    var running = allWorkflows().filter(function (w) { return w.status === "running"; }).length;
    var waiting = allWorkflows().filter(function (w) { return w.status === "paused"; }).length;
    var h = '<div class="dv-subnav">' + SUBS.map(function (s) {
      var badge = s[0] === "workflows" && (running || waiting) ? '<i class="dv-badge">' + (running + waiting) + "</i>" : "";
      return '<button class="dv-sub' + (S.sub === s[0] ? " active" : "") + '" data-act="goto" data-sub="' + s[0] + '">' + s[1] + badge + "</button>";
    }).join("") + "</div>";
    if (S.toast) h += '<div class="dv-toast dv-' + esc(S.toast.kind) + '">' + esc(S.toast.text) + "</div>";
    h += S.sub === "tickets" ? viewTickets() : S.sub === "workflows" ? viewWorkflows() : S.sub === "repos" ? viewRepos() : viewSettings();
    root.innerHTML = h;
    if (keep) {
      var again = root.querySelector('[data-filter="' + keep + '"]') || document.getElementById(keep);
      if (again && again.focus) { again.focus(); try { again.setSelectionRange(again.value.length, again.value.length); } catch (e) {} }
    }
    root.querySelectorAll(".dv-feed").forEach(function (el) { el.scrollTop = el.scrollHeight; });
    applyOpenCodeNotice();
  }

  function applyOpenCodeNotice() {
    var chat = document.getElementById("tab-chat"), id = "dv-opencode-off";
    if (!chat || !S.state) return;
    var existing = document.getElementById(id), off = S.state.settings.openCodeEnabled === false;
    if (off && !existing) {
      var d = document.createElement("div");
      d.id = id; d.className = "dv-oc-off";
      d.innerHTML = "<b>OpenCode is turned off.</b><span>Use Developer → Settings to enable it, or run tickets with Claude Code / Antigravity.</span>" +
        '<button class="dv-btn dv-primary" id="dv-oc-enable">Enable OpenCode</button>';
      chat.prepend(d);
      d.querySelector("#dv-oc-enable").addEventListener("click", function () { post("setSetting", { key: "openCodeEnabled", value: true }); });
    } else if (!off && existing) existing.remove();
  }

  // ------------------------------------------------------------------ events
  function formData(key) {
    var f = root.querySelector('.dv-form[data-ticket="' + key + '"]'); if (!f) return null;
    var repos = [], bases = {}, branches = {};
    f.querySelectorAll(".dv-repo:checked").forEach(function (c) {
      var p = c.value; repos.push(p);
      bases[p] = f.querySelector('.dv-base[data-repo="' + CSS.escape(p) + '"]').value;
      branches[p] = f.querySelector('.dv-branch[data-repo="' + CSS.escape(p) + '"]').value.trim();
    });
    return { repos: repos, bases: bases, branches: branches, mode: f.querySelector(".dv-mode").value, harness: f.querySelector(".dv-harness").value,
      model: f.querySelector(".dv-model").value.trim(), effort: f.querySelector(".dv-effort").value, stages: (function () { var o = {}; f.querySelectorAll(".dv-stage").forEach(function (c) { o[c.dataset.id] = c.checked; }); return o; })(), pauseMode: f.querySelector(".dv-pause").value, autoPush: f.querySelector(".dv-autopush").checked };
  }

  root.addEventListener("click", function (e) {
    var t = e.target.closest("[data-act]"); if (!t) return;
    e.preventDefault();
    var d = t.dataset;
    switch (d.act) {
      case "goto": S.sub = d.sub; vscode.setState(Object.assign({}, vscode.getState(), { devSub: S.sub })); render(); if (S.sub === "tickets" && !S.tickets.length) pullTickets(); break;
      case "pull": pullTickets(); break;
      case "startForm": S.startFor = S.startFor === d.key ? null : d.key; if (S.startFor) post("branchNames", { ticketKey: d.key }); render(); break;
      case "customForm":
        var cs = val("dv-custom-summary"), cd = val("dv-custom-desc");
        if (S.custom && S.startFor === S.custom.key) { S.startFor = null; render(); break; }
        if (!cs) { toast("Describe the task first.", "bad"); break; }
        S.custom = { key: "TASK-" + (Date.now() % 100000000), summary: cs, description: cd, status: "To Do", priority: "Medium", issueType: "Task", branches: {} };
        S.startFor = S.custom.key; render(); break;
      case "fetchTicket": S.ticketKeyInput = val("dv-ticket-key"); if (!S.ticketKeyInput) { toast("Enter a ticket key.", "bad"); break; }
        toast("Asking the agent to read " + S.ticketKeyInput.toUpperCase() + "…"); post("getTicket", { ticketKey: S.ticketKeyInput }); break;
      case "start": var fd = formData(d.key); if (!fd || !fd.repos.length) { toast("Select at least one repository.", "bad"); break; }
        var isCustom = S.custom && S.custom.key === d.key;
        post("startTicket", Object.assign({ ticketKey: d.key }, fd, isCustom ? { custom: { summary: S.custom.summary, description: S.custom.description } } : {})); S.startFor = null; S.sub = fd.mode === "auto" ? "workflows" : S.sub; render(); break;
      case "resume": post("resume", { ticketKey: d.key, repoPath: d.repo }); break;
      case "cancel": post("cancel", { ticketKey: d.key, repoPath: d.repo }); break;
      case "skip": post("skip", { ticketKey: d.key, repoPath: d.repo }); break;
      case "discard": post("discard", { ticketKey: d.key, repoPath: d.repo }); break;
      case "terminal": post("openTerminal", { ticketKey: d.key, repoPath: d.repo }); break;
      case "toggleLog": S.openLogs[d.id] = !S.openLogs[d.id]; render(); break;
      case "toggleOutput": S.openOutput[d.id] = !S.openOutput[d.id]; render(); break;
      case "toggleCfg": S.openCfg[d.repo] = !S.openCfg[d.repo]; render(); break;
      case "addRepo": post("addRepo"); break;
      case "removeRepo": post("removeRepo", { repoPath: d.repo }); break;
      case "setActive": post("setActiveRepo", { repoPath: d.repo }); break;
      case "syncRepo": post("syncRepo", { repoPath: d.repo }); break;
      case "syncAll": ((S.state && S.state.repos) || []).forEach(function (r) { post("syncRepo", { repoPath: r.path }); }); break;
      case "runTests": post("runTests", { repoPath: d.repo, suite: d.suite }); break;
      case "runAllRepos": ((S.state && S.state.repos) || []).forEach(function (r) { post("runTests", { repoPath: r.path, suite: "all" }); }); break;
      case "scanDiff": post("scanDiff", { repoPath: d.repo }); break;
      case "jiraToken": post("setJiraToken"); break;
      case "jiraTest": post("testJira"); break;
      case "jiraConnect": post("jiraConnect"); break;
      case "jiraDisconnect": post("jiraDisconnect"); break;
      case "addSecret": post("addSecret", { key: val("dv-sec-key"), scope: val("dv-sec-scope"), scopeId: val("dv-sec-id") }); break;
      case "delSecret": post("deleteSecret", { key: d.key, scope: d.scope, scopeId: d.id }); break;
    }
  });

  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; }

  root.addEventListener("change", function (e) {
    var t = e.target;
    if (t.dataset.stage) {
      var stNow = Object.assign({}, (S.state.settings["workflow.stages"] || {}));
      stNow[t.dataset.stage] = t.checked;
      post("setSetting", { key: "workflow.stages", value: stNow });
    } else if (t.dataset.roleeffort) {
      var reNow = Object.assign({}, (S.state.settings["agent.roleEfforts"] || {}));
      if (t.value) reNow[t.dataset.roleeffort] = t.value; else delete reNow[t.dataset.roleeffort];
      post("setSetting", { key: "agent.roleEfforts", value: reNow });
    } else if (t.dataset.rolemodel) {
      var rmNow = Object.assign({}, (S.state.settings["agent.roleModels"] || {}));
      if (t.value.trim()) rmNow[t.dataset.rolemodel] = t.value.trim(); else delete rmNow[t.dataset.rolemodel];
      post("setSetting", { key: "agent.roleModels", value: rmNow });
    } else if (t.dataset.settingList) {
      post("setSetting", { key: t.dataset.settingList, value: t.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean) });
    } else if (t.dataset.setting) {
      var v = t.type === "checkbox" ? t.checked : t.type === "number" ? Number(t.value) : t.value;
      post("setSetting", { key: t.dataset.setting, value: v });
    } else if (t.dataset.cfg) {
      var cfgVal = t.type === "checkbox" ? t.checked : t.value;
      if (t.dataset.cfg === "baseBranches") cfgVal = String(cfgVal).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      post("setRepoConfig", { repoPath: t.dataset.repo, patch: (function (o) { o[t.dataset.cfg] = cfgVal === "" ? null : cfgVal; return o; })({}) });
    } else if (t.dataset.actChange === "checkout") {
      post("checkout", { repoPath: t.dataset.repo, branch: t.value });
    } else if (t.dataset.filter) {
      S.filter[t.dataset.filter] = t.value; if (t.dataset.filter === "status") pullTickets();
    }
  });
  root.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target.dataset && e.target.dataset.filter === "query") { S.filter.query = e.target.value; pullTickets(); }
  });
  root.addEventListener("input", function (e) { if (e.target.dataset && e.target.dataset.filter === "query") S.filter.query = e.target.value; });

  function pullTickets() { S.ticketsLoading = true; S.ticketsError = ""; render(); post("listTickets", { status: S.filter.status, query: S.filter.query }); }

  window.addEventListener("message", function (event) {
    var m = event.data; if (!m || typeof m.command !== "string" || m.command.indexOf("dev:") !== 0) return;
    switch (m.command) {
      case "dev:state":
        S.state = m.state;
        // Never rebuild the DOM under a field the user is typing in; render when they leave it.
        var a = document.activeElement;
        if (a && root.contains(a) && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type !== "checkbox"))) S.pending = true;
        else render();
        break;
      case "dev:ticket":
        S.tickets = S.tickets.filter(function (t) { return t.key !== m.ticket.key; }); S.tickets.unshift(m.ticket); S.startFor = m.ticket.key; render(); break;
      case "dev:tickets": S.ticketsLoading = false; S.tickets = m.tickets || []; S.ticketsLive = !!m.live; S.ticketsError = m.error || ""; render(); break;
      case "dev:branchNames": S.tickets.forEach(function (t) { if (t.key === m.ticketKey) t.branches = m.branches; }); render(); break;
      case "dev:toast": toast(m.text, m.kind); break;
    }
  });

  root.addEventListener("focusout", function () { if (S.pending) { S.pending = false; setTimeout(render, 0); } });

  render();
  post("getState");
})();
