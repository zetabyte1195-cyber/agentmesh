// Ports that Node's fetch (and every browser) refuse to connect to, because they belong to well-known services: the
// WHATWG fetch "bad ports" list. The list below is what Node 26 itself reports, port by port.
//
// Why AgentMesh cares: when it is asked for "any free port" the operating system may hand out one of these (on a computer
// whose dynamic port range includes low numbers, which is common after Docker, Hyper-V or WSL reserve ranges), and then
// the browser, an agent or a test cannot connect to its own cockpit: "fetch failed: bad port". On one such machine about
// one test run in five failed this way, in whichever test drew the port. So an automatically chosen port is never one of
// these, and a person who asks for one is told why not.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export const isBlockedPort = (port: number): boolean => BLOCKED_PORTS.has(port);

export const blockedPortMessage = (port: number): string =>
  `Port ${port} cannot be used: browsers and Node refuse to connect to it because it belongs to a well-known service. Pick another one (the default is 8934).`;

/**
 * Listen on `port`, or on a port the system chooses when `port` is 0, never one of the refused ones (the system is asked
 * again). A refused port that was asked for by number is an error, in plain words. Returns the port.
 */
export async function listenFree(server: Pick<Server, 'listen' | 'address' | 'close' | 'once' | 'off'>, host: string, port = 0, tries = 50): Promise<number> {
  if (port !== 0 && isBlockedPort(port)) throw new Error(blockedPortMessage(port));
  for (let i = 0; i < tries; i++) {
    await new Promise<void>((resolve, reject) => {
      const failed = (err: Error) => reject(err);
      server.once('error', failed);
      server.listen(port, host, () => {
        server.off('error', failed);
        resolve();
      });
    });
    const got = (server.address() as AddressInfo).port;
    if (!isBlockedPort(got)) return got;
    await new Promise<void>((resolve) => server.close(() => resolve())); // the system gave a refused port: let it go and ask again
  }
  throw new Error(`The system kept offering ports that clients refuse (${tries} times in a row). Try again, or pick a port yourself.`);
}
