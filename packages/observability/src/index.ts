import { pino, type Logger } from 'pino';

/**
 * Structured logs only. Every line carries enough context to debug from an id:
 * tenant, then whatever the caller binds (runId, eventId, correlationId).
 */
export interface LogContext {
  tenantId?: string;
  runId?: string;
  eventId?: string;
  correlationId?: string;
  workflowId?: string;
  nodeId?: string;
}

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  const pretty = process.env.NODE_ENV === 'development' && process.env.LOG_PRETTY === 'true';
  return pino({
    name,
    level,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } } : {}),
  });
}

export function loggerWith(logger: Logger, context: LogContext): Logger {
  return logger.child(context);
}

/**
 * W3C trace context is carried through the event envelope so one trace spans
 * service, backbone, engine, and the command back into a service.
 */
export function traceparentFor(traceId: string, spanId: string, sampled = true): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

export function traceIdOf(traceparent: string | null | undefined): string | null {
  if (!traceparent) return null;
  const parts = traceparent.split('-');
  return parts.length >= 4 ? (parts[1] ?? null) : null;
}
