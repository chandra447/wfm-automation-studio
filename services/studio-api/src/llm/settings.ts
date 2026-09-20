import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import { z } from 'zod';
import {
  llmProviderKindSchema,
  providerSettingsRequestSchema,
  type ProviderSettings,
  type ProviderSettingsRequest,
} from '@wfm/contracts';
import * as schema from '../db/schema.ts';
import {
  AnthropicProvider,
  DEFAULT_LLM_TIMEOUT_MS,
  OpenAiCompatibleProvider,
  type LlmProvider,
} from './provider.ts';
import type { ModelCatalogue } from './catalogue.ts';

/**
 * Per-tenant provider settings. A customer key is encrypted with
 * LLM_CONFIG_SECRET before it is stored and is never handed back: a read
 * reports only whether a key exists and its last four characters.
 */

export type LlmDb = BunSQLDatabase<typeof schema>;

type ProviderSettingsRow = typeof schema.llmProviderSettings.$inferSelect;

const KEY_SALT = 'wfm-studio-llm-config';
const KEY_INFO = 'llm-provider-settings';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function configKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, KEY_SALT, KEY_INFO, KEY_BYTES));
}

/** AES-256-GCM over the key, with the IV and auth tag stored alongside it, base64. */
export function encryptApiKey(secret: string, apiKey: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', configKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptApiKey(secret: string, stored: string): string {
  const raw = Buffer.from(stored, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('the stored provider key is not a valid ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', configKey(secret), raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}

/** An unset variable and an empty one mean the same thing: not configured. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/**
 * What each kind needs, which the request DTO cannot express on its own: a
 * customer provider needs an endpoint, a model and a key, and the platform
 * provider owns its own key.
 */
const effectiveSettingsSchema = z
  .object({
    kind: llmProviderKindSchema,
    baseUrl: z.string().nullable(),
    model: z.string().nullable(),
    hasApiKey: z.boolean(),
    keyInRequest: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'platform') {
      if (value.keyInRequest) {
        ctx.addIssue({
          code: 'custom',
          path: ['apiKey'],
          message: 'the platform provider uses PLATFORM_LLM_API_KEY, so it cannot store a customer key',
        });
      }
      return;
    }
    if (value.kind === 'none') return;
    if (value.baseUrl === null) {
      ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: `${value.kind} needs a baseUrl` });
    }
    if (value.model === null) {
      ctx.addIssue({ code: 'custom', path: ['model'], message: `${value.kind} needs a model` });
    }
    if (!value.hasApiKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['apiKey'],
        message: `${value.kind} needs an apiKey the first time it is configured`,
      });
    }
  });

export interface LlmSettingsDeps {
  db: LlmDb;
  catalogue: ModelCatalogue;
  env?: NodeJS.ProcessEnv;
}

export class LlmSettings {
  readonly #db: LlmDb;
  readonly #catalogue: ModelCatalogue;
  readonly #env: NodeJS.ProcessEnv;

  constructor(deps: LlmSettingsDeps) {
    this.#db = deps.db;
    this.#catalogue = deps.catalogue;
    this.#env = deps.env ?? process.env;
  }

