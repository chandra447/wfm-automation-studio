import type { EngineService } from './contract.ts';

/**
 * Single engine instance per process. The HTTP layer resolves it lazily so
 * route definitions stay importable (and type-checkable) without touching
 * Postgres, Redis, or the domain services. The factory is async because the
 * model catalogue is read from disk at boot.
 */
let current: Promise<EngineService> | null = null;

export function setEngine(engine: EngineService | null): void {
  current = engine === null ? null : Promise.resolve(engine);
}

export function engineOf(create: () => Promise<EngineService>): Promise<EngineService> {
  current ??= create();
  return current;
}
