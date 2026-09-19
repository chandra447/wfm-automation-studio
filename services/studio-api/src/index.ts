import { app } from './app.ts';
import { engineOf } from './engine/runtime.ts';
import { createEngineFromEnv } from './engine/index.ts';

const port = Number(process.env.STUDIO_API_PORT ?? 4103);

const engine = engineOf(createEngineFromEnv);
await engine.start();

app.listen(port);

const shutdown = async (signal: string) => {
  process.stderr.write(`studio-api received ${signal}, stopping engine\n`);
  await engine.stop();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.stdout.write(`studio-api listening on http://127.0.0.1:${port}\n`);
