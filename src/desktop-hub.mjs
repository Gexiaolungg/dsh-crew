import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function desktopLoopbackUrls(tasklist, netstat) {
  const pids = new Set(
    [...tasklist.matchAll(/^"DeepSeek Harness\.exe","(\d+)"/gim)].map((match) => match[1]),
  );
  const sockets = netstat.matchAll(
    /^\s*TCP\s+(127\.0\.0\.1|\[::1\]):(\d+)\s+(?:0\.0\.0\.0:0|\[::\]:0)\s+\S+\s+(\d+)\s*$/gim,
  );
  const urls = new Set();
  for (const [, host, port, pid] of sockets) {
    if (pids.has(pid)) urls.add('http://' + host + ':' + port);
  }
  return [...urls];
}

export async function findDesktopHubUrls() {
  if (process.platform !== 'win32') return [];
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const options = { windowsHide: true, timeout: 2500 };
  try {
    const [processes, sockets] = await Promise.all([
      run(join(system, 'tasklist.exe'), ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], options),
      run(join(system, 'netstat.exe'), ['-ano', '-p', 'tcp'], options),
    ]);
    return desktopLoopbackUrls(processes.stdout, sockets.stdout);
  } catch {
    // An unavailable desktop leaves the usual standalone fallback in place.
    return [];
  }
}
