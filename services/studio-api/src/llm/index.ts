import type { ModelDescriptor, ProviderSettings, ProviderSettingsRequest } from '@wfm/contracts';
import { LlmAccounting } from './accounting.ts';
import { loadModelCatalogueFromEnv, type ModelCatalogue } from './catalogue.ts';
import { LlmSettings, type LlmDb } from './settings.ts';

/**
 * The model layer's public surface. `createLlmServices` is the composition
 * root: the catalogue loaded once at boot plus the two stores over the studio
 * database.
 */

export * from './accounting.ts';
export * from './catalogue.ts';
export * from './provider.ts';
export * from './settings.ts';

export interface LlmServices {
  catalogue: ModelCatalogue;
  settings: LlmSettings;
  accounting: LlmAccounting;
}

export async function createLlmServices(db: LlmDb, env: NodeJS.ProcessEnv = process.env): Promise<LlmServices> {
  const catalogue = await loadModelCatalogueFromEnv(env);
  return {
    catalogue,
    settings: new LlmSettings({ db, catalogue, env }),
    accounting: new LlmAccounting({ db, catalogue }),
  };
}

/**
 * The three HTTP operations app.ts wires, with the arguments it takes from the
 * request: GET /models, GET /provider-settings, PUT /provider-settings. The
 * tenant and user id come from the actor headers like every other route, so
 * the HTTP layer keeps owning transport and this keeps owning the model layer.
 */
export interface LlmRouteHandlers {
  models: () => ModelDescriptor[];
  providerSettings: (tenantId: string) => Promise<ProviderSettings>;
  saveProviderSettings: (
    tenantId: string,
    request: ProviderSettingsRequest,
    actorId: string,
  ) => Promise<ProviderSettings>;
}

export function llmRouteHandlers(services: LlmServices): LlmRouteHandlers {
  return {
    models: () => [...services.catalogue.models()],
    providerSettings: (tenantId) => services.settings.getSettings(tenantId),
    saveProviderSettings: (tenantId, request, actorId) => services.settings.saveSettings(tenantId, request, actorId),
  };
}
