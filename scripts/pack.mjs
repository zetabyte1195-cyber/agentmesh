// Build the shareable package:  node scripts/pack.mjs   (after `npm run build`)
//
//   release/agentmesh/
//     bin/agentmesh.mjs     a small launcher (scripts/launcher.mjs): checks Node and the database engine
//     bin/cli.mjs           the whole CLI + daemon in one file (better-sqlite3 stays a real dependency
//                           because it is native code)
//     dashboard/            the built cockpit
//     package.json, README.md
//   release/agentmesh-<version>.tgz     what you send to a friend:  npm install -g ./agentmesh-<version>.tgz
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'release', 'agentmesh');
const need = (p, hint) => {
  if (!existsSync(join(root, p))) throw new Error(`${p} is missing: ${hint}`);
};
need('packages/cli/dist/index.js', 'run "npm run build" first');
need('packages/dashboard/dist/index.html', 'run "npm run build" first');

const version = /export const VERSION = '([^']+)'/.exec(readFileSync(join(root, 'packages/cli/src/index.ts'), 'utf8'))?.[1];
if (!version) throw new Error('could not read VERSION from packages/cli/src/index.ts');
const sqlite = JSON.parse(readFileSync(join(root, 'node_modules/better-sqlite3/package.json'), 'utf8')).version;

rmSync(join(root, 'release'), { recursive: true, force: true });
mkdirSync(join(out, 'bin'), { recursive: true });

const bundle = await rolldown({
  input: join(root, 'packages/cli/dist/index.js'),
  platform: 'node',
  external: ['better-sqlite3'],
  logLevel: 'warn',
});
const { output } = await bundle.generate({ format: 'esm', codeSplitting: false });
await bundle.close();
const chunk = output.find((o) => o.type === 'chunk');
// A bundler that silently emits nothing once shipped an empty command; never again.
if (!chunk || chunk.code.length < 200_000 || !chunk.code.includes('agentmesh') || output.length !== 1) throw new Error(`the bundle looks wrong (${output.length} file(s), ${chunk?.code.length ?? 0} characters)`);
// The program, loaded by the launcher (which checks Node and the database engine first). It keeps its
// shebang: background mode starts it directly as the supervisor.
writeFileSync(join(out, 'bin', 'cli.mjs'), chunk.code.startsWith('#!') ? chunk.code : `#!/usr/bin/env node\n${chunk.code}`);
if (!chunk.code.includes('export {') || !/\bmain\b/.test(chunk.code)) throw new Error('the bundle does not export main() for the launcher');
cpSync(join(root, 'scripts', 'launcher.mjs'), join(out, 'bin', 'agentmesh.mjs'));
cpSync(join(root, 'scripts', 'update.mjs'), join(out, 'bin', 'update.mjs'));

cpSync(join(root, 'packages/dashboard/dist'), join(out, 'dashboard'), { recursive: true });
for (const doc of ['README.md', 'INSTALL.md', 'LICENSE']) if (existsSync(join(root, doc))) cpSync(join(root, doc), join(out, doc));
writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'agentmesh',
      version,
      description: 'Let several AI coding agents (Claude Code, Gemini/Antigravity, and others) plan, build and check each other\'s work on one project, while you watch and steer.',
      type: 'module',
      bin: { agentmesh: 'bin/agentmesh.mjs' },
      files: ['bin', 'dashboard', 'README.md', 'INSTALL.md', 'LICENSE'],
      license: 'MIT',
      homepage: 'https://github.com/zetabyte1195-cyber/agentmesh#readme',
      repository: { type: 'git', url: 'git+https://github.com/zetabyte1195-cyber/agentmesh.git' },
      bugs: { url: 'https://github.com/zetabyte1195-cyber/agentmesh/issues' },
      engines: { node: '>=22' },
      dependencies: { 'better-sqlite3': `^${sqlite}` },
      keywords: ['ai', 'agents', 'claude-code', 'gemini', 'mcp', 'multi-agent'],
    },
    null,
    2,
  )}\n`,
);

const packed = execSync(`npm pack --pack-destination "${join(root, 'release')}"`, { cwd: out, encoding: 'utf8' }).trim().split(/\r?\n/).at(-1);
// The same file under a fixed name, so ".../releases/latest/download/agentmesh.tgz" always installs the newest one.
cpSync(join(root, 'release', packed), join(root, 'release', 'agentmesh.tgz'));
console.log(`Built release/${packed} and release/agentmesh.tgz (agentmesh ${version}, better-sqlite3 ^${sqlite})`);
