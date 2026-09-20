import { triggerCatalog } from '@wfm/contracts';
import { commandCatalog, toolCatalog, type CommandDescriptor, type ToolDescriptor } from './catalogue.ts';

/**
 * Validation vocabulary shared by the kind declarations, the validator, and the
 * canvas. It lives on its own so a kind file can emit diagnostics without
 * importing the validator, which imports the kinds.
 */

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  nodeId?: string;
}

export interface ValidationContext {
  eventTypes: readonly string[];
  commands: readonly CommandDescriptor[];
  tools: readonly ToolDescriptor[];
  /**
   * The trigger event's JSON Schema, which is the same artifact the canvas
   * shows on the triggers page. Walking it keeps the reference checker off the
   * internals of whatever validation library the contracts package uses.
   */
  eventSchemaOf: (eventType: string) => unknown;
}

export class WorkflowValidationError extends Error {
  override readonly name = 'WorkflowValidationError';
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(`workflow rejected: ${diagnostics.map((d) => `${d.code}${d.nodeId ? `@${d.nodeId}` : ''}`).join(', ')}`);
    this.diagnostics = diagnostics;
  }
}

export function defaultValidationContext(): ValidationContext {
  const catalog = triggerCatalog();
  const schemas = new Map<string, unknown>(catalog.map((trigger) => [trigger.eventType, trigger.jsonSchema]));
  return {
    eventTypes: catalog.map((trigger) => trigger.eventType),
    commands: commandCatalog,
    tools: toolCatalog,
    eventSchemaOf: (eventType) => schemas.get(eventType),
  };
}
