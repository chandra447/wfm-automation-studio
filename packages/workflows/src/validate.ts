import {
  capabilitiesOf,
  configRulesFor,
  kindOf,
  templateSlotsOf,
} from './kinds/registry.ts';
import { authorityRules } from './kinds/invariants.ts';
import {
  defaultValidationContext,
  WorkflowValidationError,
  type Diagnostic,
  type ValidationContext,
} from './diagnostics.ts';
import { checkTemplateStrings } from './references/static-check.ts';
import { workflowDefinitionSchema, type WorkflowDefinition, type WorkflowNode } from './dsl.ts';

/**
 * Validation is where user freedom meets platform invariants. A customer can
 * wire any shape they like; these rules are what stop them shipping something
 * that moves pay without a human, or that reasons its way past a policy check.
 *
 * Nothing here branches on a node's kind. Ports, required ports, capabilities,
 * config rules, and template slots all come from the kind's own declaration, so
 * a kind added tomorrow is validated by the rules already in this file.
 */

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
    const kind = kindOf(node);
    const usedPorts = (graph.outgoing[node.id] ?? []).map((edge) => edge.port);

    for (const port of usedPorts) {
      if (!kind.ports.includes(port as never)) {
        diagnostics.push({
          severity: 'error',
          code: 'PORT_NOT_ALLOWED',
          message: `A ${node.type} node cannot emit the "${port}" port.`,
          nodeId: node.id,
        });
      }
    }

    for (const requirement of kind.requiredPorts) {
      if (!usedPorts.includes(requirement.port)) {
        diagnostics.push({
          severity: requirement.severity,
          code: requirement.code,
          message: requirement.message,
          nodeId: node.id,
        });
      }
    }

    if (kind.capabilities.terminal === true && usedPorts.length > 0) {
      diagnostics.push({
        severity: 'error',
        code: 'END_HAS_OUTGOING',
        message: 'End nodes cannot have outgoing edges.',
        nodeId: node.id,
      });
    }
  }
}

/**
 * An edge may only arrive where the kind says it can. Every kind but the
 * trigger declares one input, so this is the general form of the rule the
 * trigger used to carry alone: a kind that takes no input says so by declaring
 * none, rather than by the validator knowing its name.
 */
function checkInputs(graph: Graph, diagnostics: Diagnostic[]): void {
  for (const node of Object.values(graph.byId)) {
    if ((graph.incoming[node.id] ?? []).length === 0) continue;
    if (kindOf(node).inputs.length > 0) continue;
    diagnostics.push({
      severity: 'error',
      code: 'INPUT_NOT_ACCEPTED',
      message: `A ${node.type} node cannot be targeted by an edge.`,
      nodeId: node.id,
    });
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

/**
 * The authority invariants, applied to every node that claims the rule's
 * subject capability. A kind that declares `mutatesDomain` inherits both rules;
 * a kind that declares `providesApproval` satisfies them for everyone else.
 */
function checkAuthority(graph: Graph, diagnostics: Diagnostic[]): void {
  for (const node of Object.values(graph.byId)) {
    const capabilities = capabilitiesOf(node);

    for (const rule of authorityRules) {
      if (capabilities[rule.subject] !== true) continue;
      if (rule.when !== undefined && !rule.when(capabilities)) continue;

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
        const satisfied = path
          .map((id) => graph.byId[id])
          .filter((candidate): candidate is WorkflowNode => Boolean(candidate))
          .some((candidate) => capabilitiesOf(candidate)[rule.requires] === true);
        if (!satisfied) {
          diagnostics.push({
            severity: 'error',
            code: rule.code,
            message: rule.message(node.label),
            nodeId: node.id,
          });
        }
      }
    }
  }
}

function checkTemplates(graph: Graph, context: ValidationContext, diagnostics: Diagnostic[]): void {
  const upstreamCache: Record<string, Set<string>> = {};
  const upstreamOf = (nodeId: string): ReadonlySet<string> => {
    const cached = upstreamCache[nodeId];
    if (cached) return cached;
    const result = new Set<string>();
    const collect = (id: string, seen: Set<string>): void => {
      for (const parent of graph.incoming[id] ?? []) {
        if (parent === nodeId || seen.has(parent)) continue;
        result.add(parent);
        collect(parent, new Set([...seen, id]));
      }
    };
    collect(nodeId, new Set([nodeId]));
    upstreamCache[nodeId] = result;
    return result;
  };

  const triggerEventType = graph.trigger?.config.eventType;

  for (const node of Object.values(graph.byId)) {
    const slots = templateSlotsOf(node);
    if (slots.length === 0) continue;
    diagnostics.push(
      ...checkTemplateStrings(node.id, slots, {
        upstreamOf,
        nodeExists: (id) => graph.byId[id] !== undefined,
        triggerEventType,
        eventSchemaOf: context.eventSchemaOf,
        outputSchemaOf: (id) => {
          const producer = graph.byId[id];
          return producer === undefined ? undefined : kindOf(producer).outputSchema;
        },
      }),
    );
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
    if (kindOf(node).capabilities.terminal === true) {
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
    if (kindOf(node).capabilities.terminal === true) continue;
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

  for (const node of definition.nodes) {
    diagnostics.push(...configRulesFor(node, context));
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
  checkInputs(graph, diagnostics);
  const cyclic = detectCycles(graph, diagnostics);
  checkReachability(graph, diagnostics);
  checkTemplates(graph, context, diagnostics);
  if (!cyclic) {
    checkTerminals(graph, diagnostics);
    checkAuthority(graph, diagnostics);
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
