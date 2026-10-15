// Why a containerized run failed, in plain words. This runs BEFORE the quota check on purpose: Docker Hub's
// "toomanyrequests: You have reached your pull rate limit" contains the words "rate limit", and treating it
// as the agent's quota would put the whole platform into a long back-off for a problem that has nothing to do
// with the agent.
import type { RunResult } from '../runner/run.js';

export interface SandboxFailure {
  text: string;
  /** How long to leave this platform alone before trying again. */
  backoffMs: number;
}

const MIN = 60_000;

export function explainSandboxFailure(result: Pick<RunResult, 'ok' | 'exitCode' | 'stderrTail' | 'failure'>, name: string): SandboxFailure | null {
  if (result.ok) return null;
  const text = [result.failure ?? '', ...result.stderrTail].join('\n');
  const first = (re: RegExp) => re.test(text);
  if (first(/Cannot connect to the Docker daemon|error during connect|docker daemon is not running|failed to connect to the docker API|docker_engine/i)) {
    return { text: 'The container engine is not running. Start Docker (or your container tool); AgentMesh will carry on by itself.', backoffMs: 2 * MIN };
  }
  if (first(/toomanyrequests|pull rate limit|rate limit.*(docker|registry)/i)) {
    return { text: 'The registry refused to send the image because of its own pull limit (not your agent\'s quota). Sign in to the registry, or build the image locally so nothing is pulled.', backoffMs: 10 * MIN };
  }
  if (first(/Unable to find image|pull access denied|manifest unknown|repository does not exist|image.*not found/i)) {
    return { text: 'The image does not exist on this computer and could not be pulled. Build or pull it (the name is in the "sandbox" section of .agentmesh/config.json).', backoffMs: 5 * MIN };
  }
  if (first(/Mounts denied|not shared from the host|invalid mount|drive has not been shared|is not a valid Windows path/i)) {
    return { text: 'The container engine is not allowed to use the project folder. In Docker Desktop, allow the drive or folder under Settings, Resources, File sharing.', backoffMs: 5 * MIN };
  }
  if (first(/Conflict\. The container name/i)) {
    return { text: `A container called ${name} already exists (left over from a crash). It is removed when AgentMesh next starts.`, backoffMs: 1 * MIN };
  }
  if (result.exitCode === 127 || first(/executable file not found|command not found|no such file or directory.*(claude|agy|codex|gemini|opencode)/i)) {
    return { text: 'The agent tool is not installed inside the image (or its name in "commands" is wrong). Install it in the image and sign in once there.', backoffMs: 5 * MIN };
  }
  if (result.exitCode === 137 && !first(/stopped/)) {
    return { text: 'The container was killed (exit 137): usually it ran out of the memory the wrapper allows (--memory), or it was stopped.', backoffMs: 0 };
  }
  return null;
}
