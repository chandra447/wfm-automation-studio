import { createEngineFromEnv } from './engine/index.ts';

process.stdout.write('studio worker starting\n');

const engine = await createEngineFromEnv();
await engine.start();

const shutdown = async (signal: string) => {
  process.stderr.write(`studio worker received ${signal}, stopping\n`);
  await engine.stop();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.stdout.write('studio worker running: router + queue worker\n');
