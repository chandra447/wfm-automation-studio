import { triggerCatalog } from '@wfm/contracts';
import { commandCatalog, toolCatalog, type CommandDescriptor, type ToolDescriptor } from './catalogue.ts';
import {
  legalPortsByNodeType,
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeType,
} from './dsl.ts';
import { TEMPLATE_PATTERN, parseTemplateExpression } from './templates.ts';

/**
 * Validation is where user freedom meets platform invariants. A customer can
 * wire any shape they like; these rules are what stop them shipping something
 * that moves pay without a human, or that reasons its way past a policy check.
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
  return {
    eventTypes: triggerCatalog().map((trigger) => trigger.eventType),
    commands: commandCatalog,
    tools: toolCatalog,
  };
}

const MAX_ENUMERATED_PATHS = 512;

interface Graph {
  byId: Record<string, WorkflowNode>;
  outgoing: Record<string, Array<{ to: string; port: string }>>;
  incoming: Record<string, string[]>;
  trigger?: WorkflowNode & { type: 'trigger' };
}

function buildGraph(definition: WorkflowDefinition, diagnostics: Diagnostic[]): Graph {
  const byId: Record<string, WorkflowNode> = {};
  const outgoing: Graph['outgoing'] = {};
  const incoming: Graph['incoming'] = {};

  for (const node of definition.nodes) {
    if (byId[node.id]) {
      diagnostics.push({
        severity: 'error',
        code: 'NODE_ID_DUPLICATE',
        message: `Node id "${node.id}" is used more than once.`,
        nodeId: node.id,
      });
      continue;
    }
    byId[node.id] = node;
    outgoing[node.id] = [];
    incoming[node.id] = [];
  }

  for (const edge of definition.edges) {
    const from = byId[edge.from];
    const to = byId[edge.to];
    if (!from || !to) {
      diagnostics.push({
        severity: 'error',
        code: 'EDGE_DANGLING',
        message: `Edge ${edge.from} → ${edge.to} references a node that does not exist.`,
        ...(from ? { nodeId: from.id } : to ? { nodeId: to.id } : {}),
      });
      continue;
    }
    outgoing[edge.from]?.push({ to: edge.to, port: edge.port });
    incoming[edge.to]?.push(edge.from);
  }

  const triggers = definition.nodes.filter((node) => node.type === 'trigger');
  if (triggers.length !== 1) {
    diagnostics.push({
      severity: 'error',
      code: 'TRIGGER_COUNT',
      message: `Exactly one trigger node is required; found ${triggers.length}.`,
      ...(triggers[0] ? { nodeId: triggers[0].id } : {}),
    });
  }

  return { byId, outgoing, incoming, ...(triggers[0] ? { trigger: triggers[0] } : {}) };
}

function checkPorts(graph: Graph, diagnostics: Diagnostic[]): void {
  for (const node of Object.values(graph.byId)) {
    const legal = legalPortsByNodeType[node.type as WorkflowNodeType];
    const usedPorts = (graph.outgoing[node.id] ?? []).map((edge) => edge.port);

    for (const port of usedPorts) {
      if (!legal.includes(port as never)) {
        diagnostics.push({
          severity: 'error',
          code: 'PORT_NOT_ALLOWED',
          message: `A ${node.type} node cannot emit the "${port}" port.`,
          nodeId: node.id,
        });
      }
    }

    if (node.type === 'condition') {
      for (const port of ['true', 'false'] as const) {
        if (!usedPorts.includes(port)) {
          diagnostics.push({
            severity: 'error',
            code: 'PORT_MISSING',
            message: `Condition nodes must wire both the "yes" and "no" paths.`,
            nodeId: node.id,
          });
        }
      }
    }
    if (node.type === 'policy_check') {
      for (const port of ['passed', 'failed'] as const) {
        if (!usedPorts.includes(port)) {
          diagnostics.push({
            severity: 'error',
            code: 'PORT_MISSING',
            message: `Policy check nodes must wire both the "passed" and "failed" paths.`,
            nodeId: node.id,
          });
        }
      }
    }
    if (node.type === 'human_approval' && !usedPorts.includes('approved')) {
      diagnostics.push({
        severity: 'error',
        code: 'PORT_MISSING',
        message: 'Approval nodes must wire the "approved" path.',
        nodeId: node.id,
      });
    }
    if (node.type === 'human_approval' && !usedPorts.includes('rejected')) {
      diagnostics.push({
        severity: 'warning',
        code: 'PORT_MISSING_REJECTED',
        message: 'No "rejected" path wired: a rejection will end the run immediately.',
        nodeId: node.id,
      });
    }
    if (node.type === 'end' && usedPorts.length > 0) {
      diagnostics.push({
        severity: 'error',
        code: 'END_HAS_OUTGOING',
        message: 'End nodes cannot have outgoing edges.',
        nodeId: node.id,
      });
    }
    if (node.type === 'trigger' && (graph.incoming[node.id] ?? []).length > 0) {
      diagnostics.push({
        severity: 'error',
        code: 'TRIGGER_HAS_INCOMING',
        message: 'The trigger node cannot be targeted by an edge.',
        nodeId: node.id,
      });
    }
  }
}

function detectCycles(graph: Graph, diagnostics: Diagnostic[]): boolean {
  const state: Record<string, 'visiting' | 'done'> = {};
  let cyclic = false;

  const visit = (nodeId: string, trail: string[]): void => {
    if (state[nodeId] === 'done') return;
    if (state[nodeId] === 'visiting') {
      cyclic = true;
      diagnostics.push({
        severity: 'error',
        code: 'CYCLE',
        message: `Cycle detected: ${[...trail, nodeId].join(' → ')}. Loops are not supported yet.`,
        nodeId,
      });
      return;
    }
    state[nodeId] = 'visiting';
    for (const edge of graph.outgoing[nodeId] ?? []) visit(edge.to, [...trail, nodeId]);
    state[nodeId] = 'done';
  };

  for (const nodeId of Object.keys(graph.byId)) visit(nodeId, []);
  return cyclic;
}

/** Every path from the trigger to `targetId`, or null if the graph is too large. */
function pathsTo(graph: Graph, targetId: string): string[][] | null {
  if (!graph.trigger) return [];
  const found: string[][] = [];
  const walk = (nodeId: string, trail: string[]): void => {
    if (found.length > MAX_ENUMERATED_PATHS) return;
    const next = [...trail, nodeId];
    if (nodeId === targetId) {
      found.push(next);
      return;
    }
    for (const edge of graph.outgoing[nodeId] ?? []) walk(edge.to, next);
  };
  walk(graph.trigger.id, []);
  return found.length > MAX_ENUMERATED_PATHS ? null : found;
}

