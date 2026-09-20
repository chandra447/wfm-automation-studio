'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Robot } from '@phosphor-icons/react';
import type { ModelDescriptor, ProviderSettings } from '@wfm/contracts';
import type {
  BuilderChatMessage,
  BuilderChatRequest,
  BuilderChatResponse,
  BuilderFocus,
  BuilderStreamEvent,
  BuilderToolCall,
} from '@wfm/workflows';
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ai-elements/prompt-input';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiFailure, apiFetch, fetchBuilderChat, streamBuilderChat } from '@/lib/api';
import { applyStreamEvent, emptyLiveTurn, type LiveTurn } from './chat-stream';
import type { BuilderSnapshot } from './state';

/**
 * The builder conversation. Every turn carries the definition and layout the
 * canvas holds right now — including nodes the user has dragged — because the
 * agent is meant to reason about what is on the screen, not about what it last
 * saw. Radix refuses an empty item value, so "leave the choice to the tenant"
 * needs a sentinel rather than ''.
 *
 * The turn streams: prose and tool calls are rendered as they arrive, and the
 * finished turn is built from the response `done` carries, which is the same
 * response the blocking route returns.
 */
const TENANT_DEFAULT = 'tenant-default';

/** Past this many tool calls the trail collapses to its count. */
const STEP_LIMIT = 4;

/**
 * The stored thread carries only what the panel always renders. The tool trail
 * and the focus belong to the turn this session sent, so they ride on the
 * in-memory message rather than being persisted with the conversation.
 */
interface TurnMessage extends BuilderChatMessage {
  /** The calls the turn made, kept from the live turn so the trail stays openable. */
  calls?: readonly BuilderToolCall[];
  focus?: BuilderFocus;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** `pointed at 3 nodes`, or `pointed at 1 node and 2 edges`; null when it pointed at nothing. */
function focusSummary(focus: BuilderFocus): string | null {
  const parts: string[] = [];
  if (focus.nodeIds.length > 0) parts.push(plural(focus.nodeIds.length, 'node'));
  if (focus.edgeIds.length > 0) parts.push(plural(focus.edgeIds.length, 'edge'));
  return parts.length === 0 ? null : `pointed at ${parts.join(' and ')}`;
}

function failureLine(cause: unknown): string {
  if (cause instanceof ApiFailure) return `HTTP ${cause.status} — ${cause.message}`;
  return 'The Studio API is unreachable.';
}

/** The contract's three states in the vocabulary the tool row badges speak. */
const toolState: Record<BuilderToolCall['state'], 'input-available' | 'output-available' | 'output-error'> = {
  running: 'input-available',
  done: 'output-available',
  failed: 'output-error',
};

/** The avatar belongs to the agent's turns, so it sits outside the message itself. */
function AgentRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full items-start gap-2">
      <Robot size={32} weight="duotone" className="mt-1 shrink-0 text-[var(--color-primary)]" />
      {children}
    </div>
  );
}

/**
 * A tool call as it happens and after the turn is over: the name and its state
 * on the row, the arguments and the result a click away. Collapsed by default,
 * because a turn that calls a dozen tools would otherwise push its own answer
 * off the panel.
 */
function ToolRow({ call }: { call: BuilderToolCall }) {
  return (
    <Tool className="mb-0 w-full">
      <ToolHeader type="dynamic-tool" state={toolState[call.state]} toolName={call.name} />
      <ToolContent>
        {call.input !== null && <ToolInput input={call.input} />}
        <ToolOutput errorText={call.error ?? undefined} output={call.output} />
      </ToolContent>
    </Tool>
  );
}

function TurnHeader({ role, at }: { role: 'Agent' | 'You'; at?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span
        className="text-[10px] font-semibold uppercase tracking-wide"
        style={{ color: role === 'Agent' ? 'var(--color-primary)' : 'var(--color-ink-faint)' }}
      >
        {role}
      </span>
      {at !== undefined && (
        <span className="shrink-0 text-[10px] text-[var(--color-ink-faint)]">{at}</span>
      )}
    </div>
  );
}

