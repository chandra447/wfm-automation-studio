import { describe, expect, test } from 'bun:test';
import type { WorkflowDefinition } from '../src/dsl.ts';
import { compileWorkflow } from '../src/compile.ts';
import { validateWorkflow, validationErrors, defaultValidationContext } from '../src/validate.ts';
import { coverageRescueWorkflow, payrollExceptionWorkflow } from '../src/templates/demo-workflows.ts';

function codes(definition: WorkflowDefinition): string[] {
  return validateWorkflow(definition).map((diagnostic) => diagnostic.code);
}

/** The seeded workflows are what the demo ships, so they must be valid. */
describe('seeded workflows', () => {
  test('the coverage rescue workflow passes validation', () => {
    expect(validationErrors(validateWorkflow(coverageRescueWorkflow))).toEqual([]);
  });

  test('the payroll exception workflow passes validation', () => {
    expect(validationErrors(validateWorkflow(payrollExceptionWorkflow))).toEqual([]);
  });
});

describe('platform invariants', () => {
  test('a pay-affecting action reachable without approval is rejected', () => {
    const definition: WorkflowDefinition = {
      name: 'Unsafe offers',
      description: '',
      enabled: true,
      nodes: [
        { id: 'trigger', type: 'trigger', label: 'Start', config: { eventType: 'shift.cancelled', conditions: [] } },
        {
          id: 'check',
          type: 'policy_check',
          label: 'Policy',
          config: { checks: ['cost_delta_cap'], costCapCents: 100, escalateOnFailure: true },
        },
        {
          id: 'offer',
          type: 'action',
          label: 'Offer shift',
          config: {
            command: 'rostering.send_offers',
            input: {
              shiftId: '{{input.payload.shiftId}}',
              employeeIds: '["x"]',
              expiresAt: '{{now+1h}}',
              reason: 'test',
            },
          },
        },
        { id: 'done', type: 'end', label: 'Done', config: { outcome: 'completed' } },
      ],
      edges: [
        { from: 'trigger', to: 'check', port: 'always' },
        { from: 'check', to: 'offer', port: 'passed' },
        { from: 'offer', to: 'done', port: 'always' },
      ],
    };

    expect(codes(definition)).toContain('PAY_ACTION_WITHOUT_APPROVAL');
  });

  test('an action reachable without a policy check is rejected', () => {
    const definition: WorkflowDefinition = {
      name: 'No guardrails',
      description: '',
      enabled: true,
      nodes: [
        { id: 'trigger', type: 'trigger', label: 'Start', config: { eventType: 'shift.cancelled', conditions: [] } },
        {
          id: 'approve',
          type: 'human_approval',
          label: 'Approve',
          config: { role: 'roster_manager', timeoutMinutes: 60, escalateTo: 'operations_lead', show: ['rationale'] },
        },
        {
          id: 'offer',
          type: 'action',
          label: 'Offer shift',
          config: {
            command: 'rostering.send_offers',
            input: {
              shiftId: '{{input.payload.shiftId}}',
              employeeIds: '["x"]',
              expiresAt: '{{now+1h}}',
              reason: 'test',
            },
          },
        },
        { id: 'done', type: 'end', label: 'Done', config: { outcome: 'completed' } },
      ],
      edges: [
        { from: 'trigger', to: 'approve', port: 'always' },
        { from: 'approve', to: 'offer', port: 'approved' },
        { from: 'offer', to: 'done', port: 'always' },
      ],
    };

    expect(codes(definition)).toContain('ACTION_WITHOUT_POLICY');
  });

  test('a branch that bypasses approval is caught even when another branch approves', () => {
    const definition: WorkflowDefinition = structuredClone(coverageRescueWorkflow);
    definition.edges = definition.edges.map((edge) =>
      edge.from === 'coverage_policy' && edge.port === 'passed' ? { from: 'coverage_policy', to: 'send_offers', port: 'passed' } : edge,
    );
    expect(codes(definition)).toContain('PAY_ACTION_WITHOUT_APPROVAL');
  });
});

