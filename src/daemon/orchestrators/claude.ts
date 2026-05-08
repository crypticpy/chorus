import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHORUS_TOOLS,
  DEFAULT_DAEMON_URL,
  type ConnectOpts,
  type ConnectResult,
  type OrchestratorDefinition,
  type OrchestratorStatus,
} from "./shared.js";

interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    defaultMode?: string;
    additionalDirectories?: string[];
  };
  [key: string]: unknown;
}

const CLAUDE_SETTINGS_PATH = path.join(
  os.homedir(),
  ".claude",
  "settings.local.json",
);
const CLAUDE_SLASH_COMMAND_PATH = path.join(
  os.homedir(),
  ".claude",
  "commands",
  "chorus.md",
);
const CLAUDE_PROJECT_CONFIG_PATH = path.join(os.homedir(), ".claude.json");

function readClaudeSettings(): ClaudeSettings {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function getClaudeStatus(): OrchestratorStatus {
  const config = readClaudeSettings();
  const allow = new Set(config.permissions?.allow ?? []);
  const approved = CHORUS_TOOLS.filter((t) => allow.has(t)).length;
  return {
    name: "claude",
    label: "Claude Code",
    connected: approved === CHORUS_TOOLS.length,
    approvedTools: approved,
    totalTools: CHORUS_TOOLS.length,
    note: "Pre-approves the 7 chorus.* tools so Claude Code doesn't prompt per-tool.",
    supported: true,
    firstCallBehavior: "auto",
  };
}

/**
 * Resolve the bundled `/chorus` slash command markdown shipped in the npm
 * package at `assets/slash-commands/chorus.md`. Works in both dist
 * (`__dirname` = `dist/daemon/orchestrators`) and dev/tsx
 * (`__dirname` = `src/daemon/orchestrators`) — both resolve to
 * `<pkg>/assets/...`.
 */
function resolveChorusSlashAsset(): string | null {
  const candidate = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "assets",
    "slash-commands",
    "chorus.md",
  );
  return fs.existsSync(candidate) ? candidate : null;
}

function installChorusSlashCommand(): ConnectResult["slashCommand"] {
  const source = resolveChorusSlashAsset();
  if (!source) return "skipped";
  const desired = fs.readFileSync(source, "utf-8");

  if (fs.existsSync(CLAUDE_SLASH_COMMAND_PATH)) {
    const current = fs.readFileSync(CLAUDE_SLASH_COMMAND_PATH, "utf-8");
    if (current === desired) return "unchanged";
    fs.writeFileSync(CLAUDE_SLASH_COMMAND_PATH, desired, "utf-8");
    return "updated";
  }

  fs.mkdirSync(path.dirname(CLAUDE_SLASH_COMMAND_PATH), { recursive: true });
  fs.writeFileSync(CLAUDE_SLASH_COMMAND_PATH, desired, "utf-8");
  return "installed";
}

/**
 * Patch Claude Code's local settings to whitelist all 7 Chorus MCP tools, and
 * drop the `/chorus` slash command into `~/.claude/commands/`. Idempotent.
 */
async function connectClaude(): Promise<ConnectResult> {
  const config = readClaudeSettings();
  const permissions = (config.permissions ?? {}) as NonNullable<
    ClaudeSettings["permissions"]
  >;
  const existing = new Set(permissions.allow ?? []);

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const tool of CHORUS_TOOLS) {
    if (existing.has(tool)) {
      alreadyPresent.push(tool);
    } else {
      existing.add(tool);
      added.push(tool);
    }
  }

  if (added.length > 0) {
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    const next: ClaudeSettings = {
      ...config,
      permissions: {
        ...permissions,
        allow: Array.from(existing).sort(),
      },
    };
    fs.writeFileSync(
      CLAUDE_SETTINGS_PATH,
      JSON.stringify(next, null, 2) + "\n",
      "utf-8",
    );
  }

  const slashCommand = installChorusSlashCommand();

  return {
    added,
    alreadyPresent,
    configPath: CLAUDE_SETTINGS_PATH,
    slashCommand,
    slashCommandPath: CLAUDE_SLASH_COMMAND_PATH,
  };
}