function Turn({ message }: { message: TurnMessage }) {
  const assistant = message.role === 'assistant';
  const calls = message.calls ?? [];
  const focus = message.focus === undefined ? null : focusSummary(message.focus);

  const content = (
    <Message from={message.role} className={assistant ? 'min-w-0 flex-1' : undefined}>
      <MessageContent className={assistant ? 'w-full' : undefined}>
        <TurnHeader role={assistant ? 'Agent' : 'You'} at={new Date(message.at).toLocaleTimeString()} />
        <MessageResponse>{message.content}</MessageResponse>
        {message.applied.length > 0 && (
          <ul className="flex flex-wrap gap-1">
            {message.applied.map((line, index) => (
              <li key={`${line}:${index}`} className="min-w-0 max-w-full">
                <Badge className="h-auto max-w-full bg-[var(--color-success-soft)] text-left font-normal break-words whitespace-normal text-[var(--color-success)]">
                  {line}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {message.rejected.length > 0 && (
          <ul className="flex flex-col items-start gap-1">
            {message.rejected.map((rejection, index) => (
              <li key={`${rejection.op}:${rejection.target}:${index}`} className="min-w-0 max-w-full">
                <Badge
                  title={`${rejection.op} ${rejection.target}`.trim()}
                  className="h-auto max-w-full bg-[var(--color-warning-soft)] text-left font-normal break-words whitespace-normal text-[var(--color-warning)]"
                >
                  {rejection.reason}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {assistant && (calls.length > 0 || focus !== null) && (
          <div className="flex min-w-0 flex-col gap-0.5">
            {focus !== null && (
              <span className="truncate font-mono text-[10px] leading-snug text-[var(--color-ink-faint)]" title={focus}>
                {focus}
              </span>
            )}
            {/* The same rows the turn showed while it ran, so a call can be
                opened afterwards to read what it was asked and what it said. */}
            {calls.length > STEP_LIMIT ? (
              <details>
                <summary className="cursor-pointer font-mono text-[10px] leading-snug text-[var(--color-ink-faint)] select-none hover:text-[var(--color-ink-muted)]">
                  {plural(calls.length, 'step')}
                </summary>
                <div className="flex min-w-0 flex-col gap-0.5 pt-1">
                  {calls.map((call) => (
                    <ToolRow key={call.id} call={call} />
                  ))}
                </div>
              </details>
            ) : (
              calls.map((call) => (
                <ToolRow key={call.id} call={call} />
              ))
            )}
          </div>
        )}
        {assistant && message.model !== null && (
          <span className="text-[10px] text-[var(--color-ink-faint)]">{message.model}</span>
        )}
      </MessageContent>
    </Message>
  );

  return assistant ? <AgentRow>{content}</AgentRow> : content;
}

/** The turn while it is still arriving: the run's text, and each call as it is made and answered. */
function LiveTurnView({ turn }: { turn: LiveTurn }) {
  const focus = turn.focus === null ? null : focusSummary(turn.focus);
  return (
    <AgentRow>
      <Message from="assistant" className="min-w-0 flex-1">
        <MessageContent className="w-full">
          <TurnHeader role="Agent" />
          {turn.text.length > 0 && <MessageResponse isAnimating>{turn.text}</MessageResponse>}
          {turn.calls.map((call) => (
            <ToolRow key={call.id} call={call} />
          ))}
          {focus !== null && (
            <span className="font-mono text-[10px] leading-snug text-[var(--color-ink-faint)]">{focus}</span>
          )}
        </MessageContent>
      </Message>
    </AgentRow>
  );
}

export function ChatPanel({
  workflowId,
  headers,
  snapshot,
  eventType,
  disabled,
  onApplied,
  onFocus,
}: {
  workflowId: string;
  headers: Record<string, string>;
  /** Read at send time, so a drag that happened mid-turn is still included. */
  snapshot: BuilderSnapshot;
  eventType: string;
  disabled: boolean;
  /** Receives the graph the turn produced, the diagnostics it carries, and what it asked the canvas to point at. */
  onApplied: (snapshot: BuilderSnapshot, diagnostics: BuilderChatResponse['diagnostics'], focus: BuilderFocus) => void;
  /** Fired the moment the agent asks, so the canvas rings the nodes while it is still working. */
  onFocus: (focus: BuilderFocus) => void;
}) {
  const [messages, setMessages] = useState<readonly TurnMessage[]>([]);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [sending, setSending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<readonly ModelDescriptor[]>([]);
  const [modelChoice, setModelChoice] = useState<string>(TENANT_DEFAULT);

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const headersRef = useRef(headers);
  headersRef.current = headers;
  const inFlightRef = useRef<AbortController | null>(null);
  /** The live turn, readable from the stream callback without a stale render. */
  const liveRef = useRef<LiveTurn | null>(null);

  const pushLive = (event: BuilderStreamEvent): void => {
    const next = applyStreamEvent(liveRef.current ?? emptyLiveTurn, event);
    liveRef.current = next;
    setLive(next);
  };

  const clearLive = (): void => {
    liveRef.current = null;
    setLive(null);
  };

  /** A send that lands before the history read does not get overwritten by it. */
  const sentRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const history = await fetchBuilderChat(workflowId, headersRef.current);
        if (alive && !sentRef.current) setMessages(history.messages);
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
        // Only the family this tenant's provider speaks: a model id from the
        // other one would be sent to their own vendor and come back a 404.
        const family = settings.kind === 'anthropic' ? 'anthropic' : 'openai-compatible';
        const usable = catalogue.filter((model) => model.provider === family);
        setModels(usable);
        const configured = usable.some((model) => model.id === settings.model) ? settings.model : null;
        setModelChoice(configured ?? usable.find((model) => model.default)?.id ?? TENANT_DEFAULT);
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

  // A stream outlives the pane it was started from: leaving the builder tab
  // mid-turn would otherwise keep the request open for the rest of its minute.
  useEffect(() => () => inFlightRef.current?.abort(), []);

  const stop = useCallback(() => {
    inFlightRef.current?.abort();
    setLive(null);
    setSending(false);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (message.length === 0 || sending || disabled) return;
      const current = snapshotRef.current;
      const body: BuilderChatRequest = {
        message,
        definition: current.definition,
        layout: current.layout,
        eventType,
        ...(modelChoice === TENANT_DEFAULT ? {} : { model: modelChoice }),
      };
      sentRef.current = true;
      setMessages((previous) => [
        ...previous,
        {
          messageId: crypto.randomUUID(),
          role: 'user',
          content: message,
          at: new Date().toISOString(),
          model: null,
          applied: [],
          rejected: [],
        },
      ]);
      setError(null);
      setLive(emptyLiveTurn);
      liveRef.current = emptyLiveTurn;
      setSending(true);

      const controller = new AbortController();
      inFlightRef.current = controller;
      /** The turn is not finished until `done` arrives; a stream that just stops is a failure. */
      let finished = false;

      try {
        await streamBuilderChat(
          workflowId,
          body,
          headersRef.current,
          (event) => {
            if (event.type === 'focus') {
              onFocus(event.focus);
              pushLive(event);
              return;
            }
            if (event.type === 'done') {
              finished = true;
              const response = event.response;
              // Read before the update is queued: the updater runs after the
              // live turn is cleared, so it would find nothing left to keep.
              const calls = liveRef.current?.calls ?? [];
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
                  calls,
                  focus: response.focus,
                },
              ]);
              onApplied(
                { definition: response.definition, layout: response.layout },
                response.diagnostics,
                response.focus,
              );
              clearLive();
              return;
            }
            if (event.type === 'error') {
              setError(event.message);
              clearLive();
              return;
            }
            pushLive(event);
          },
          controller.signal,
        );
        if (!finished && !controller.signal.aborted) {
          setError('The turn ended before the agent answered.');
          clearLive();
        }
      } catch (cause) {
        // A stop the reader asked for is not a failure to report.
        if (!controller.signal.aborted) setError(failureLine(cause));
        clearLive();
      } finally {
        // A turn that was stopped and replaced must not clear the new one's state.
        if (inFlightRef.current === controller) {
          inFlightRef.current = null;
          setSending(false);
        }
      }
    },
    [sending, disabled, eventType, modelChoice, workflowId, onApplied, onFocus],
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2.5">
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
        <p className="text-[10px] leading-snug text-[var(--color-ink-faint)]">
          Each turn carries the canvas as it stands.
        </p>
      </div>
      <Conversation className="min-h-0">
        <ConversationContent className="gap-3 px-3 py-2.5">
          {messages.length === 0 && live === null && !sending && (
            <p className="text-[11px] leading-snug text-[var(--color-ink-faint)]">
              Ask the agent to add a node, rewire a branch, or explain the graph. Each turn carries the definition and
              layout currently on the canvas, dragged positions included.
            </p>
          )}
          {messages.map((message) => (
            <Turn key={message.messageId} message={message} />
          ))}
          {live !== null && <LiveTurnView turn={live} />}
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
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {error !== null && (
        <p
          role="alert"
          className="shrink-0 border-t border-[var(--color-border-subtle)] px-3 py-2 text-[11px]"
          style={{ backgroundColor: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}
        >
          {error}
        </p>
      )}
      <PromptInput
        className="shrink-0 gap-2 border-t border-[var(--color-border-subtle)] p-3"
        onSubmit={(payload) => send(payload.text)}
      >
        <PromptInputBody>
          <PromptInputTextarea
            aria-label="Message the builder agent"
            className="min-h-12 text-[11px]"
            disabled={disabled || sending}
            placeholder={disabled ? 'Waiting for the workflow to load…' : 'Ask the agent to change the graph…'}
          />
        </PromptInputBody>
        <PromptInputFooter className="items-center justify-between gap-2">
          <span className="text-[10px] text-[var(--color-ink-faint)]">⌘↵ to send</span>
          <PromptInputSubmit
            disabled={disabled}
            onStop={stop}
            status={sending ? 'submitted' : 'ready'}
            title={sending ? 'Stop the turn' : 'Send'}
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
