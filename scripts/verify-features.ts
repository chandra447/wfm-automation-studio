#!/usr/bin/env bun
/**
 * Feature verification for the studio: bring-your-own provider, model catalogue,
 * token accounting, dashboard, run input and output, workflow reuse, references
 * and artifacts, and the node-kind extension claim.
 *
 * Run through scripts/verify-features.sh, which starts the fake provider first.
 * Assumes the stack is up (scripts/verify.sh owns that).
 */
import { SQL } from 'bun';

const STUDIO_API = process.env.STUDIO_API_BASE_URL ?? 'http://127.0.0.1:4103';
const ROSTERING_API = process.env.ROSTERING_BASE_URL ?? 'http://127.0.0.1:4101';
const TENANT = process.env.DEMO_TENANT_ID ?? '11111111-1111-4111-8111-111111111111';

/** The platform credentials, read from the repo's .env so the checks use the real provider. */
async function envFile(): Promise<Record<string, string>> {
  const text = await Bun.file(new URL('../.env', import.meta.url)).text().catch(() => '');
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2];
  }
  return values;
}

const env = await envFile();
const PLATFORM_BASE_URL = env['PLATFORM_LLM_BASE_URL'] ?? '';
const PLATFORM_API_KEY = env['PLATFORM_LLM_API_KEY'] ?? '';
const STUDIO_DB = process.env.STUDIO_DATABASE_URL ?? 'postgres://wfm:wfm@127.0.0.1:5433/studio';
const COVERAGE_WORKFLOW = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';


const actor = (roles: string, userId = 'verify@demo.test'): Record<string, string> => ({
  'content-type': 'application/json',
  'x-tenant-id': TENANT,
  'x-user-id': userId,
  'x-user-roles': roles,
});

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  const tag = ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  console.log(`  ${tag} ${name}`);
  if (!ok) console.log(`       ${detail}`);
}

function skip(name: string, reason: string): void {
  results.push({ name, ok: true, detail: reason, skipped: true });
  console.log(`  \u001b[33mSKIP\u001b[0m ${name}`);
  console.log(`       ${reason}`);
}

async function call(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; body: unknown }> {
  try {
    const response = await fetch(`${STUDIO_API}${path}`, {
      method: init.method ?? 'GET',
      headers: init.headers ?? actor('roster_manager'),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      // A model call is the slowest thing any route does, so a caller that
      // expects one asks for a budget rather than taking the default.
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  } catch (error) {
    return { status: 0, body: String(error) };
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);


async function fireScenario(scenario: string): Promise<string | null> {
  const before = await call('/runs?limit=100');
  const known = new Set(asArray(before.body).map((run) => String(asRecord(run)['runId'])));
  const fired = await call(`/simulator/${scenario}`, { method: 'POST', body: {} });
  if (fired.status >= 400) return null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await Bun.sleep(500);
    const runs = await call('/runs?limit=100');
    const fresh = asArray(runs.body)
      .map(asRecord)
      .find((run) => !known.has(String(run['runId'])));
    if (fresh !== undefined) return String(fresh['runId']);
  }
  return null;
}

/**
 * A reasoning model can spend a minute or more on one proposal, so this waits
 * far longer than the engine's own model timeout before giving up.
 */
/**
 * The budget covers a slow vendor, not a slow engine: a model call on a large
 * prompt has taken 59s here, and the proposer retries once, so a single node can
 * spend two minutes before the graph moves on. The waits are generous on
 * purpose, because a verification that fails when the vendor is having a bad
 * afternoon is a verification nobody trusts.
 */
async function waitForStatus(runId: string, wanted: readonly string[], tries = 900): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const detail = await call(`/runs/${runId}`);
    const run = asRecord(asRecord(detail.body)['run']);
    if (wanted.includes(String(run['status']))) return asRecord(detail.body);
    if (['succeeded', 'failed', 'cancelled'].includes(String(run['status'])) && !wanted.includes(String(run['status']))) {
      return asRecord(detail.body);
    }
    await Bun.sleep(500);
  }
  return null;
}

