import { app, setAttendanceService } from './app.ts';
import { createAttendanceRuntime } from './runtime.ts';

const port = Number(process.env.TIME_ATTENDANCE_PORT ?? 4102);

const runtime = await createAttendanceRuntime(process.env);
setAttendanceService(runtime.service);

app.listen(port);

const shutdown = async (signal: string) => {
  process.stderr.write(`time-attendance-service received ${signal}, draining outbox\n`);
  await runtime.publisher.stop();
  await runtime.publisher.drain();
  await runtime.bus.close();
  await runtime.service.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.stdout.write(`time-attendance-service listening on http://127.0.0.1:${port}\n`);
