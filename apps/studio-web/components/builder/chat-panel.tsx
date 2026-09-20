'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ModelDescriptor, ProviderSettings } from '@wfm/contracts';
import type { BuilderChatMessage, BuilderChatRequest, BuilderChatResponse } from '@wfm/workflows';
import { ApiFailure, apiFetch, fetchBuilderChat, sendBuilderMessage } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { BuilderSnapshot } from './state';

/**
 * The builder conversation. Every turn carries the definition and layout the
 * canvas holds right now — including nodes the user has dragged — because the
 * agent is meant to reason about what is on the screen, not about what it last
 * saw. Radix refuses an empty item value, so "leave the choice to the tenant"
 * needs a sentinel rather than ''.
 */
const TENANT_DEFAULT = 'tenant-default';

function failureLine(cause: unknown): string {
  if (cause instanceof ApiFailure) return `HTTP ${cause.status} — ${cause.message}`;
  return 'The Studio API is unreachable.';
}

function Turn({ message }: { message: BuilderChatMessage }) {
  const assistant = message.role === 'assistant';
  return (
    <article
      className={cn(
        'flex flex-col gap-1.5 rounded-md px-2.5 py-2',
        assistant ? 'bg-[var(--color-surface-raised)]' : 'border border-[var(--color-border-subtle)]',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span
          className="text-[10px] font-semibold uppercase tracking-wide"
          style={{ color: assistant ? 'var(--color-primary)' : 'var(--color-ink-faint)' }}
        >
          {assistant ? 'Agent' : 'You'}
        </span>
        <span className="shrink-0 text-[10px] text-[var(--color-ink-faint)]">
          {new Date(message.at).toLocaleTimeString()}
        </span>
      </div>
      <p className="whitespace-pre-wrap text-[11px] leading-snug text-[var(--color-ink)]">{message.content}</p>
      {message.applied.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {message.applied.map((line, index) => (
            <li key={`${line}:${index}`}>
              <Badge className="h-auto max-w-full bg-[var(--color-success-soft)] text-left font-normal whitespace-normal text-[var(--color-success)]">
                {line}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {message.rejected.length > 0 && (
        <ul className="flex flex-col items-start gap-1">
          {message.rejected.map((rejection, index) => (
            <li key={`${rejection.op}:${rejection.target}:${index}`} className="max-w-full">
              <Badge
                title={`${rejection.op} ${rejection.target}`.trim()}
                className="h-auto max-w-full bg-[var(--color-warning-soft)] text-left font-normal whitespace-normal text-[var(--color-warning)]"
              >
                {rejection.reason}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {assistant && message.model !== null && (
        <span className="text-[10px] text-[var(--color-ink-faint)]">{message.model}</span>
      )}
    </article>
  );
}

export function ChatPanel({
  workflowId,
  headers,
  snapshot,
  eventType,
  disabled,
  onApplied,
}: {
  workflowId: string;
  headers: Record<string, string>;
  /** Read at send time, so a drag that happened mid-turn is still included. */
  snapshot: BuilderSnapshot;
  eventType: string;
  disabled: boolean;
  /** Receives the graph the turn produced, and the diagnostics it carries. */
  onApplied: (snapshot: BuilderSnapshot, diagnostics: BuilderChatResponse['diagnostics']) => void;
}) {
  const [messages, setMessages] = useState<readonly BuilderChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<readonly ModelDescriptor[]>([]);
  const [modelChoice, setModelChoice] = useState<string>(TENANT_DEFAULT);

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const headersRef = useRef(headers);
  headersRef.current = headers;
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const history = await fetchBuilderChat(workflowId, headersRef.current);
        if (alive) setMessages(history.messages);
      } catch (cause) {
        if (alive) setError(failureLine(cause));
      }
    })();
    return () => {
      alive = false;
    };
  }, [workflowId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [catalogue, settings] = await Promise.all([
          apiFetch<ModelDescriptor[]>('/models', { headers: headersRef.current }),
          apiFetch<ProviderSettings>('/provider-settings', { headers: headersRef.current }),
        ]);
        if (!alive) return;
        setModels(catalogue);
        setModelChoice(settings.model ?? catalogue.find((model) => model.default)?.id ?? TENANT_DEFAULT);
      } catch {
        if (alive) setModels([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // A real model turn can run for a minute and a half, so the wait is counted
  // out rather than left as a spinner the user cannot read anything into.
  useEffect(() => {
    if (!sending) return;
    const startedAt = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(timer);
  }, [sending]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages, sending]);

  const send = useCallback(async () => {
    const message = draft.trim();
    if (message.length === 0 || sending || disabled) return;
    const current = snapshotRef.current;
    const body: BuilderChatRequest = {
      message,
      definition: current.definition,
      layout: current.layout,
      eventType,
      ...(modelChoice === TENANT_DEFAULT ? {} : { model: modelChoice }),
    };
    const at = new Date().toISOString();
    setMessages((previous) => [
      ...previous,
      {
        messageId: crypto.randomUUID(),
        role: 'user',
        content: message,
        at,
        model: null,
        applied: [],
        rejected: [],
      },
    ]);
    setDraft('');
    setError(null);
    setSending(true);
    try {
      const response = await sendBuilderMessage(workflowId, body, headersRef.current);
      setMessages((previous) => [
        ...previous,
        {
          messageId: crypto.randomUUID(),
          role: 'assistant',
          content: response.reply,
          at: new Date().toISOString(),
          model: response.model,
          applied: response.applied,
          rejected: response.rejected,
        },
      ]);
      onApplied({ definition: response.definition, layout: response.layout }, response.diagnostics);
    } catch (cause) {
      setError(failureLine(cause));
    } finally {
      setSending(false);
    }
  }, [draft, sending, disabled, eventType, modelChoice, workflowId, onApplied]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--color-border-subtle)] px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">Agent</p>
          <span className="text-[10px] text-[var(--color-ink-faint)]">sees the canvas as it stands</span>
        </div>
        <Select value={modelChoice} onValueChange={setModelChoice}>
          <SelectTrigger size="sm" className="w-full" aria-label="Chat model">
            <SelectValue placeholder="Tenant default model" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TENANT_DEFAULT}>Tenant default model</SelectItem>
            {models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label} · {model.provider}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </header>
      <div ref={transcriptRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && !sending && (
          <p className="text-[11px] leading-snug text-[var(--color-ink-faint)]">
            Ask the agent to add a node, rewire a branch, or explain the graph. Each turn carries the definition and
            layout currently on the canvas, dragged positions included.
          </p>
        )}
        {messages.map((message) => (
          <Turn key={message.messageId} message={message} />
        ))}
        {sending && (
          <div
            role="status"
            aria-live="polite"
            className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-ink-muted)]"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
            <span>Thinking… {elapsed}s</span>
            {elapsed >= 30 && <span className="text-[var(--color-ink-faint)]">long turns can take up to 90s</span>}
          </div>
        )}
      </div>
      {error !== null && (
        <p
          role="alert"
          className="shrink-0 border-t border-[var(--color-border-subtle)] px-3 py-2 text-[11px]"
          style={{ backgroundColor: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}
        >
          {error}
        </p>
      )}
      <div className="flex shrink-0 flex-col gap-2 border-t border-[var(--color-border-subtle)] p-3">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled || sending}
          rows={3}
          aria-label="Message the builder agent"
          placeholder={disabled ? 'Waiting for the workflow to load…' : 'Ask the agent to change the graph…'}
          className="min-h-16 resize-none"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-[var(--color-ink-faint)]">⌘↵ to send</span>
          <Button size="xs" onClick={() => void send()} disabled={disabled || sending || draft.trim().length === 0}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  );
}