/**
 * Register Chorus as an MCP server in Claude Code's USER scope.
 * Patches `~/.claude.json` → top-level `mcpServers.chorus`.
 *
 * Why user scope, not project scope: Claude Code only loads
 * `projects.<dir>.mcpServers.*` when CWD matches that exact `<dir>`.
 * Earlier Chorus versions wrote into `projects[homedir].mcpServers.chorus`,
 * which is a no-op for every real project (CWD is rarely `~`). User-scope
 * entries load from any CWD — this matches what
 * `claude mcp add chorus -s user` produces.
 *
 * Idempotent: returns `{ added: false }` when the user-scope entry already
 * points at the same bin path. Also opportunistically removes any stale
 * `projects.<homedir>.mcpServers.chorus` entry the old code left behind.
 */
export async function registerClaudeMcpServer(opts: {
  binPath: string;
  /** Retained for compatibility; user-scope registration ignores it. */
  projectDir?: string;
  daemonUrl?: string;
}): Promise<{ added: boolean; configPath: string; project: string }> {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(CLAUDE_PROJECT_CONFIG_PATH)) {
    try {
      config = JSON.parse(fs.readFileSync(CLAUDE_PROJECT_CONFIG_PATH, "utf-8"));
    } catch {
      throw new Error(
        `Could not parse ${CLAUDE_PROJECT_CONFIG_PATH}. Fix the JSON or remove it and re-run.`,
      );
    }
  }

  const mcpServers =
    config.mcpServers && typeof config.mcpServers === "object"
      ? (config.mcpServers as Record<string, unknown>)
      : {};

  const desired = {
    command: "node",
    args: [opts.binPath, "mcp"],
    env: { CHORUS_DAEMON_URL: opts.daemonUrl ?? DEFAULT_DAEMON_URL },
  };

  // Sweep stale project-scoped entries written by older Chorus versions
  // (any project whose chorus entry points at the chorus bin). Without
  // this, the old keyed-on-homedir entry sticks around forever and
  // confuses `claude mcp list`.
  let projectsChanged = false;
  const projects =
    config.projects && typeof config.projects === "object"
      ? (config.projects as Record<string, Record<string, unknown>>)
      : undefined;
  if (projects) {
    for (const [, block] of Object.entries(projects)) {
      const blockServers = block?.mcpServers as
        | Record<string, { args?: string[] }>
        | undefined;
      if (!blockServers || typeof blockServers !== "object") continue;
      const entry = blockServers.chorus;
      if (!entry) continue;
      const isOurs =
        Array.isArray(entry.args) &&
        entry.args.length >= 2 &&
        entry.args[1] === "mcp";
      if (isOurs) {
        delete blockServers.chorus;
        projectsChanged = true;
      }
    }
  }

  const existing = mcpServers.chorus as
    | { command?: string; args?: string[]; env?: Record<string, string> }
    | undefined;
  const sameBin =
    existing &&
    Array.isArray(existing.args) &&
    existing.args[0] === opts.binPath &&
    existing.args[1] === "mcp";

  if (sameBin && !projectsChanged) {
    return {
      added: false,
      configPath: CLAUDE_PROJECT_CONFIG_PATH,
      project: "user",
    };
  }

  mcpServers.chorus = desired;
  const next = { ...config, mcpServers } as Record<string, unknown>;
  if (projects) next.projects = projects;

  fs.writeFileSync(
    CLAUDE_PROJECT_CONFIG_PATH,
    JSON.stringify(next, null, 2),
    "utf-8",
  );
  return {
    added: !sameBin,
    configPath: CLAUDE_PROJECT_CONFIG_PATH,
    project: "user",
  };
}

export const claudeOrchestrator: OrchestratorDefinition = {
  name: "claude",
  label: "Claude Code",
  getStatus: getClaudeStatus,
  detect: () => fs.existsSync(CLAUDE_PROJECT_CONFIG_PATH),
  connect: async (opts: ConnectOpts) => {
    const reg = await registerClaudeMcpServer(opts);
    const conn = await connectClaude();
    return {
      registered: reg.added,
      toolsAdded: conn.added.length,
      slashCommand: conn.slashCommand,
      full: conn,
    };
  },
};
