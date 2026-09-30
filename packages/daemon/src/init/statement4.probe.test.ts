import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isEmptyFolder } from './detect.js';
import { initProject } from './init.js';

describe('statement 4 probe', () => {
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
