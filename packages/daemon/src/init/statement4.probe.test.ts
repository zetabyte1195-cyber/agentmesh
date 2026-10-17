import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isEmptyFolder } from './detect.js';
import { initProject } from './init.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };

describe('statement 4 probe', () => {
  // init refuses to run without a git identity. A machine with none configured (a fresh CI runner) must not decide
  // whether this passes, so the test brings its own.
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(IDENTITY)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const k of Object.keys(IDENTITY)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('detects a folder with README.md as empty and creates a repo in it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-test-s4-'));
    try {
      // Put a README.md file in the folder so the folder is NOT empty
      writeFileSync(join(dir, 'README.md'), '# Existing project readme\n');
      expect(isEmptyFolder(dir)).toBe(true); // isEmptyFolder claims a non-empty folder is empty

      const rep = await initProject({ repoRoot: dir, createRepo: true, commit: false });
      expect(rep.repoCreated).toBe(true); // Repo was created in a non-empty folder
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