function eventsOf(detail: Record<string, unknown>, kind: string): Array<Record<string, unknown>> {
  return asArray(detail['events']).map(asRecord).filter((event) => event['kind'] === kind);
}

/* 1. the three provider modes: platform, bring your own, and none */
const CATALOGUE_MODEL = 'deepseek/deepseek-v4.1-flash';

/** The chat is interactive, so its checks use the catalogue's fast model. */
const FAST_MODEL = 'deepseek/deepseek-chat-v3.1';

async function checkPlatformProvider(): Promise<void> {
  const current = asRecord((await call('/provider-settings')).body);
  if (current['platformConfigured'] === false) {
    skip(
      'provider: the platform provider runs the workflow',
      'PLATFORM_LLM_API_KEY is not set in the service environment, so there is nothing to call',
    );
    return;
  }
  const configured = await call('/provider-settings', { method: 'PUT', body: { kind: 'platform', model: CATALOGUE_MODEL } });
  if (configured.status >= 400) {
    record('provider: the platform provider runs the workflow', false, `PUT /provider-settings returned ${configured.status} ${JSON.stringify(configured.body).slice(0, 200)}`);
    return;
  }
  const runId = await fireScenario('coverage_rescue');
  if (runId === null) {
    record('provider: the platform provider runs the workflow', false, 'the coverage scenario did not produce a run');
    return;
  }
  const detail = (await waitForStatus(runId, ['awaiting_approval', 'succeeded'])) ?? {};
  const data = asRecord(eventsOf(detail, 'proposal_created')[0]?.['data']);
  const usage = asRecord(asRecord(detail['run'])['tokens']);
  const real = data['proposer'] === 'llm' && data['model'] === CATALOGUE_MODEL && Number(usage['inputTokens'] ?? 0) > 0;
  record(
    'provider: the platform provider runs the workflow',
    real,
    `proposer=${String(data['proposer'])} model=${String(data['model'])} tokens=${JSON.stringify(usage)}`,
  );
}

async function checkByoProvider(): Promise<void> {
  if (PLATFORM_API_KEY === '' || PLATFORM_BASE_URL === '') {
    skip(
      'provider: a customer-supplied provider is used',
      'PLATFORM_LLM_API_KEY and PLATFORM_LLM_BASE_URL are not set in .env, so there is nothing to point at',
    );
    return;
  }
  // The customer key is the same vendor credential, stored encrypted and read
  // back at run time, so this exercises the whole bring-your-own path.
  const configured = await call('/provider-settings', {
    method: 'PUT',
    body: { kind: 'openai-compatible', baseUrl: PLATFORM_BASE_URL, apiKey: PLATFORM_API_KEY, model: CATALOGUE_MODEL },
  });
  if (configured.status >= 400) {
    record('provider: a customer-supplied provider is used', false, `PUT /provider-settings returned ${configured.status} ${JSON.stringify(configured.body).slice(0, 200)}`);
    return;
  }
  const stored = asRecord(configured.body);
  const keyStored = stored['hasApiKey'] === true && String(stored['apiKeyLast4'] ?? '') === PLATFORM_API_KEY.slice(-4);
  const keyNotReturned = !JSON.stringify(configured.body).includes(PLATFORM_API_KEY);

  const runId = await fireScenario('coverage_rescue');
  if (runId === null) {
    record('provider: a customer-supplied provider is used', false, 'the coverage scenario did not produce a run');
    return;
  }
  const detail = (await waitForStatus(runId, ['awaiting_approval', 'succeeded'])) ?? {};
  const data = asRecord(eventsOf(detail, 'proposal_created')[0]?.['data']);
  const usage = asRecord(asRecord(detail['run'])['tokens']);
  record(
    'provider: a customer-supplied provider is used',
    data['proposer'] === 'llm' && data['model'] === CATALOGUE_MODEL && Number(usage['inputTokens'] ?? 0) > 0 && keyStored && keyNotReturned,
    `proposer=${String(data['proposer'])} model=${String(data['model'])} tokens=${JSON.stringify(usage)} keyStored=${keyStored} keyNotReturned=${keyNotReturned}`,
  );
}

