// Whether an address is this computer: 127.0.0.1, localhost, or the same address written another way (one number, say).
// The same rule as the daemon's, so the warning the cockpit shows is the one the timeline will record.
export function isThisComputer(address: string): boolean {
  try {
    return ['127.0.0.1', 'localhost'].includes(new URL(address).hostname);
  } catch {
    return false;
  }
}

/** An Ollama model that runs on Ollama's servers: the list says so, and so does a name ending in cloud. */
export const looksLikeCloudModel = (name: string): boolean => /[:-]cloud$/i.test(name);
