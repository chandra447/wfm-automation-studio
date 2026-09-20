import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { modelDescriptorSchema, type ModelDescriptor } from '@wfm/contracts';

/**
 * The model allow-list. config/models.jsonl is the only place a model is
 * declared: adding one is a line in that file and nothing else changes, so the
 * file is read once at boot and every consumer asks this catalogue.
 */

export interface ModelCatalogue {
  models: () => readonly ModelDescriptor[];
  modelById: (id: string) => ModelDescriptor | undefined;
  defaultModel: () => ModelDescriptor;
}

export const DEFAULT_CATALOGUE_PATH = 'config/models.jsonl';

/** Repo root, so MODEL_CATALOGUE_PATH means the same thing whatever the cwd is. */
const REPO_ROOT = new URL('../../../../', import.meta.url);

/**
 * A line may leave `default` out. The field still exists so exactly one model
 * can be marked as the one a tenant gets before it has chosen.
 */
const catalogueEntrySchema = modelDescriptorSchema.extend({ default: z.boolean().default(false) });

function cataloguePath(path: string): string {
  return isAbsolute(path) ? path : fileURLToPath(new URL(path, REPO_ROOT));
}

export async function loadModelCatalogue(path: string = DEFAULT_CATALOGUE_PATH): Promise<ModelCatalogue> {
  const absolute = cataloguePath(path);
  const file = Bun.file(absolute);
  if (!(await file.exists())) throw new Error(`model catalogue ${absolute} does not exist`);

  const models: ModelDescriptor[] = [];
  const byId = new Map<string, ModelDescriptor>();
  const lines = (await file.text()).split('\n');

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const where = `${absolute}:${index + 1}`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${where} is not valid JSON: ${reason}`);
    }

    const entry = catalogueEntrySchema.safeParse(parsed);
    if (!entry.success) {
      const issues = entry.error.issues
        .map((issue) => `${issue.path.join('.') || 'line'} ${issue.message}`)
        .join('; ');
      throw new Error(`${where} is not a model descriptor: ${issues}`);
    }
    if (byId.has(entry.data.id)) throw new Error(`${where} declares model ${entry.data.id} twice`);

    models.push(entry.data);
    byId.set(entry.data.id, entry.data);
  }

  const [first] = models;
  if (first === undefined) throw new Error(`${absolute} declares no models`);
  const fallback = models.find((model) => model.default) ?? first;

  return {
    models: () => models,
    modelById: (id) => byId.get(id),
    defaultModel: () => fallback,
  };
}

export async function loadModelCatalogueFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<ModelCatalogue> {
  return loadModelCatalogue(env.MODEL_CATALOGUE_PATH ?? DEFAULT_CATALOGUE_PATH);
}
