'use client';

import type { RunEvent } from '@wfm/contracts';
import { builderChatResponseSchema } from '@wfm/workflows';
import type { BuilderChatHistory, BuilderChatRequest, BuilderChatResponse } from '@wfm/workflows';

export const studioApiUrl = process.env.NEXT_PUBLIC_STUDIO_API_URL ?? 'http://127.0.0.1:4103';

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Thin fetch wrapper rather than a treaty call per route: the canvas, the runs
 * view, and the approvals inbox all need the same actor headers, error shape,
 * and JSON handling, and SSE cannot go through treaty at all.
 */
export async function apiFetch<TResponse>(
  path: string,
  options: { method?: string; headers: Record<string, string>; body?: unknown; signal?: AbortSignal } = {
    headers: {},
  },
): Promise<TResponse> {
  const response = await fetch(`${studioApiUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: { ...options.headers, 'content-type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const text = await response.text();
  const payload: unknown = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiFailure(
      response.status,
      error?.code ?? 'REQUEST_FAILED',
      error?.message ?? `request failed with ${response.status}`,
      error?.details,
    );
  }

  return payload as TResponse;
}

/**
 * The builder conversation is stored per workflow, so the transcript and the
 * next turn are the same route: GET reads the thread, POST appends to it and
 * returns the graph the turn produced.
 */
export async function fetchBuilderChat(
  workflowId: string,
  headers: Record<string, string>,
): Promise<BuilderChatHistory> {
  return apiFetch<BuilderChatHistory>(`/workflows/${workflowId}/chat`, { headers });
}

export async function sendBuilderMessage(
  workflowId: string,
  body: BuilderChatRequest,
  headers: Record<string, string>,
): Promise<BuilderChatResponse> {
  // Parsed rather than trusted: a response that does not match the contract
  // would otherwise reach the canvas as an undefined definition.
  const payload = await apiFetch<unknown>(`/workflows/${workflowId}/chat`, { method: 'POST', headers, body });
  return builderChatResponseSchema.parse(payload);
}

/** SSE over fetch so actor headers survive; EventSource cannot send headers. */
export async function subscribeToRun(
  runId: string,
  headers: Record<string, string>,
  onEvent: (event: RunEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${studioApiUrl}/runs/${runId}/stream`, {
    headers: { ...headers, accept: 'text/event-stream' },
    signal,
  });
  if (!response.body) throw new ApiFailure(response.status, 'NO_STREAM', 'run stream unavailable');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
      if (!line) continue;
      onEvent(JSON.parse(line.slice('data: '.length)) as RunEvent);
    }
  }
}
