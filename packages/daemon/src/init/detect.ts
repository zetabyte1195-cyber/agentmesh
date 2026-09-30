// What kind of project is this, how do we check it works, and how do fresh worktrees get set up?
// Deliberately conservative: it only names a command when the project shows clear signs of using
// it, never installs into a global environment, and says so when it can't tell.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Bootstrap {
  strategy: 'none' | 'install' | 'junction';
  installCommand?: string;
  copyFiles?: string[];
}

export interface ProjectDetection {
  /** node | python | go | rust | java-maven | java-gradle | dotnet | make | empty | unknown */
  kind: string;
  /** How to check the project works, or null when it can't be told. */
  verifyCommand: string | null;
  bootstrap: Bootstrap;
  /** Things the person should know or decide, in plain words. */
  notes: string[];
}

const has = (root: string, ...names: string[]): boolean => names.some((n) => existsSync(join(root, n)));

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function textOf(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function entries(root: string): string[] {
  try {
    return readdirSync(root).filter((n) => n !== '.git');
  } catch {
    return [];
  }
}

/** Files that don't make a folder "a project": a fresh folder may hold these and still count as empty. */
const HARMLESS = new Set([
  '.gitignore', 'README.md', 'readme.md', 'LICENSE', 'LICENSE.md', '.DS_Store', 'Thumbs.db', '.gitattributes',
  // what `agentmesh init` itself writes: a project is still new after it ran
  'CLAUDE.md', 'GEMINI.md', 'AGENTS.md', '.mcp.json', '.agents', '.agentmesh',
]);

export function isEmptyFolder(root: string): boolean {
  return entries(root).every((n) => HARMLESS.has(n));
}

function detectNode(root: string): ProjectDetection {
  const pkg = readJson<{ scripts?: Record<string, string>; dependencies?: object; devDependencies?: object }>(join(root, 'package.json')) ?? {};
  const scripts = pkg.scripts ?? {};
  const manager = has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'yarn.lock') ? 'yarn' : has(root, 'bun.lock', 'bun.lockb') ? 'bun' : 'npm';
  const run = (name: string) => (manager === 'npm' ? (name === 'test' ? 'npm test' : `npm run ${name}`) : `${manager} ${name === 'test' ? 'test' : `run ${name}`}`);
  const notes: string[] = [];
  const isPlaceholder = (s: string | undefined) => !s || /no test specified/i.test(s);
  let verifyCommand: string | null = null;
  if (!isPlaceholder(scripts.check)) verifyCommand = run('check');
  else if (!isPlaceholder(scripts.test)) verifyCommand = run('test');
  else notes.push('package.json has no "test" or "check" script, so nothing verifies the code yet.');
  const install: Record<string, string> = {
    npm: has(root, 'package-lock.json') ? 'npm ci' : 'npm install',
    pnpm: 'pnpm install --frozen-lockfile',
    yarn: 'yarn install --frozen-lockfile',
    bun: 'bun install --frozen-lockfile',
  };
  const hasDeps = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length > 0;
  const lock = has(root, 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb');
  const bootstrap: Bootstrap = hasDeps || lock ? { strategy: 'install', installCommand: install[manager]!, copyFiles: ['.env'] } : { strategy: 'none', copyFiles: ['.env'] };
  return { kind: 'node', verifyCommand, bootstrap, notes };
}

function detectPython(root: string): ProjectDetection {
  const pyproject = textOf(join(root, 'pyproject.toml'));
  const req = `${textOf(join(root, 'requirements.txt'))}\n${textOf(join(root, 'requirements-dev.txt'))}`;
  const usesPytest = has(root, 'pytest.ini', 'conftest.py') || /\[tool\.pytest/.test(pyproject) || /\bpytest\b/.test(req) || /\bpytest\b/.test(pyproject) || has(root, 'tox.ini');
  const testsDir = has(root, 'tests', 'test');
  const notes = ['Python dependencies are not installed into new worktrees automatically. If your tests need packages, set bootstrap.installCommand in .agentmesh/config.json.'];
  let verifyCommand: string | null = null;
  if (usesPytest) verifyCommand = 'python -m pytest -q';
  else if (testsDir) verifyCommand = 'python -m unittest discover';
  else notes.push('No tests found yet, so nothing verifies the code.');
  return { kind: 'python', verifyCommand, bootstrap: { strategy: 'none', copyFiles: ['.env'] }, notes };
}

function detectMake(): ProjectDetection {
  return { kind: 'make', verifyCommand: 'make test', bootstrap: { strategy: 'none', copyFiles: ['.env'] }, notes: [] };
}

/** Inspect a repository root. Never runs anything. */
export function detectProject(root: string): ProjectDetection {
  const none: Bootstrap = { strategy: 'none', copyFiles: ['.env'] };
  if (has(root, 'package.json')) return detectNode(root);
  if (has(root, 'go.mod')) return { kind: 'go', verifyCommand: 'go test ./...', bootstrap: none, notes: [] };
  if (has(root, 'Cargo.toml')) return { kind: 'rust', verifyCommand: 'cargo test', bootstrap: none, notes: [] };
  if (has(root, 'pom.xml')) return { kind: 'java-maven', verifyCommand: 'mvn -q -B test', bootstrap: none, notes: [] };
  if (has(root, 'build.gradle', 'build.gradle.kts')) {
    const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
    const cmd = has(root, wrapper) ? (process.platform === 'win32' ? 'gradlew.bat test' : './gradlew test') : 'gradle test';
    return { kind: 'java-gradle', verifyCommand: cmd, bootstrap: none, notes: [] };
  }
  if (entries(root).some((n) => /\.(sln|csproj|fsproj)$/i.test(n))) return { kind: 'dotnet', verifyCommand: 'dotnet test', bootstrap: none, notes: [] };
  if (has(root, 'pyproject.toml', 'setup.py', 'requirements.txt', 'pytest.ini')) return detectPython(root);
  if (/^test:/m.test(textOf(join(root, 'Makefile')))) return detectMake();
  if (isEmptyFolder(root)) {
    return {
      kind: 'empty',
      verifyCommand: null,
      bootstrap: none,
      notes: ['New project: work will land after the other agent reviews it, without an automatic test run, until you set a test command ("verifyCommand" in .agentmesh/config.json).'],
    };
  }
  return {
    kind: 'unknown',
    verifyCommand: null,
    bootstrap: none,
    notes: ['Could not tell how to test this project. Set "verifyCommand" in .agentmesh/config.json (for example "make check").'],
  };
}
