import fs from "node:fs";
import path from "node:path";

const READ_TOOLS = new Set(["read", "read_file", "view_file", "glob", "grep", "grep_search", "find_by_name", "list_dir"]);
const EDIT_TOOLS = new Set(["edit", "write", "edit_file", "write_file", "replace_file_content", "multi_replace_file_content"]);
const SHELL_TOOLS = new Set(["bash", "run_command", "shell", "execute"]);
const NET_TOOLS = new Set(["webfetch", "web_fetch", "fetch", "curl"]);

const SAFE_SHELL_PREFIXES = [
  "git status",
  "git diff",
  "git log",
  "ls ",
  "ls",
  "pwd",
  "npm test",
  "node --test",
  "pytest",
  "./gradlew test",
];

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bcurl\b.*\|\s*(sh|bash)\b/i,
  /\bwget\b.*\|\s*(sh|bash)\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
];

function isPathInside(candidate, workspaceDir) {
  if (!candidate || !workspaceDir) return true;
  try {
    const wsReal = fs.existsSync(workspaceDir) ? fs.realpathSync(workspaceDir) : path.resolve(workspaceDir);
    const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(wsReal, candidate);
    const targetReal = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    return targetReal === wsReal || targetReal.startsWith(wsReal + path.sep);
  } catch {
    return false;
  }
}

export function formatSpokenPermissionSummary({ tool, input = {}, workspaceDir = "" }) {
  const t = String(tool || "tool").trim();
  const lower = t.toLowerCase();
  const wsName = workspaceDir ? path.basename(workspaceDir) : "the workspace";
  if (SHELL_TOOLS.has(lower)) {
    const cmd = String(input.command || input.cmd || "a command").trim().slice(0, 80);
    return `It wants to run ${cmd} in ${wsName}. Allow?`;
  }
  if (NET_TOOLS.has(lower)) {
    const url = String(input.url || "a web page").trim().slice(0, 80);
    return `It wants to fetch ${url}. Allow?`;
  }
  const target = String(input.file_path || input.path || input.target_file || "").trim();
  const shortTarget = target ? path.basename(target) : "a file";
  return `It wants to use ${t} on ${shortTarget} in ${wsName}. Allow?`;
}

export function evaluatePermissionPolicy({ tool, input = {}, workspaceDir = "", allowEdits = true }) {
  const lower = String(tool || "").trim().toLowerCase();
  const targetPath = String(input.file_path || input.path || input.target_file || input.directory || "").trim();
  const summary = formatSpokenPermissionSummary({ tool, input, workspaceDir });

  if (targetPath && !isPathInside(targetPath, workspaceDir)) {
    return {
      decision: "deny",
      risk: "high",
      reason: "outside workspace",
      summary: `Blocked ${tool} outside ${path.basename(workspaceDir || "workspace")}.`,
    };
  }

  if (READ_TOOLS.has(lower)) {
    return { decision: "allow", risk: "low", reason: "read inside workspace", summary };
  }

  if (EDIT_TOOLS.has(lower)) {
    return {
      decision: allowEdits ? "allow" : "ask",
      risk: allowEdits ? "low" : "medium",
      reason: allowEdits ? "edit inside workspace" : "edits require approval",
      summary,
    };
  }

  if (SHELL_TOOLS.has(lower)) {
    const cmd = String(input.command || input.cmd || "").trim();
    if (DESTRUCTIVE_PATTERNS.some((re) => re.test(cmd))) {
      return { decision: "ask", risk: "high", reason: "destructive command", summary };
    }
    if (SAFE_SHELL_PREFIXES.some((p) => cmd === p.trim() || cmd.startsWith(p))) {
      return { decision: "allow", risk: "low", reason: "safe shell allowlist", summary };
    }
    return { decision: "ask", risk: "medium", reason: "shell command requires approval", summary };
  }

  if (NET_TOOLS.has(lower)) {
    return { decision: "ask", risk: "medium", reason: "network access requires approval", summary };
  }

  return { decision: "ask", risk: "medium", reason: "default ask", summary };
}
