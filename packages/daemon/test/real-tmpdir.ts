// Tests make folders under the system temp folder and then compare paths with what git prints, and git prints the real path.
// The system temp folder is often an alias of it (on macOS /var is really /private/var; on Windows a short 8.3 name such as
// RUNNER~1 stands for the long user name). Point the temp variables at the real path so both sides spell it the same way.
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

const real = realpathSync.native(tmpdir());
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = real;
