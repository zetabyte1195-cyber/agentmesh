// Where the built cockpit lives. Three layouts exist:
//   1. AGENTMESH_DASHBOARD_DIR, if set (an explicit override);
//   2. a packaged install:  <package>/bin/agentmesh.mjs  next to  <package>/dashboard/
//   3. this repository:     packages/daemon/dist/**  and  packages/dashboard/dist/
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function dashboardCandidates(fromUrl: string = import.meta.url, env: NodeJS.ProcessEnv = process.env): string[] {
  const here = dirname(fileURLToPath(fromUrl));
  return [
    ...(env.AGENTMESH_DASHBOARD_DIR ? [resolve(env.AGENTMESH_DASHBOARD_DIR)] : []),
    resolve(here, '..', 'dashboard'), // packaged: bin/ next to dashboard/
    resolve(here, '..', '..', '..', 'dashboard', 'dist'), // repo: packages/daemon/dist/<x>/ -> packages/dashboard/dist
    resolve(here, '..', '..', 'dashboard', 'dist'), // repo: packages/daemon/dist/ -> packages/dashboard/dist
  ];
}

/** The first candidate that has an index.html; otherwise the repo location (so the error names something useful). */
export function dashboardDist(fromUrl: string = import.meta.url, env: NodeJS.ProcessEnv = process.env): string {
  const found = dashboardCandidates(fromUrl, env).find((d) => existsSync(join(d, 'index.html')));
  return found ?? dashboardCandidates(fromUrl, env).at(-2)!;
}
