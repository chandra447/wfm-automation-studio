import type { EngineService } from './contract.ts';

/**
 * Single engine instance per process. The HTTP layer resolves it lazily so
 * route definitions stay importable (and type-checkable) without touching
 * Postgres, Redis, or the domain services.
 */
let current: EngineService | null = null;

export function setEngine(engine: EngineService | null): void {
  current = engine;
}

export function engineOf(create: () => EngineService): EngineService {
  current ??= create();
  return current;
}