describe('structural validation', () => {
  test('a cycle is rejected', () => {
    const definition = structuredClone(coverageRescueWorkflow);
    definition.edges.push({ from: 'send_offers', to: 'rank_candidates', port: 'always' });
    expect(codes(definition)).toContain('CYCLE');
  });

  test('an unreachable node is rejected', () => {
    const definition = structuredClone(coverageRescueWorkflow);
    definition.nodes.push({ id: 'orphan', type: 'end', label: 'Orphan', config: { outcome: 'completed' } });
    expect(codes(definition)).toContain('UNREACHABLE_NODE');
  });

  test('an unknown command is rejected', () => {
    const definition = structuredClone(payrollExceptionWorkflow);
    const action = definition.nodes.find((node) => node.type === 'action');
    if (action && action.type === 'action') action.config.command = 'payroll.delete_everything';
    expect(codes(definition)).toContain('UNKNOWN_COMMAND');
  });

  test('an unknown trigger event is rejected', () => {
    const definition = structuredClone(coverageRescueWorkflow);
    const trigger = definition.nodes.find((node) => node.type === 'trigger');
    if (trigger && trigger.type === 'trigger') trigger.config.eventType = 'shift.vanished';
    expect(codes(definition)).toContain('UNKNOWN_EVENT');
  });

  test('a template pointing at a downstream node is rejected', () => {
    const definition = structuredClone(coverageRescueWorkflow);
    const action = definition.nodes.find((node) => node.id === 'send_offers');
    if (action && action.type === 'action') action.config.input.shiftId = '{{nodes.rank_candidates.output.shiftId}}';
    const downstream: WorkflowDefinition = {
      ...definition,
      edges: [...definition.edges, { from: 'send_offers', to: 'rank_candidates', port: 'always' }],
    };
    expect(codes(downstream)).toContain('CYCLE');
  });

  test('a template referencing a node that does not exist is rejected', () => {
    const definition = structuredClone(coverageRescueWorkflow);
    const action = definition.nodes.find((node) => node.id === 'send_offers');
    if (action && action.type === 'action') action.config.input.shiftId = '{{nodes.ghost_node.output.shiftId}}';
    expect(codes(definition)).toContain('TEMPLATE_NODE_UNKNOWN');
  });

  test('a condition node with only one wired port is rejected', () => {
    const definition = structuredClone(coverageRescueWorkflow);
    definition.edges = definition.edges.filter((edge) => !(edge.from === 'coverage_policy' && edge.port === 'failed'));
    expect(codes(definition)).toContain('PORT_MISSING');
  });

  test('an unknown AI tool is rejected', () => {
    const definition = structuredClone(coverageRescueWorkflow);
    const ai = definition.nodes.find((node) => node.type === 'ai_decision');
    if (ai && ai.type === 'ai_decision') ai.config.tools = ['shift.get', 'payroll.rebalance'];
    expect(codes(definition)).toContain('UNKNOWN_TOOL');
  });
});

describe('compiler', () => {
  test('produces an executable spec with the trigger as entry and both ends as terminals', () => {
    const spec = compileWorkflow(coverageRescueWorkflow);
    expect(spec.entry).toBe('when_shift_cancelled');
    expect(spec.terminals.sort()).toEqual(['filled_end', 'stopped_end']);
    expect(spec.approvalNodeIds.sort()).toEqual(['manager_approval', 'operations_approval']);
    expect(spec.actionNodeIds).toEqual(['send_offers']);
  });

  test('transitions carry their port so the runtime can route on outcomes', () => {
    const spec = compileWorkflow(coverageRescueWorkflow);
    const policy = spec.nodes.find((node) => node.id === 'coverage_policy');
    expect(policy?.transitions.map((transition) => transition.port).sort()).toEqual(['failed', 'passed']);
  });

  test('refuses to compile an invalid definition', () => {
    const definition = structuredClone(coverageRescueWorkflow);
    definition.edges = definition.edges.filter((edge) => edge.port !== 'approved');
    expect(() => compileWorkflow(definition)).toThrow(/workflow rejected/);
  });

  test('the default validation context knows the platform catalogues', () => {
    const context = defaultValidationContext();
    expect(context.eventTypes).toContain('shift.cancelled');
    expect(context.commands.map((command) => command.id)).toContain('time_attendance.apply_adjustment');
    expect(context.tools.map((tool) => tool.id)).toContain('award_rule.get');
  });
});
