import type {
  ActorContext,
  Approval,
  DecisionRequest,
  DecisionResponse,
  RunDetail,
  RunEvent,
  RunStatus,
  RunSummary,
  SimulatorResponse,
  SimulatorScenario,
  TriggerDescriptor,
} from '@wfm/contracts';
import type { CanvasLayout, Diagnostic, WorkflowDefinition } from '@wfm/workflows';

/**
 * The engine's public surface. The HTTP layer in app.ts owns transport only;
 * everything below this interface is the Automation Studio implementation.
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

export interface SaveWorkflowRequest {
  name: string;
  description: string;
  enabled: boolean;
  definition: WorkflowDefinition;
  layout: CanvasLayout;
}

export interface WorkflowMutationResult {
  workflowId: string;
  versionNumber: number;
  status: 'draft' | 'published';
  diagnostics: Diagnostic[];
}

export interface RunFilter {
  workflowId?: string;
  status?: RunStatus;
  limit?: number;
}

export interface EngineService {
  listTriggers: () => TriggerDescriptor[];
  listWorkflows: (context: ActorContext) => Promise<WorkflowSummary[]>;
  getWorkflow: (context: ActorContext, workflowId: string) => Promise<WorkflowDetail>;
  createWorkflow: (context: ActorContext, request: SaveWorkflowRequest) => Promise<WorkflowMutationResult>;
  saveDraft: (context: ActorContext, workflowId: string, request: SaveWorkflowRequest) => Promise<WorkflowMutationResult>;
  publishWorkflow: (context: ActorContext, workflowId: string) => Promise<WorkflowMutationResult>;
  deleteWorkflow: (context: ActorContext, workflowId: string) => Promise<void>;
  listRuns: (context: ActorContext, filter: RunFilter) => Promise<RunSummary[]>;
  getRun: (context: ActorContext, runId: string) => Promise<RunDetail>;
  streamRun: (context: ActorContext, runId: string, signal: AbortSignal) => AsyncIterable<RunEvent>;
  listApprovals: (context: ActorContext, status?: Approval['status']) => Promise<Approval[]>;
  decideApproval: (context: ActorContext, approvalId: string, request: DecisionRequest) => Promise<DecisionResponse>;
  simulate: (context: ActorContext, scenario: SimulatorScenario) => Promise<SimulatorResponse>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface CreateWorkflowBody extends Omit<SaveWorkflowRequest, 'name' | 'description' | 'enabled'> {
  name: string;
  description?: string;
  enabled?: boolean;
}
