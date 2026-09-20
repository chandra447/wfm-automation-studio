import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  authorityRules,
  capabilitiesOf,
  compileWorkflow,
  defaultNodeOf,
  defaultValidationContext,
  defineKind,
  inputsOf,
  legalPortsByNodeType,
  nodeKinds,
  nodePalette,
  summaryOf,
  validateWorkflow,
  workflowNodeSchema,
  workflowNodeTypeSchema,
  type NodeCapabilities,
  type WorkflowNode,
} from '../src/index.ts';
import { coverageRescueWorkflow } from '../src/templates/demo-workflows.ts';

/**
 * The extension contract. Adding a node kind must be one declaration plus the
 * registrations in kinds/registry.ts, with no edit to the validator, the
 * compiler, the catalogue, the engine dispatch, or the inspector. These tests
 * hold the structure that makes that true.
 */

describe('registry', () => {
  test('every registry key matches its kind literal type', () => {
    for (const [key, kind] of Object.entries(nodeKinds)) {
      expect(String(kind.type)).toBe(key);
    }
  });

  test('the runtime enum covers every registered kind', () => {
    for (const key of Object.keys(nodeKinds)) {
      expect(workflowNodeTypeSchema.safeParse(key).success).toBe(true);
    }
  });

  test('every kind parses its own default node', () => {
    for (const key of Object.keys(nodeKinds)) {
      const node = defaultNodeOf(key as WorkflowNode['type'], 'a_node');
      expect(String(node.type)).toBe(key);
      expect(node.label.length).toBeGreaterThan(0);
      expect(summaryOf(node)).toBeTypeOf('string');
    }
  });

  test('the palette, the ports table, and the field specs are derived, not listed', () => {
    const types = Object.keys(nodeKinds);
    expect(nodePalette.map((entry) => String(entry.type)).sort()).toEqual(types.sort());
    expect(Object.keys(legalPortsByNodeType).sort()).toEqual(types.sort());
    for (const key of types) {
      const kind = nodeKinds[key as WorkflowNode['type']];
      expect(legalPortsByNodeType[key as WorkflowNode['type']]).toEqual(kind.ports);
      expect(kind.fields.length).toBeGreaterThan(0);
      expect(inputsOf(key as WorkflowNode['type'])).toEqual(kind.inputs);
    }
  });

  test('the trigger is the only kind that takes no input', () => {
    for (const key of Object.keys(nodeKinds)) {
      const inputs = inputsOf(key as WorkflowNode['type']);
      // An edge names a source port and nothing else, so a kind with two
      // inputs would be unaddressable. When one needs them, `WorkflowEdge`
      // grows a `toPort`, React Flow edges grow a `targetHandle`, and this
      // ceiling comes off.
      expect(inputs.length).toBeLessThanOrEqual(1);
      expect(inputs.length).toBe(key === 'trigger' ? 0 : 1);
    }
  });
});

describe('union narrowing', () => {
  test('a switch on node.type reaches each kind config without a cast', () => {
    const read = (node: WorkflowNode): string => {
      switch (node.type) {
        case 'trigger':
          return node.config.eventType;
        case 'condition':
          return String(node.config.conditions.length);
        case 'ai_decision':
          return node.config.output;
        case 'policy_check':
          return node.config.checks.join(',');
        case 'human_approval':
          return node.config.role;
        case 'action':
          return node.config.command;
        case 'artifact':
          return node.config.name;
        case 'end':
          return node.config.outcome;
      }
    };
    expect(read(defaultNodeOf('artifact', 'a'))).toBe('Run summary');
    expect(read(defaultNodeOf('trigger', 'b'))).toBe('shift.cancelled');
  });
});

