#!/usr/bin/env node
// The `agentmesh` command of the packed release (G16). Before loading the program it checks the two things
// the program itself needs, and says (or fixes) what is wrong instead of failing with a stack trace:
//   • Node 22 or newer
//   • better-sqlite3's native part loads. It ships ready-made for Windows, macOS and Linux; it can still be
//     missing or damaged (an interrupted install, a file removed by a cleaner). `agentmesh repair` downloads
//     it again; in a terminal AgentMesh offers to do that itself.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`AgentMesh needs Node 22 or newer; this is Node ${process.versions.node}.\n  Install a current Node from https://nodejs.org, open a new terminal, then run agentmesh again.`);
  process.exit(1);
}

function sqliteProblem() {
  try {
    const Database = createRequire(import.meta.url)('better-sqlite3');
    new Database(':memory:').close();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.split('\n')[0] : String(err);
  }
}

// better-sqlite3 13 ships ready-made builds for Windows, macOS and Linux (x64 and arm64) inside its package,
// built against Node-API, so a Node upgrade does not break them. What can break is the package itself
// (a file deleted or damaged, an interrupted install): fetch it again. `npm rebuild` would try to COMPILE it,
// which needs build tools most people do not have.
function repair() {
  console.error('Repairing: downloading AgentMesh\'s database engine again (npm install, in AgentMesh\'s folder)');
  rmSync(join(packageDir, 'node_modules', 'better-sqlite3'), { recursive: true, force: true });
  // One fixed command string: npm is a .cmd shim on Windows, which only runs through a shell.
  const r = spawnSync('npm install --omit=dev --no-save --no-package-lock --no-audit --no-fund', { cwd: packageDir, stdio: 'inherit', shell: true });
  return r.status === 0 && sqliteProblem() === null;
}

const wantsRepair = process.argv[2] === 'repair';
const problem = sqliteProblem();
if (wantsRepair && !problem) {
  console.log('Nothing to repair: AgentMesh\'s database engine works with this Node.');
  process.exit(0);
}
if (problem) {
  console.error(`AgentMesh's database engine (better-sqlite3) does not work with this Node (${process.versions.node}):\n  ${problem}`);
  let yes = wantsRepair;
  if (!yes && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    yes = /^y(es)?$/i.test((await rl.question('Repair it now? This downloads it again with npm. [y/N] ')).trim());
    rl.close();
  }
  if (!yes) {
    console.error('  To repair it: agentmesh repair');
    process.exit(1);
  }
  if (!repair()) {
    console.error('\nThe repair did not work. Check your internet connection, then reinstall AgentMesh: npm install -g <the agentmesh .tgz file>');
    process.exit(1);
  }
  console.error('Repaired.');
  if (wantsRepair) process.exit(0);
}

const { main } = await import('./cli.mjs');
await main(process.argv.slice(2));
