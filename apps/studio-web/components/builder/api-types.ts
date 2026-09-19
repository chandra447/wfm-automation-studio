import type { CanvasLayout, Diagnostic, WorkflowDefinition } from '@wfm/workflows';
import type { TriggerDescriptor } from '@wfm/contracts';

export type { TriggerDescriptor };

/**
 * Mirrors the studio API's workflow DTOs (services/studio-api engine contract)
 * as plain interfaces: the canvas reads them over fetch, not Eden, and the
 * shapes here are what the API actually returns.
 */
export interface WorkflowSummary {
  workflowId: string;
  tenantId: string;
  name: string;
  description: string;
  enabled: boolean;
  draftVersionNumber: number;
  publishedVersionNumber: number | null;
  updatedAt: string;
}

export interface WorkflowVersion {
  versionId: string;
  versionNumber: number;
  status: 'draft' | 'published';
  definition: WorkflowDefinition;
  layout: CanvasLayout;
  diagnostics: Diagnostic[];
  createdBy: string;
  createdAt: string;
}

export interface WorkflowDetail {
  workflow: WorkflowSummary;
  versions: WorkflowVersion[];
}

export interface WorkflowMutationResult {
  workflowId: string;
  versionNumber: number;
  status: 'draft' | 'published';
  diagnostics: Diagnostic[];
}

export interface SaveWorkflowBody {
  name: string;
  description: string;
  enabled: boolean;
  definition: WorkflowDefinition;
  layout: CanvasLayout;
}

export function toSaveBody(snapshot: {
  definition: WorkflowDefinition;
  layout: CanvasLayout;
}): SaveWorkflowBody {
  return {
    name: snapshot.definition.name,
    description: snapshot.definition.description,
    enabled: snapshot.definition.enabled,
    definition: snapshot.definition,
    layout: snapshot.layout,
  };
}

export function diagnosticsFromDetails(details: unknown): Diagnostic[] {
  if (typeof details === 'object' && details !== null && 'diagnostics' in details) {
    const candidates = (details as { diagnostics?: unknown }).diagnostics;
    if (Array.isArray(candidates)) {
      return candidates.filter((entry): entry is Diagnostic => {
        if (typeof entry !== 'object' || entry === null) return false;
        const candidate = entry as Record<string, unknown>;
        return (
          (candidate.severity === 'error' || candidate.severity === 'warning') &&
          typeof candidate.code === 'string' &&
          typeof candidate.message === 'string'
        );
      });
    }
  }
  return [];
}
