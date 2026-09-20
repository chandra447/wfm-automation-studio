import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '@wfm/testkit';
import { startFakeLlmProvider, type FakeLlmServer } from '../../../packages/testkit/src/fake-llm.ts';
import { connectStudioDb, type StudioDb } from '../src/engine/db.ts';
import { loadModelCatalogue, type ModelCatalogue } from '../src/llm/catalogue.ts';
import { LlmAccounting } from '../src/llm/accounting.ts';
import { LlmSettings } from '../src/llm/settings.ts';
import { OpenAiCompatibleProvider } from '../src/llm/provider.ts';

const CATALOGUE_MODEL = 'deepseek/deepseek-v4.1-flash';
const CUSTOMER_KEY = 'sk-customer-key-1234';
const SECRET = 'a'.repeat(64);

const TENANT_NONE = '11111111-1111-4111-8111-111111111111';
const TENANT_CUSTOMER = '11111111-1111-4111-8111-000000000002';
const TENANT_PLATFORM = '11111111-1111-4111-8111-000000000003';
const TENANT_USAGE = '11111111-1111-4111-8111-000000000004';
const OTHER_TENANT = '11111111-1111-4111-8111-000000000005';
const RUN_ID = '99999999-9999-4999-8999-000000000001';
const SECOND_RUN_ID = '99999999-9999-4999-8999-000000000002';
const THIRD_RUN_ID = '99999999-9999-4999-8999-000000000003';
const UNKNOWN_RUN_ID = '99999999-9999-4999-8999-000000000004';

const env: NodeJS.ProcessEnv = {
  LLM_CONFIG_SECRET: SECRET,
  PLATFORM_LLM_BASE_URL: 'https://platform.test/v1',
  PLATFORM_LLM_API_KEY: 'sk-platform-key',
  PLATFORM_LLM_MODEL: CATALOGUE_MODEL,
  LLM_TIMEOUT_MS: '2000',
};

let database: TestDatabase;
let studio: StudioDb;
let catalogue: ModelCatalogue;
let settings: LlmSettings;
let accounting: LlmAccounting;
let fake: FakeLlmServer;

/**
 * The llm tables come from the shipped migration, so the schema this test runs
 * against cannot drift from the one a deployment gets.
 */
async function applyLlmMigration(): Promise<void> {
  const migration = await Bun.file(new URL('../drizzle/0002_features.sql', import.meta.url)).text();
  const sql = migration
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  for (const statement of sql.split(';')) {
    if (statement.includes('llm_')) await studio.sql.unsafe(statement);
  }
}

beforeAll(async () => {
  database = await createTestDatabase(
    'postgres://wfm:wfm@127.0.0.1:5433/studio',
    `studio_llm_${Math.random().toString(36).slice(2, 8)}`,
  );
  studio = connectStudioDb(database.url);
  await applyLlmMigration();
  catalogue = await loadModelCatalogue('config/models.jsonl');
  settings = new LlmSettings({ db: studio.db, catalogue, env });
  accounting = new LlmAccounting({ db: studio.db, catalogue });
  fake = startFakeLlmProvider();
});

afterAll(async () => {
  fake.stop();
  await studio.close();
  await database.drop();
});