async function checkRulesFallback(): Promise<void> {
  const configured = await call('/provider-settings', { method: 'PUT', body: { kind: 'none' } });
  if (configured.status >= 400) {
    record('provider: no provider configured falls back to the rules proposer', false, `PUT /provider-settings returned ${configured.status}`);
    return;
  }
  const runId = await fireScenario('coverage_rescue');
  if (runId === null) {
    record('provider: no provider configured falls back to the rules proposer', false, 'the coverage scenario did not produce a run');
    return;
  }
  const detail = (await waitForStatus(runId, ['awaiting_approval', 'succeeded'])) ?? {};
  const data = asRecord(eventsOf(detail, 'proposal_created')[0]?.['data']);
  record(
    'provider: no provider configured falls back to the rules proposer',
    data['proposer'] === 'rules',
    `proposer=${String(data['proposer'])}`,
  );
}

/* 2. model catalogue from config/models.jsonl */
async function checkModels(): Promise<void> {
  const listed = await call('/models');
  const catalogue = await Bun.file(new URL('../config/models.jsonl', import.meta.url)).text().catch(() => '');
  const declared = new Set(
    catalogue
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => String(asRecord(JSON.parse(line))['id'])),
  );
  const models = asArray(listed.body).map(asRecord);
  const ids = models.map((model) => String(model['id']));
  const allDeclared = ids.length > 0 && ids.every((id) => declared.has(id));
  record(
    'models: every offered model is declared in config/models.jsonl',
    listed.status === 200 && allDeclared,
    `GET /models returned ${listed.status} with ${ids.length} models; undeclared=${ids.filter((id) => !declared.has(id)).join(',') || 'none'}`,
  );

  const source = await call(`/workflows/${COVERAGE_WORKFLOW}`);
  const detail = asRecord(source.body);
  const version = asRecord(asArray(detail['versions']).map(asRecord).at(-1));
  const definition = asRecord(version['definition']);
  const nodes = asArray(definition['nodes']).map(asRecord);
  const ai = nodes.find((node) => node['type'] === 'ai_decision');
  if (ai === undefined) {
    record('models: a workflow naming an unknown model is rejected at save time', false, 'the coverage workflow has no ai_decision node');
    return;
  }
  const config = asRecord(ai['config']);
  const mutated = {
    ...definition,
    name: 'Model catalogue probe',
    nodes: nodes.map((node) =>
      node['type'] === 'ai_decision' ? { ...node, config: { ...config, model: 'not-a-real-model' } } : node,
    ),
  };
  const rejected = await call('/workflows', {
    method: 'POST',
    body: { name: 'Model catalogue probe', description: '', enabled: true, definition: mutated, layout: version['layout'] ?? {} },
  });
  const issues = JSON.stringify(rejected.body);
  record(
    'models: a workflow naming an unknown model is rejected at save time',
    rejected.status === 422 && issues.includes('models.jsonl'),
    `status=${rejected.status} body=${issues.slice(0, 240)}`,
  );
}

/* 3. token accounting */
async function checkTokens(): Promise<void> {
  const configured = await call('/provider-settings', {
    method: 'PUT',
    body: { kind: 'platform', model: CATALOGUE_MODEL },
  });
  if (configured.status >= 400) {
    record('tokens: run detail reports the provider usage', false, `PUT /provider-settings returned ${configured.status}`);
    record('tokens: dashboard totals match the run detail', false, 'no provider configured');
    return;
  }
  const runId = await fireScenario('coverage_rescue');
  if (runId === null) {
    record('tokens: run detail reports the provider usage', false, 'the coverage scenario did not produce a run');
    record('tokens: dashboard totals match the run detail', false, 'no run');
    return;
  }
  const detail = (await waitForStatus(runId, ['awaiting_approval', 'succeeded'])) ?? {};
  const usage = asRecord(asRecord(detail['run'])['tokens']);

  const sql = new SQL(STUDIO_DB, { max: 1 });
  const rows = await sql<Array<{ input: number; output: number; calls: number }>>`
    select coalesce(sum(input_tokens), 0)::int as input,
           coalesce(sum(output_tokens), 0)::int as output,
           count(*)::int as calls
    from llm_calls where run_id = ${runId}
  `;
  await sql.close();
  const stored = rows[0] ?? { input: 0, output: 0, calls: 0 };
  record(
    'tokens: run detail reports the provider usage',
    Number(usage['inputTokens'] ?? 0) === stored.input &&
      Number(usage['outputTokens'] ?? 0) === stored.output &&
      Number(usage['calls'] ?? 0) === stored.calls &&
      stored.input > 0,
    `run=${JSON.stringify(usage)} stored=${JSON.stringify(stored)}`,
  );

  const dashboard = asRecord((await call('/dashboard')).body);
  const totals = asRecord(dashboard['tokens']);
  record(
    'tokens: dashboard totals match the run detail',
    Number(totals['inputTokens'] ?? -1) >= Number(usage['inputTokens'] ?? 0) &&
      Number(totals['outputTokens'] ?? -1) >= Number(usage['outputTokens'] ?? 0),
    `dashboard=${JSON.stringify(totals)} run=${JSON.stringify(usage)}`,
  );
}