  async #row(tenantId: string): Promise<ProviderSettingsRow | undefined> {
    const rows = await this.#db
      .select()
      .from(schema.llmProviderSettings)
      .where(eq(schema.llmProviderSettings.tenantId, tenantId))
      .limit(1);
    return rows.at(0);
  }

  async getSettings(tenantId: string): Promise<ProviderSettings> {
    const row = await this.#row(tenantId);
    const platform = this.#platform();
    return {
      kind: row?.kind ?? 'none',
      baseUrl: row?.baseUrl ?? null,
      model: row?.model ?? null,
      hasApiKey: Boolean(row?.apiKeyCiphertext),
      apiKeyLast4: row?.apiKeyLast4 ?? null,
      platformConfigured: platform.baseUrl !== null && platform.apiKey !== null,
      updatedAt: row ? row.updatedAt.toISOString() : null,
      updatedBy: row?.updatedBy ?? null,
    };
  }

  async saveSettings(
    tenantId: string,
    request: ProviderSettingsRequest,
    actorId: string,
  ): Promise<ProviderSettings> {
    const input = providerSettingsRequestSchema.parse(request);
    const existing = await this.#row(tenantId);
    const customerKey = input.kind === 'openai-compatible' || input.kind === 'anthropic';

    const baseUrl = customerKey ? (input.baseUrl ?? existing?.baseUrl ?? null) : null;
    const model =
      input.kind === 'none'
        ? null
        : (input.model ?? existing?.model ?? this.#modelForKind(input.kind));
    const keptCiphertext = customerKey && input.apiKey === undefined ? (existing?.apiKeyCiphertext ?? null) : null;

    effectiveSettingsSchema.parse({
      kind: input.kind,
      baseUrl,
      model,
      hasApiKey: input.apiKey !== undefined || keptCiphertext !== null,
      keyInRequest: input.apiKey !== undefined,
    });

    let apiKeyCiphertext: string | null;
    let apiKeyLast4: string | null;
    if (!customerKey) {
      apiKeyCiphertext = null;
      apiKeyLast4 = null;
    } else if (input.apiKey !== undefined) {
      const secret = envValue(this.#env, 'LLM_CONFIG_SECRET');
      if (secret === null) throw new Error('LLM_CONFIG_SECRET is required to store a customer API key');
      apiKeyCiphertext = encryptApiKey(secret, input.apiKey);
      apiKeyLast4 = input.apiKey.slice(-4);
    } else {
      apiKeyCiphertext = keptCiphertext;
      apiKeyLast4 = existing?.apiKeyLast4 ?? null;
    }

    const updatedAt = new Date();
    const values = {
      tenantId,
      kind: input.kind,
      baseUrl,
      model,
      apiKeyCiphertext,
      apiKeyLast4,
      updatedBy: actorId,
      updatedAt,
    };
    await this.#db
      .insert(schema.llmProviderSettings)
      .values(values)
      .onConflictDoUpdate({ target: schema.llmProviderSettings.tenantId, set: values });

    return this.getSettings(tenantId);
  }

  /**
   * The provider this tenant's runs should call, or null when it has none: a
   * tenant with no row, `none`, or a platform that is not configured from env
   * all fall back to the deterministic rules path. `model` overrides the
   * tenant's configured model for one call, which is how the builder chat can
   * use a faster model than the workflows it writes.
   */
  async resolveProvider(tenantId: string, model?: string): Promise<LlmProvider | null> {
    const row = await this.#row(tenantId);
    if (row === undefined || row.kind === 'none') return null;

    const timeoutMs = this.#timeoutMs();
    if (row.kind === 'platform') {
      const platform = this.#platform();
      if (platform.baseUrl === null || platform.apiKey === null) return null;
      const chosen = model ?? row.model ?? platform.model ?? this.#catalogue.defaultModel().id;
      return new OpenAiCompatibleProvider({
        kind: 'platform',
        baseUrl: platform.baseUrl,
        apiKey: platform.apiKey,
        model: chosen,
        jsonMode: this.#jsonMode(chosen),
        timeoutMs,
      });
    }

    const { baseUrl, apiKeyCiphertext } = row;
    const chosen = model ?? row.model;
    if (baseUrl === null || chosen === null || apiKeyCiphertext === null) return null;
    const secret = envValue(this.#env, 'LLM_CONFIG_SECRET');
    if (secret === null) throw new Error('LLM_CONFIG_SECRET is required to read a stored provider key');
    const apiKey = decryptApiKey(secret, apiKeyCiphertext);

    if (row.kind === 'anthropic') {
      const maxTokens = this.#catalogue.modelById(chosen)?.maxOutputTokens;
      return new AnthropicProvider({
        baseUrl,
        apiKey,
        model: chosen,
        ...(maxTokens === undefined ? {} : { maxTokens }),
        timeoutMs,
      });
    }
    return new OpenAiCompatibleProvider({
      kind: row.kind,
      baseUrl,
      apiKey,
      model: chosen,
      jsonMode: this.#jsonMode(chosen),
      timeoutMs,
    });
  }

  #platform(): { baseUrl: string | null; apiKey: string | null; model: string | null } {
    return {
      baseUrl: envValue(this.#env, 'PLATFORM_LLM_BASE_URL'),
      apiKey: envValue(this.#env, 'PLATFORM_LLM_API_KEY'),
      model: envValue(this.#env, 'PLATFORM_LLM_MODEL'),
    };
  }

  /** A customer's model namespace is its own, so only the platform provider has a fallback. */
  #modelForKind(kind: 'platform' | 'openai-compatible' | 'anthropic'): string | null {
    if (kind !== 'platform') return null;
    return this.#platform().model ?? this.#catalogue.defaultModel().id;
  }

  #jsonMode(model: string): boolean {
    return this.#catalogue.modelById(model)?.jsonMode ?? true;
  }

  #timeoutMs(): number {
    const configured = Number(this.#env.LLM_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LLM_TIMEOUT_MS;
  }
}