describe('tenant provider settings', () => {
  test('a tenant with no row has no provider, but the platform is reported as available', async () => {
    expect(await settings.getSettings(TENANT_NONE)).toEqual({
      kind: 'none',
      baseUrl: null,
      model: null,
      hasApiKey: false,
      apiKeyLast4: null,
      platformConfigured: true,
      updatedAt: null,
      updatedBy: null,
    });
    expect(await settings.resolveProvider(TENANT_NONE)).toBeNull();
  });

  test('a customer key round-trips, is never readable, and reaches the provider', async () => {
    fake.reset();
    const baseUrl = fake.url;
    const saved = await settings.saveSettings(
      TENANT_CUSTOMER,
      { kind: 'openai-compatible', baseUrl, apiKey: CUSTOMER_KEY, model: 'fake-model-1' },
      'actor-1',
    );

    expect(saved).toMatchObject({
      kind: 'openai-compatible',
      baseUrl,
      model: 'fake-model-1',
      hasApiKey: true,
      apiKeyLast4: CUSTOMER_KEY.slice(-4),
      updatedBy: 'actor-1',
    });
    expect(typeof saved.updatedAt).toBe('string');
    expect(JSON.stringify(saved)).not.toContain(CUSTOMER_KEY);
    expect(JSON.stringify(saved)).not.toContain('sk-customer');

    const rows = await studio.sql<Array<{ api_key_ciphertext: string | null; api_key_last4: string | null }>>`
      select api_key_ciphertext, api_key_last4 from llm_provider_settings where tenant_id = ${TENANT_CUSTOMER}`;
    const stored = rows.at(0);
    expect(stored?.api_key_last4).toBe(CUSTOMER_KEY.slice(-4));
    expect(stored?.api_key_ciphertext).not.toBe(CUSTOMER_KEY);
    expect(stored?.api_key_ciphertext).not.toContain(CUSTOMER_KEY);
    expect(Buffer.from(stored?.api_key_ciphertext ?? '', 'base64').includes(Buffer.from(CUSTOMER_KEY, 'utf8'))).toBe(
      false,
    );

    const provider = await settings.resolveProvider(TENANT_CUSTOMER);
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
    if (provider === null) throw new Error('expected a provider');
    expect(provider.kind).toBe('openai-compatible');
    expect(provider.model).toBe('fake-model-1');
    expect(await provider.complete({ system: 's', user: 'u' })).toMatchObject({ model: 'fake-model-1' });

    const [sent] = fake.requests();
    expect(sent?.authorization).toBe(`Bearer ${CUSTOMER_KEY}`);
    expect(sent?.model).toBe('fake-model-1');
  });

  test('a later save without a key keeps the stored one', async () => {
    const saved = await settings.saveSettings(
      TENANT_CUSTOMER,
      { kind: 'openai-compatible', baseUrl: fake.url, model: 'fake-model-2' },
      'actor-2',
    );

    expect(saved).toMatchObject({ model: 'fake-model-2', hasApiKey: true, apiKeyLast4: CUSTOMER_KEY.slice(-4) });
    expect(saved.updatedBy).toBe('actor-2');
  });

  test('choosing none clears the stored key and resolves to no provider', async () => {
    const saved = await settings.saveSettings(TENANT_CUSTOMER, { kind: 'none' }, 'actor-3');
    const { updatedAt, ...rest } = saved;

    expect(typeof updatedAt).toBe('string');
    expect(rest).toEqual({
      kind: 'none',
      baseUrl: null,
      model: null,
      hasApiKey: false,
      apiKeyLast4: null,
      platformConfigured: true,
      updatedBy: 'actor-3',
    });
    expect(await settings.resolveProvider(TENANT_CUSTOMER)).toBeNull();
  });

  test('the platform provider uses the environment endpoint and its own model', async () => {
    const saved = await settings.saveSettings(TENANT_PLATFORM, { kind: 'platform' }, 'actor-1');

    expect(saved).toMatchObject({ kind: 'platform', baseUrl: null, model: CATALOGUE_MODEL, hasApiKey: false });

    const provider = await settings.resolveProvider(TENANT_PLATFORM);
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
    if (provider === null) throw new Error('expected a provider');
    expect(provider.kind).toBe('platform');
    expect(provider.model).toBe(CATALOGUE_MODEL);
  });

  test('a customer key is refused when LLM_CONFIG_SECRET is missing, naming the variable', async () => {
    const strict = new LlmSettings({
      db: studio.db,
      catalogue,
      env: {
        PLATFORM_LLM_BASE_URL: env.PLATFORM_LLM_BASE_URL,
        PLATFORM_LLM_API_KEY: env.PLATFORM_LLM_API_KEY,
        PLATFORM_LLM_MODEL: env.PLATFORM_LLM_MODEL,
      },
    });

    await expect(
      strict.saveSettings(TENANT_NONE, { kind: 'openai-compatible', baseUrl: 'https://customer.test/v1', apiKey: CUSTOMER_KEY, model: 'm' }, 'actor-1'),
    ).rejects.toThrow(/LLM_CONFIG_SECRET/);
  });

  test('an unusable provider setting is rejected', async () => {
    await expect(settings.saveSettings(TENANT_NONE, { kind: 'openai-compatible', model: 'm' }, 'actor-1')).rejects.toThrow(
      /baseUrl/,
    );
    await expect(
      settings.saveSettings(TENANT_NONE, { kind: 'platform', apiKey: CUSTOMER_KEY }, 'actor-1'),
    ).rejects.toThrow(/PLATFORM_LLM_API_KEY/);
  });
});

describe('token accounting', () => {
  test('sums a run and a tenant from the same rows, priced by the catalogue', async () => {
    const call = (overrides: { tenantId: string; runId: string; model: string; inputTokens: number; outputTokens: number }) =>
      accounting.recordCall({ nodeId: 'propose', providerKind: 'platform', latencyMs: 900, status: 'ok', ...overrides });

    await call({ tenantId: TENANT_USAGE, runId: RUN_ID, model: CATALOGUE_MODEL, inputTokens: 1_000_000, outputTokens: 500_000 });
    await call({ tenantId: TENANT_USAGE, runId: RUN_ID, model: CATALOGUE_MODEL, inputTokens: 500_000, outputTokens: 500_000 });
    // A model the catalogue does not list costs nothing, but its tokens still count.
    await call({ tenantId: TENANT_USAGE, runId: SECOND_RUN_ID, model: 'fake-model-1', inputTokens: 1_000_000, outputTokens: 1_000_000 });
    await call({ tenantId: OTHER_TENANT, runId: THIRD_RUN_ID, model: CATALOGUE_MODEL, inputTokens: 2_000_000, outputTokens: 0 });

    expect(await accounting.tokensForRun(RUN_ID)).toEqual({
      inputTokens: 1_500_000,
      outputTokens: 1_000_000,
      calls: 2,
      estimatedCostCents: 82.5,
    });
    expect(await accounting.tokensForTenant(TENANT_USAGE)).toEqual({
      inputTokens: 2_500_000,
      outputTokens: 2_000_000,
      calls: 3,
      estimatedCostCents: 82.5,
    });
    expect(await accounting.tokensForTenant(OTHER_TENANT)).toEqual({
      inputTokens: 2_000_000,
      outputTokens: 0,
      calls: 1,
      estimatedCostCents: 30,
    });
    expect(await accounting.tokensForRun(UNKNOWN_RUN_ID)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      estimatedCostCents: 0,
    });
  });
});