function checkAuthority(graph: Graph, context: ValidationContext, diagnostics: Diagnostic[]): void {
  for (const node of Object.values(graph.byId)) {
    if (node.type !== 'action') continue;

    const command = context.commands.find((candidate) => candidate.id === node.config.command);
    const paths = pathsTo(graph, node.id);
    if (!paths) {
      diagnostics.push({
        severity: 'error',
        code: 'GRAPH_TOO_COMPLEX',
        message: 'Too many execution paths to prove approval coverage; simplify the workflow.',
        nodeId: node.id,
      });
      continue;
    }

    for (const path of paths) {
      const pathNodes = path.map((id) => graph.byId[id]).filter((n): n is WorkflowNode => Boolean(n));
      const hasPolicy = pathNodes.some((candidate) => candidate.type === 'policy_check');
      const hasApproval = pathNodes.some((candidate) => candidate.type === 'human_approval');

      if (!hasPolicy) {
        diagnostics.push({
          severity: 'error',
          code: 'ACTION_WITHOUT_POLICY',
          message: `"${node.label}" can be reached without a policy check. Every action needs deterministic guardrails on its path.`,
          nodeId: node.id,
        });
      }
      if (command?.payAffecting && !hasApproval) {
        diagnostics.push({
          severity: 'error',
          code: 'PAY_ACTION_WITHOUT_APPROVAL',
          message: `"${node.label}" can move pay without a human approval on every path. Add an approval node before it.`,
          nodeId: node.id,
        });
      }
    }

    if (!command) {
      diagnostics.push({
        severity: 'error',
        code: 'UNKNOWN_COMMAND',
        message: `Unknown action command "${node.config.command}".`,
        nodeId: node.id,
      });
      continue;
    }

    for (const input of command.inputs) {
      if (input.required && !(input.field in node.config.input)) {
        diagnostics.push({
          severity: 'error',
          code: 'MISSING_INPUT',
          message: `"${node.label}" is missing the required input "${input.field}".`,
          nodeId: node.id,
        });
      }
    }
  }
}

function checkTemplates(graph: Graph, diagnostics: Diagnostic[]): void {
  // A node may only read from nodes that can reach it (upstream), never ahead.
  const upstream: Record<string, Set<string>> = {};
  const collect = (nodeId: string, seen: Set<string>): Set<string> => {
    const cached = upstream[nodeId];
    if (cached) return cached;
    const result = new Set<string>();
    for (const parent of graph.incoming[nodeId] ?? []) {
      if (parent === nodeId || seen.has(parent)) continue;
      result.add(parent);
      for (const ancestor of collect(parent, new Set([...seen, nodeId]))) result.add(ancestor);
    }
    upstream[nodeId] = result;
    return result;
  };

  for (const node of Object.values(graph.byId)) {
    if (node.type !== 'action') continue;
    const reachable = collect(node.id, new Set());

    for (const [field, template] of Object.entries(node.config.input)) {
      for (const match of template.matchAll(TEMPLATE_PATTERN)) {
        const expression = match[1] ?? '';
        const reference = parseTemplateExpression(expression);
        if (!reference) {
          diagnostics.push({
            severity: 'error',
            code: 'TEMPLATE_INVALID',
            message: `Input "${field}" uses an unsupported expression "{{${expression}}}".`,
            nodeId: node.id,
          });
          continue;
        }
        if (reference.kind === 'node') {
          if (!graph.byId[reference.nodeId]) {
            diagnostics.push({
              severity: 'error',
              code: 'TEMPLATE_NODE_UNKNOWN',
              message: `Input "${field}" references node "${reference.nodeId}", which does not exist.`,
              nodeId: node.id,
            });
          } else if (reference.nodeId === node.id || !reachable.has(reference.nodeId)) {
            diagnostics.push({
              severity: 'error',
              code: 'TEMPLATE_NOT_UPSTREAM',
              message: `Input "${field}" references "${reference.nodeId}", which does not run before this node.`,
              nodeId: node.id,
            });
          }
        }
      }
    }
  }
}

