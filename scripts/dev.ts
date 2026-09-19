/**
 * Dev runner: one command to bring up the whole stack with readable prefixed
 * output, and one Ctrl-C to bring it down.
 *
 *   bun run dev            # services + engine + worker + web
 *   bun run dev --no-web   # skip Next.js when you only need the API
 */
import { spawn } from 'bun';

const includeWeb = !process.argv.includes('--no-web');

interface Proc {
  name: string;
  color: string;
  cwd: string;
  args: string[];
}

const processes: Proc[] = [
  { name: 'rostering', color: '\x1b[33m', cwd: 'services/rostering-service', args: ['run', 'start'] },
  { name: 'attendance', color: '\x1b[36m', cwd: 'services/time-attendance-service', args: ['run', 'start'] },
  { name: 'studio-api', color: '\x1b[35m', cwd: 'services/studio-api', args: ['run', 'start'] },
  { name: 'studio-worker', color: '\x1b[32m', cwd: 'services/studio-api', args: ['run', 'worker'] },
  ...(includeWeb
    ? [{ name: 'studio-web', color: '\x1b[34m', cwd: 'apps/studio-web', args: ['run', 'dev'] }]
    : []),
];

const children: Array<{ proc: Proc; child: ReturnType<typeof spawn> }> = [];

function pipe(proc: Proc, stream: ReadableStream<Uint8Array> | null): void {
  if (!stream) return;
  const decoder = new TextDecoder();
  void (async () => {
    const reader = stream.getReader();
    let carry = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      carry += decoder.decode(value, { stream: true });
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        process.stdout.write(`${proc.color}[${proc.name}]\x1b[0m ${line}\n`);
      }
    }
  })();
}

for (const proc of processes) {
  const child = spawn({
    cmd: ['bun', ...proc.args],
    cwd: new URL(`../${proc.cwd}`, import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
  pipe(proc, child.stdout as ReadableStream<Uint8Array>);
  pipe(proc, child.stderr as ReadableStream<Uint8Array>);
  children.push({ proc, child });
  process.stdout.write(`${proc.color}[${proc.name}]\x1b[0m started\n`);
}

const shutdown = async () => {
  process.stdout.write('\nstopping…\n');
  for (const { child } of children) child.kill();
  await Promise.all(children.map(({ child }) => child.exited));
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