/* 4. dashboard against SQL */
async function checkDashboard(): Promise<void> {
  const dashboard = await call('/dashboard');
  if (dashboard.status !== 200) {
    record('dashboard: run counts match SQL aggregates', false, `GET /dashboard returned ${dashboard.status}`);
    record('dashboard: workflow rows carry version and run counts', false, `GET /dashboard returned ${dashboard.status}`);
    return;
  }
  const body = asRecord(dashboard.body);
  const sql = new SQL(STUDIO_DB, { max: 1 });
  const counts = await sql<Array<{ status: string; count: string }>>`select status, count(*)::text as count from runs group by status`;
  await sql.close();
  const expected = Object.fromEntries(counts.map((row) => [row.status, Number(row.count)]));
  const reported = asRecord(asRecord(body['runs'])['byStatus']);
  const matches = Object.entries(expected).every(([status, count]) => Number(reported[status] ?? -1) === count);
  record(
    'dashboard: run counts match SQL aggregates',
    matches,
    `sql=${JSON.stringify(expected)} dashboard=${JSON.stringify(reported)}`,
  );

  const workflows = asArray(body['workflows']).map(asRecord);
  const complete = workflows.length > 0 && workflows.every((workflow) => 'publishedVersion' in workflow && 'runs' in workflow);
  record(
    'dashboard: workflow rows carry version and run counts',
    complete,
    `workflows=${JSON.stringify(workflows.slice(0, 2))}`,
  );
}

/* 5. run input and output */
async function checkRunInputOutput(): Promise<void> {
  const runs = asArray((await call('/runs?limit=1')).body).map(asRecord);
  const runId = String(runs[0]?.['runId'] ?? '');
  const detail = await call(`/runs/${runId}`);
  const body = asRecord(detail.body);
  const input = asRecord(body['input']);
  const output = asRecord(body['output']);
  const triggerOk = String(input['triggerEventType'] ?? '') !== '' && input['payload'] !== undefined;
  record(
    'run detail: the trigger payload is exposed as input',
    detail.status === 200 && triggerOk,
    `status=${detail.status} input=${JSON.stringify(input).slice(0, 200)}`,
  );
  const outputOk = String(output['status'] ?? '') !== '' && 'actionsExecuted' in output;
  record(
    'run detail: the delivered result is exposed as output',
    outputOk,
    `output=${JSON.stringify(output).slice(0, 200)}`,
  );
}

