'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiFailure, apiFetch } from '../../lib/api';
import { useDemoActor } from '../../components/demo-actor-provider';
import type { ModelDescriptor, ProviderSettings, ProviderSettingsRequest } from '@wfm/contracts';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';

const KINDS: ReadonlyArray<{ value: ProviderSettingsRequest['kind']; label: string; blurb: string }> = [
  {
    value: 'platform',
    label: 'Platform provider',
    blurb: 'Runs on the studio\u2019s own OpenAI-compatible endpoint. Nothing to configure here.',
  },
  {
    value: 'openai-compatible',
    label: 'Your own OpenAI-compatible endpoint',
    blurb: 'OpenAI, Azure OpenAI, OpenRouter, Groq, Together, vLLM, Ollama, LM Studio. Any base URL that speaks the chat completions API.',
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    blurb: 'Uses the messages API with your own key.',
  },
  { value: 'none', label: 'No model', blurb: 'Runs fall back to the deterministic rules proposer.' },
];

const panel = 'flex flex-col gap-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5';
const heading = 'text-xs font-medium tracking-wide uppercase text-[var(--color-ink-faint)]';

export default function SettingsPage() {
  const { headers } = useDemoActor();
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [kind, setKind] = useState<ProviderSettingsRequest['kind']>('platform');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [replaceKey, setReplaceKey] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextSettings, nextModels] = await Promise.all([
        apiFetch<ProviderSettings>('/provider-settings', { headers }),
        apiFetch<ModelDescriptor[]>('/models', { headers }),
      ]);
      setSettings(nextSettings);
      setModels(nextModels);
      setKind(nextSettings.kind);
      setBaseUrl(nextSettings.baseUrl ?? '');
      setModel(nextSettings.model ?? nextModels.find((entry) => entry.default)?.id ?? nextModels[0]?.id ?? '');
      setError(null);
    } catch (failure) {
      setError(failure instanceof ApiFailure ? failure.message : String(failure));
    }
  }, [headers]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setStatus('saving');
    setError(null);
    try {
      const body: ProviderSettingsRequest = {
        kind,
        ...(kind === 'openai-compatible' || kind === 'anthropic' ? { baseUrl: baseUrl.trim(), model } : {}),
        ...(kind === 'platform' ? { model } : {}),
        ...(apiKey.trim() !== '' && kind !== 'platform' && kind !== 'none' ? { apiKey: apiKey.trim() } : {}),
      };
      const saved = await apiFetch<ProviderSettings>('/provider-settings', { method: 'PUT', headers, body });
      setSettings(saved);
      setApiKey('');
      setReplaceKey(false);
      setStatus('saved');
    } catch (failure) {
      setStatus('idle');
      setError(failure instanceof ApiFailure ? `${failure.code}: ${failure.message}` : String(failure));
    }
  };

  const needsEndpoint = kind === 'openai-compatible' || kind === 'anthropic';
  const needsKey = needsEndpoint && (!settings?.hasApiKey || replaceKey);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Model provider</h1>
        <p className="text-sm text-[var(--color-ink-muted)]">
          Which model the AI decision nodes call. Policy checks and human approvals stay in the path whatever you pick here.
        </p>
      </header>

      {error === null ? null : (
        <div className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3 text-sm">{error}</div>
      )}

      <section className={panel}>
        <h2 className={heading}>Provider</h2>
        <div className="flex flex-col gap-2">
          {KINDS.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-3 transition-colors ${
                kind === option.value
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)]'
                  : 'border-[var(--color-border-subtle)] hover:border-[var(--color-primary)]'
              }`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="provider-kind"
                  className="accent-[var(--color-primary)]"
                  checked={kind === option.value}
                  onChange={() => setKind(option.value)}
                />
                <span className="text-sm font-medium">{option.label}</span>
                {option.value === 'platform' && settings?.platformConfigured === true ? (
                  <span className="rounded-full border border-[var(--color-success)] px-2 py-0.5 text-[10px] text-[var(--color-success)]">
                    configured
                  </span>
                ) : null}
                {option.value === 'platform' && settings?.platformConfigured === false ? (
                  <span className="rounded-full border border-[var(--color-warning)] px-2 py-0.5 text-[10px] text-[var(--color-warning)]">
                    no key in env
                  </span>
                ) : null}
              </span>
              <span className="pl-6 text-xs text-[var(--color-ink-muted)]">{option.blurb}</span>
            </label>
          ))}
        </div>
      </section>

      <section className={panel}>
        <h2 className={heading}>Model</h2>
        <p className="text-xs text-[var(--color-ink-faint)]">
          Only models declared in <span className="font-mono">config/models.jsonl</span> are offered. Add a line there to offer another.
        </p>
        <div className="flex flex-col gap-1">
          <Label htmlFor="model">Model</Label>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger id="model">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {models.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label} · {entry.id} · {(entry.contextWindow / 1024).toFixed(0)}k context
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {models.length === 0 ? (
            <span className="text-xs text-[var(--color-warning)]">
              The catalogue is empty, so no model can be selected. Add a line to config/models.jsonl.
            </span>
          ) : null}
        </div>
        {model === '' ? null : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[var(--color-ink-muted)]">
            <dt>Input price</dt>
            <dd className="font-mono">
              {models.find((entry) => entry.id === model)?.inputCentsPerMillion ?? 0}c per million tokens
            </dd>
            <dt>Output price</dt>
            <dd className="font-mono">
              {models.find((entry) => entry.id === model)?.outputCentsPerMillion ?? 0}c per million tokens
            </dd>
            <dt>JSON mode</dt>
            <dd className="font-mono">{models.find((entry) => entry.id === model)?.jsonMode === true ? 'supported' : 'prompt only'}</dd>
          </dl>
        )}
      </section>

      {needsEndpoint ? (
        <section className={panel}>
          <h2 className={heading}>Endpoint and key</h2>
          <div className="flex flex-col gap-1">
            <Label htmlFor="base-url">Base URL</Label>
            <Input
              id="base-url"
              value={baseUrl}
              placeholder={kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://openrouter.ai/api/v1'}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="api-key">API key</Label>
              {settings?.hasApiKey === true && !replaceKey ? (
                <Button variant="ghost" size="sm" onClick={() => setReplaceKey(true)}>
                  Replace key
                </Button>
              ) : null}
            </div>
            {settings?.hasApiKey === true && !replaceKey ? (
              <p className="font-mono text-xs text-[var(--color-ink-muted)]">stored · ends {settings.apiKeyLast4}</p>
            ) : (
              <Input
                id="api-key"
                type="password"
                value={apiKey}
                placeholder="sk-…"
                autoComplete="off"
                onChange={(event) => setApiKey(event.target.value)}
              />
            )}
            <p className="text-xs text-[var(--color-ink-faint)]">
              Stored encrypted with the server&apos;s config secret and never returned by the API.
            </p>
          </div>
        </section>
      ) : null}

      <section className={panel}>
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <h2 className={heading}>Current setting</h2>
            <p className="text-sm">
              {settings === null
                ? 'loading…'
                : `${settings.kind}${settings.model === null ? '' : ` · ${settings.model}`}${
                    settings.hasApiKey ? ` · key ends ${settings.apiKeyLast4}` : ''
                  }`}
            </p>
            <p className="text-xs text-[var(--color-ink-faint)]">
              {settings?.updatedBy === null || settings?.updatedBy === undefined
                ? 'never changed'
                : `last changed by ${settings.updatedBy}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {status === 'saved' ? <span className="text-xs text-[var(--color-success)]">saved</span> : null}
            <Button onClick={() => void save()} disabled={status === 'saving' || (needsKey && apiKey.trim() === '')}>
              {status === 'saving' ? 'Saving…' : 'Save provider'}
            </Button>
          </div>
        </div>
      </section>

      <section className={panel}>
        <h2 className={heading}>How a run uses this</h2>
        <ol className="flex flex-col gap-1 text-sm text-[var(--color-ink-muted)]">
          <li>1. The run reaches an AI decision node and asks the configured provider for a proposal.</li>
          <li>2. The proposal is validated against the node&apos;s output schema, and ineligible employees are dropped regardless of what the model said.</li>
          <li>3. Tokens and cost are recorded per call, and the dashboard totals them.</li>
          <li>4. Policy checks and any human approval still gate the action.</li>
        </ol>
        <p className="text-xs text-[var(--color-ink-faint)]">
          Model output is never authoritative on its own.
        </p>
      </section>
    </main>
  );
}