describe('a kind the rules have never seen', () => {
  /**
   * Declared here, in the test, exactly the way a real kind is declared. The
   * platform rules below apply to it through its capabilities alone.
   */
  const notifyKind = defineKind('notify', z.object({ channel: z.string().min(1) }), {
    ports: ['always'],
    inputs: [{ id: 'in', label: 'Input' }],
    capabilities: { mutatesDomain: true },
    capabilitiesOf: () => ({ mutatesDomain: true, payImpact: true }),
    palette: { label: 'Notify', description: 'Sends a message.', accent: 'teal', icon: '✉' },
    defaultLabel: 'Notify',
    defaultConfig: { channel: 'ops' },
    fields: [{ key: 'channel', label: 'Channel', control: { kind: 'text' } }],
    summary: (config) => `Notify ${config.channel}`,
  });

  test('it declares itself into the authority rules without new validator code', () => {
    const capabilities = notifyKind.capabilitiesOf?.({
      id: 'notify_1',
      type: 'notify',
      label: 'Notify',
      config: { channel: 'ops' },
    }) as NodeCapabilities;

    const policyRule = authorityRules.find((rule) => rule.code === 'ACTION_WITHOUT_POLICY');
    const approvalRule = authorityRules.find((rule) => rule.code === 'PAY_ACTION_WITHOUT_APPROVAL');

    expect(policyRule?.subject).toBe('mutatesDomain');
    expect(capabilities[policyRule?.subject ?? 'mutatesDomain']).toBe(true);
    expect(approvalRule?.when?.(capabilities)).toBe(true);
  });

  test('a non-pay mutating kind is exempt from the approval rule', () => {
    const approvalRule = authorityRules.find((rule) => rule.code === 'PAY_ACTION_WITHOUT_APPROVAL');
    expect(approvalRule?.when?.({ mutatesDomain: true, payImpact: false })).toBe(false);
    expect(approvalRule?.when?.({ mutatesDomain: true })).toBe(false);
  });
});

describe('the artifact kind, added by declaration alone', () => {
  test('it validates inside a real workflow', () => {
    const diagnostics = validateWorkflow(coverageRescueWorkflow, defaultValidationContext());
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });

  test('the compiler buckets it by capability, not by name', () => {
    const spec = compileWorkflow(coverageRescueWorkflow);
    expect(spec.artifactNodeIds).toEqual(['cover_note']);
    expect(spec.actionNodeIds).toEqual(['send_offers']);
    expect(spec.approvalNodeIds.sort()).toEqual(['manager_approval', 'operations_approval']);
    expect(spec.terminals.sort()).toEqual(['filled_end', 'stopped_end']);
  });

  test('its template slots are checked like every other kind', () => {
    const node = defaultNodeOf('artifact', 'cover_note');
    if (node.type !== 'artifact') throw new Error('expected an artifact node');
    const broken = {
      ...coverageRescueWorkflow,
      nodes: [
        ...coverageRescueWorkflow.nodes.filter((candidate) => candidate.type !== 'artifact'),
        { ...node, config: { ...node.config, body: 'Shift {{input.payload.notAField}} was covered.' } },
      ],
    };
    const codes = validateWorkflow(broken).map((diagnostic) => diagnostic.code);
    expect(codes).toContain('TEMPLATE_EVENT_PATH');
  });

  test('the union still rejects an unknown kind at the boundary', () => {
    const parsed = workflowNodeSchema.safeParse({ id: 'x', type: 'notify', label: 'X', config: {} });
    expect(parsed.success).toBe(false);
  });
});

describe('capabilities resolve per node', () => {
  test('a pay-affecting action reports pay impact, a non-pay one does not', () => {
    const payAction: WorkflowNode = {
      id: 'a',
      type: 'action',
      label: 'Offer',
      config: { command: 'rostering.send_offers', input: {} },
    };
    const neutralAction: WorkflowNode = {
      id: 'b',
      type: 'action',
      label: 'Approve timesheet',
      config: { command: 'time_attendance.approve_timesheet', input: {} },
    };
    expect(capabilitiesOf(payAction).payImpact).toBe(true);
    expect(capabilitiesOf(neutralAction).payImpact).toBe(true);
    expect(capabilitiesOf(defaultNodeOf('artifact', 'c')).payImpact).toBeUndefined();
  });
});
