// agentmeshd. The store, leases, worktrees, merge queue, MCP gateway and runner
// arrive in tasks P1.2–P2.2 (see spec v1.1 §3 for the component map).
import { TASK_STATUSES } from '@agentmesh/core';

/** Cockpit, MCP (POST /mcp) and WebSocket share this one port (spec v1.1 §10.1, §11). */
export const DEFAULT_COCKPIT_PORT = 8934;
/** Loopback only: AgentMesh never listens on external interfaces (spec v1.1 §2.1, §7.5). */
export const BIND_HOST = '127.0.0.1';

export const KNOWN_TASK_STATUS_COUNT = TASK_STATUSES.length;

export { initProject, type InitReport } from './init/index.js';
export { startDaemon, type RunningDaemon } from './start/index.js';
export { exportBoard, type ExportOptions, type ExportReport } from './export/index.js';
export { chooseAgents, agentIdFor, detectProject, isEmptyFolder, InitError, DEFAULT_AGENTS, requireGitIdentity, type InitOptions, type ProjectConfig } from './init/index.js';
export { runDoctor, formatDoctor, smokeTestPlatform, platformInstaller, runInstall, type DoctorReport, type DoctorOptions, type InstallStep } from './doctor/index.js';
export { createRegistry, ensureAgyMcpRule, type PlatformAdapter, type PlatformRegistry, type CustomPlatformConfig } from './platforms/index.js';
export { projectStatus, formatStatus, callDaemon, projectRoot, readDaemonRecord, isAlive, NotRunningError, type StatusReport, type DaemonRecord } from './start/index.js';