/* 6. reuse an existing workflow when creating one */
async function checkReuse(): Promise<void> {
  const source = asRecord((await call(`/workflows/${COVERAGE_WORKFLOW}`)).body);
  const sourceVersion = asRecord(asArray(source['versions']).map(asRecord).at(-1));
  const sourceDefinition = asRecord(sourceVersion['definition']);

  const created = await call('/workflows', {
    method: 'POST',
    body: { name: `Reuse probe ${Date.now()}`, fromWorkflowId: COVERAGE_WORKFLOW },
  });
  if (created.status >= 400) {
    record('reuse: a new workflow can be created from an existing one', false, `POST /workflows returned ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
    return;
  }
  const newId = String(asRecord(created.body)['workflowId'] ?? '');
  const copy = asRecord((await call(`/workflows/${newId}`)).body);
  const copyVersion = asRecord(asArray(copy['versions']).map(asRecord).at(-1));
  const copyDefinition = asRecord(copyVersion['definition']);
  const shapeOf = (definition: Record<string, unknown>): string =>
    JSON.stringify({
      nodes: asArray(definition['nodes']).map((node) => {
        const record = asRecord(node);
        return { type: record['type'], label: record['label'], config: record['config'] };
      }),
      edges: asArray(definition['edges']).map((edge) => {
        const record = asRecord(edge);
        return { from: record['from'], to: record['to'], port: record['port'] };
      }),
    });
  const identical = shapeOf(sourceDefinition) === shapeOf(copyDefinition);
  record('reuse: a new workflow can be created from an existing one', identical, `newId=${newId} sourceNodes=${asArray(sourceDefinition['nodes']).length} copyNodes=${asArray(copyDefinition['nodes']).length}`);

  const after = asRecord((await call(`/workflows/${COVERAGE_WORKFLOW}`)).body);
  const afterVersion = asRecord(asArray(after['versions']).map(asRecord).at(-1));
  record(
    'reuse: the source workflow is untouched',
    shapeOf(asRecord(afterVersion['definition'])) === shapeOf(sourceDefinition),
    'the source definition changed after the copy',
  );
}

/* 7. references resolve, and an artifact is produced and retrievable */
async function checkReferencesAndArtifact(): Promise<void> {
  const runId = await fireScenario('coverage_rescue');
  if (runId === null) {
    record('references: a run resolves {{input.payload.*}} and context paths', false, 'no run');
    record('artifact: a rendered artifact is listed and retrievable', false, 'no run');
    return;
  }
  const parked = (await waitForStatus(runId, ['awaiting_approval', 'succeeded'])) ?? {};
  const approval = asRecord(parked['approval']);
  if (approval['status'] === 'pending') {
    await call(`/approvals/${String(approval['approvalId'])}/decision`, {
      method: 'POST',
      body: { decision: 'approve', reason: 'Feature verification: approve so the run can finish' },
    });
  }
  const detail = (await waitForStatus(runId, ['succeeded', 'failed'])) ?? {};
  const run = asRecord(detail['run']);
  const unresolved = JSON.stringify(detail).includes('{{');
  const payload = asRecord(asRecord(detail['input'])['payload']);
  const rendered = asArray(asRecord(detail['output'])['artifacts'])
    .map(asRecord)
    .map((artifact) => String(artifact['name'] ?? ''))
    .join(' ');
  const resolvedArtifact = asArray(asRecord(detail['output'])['artifacts']).length > 0 && !unresolved;
  record(
    'references: a run resolves {{input.payload.*}} and context paths',
    resolvedArtifact && payload['shiftId'] !== undefined,
    `artifacts=${rendered} unresolvedPlaceholder=${unresolved} triggerShiftId=${String(payload['shiftId'])} status=${String(run['status'])}`,
  );

  const artifacts = asArray(asRecord(detail['output'])['artifacts']).map(asRecord);
  if (artifacts.length === 0) {
    record('artifact: a rendered artifact is listed and retrievable', false, 'the run has no artifacts');
    return;
  }
  const artifactId = String(artifacts[0]?.['artifactId'] ?? '');
  const fetched = await call(`/artifacts/${artifactId}`);
  const content = String(asRecord(fetched.body)['content'] ?? '');
  const shiftId = String(asRecord(asRecord(detail['input'])['payload'])['shiftId'] ?? '');
  record(
    'artifact: a rendered artifact is listed and retrievable',
    fetched.status === 200 && content.length > 0 && !content.includes('{{') && (shiftId === '' || content.includes(shiftId)),
    `status=${fetched.status} contentLength=${content.length} mentionsShiftId=${content.includes(shiftId)}`,
  );
}

/* 8. the extension claim */
async function checkExtension(): Promise<void> {
  const test = Bun.spawnSync(['bun', 'test', 'packages/workflows/tests/kinds.test.ts'], { stdout: 'pipe', stderr: 'pipe' });
  const output = `${test.stdout.toString()}${test.stderr.toString()}`;
  const passed = test.exitCode === 0 && /pass/.test(output);
  record(
    'extension: a new node kind is one file plus registration lines',
    passed,
    `exit=${test.exitCode} ${output.split('\n').filter((line) => line.includes('pass') || line.includes('fail')).join(' | ').slice(0, 200)}`,
  );
}

/* extra: the offer the coverage action produced, read from the owning service */
async function checkDomainOutcome(): Promise<void> {
  const shiftId = '22222222-2222-4222-8222-000000000003';
  const response = await fetch(`${ROSTERING_API}/shifts/${shiftId}`, { headers: actor('roster_manager'), signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const body = response === null ? {} : asRecord(await response.json().catch(() => ({})));
  const shift = asRecord(body['shift'] ?? body);
  record(
    'outcome: the domain service reflects the workflow action',
    response?.status === 200 && ['offered', 'assigned'].includes(String(shift['status'])),
    `status=${String(shift['status'])}`,
  );
}

/* 11. steering: an approver's message becomes part of the run */
async function checkSteering(): Promise<void> {
  await call('/provider-settings', { method: 'PUT', body: { kind: 'none' } });
  const runId = await fireScenario('coverage_rescue');
  if (runId === null) {
    record('steering: an approver message reaches the run and its artifacts', false, 'the coverage scenario did not produce a run');
    return;
  }
  const paused = (await waitForStatus(runId, ['awaiting_approval'])) ?? {};
  const approvalId = String(asRecord(paused['approval'])['approvalId'] ?? '');
  if (approvalId === '') {
    record('steering: an approver message reaches the run and its artifacts', false, 'the run never reached an approval');
    return;
  }

  const steering = 'Offer it to Marcus and cap the overtime premium at two hours.';
  const decided = await call(`/approvals/${approvalId}/decision`, {
    method: 'POST',
    body: { decision: 'approve', reason: 'Approved with a condition', feedback: steering },
  });
  if (decided.status >= 400) {
    record(
      'steering: an approver message reaches the run and its artifacts',
      false,
      `the decision returned ${decided.status} ${JSON.stringify(decided.body).slice(0, 200)}`,
    );
    return;
  }

  const final = (await waitForStatus(runId, ['succeeded', 'failed', 'cancelled'])) ?? {};
  const status = String(asRecord(final['run'])['status']);
  const stored = String(asRecord(final['approval'])['feedback'] ?? '');
  const eventFeedback = String(asRecord(eventsOf(final, 'approval_decided')[0]?.['data'])['feedback'] ?? '');
  const artifactId = String(asArray(asRecord(final['output'])['artifacts']).map(asRecord)[0]?.['artifactId'] ?? '');
  const content = artifactId === '' ? '' : String(asRecord((await call(`/artifacts/${artifactId}`)).body)['content'] ?? '');

  record(
    'steering: an approver message reaches the run and its artifacts',
    status === 'succeeded' && stored === steering && eventFeedback === steering && content.includes(steering),
    `status=${status} stored=${stored === steering} event=${eventFeedback === steering} artifactQuotesSteering=${content.includes(steering)}`,
  );
}

/* 12. the conversational builder edits the graph through a validated operation list */
async function checkBuilderChat(): Promise<void> {
  await call('/provider-settings', { method: 'PUT', body: { kind: 'platform', model: FAST_MODEL } });
  const created = await call('/workflows', {
    method: 'POST',
    body: { name: `Builder chat check ${Date.now()}`, fromWorkflowId: COVERAGE_WORKFLOW },
  });
  const workflowId = String(asRecord(created.body)['workflowId'] ?? '');
  if (created.status >= 400 || workflowId === '') {
    record('builder: a chat turn edits the graph through validated operations', false, `POST /workflows returned ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
    return;
  }

  try {
    const detail = asRecord((await call(`/workflows/${workflowId}`)).body);
    const version = asArray(detail['versions']).map(asRecord).find((candidate) => candidate['status'] === 'draft') ?? asArray(detail['versions']).map(asRecord)[0];
    const definition = version?.['definition'];
    const before = asArray(asRecord(definition)['nodes']).length;

    const chat = await call(`/workflows/${workflowId}/chat`, {
      method: 'POST',
      timeoutMs: 180_000,
      body: {
        message:
          'Add an artifact node with id manager_handover, labelled "Manager handover", whose body says the shift was covered and quotes the approver steering. Wire it from cover_note on its always port and into filled_end, replacing the direct cover_note to filled_end edge.',
        definition,
        layout: version?.['layout'],
        eventType: 'shift.cancelled',
        model: FAST_MODEL,
      },
    });
    const reply = asRecord(chat.body);
    const after = asArray(asRecord(reply['definition'])['nodes']).length;
    const applied = asArray(reply['applied']);
    const rejected = asArray(reply['rejected']);
    const errors = asArray(reply['diagnostics']).map(asRecord).filter((diagnostic) => diagnostic['severity'] === 'error');
    const history = asArray(asRecord((await call(`/workflows/${workflowId}/chat`)).body)['messages']);

    record(
      'builder: a chat turn edits the graph through validated operations',
      chat.status === 200 && applied.length > 0 && after === before + 1 && errors.length === 0 && history.length >= 2,
      `status=${chat.status} nodes ${before}->${after} applied=${applied.length} rejected=${rejected.length} errors=${errors.length} history=${history.length} reply="${String(reply['reply']).replace(/\s+/g, ' ').slice(0, 120)}"`,
    );
  } finally {
    await call(`/workflows/${workflowId}`, { method: 'DELETE' });
  }
}

/* 14. the agent node runs a loop against the real provider */
const PAYROLL_WORKFLOW = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';

/**
 * The strongest claim about the agent node is that it is interchangeable with
 * an AI decision: same declared tools, same structured output, same gates. So
 * this takes the payroll workflow, swaps its single-shot decision for an agent,
 * publishes it, fires the real scenario, and reads back what the loop did.
 */
async function checkAgentNode(): Promise<void> {
  await call('/provider-settings', { method: 'PUT', body: { kind: 'platform', model: FAST_MODEL } });
  const created = await call('/workflows', {
    method: 'POST',
    body: { name: `Agent node check ${Date.now()}`, fromWorkflowId: PAYROLL_WORKFLOW },
  });
  const workflowId = String(asRecord(created.body)['workflowId'] ?? '');
  if (created.status >= 400 || workflowId === '') {
    record('agent: a loop node runs the payroll workflow and proposes', false, `POST /workflows returned ${created.status}`);
    return;
  }

  try {
    const detail = asRecord((await call(`/workflows/${workflowId}`)).body);
    const version =
      asArray(detail['versions']).map(asRecord).find((candidate) => candidate['status'] === 'draft') ??
      asArray(detail['versions']).map(asRecord).at(-1);
    const definition = asRecord(version?.['definition']);
    const nodes = asArray(definition['nodes'])
      .map(asRecord)
      .map((node) =>
        node['type'] === 'ai_decision'
          ? {
              ...node,
              type: 'agent',
              label: 'Investigate the exception',
              config: { ...asRecord(node['config']), maxSteps: 4 },
            }
          : node,
      );

    const saved = await call(`/workflows/${workflowId}/draft`, {
      method: 'PUT',
      body: {
        name: String(definition['name'] ?? 'Agent node check'),
        definition: { ...definition, nodes },
        layout: version?.['layout'] ?? {},
      },
    });
    const published = await call(`/workflows/${workflowId}/publish`, { method: 'POST' });
    if (saved.status >= 400 || published.status >= 400) {
      record(
        'agent: a loop node runs the payroll workflow and proposes',
        false,
        `PUT draft=${saved.status} publish=${published.status} ${JSON.stringify(published.body).slice(0, 200)}`,
      );
      return;
    }

    const before = await call('/runs?limit=100');
    const known = new Set(asArray(before.body).map((run) => String(asRecord(run)['runId'])));
    const fired = await call('/simulator/payroll_exception', { method: 'POST', body: {} });
    if (fired.status >= 400) {
      record('agent: a loop node runs the payroll workflow and proposes', false, `simulator returned ${fired.status}`);
      return;
    }

    let runId: string | null = null;
    for (let attempt = 0; attempt < 60 && runId === null; attempt += 1) {
      await Bun.sleep(500);
      const runs = asArray((await call('/runs?limit=100')).body).map(asRecord);
      const mine = runs.find((run) => !known.has(String(run['runId'])) && String(run['workflowId']) === workflowId);
      if (mine !== undefined) runId = String(mine['runId']);
    }
    if (runId === null) {
      record('agent: a loop node runs the payroll workflow and proposes', false, 'no run for the agent workflow');
      return;
    }

    const finished = (await waitForStatus(runId, ['awaiting_approval', 'succeeded'], 400)) ?? {};
    const events = asArray(finished['events']).map(asRecord);
    const proposal = events.find((event) => event['kind'] === 'proposal_created' && event['nodeId'] === 'draft_adjustment');
    const data = asRecord(proposal?.['data']);
    const trail = asArray(data['toolTrail']).map(String);
    const declared = new Set(['timesheet.get', 'award_rule.get']);

    const sql = new SQL(STUDIO_DB, { max: 1 });
    const rows = await sql<Array<{ calls: number; input: number }>>`
      select count(*)::int as calls, coalesce(sum(input_tokens), 0)::int as input
      from llm_calls where run_id = ${runId} and node_id = 'draft_adjustment'
    `;
    await sql.close();
    const accounting = rows[0];

    const status = String(asRecord(finished['run'])['status']);
    record(
      'agent: a loop node runs the payroll workflow and proposes',
      status === 'awaiting_approval' &&
        data['proposer'] === 'agent' &&
        trail.length > 0 &&
        trail.every((tool) => declared.has(tool)) &&
        accounting?.calls === 1 &&
        (accounting?.input ?? 0) > 0,
      `status=${status} toolTrail=[${trail.join(', ')}] llm_calls rows=${accounting?.calls ?? 0} inputTokens=${accounting?.input ?? 0}`,
    );
  } finally {
    await call(`/workflows/${workflowId}`, { method: 'DELETE' });
  }
}

/* leave the demo configured the way a reviewer will find it */
async function restorePlatformProvider(): Promise<void> {
  const restored = await call('/provider-settings', { method: 'PUT', body: { kind: 'platform', model: CATALOGUE_MODEL } });
  record(
    'demo state: the tenant is left on the platform provider',
    restored.status < 400,
    `PUT /provider-settings returned ${restored.status}`,
  );
}

const steps: Array<[string, () => Promise<void>]> = [
  ['1. Platform provider', checkPlatformProvider],
  ['2. Bring your own provider', checkByoProvider],
  ['3. Rules fallback', checkRulesFallback],
  ['4. Model catalogue', checkModels],
  ['5. Token accounting', checkTokens],
  ['6. Dashboard', checkDashboard],
  ['7. Run input and output', checkRunInputOutput],
  ['8. Workflow reuse', checkReuse],
  ['9. References and artifacts', checkReferencesAndArtifact],
  ['10. Node-kind extension', checkExtension],
  ['11. Domain outcome', checkDomainOutcome],
  ['12. Steering from an approval', checkSteering],
  ['13. Conversational builder', checkBuilderChat],
  ['14. Agent node', checkAgentNode],
  ['15. Leave the demo on the platform provider', restorePlatformProvider],
];

for (const [title, run] of steps) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
  try {
    await run();
  } catch (error) {
    record(`${title} (crashed)`, false, error instanceof Error ? error.message : String(error));
  }
}

const failed = results.filter((result) => !result.ok);
const skipped = results.filter((result) => result.skipped === true);
console.log('\n\u001b[1mResult\u001b[0m');
if (failed.length === 0) {
  const note = skipped.length === 0 ? '' : ` (${skipped.length} skipped)`;
  console.log(`  \u001b[32mall ${results.length - skipped.length} feature properties verified\u001b[0m${note}`);
  process.exit(0);
}
console.log(`  \u001b[31m${failed.length} of ${results.length} feature properties failed\u001b[0m`);
for (const result of failed) console.log(`    ${result.name}: ${result.detail}`);
process.exit(1);