function checkReachability(graph: Graph, diagnostics: Diagnostic[]): void {
  if (!graph.trigger) return;
  const seen = new Set<string>([graph.trigger.id]);
  const queue = [graph.trigger.id];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const edge of graph.outgoing[current] ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }

  for (const node of Object.values(graph.byId)) {
    if (seen.has(node.id)) continue;
    diagnostics.push({
      severity: 'error',
      code: 'UNREACHABLE_NODE',
      message: `"${node.label}" cannot be reached from the trigger.`,
      nodeId: node.id,
    });
  }
}

function checkTerminals(graph: Graph, diagnostics: Diagnostic[]): void {
  const canReachEnd: Record<string, boolean> = {};
  const walk = (nodeId: string, trail: Set<string>): boolean => {
    const cached = canReachEnd[nodeId];
    if (cached !== undefined) return cached;
    const node = graph.byId[nodeId];
    if (!node) return false;
    if (node.type === 'end') {
      canReachEnd[nodeId] = true;
      return true;
    }
    if (trail.has(nodeId)) return false;
    const next = new Set([...trail, nodeId]);
    const reached = (graph.outgoing[nodeId] ?? []).some((edge) => walk(edge.to, next));
    canReachEnd[nodeId] = reached;
    return reached;
  };

  for (const node of Object.values(graph.byId)) {
    if (node.type === 'end') continue;
    if (!walk(node.id, new Set())) {
      diagnostics.push({
        severity: 'error',
        code: 'NO_TERMINAL_PATH',
        message: `"${node.label}" has no path to an End node; the run would have nowhere to finish.`,
        nodeId: node.id,
      });
    }
  }
}

function checkNodeConfigs(definition: WorkflowDefinition, context: ValidationContext, diagnostics: Diagnostic[]): void {
  const parsed = workflowDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const nodeIndex = issue.path[1];
      const nodeId = typeof nodeIndex === 'number' ? definition.nodes[nodeIndex]?.id : undefined;
      diagnostics.push({
        severity: 'error',
        code: 'NODE_CONFIG_INVALID',
        message: `${issue.path.join('.')}: ${issue.message}`,
        ...(nodeId ? { nodeId } : {}),
      });
    }
  }

  const trigger = definition.nodes.find((node) => node.type === 'trigger');
  if (trigger && !context.eventTypes.includes(trigger.config.eventType)) {
    diagnostics.push({
      severity: 'error',
      code: 'UNKNOWN_EVENT',
      message: `Unknown trigger event "${trigger.config.eventType}".`,
      nodeId: trigger.id,
    });
  }

  for (const node of definition.nodes) {
    if (node.type === 'ai_decision') {
      for (const tool of node.config.tools) {
        if (!context.tools.some((candidate) => candidate.id === tool)) {
          diagnostics.push({
            severity: 'error',
            code: 'UNKNOWN_TOOL',
            message: `Unknown tool "${tool}" on the AI decision node.`,
            nodeId: node.id,
          });
        }
      }
    }
    if (node.type === 'human_approval' && node.config.timeoutMinutes > 1440) {
      diagnostics.push({
        severity: 'warning',
        code: 'LONG_APPROVAL_TIMEOUT',
        message: `Approvals waiting longer than 24h will escalate slowly; ${node.config.timeoutMinutes} minutes configured.`,
        nodeId: node.id,
      });
    }
  }
}

export function validateWorkflow(
  definition: WorkflowDefinition,
  context: ValidationContext = defaultValidationContext(),
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const graph = buildGraph(definition, diagnostics);

  checkNodeConfigs(definition, context, diagnostics);
  checkPorts(graph, diagnostics);
  const cyclic = detectCycles(graph, diagnostics);
  checkReachability(graph, diagnostics);
  checkTemplates(graph, diagnostics);
  if (!cyclic) {
    checkTerminals(graph, diagnostics);
    checkAuthority(graph, context, diagnostics);
  }

  return diagnostics;
}

export function validationErrors(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
}

export function assertValidWorkflow(
  definition: WorkflowDefinition,
  context: ValidationContext = defaultValidationContext(),
): void {
  const errors = validationErrors(validateWorkflow(definition, context));
  if (errors.length > 0) throw new WorkflowValidationError(errors);
}
