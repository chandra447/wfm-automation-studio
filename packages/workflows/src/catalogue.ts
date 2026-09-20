import { z } from 'zod';
import { policyCheckKindSchema, aiOutputSchema } from './dsl.ts';

/**
 * Catalogues the canvas reads from and the validator checks against. Adding a
 * command to the platform means adding it here once: the palette, the
 * inspector's input fields, and the validation all follow.
 */

export interface CommandDescriptor {
  id: string;
  service: 'rostering' | 'time-attendance';
  label: string;
  method: 'POST';
  pathTemplate: string;
  payAffecting: boolean;
  /** Which input fields the canvas must collect, as template strings. */
  inputs: Array<{ field: string; required: boolean; description: string }>;
}

export const commandCatalog: readonly CommandDescriptor[] = [
  {
    id: 'rostering.send_offers',
    service: 'rostering',
    label: 'Offer shift to employees',
    method: 'POST',
    pathTemplate: '/shifts/{{shiftId}}/offers',
    payAffecting: true,
    inputs: [
      { field: 'shiftId', required: true, description: 'Shift to fill' },
      { field: 'employeeIds', required: true, description: 'Employees to offer' },
      { field: 'expiresAt', required: true, description: 'Offer expiry' },
      { field: 'reason', required: true, description: 'Why this action ran' },
    ],
  },
  {
    id: 'rostering.assign_employee',
    service: 'rostering',
    label: 'Assign employee to shift',
    method: 'POST',
    pathTemplate: '/shifts/{{shiftId}}/assignment',
    payAffecting: true,
    inputs: [
      { field: 'shiftId', required: true, description: 'Shift to fill' },
      { field: 'employeeId', required: true, description: 'Employee to assign' },
      { field: 'reason', required: true, description: 'Why this action ran' },
    ],
  },
  {
    id: 'time_attendance.apply_adjustment',
    service: 'time-attendance',
    label: 'Apply timesheet adjustment',
    method: 'POST',
    pathTemplate: '/timesheets/{{timesheetId}}/adjustments',
    payAffecting: true,
    inputs: [
      { field: 'timesheetId', required: true, description: 'Timesheet to adjust' },
      { field: 'unpaidBreakMinutesDelta', required: true, description: 'Break minutes to add/remove' },
      { field: 'overtimeMinutesDelta', required: true, description: 'Overtime minutes to add/remove' },
      { field: 'reason', required: true, description: 'Why this action ran' },
    ],
  },
  {
    id: 'time_attendance.approve_timesheet',
    service: 'time-attendance',
    label: 'Approve timesheet for pay run',
    method: 'POST',
    pathTemplate: '/timesheets/{{timesheetId}}/approval',
    payAffecting: true,
    inputs: [
      { field: 'timesheetId', required: true, description: 'Timesheet to approve' },
      { field: 'decision', required: true, description: 'approve or reject' },
      { field: 'reason', required: true, description: 'Why this action ran' },
    ],
  },
];

export function commandById(id: string): CommandDescriptor | undefined {
  return commandCatalog.find((command) => command.id === id);
}

export interface ToolDescriptor {
  id: string;
  service: 'rostering' | 'time-attendance';
  label: string;
  description: string;
}

/** Read-only context an AI decision node is allowed to fetch. */
export const toolCatalog: readonly ToolDescriptor[] = [
  {
    id: 'shift.get',
    service: 'rostering',
    label: 'Read shift',
    description: 'Current shift state: role, location, qualification requirements, timing.',
  },
  {
    id: 'shift.candidates',
    service: 'rostering',
    label: 'Read eligible candidates',
    description: 'Eligibility, rest hours, cost estimate, and ranking from the rostering service.',
  },
  {
    id: 'employee.availability',
    service: 'rostering',
    label: 'Read availability',
    description: 'Approved leave and availability windows for an employee.',
  },
  {
    id: 'timesheet.get',
    service: 'time-attendance',
    label: 'Read timesheet',
    description: 'Worked minutes, breaks, pay lines, and open exceptions.',
  },
  {
    id: 'award_rule.get',
    service: 'time-attendance',
    label: 'Read award rule',
    description: 'Break entitlement, ordinary-hours cap, overtime multiplier, minimum rest.',
  },
];

export function toolById(id: string): ToolDescriptor | undefined {
  return toolCatalog.find((tool) => tool.id === id);
}

export const policyCheckLabels: Readonly<Record<z.infer<typeof policyCheckKindSchema>, string>> = {
  cost_delta_cap: 'Cost delta under cap',
  rest_rule: 'Minimum rest between shifts',
  availability: 'Employee availability',
  award_validity: 'Award rule validity',
  overtime_risk: 'Overtime risk tolerance',
};

export const aiOutputLabels: Readonly<Record<z.infer<typeof aiOutputSchema>, string>> = {
  candidate_choice: 'Choose employee(s) to cover a shift',
  timesheet_adjustment: 'Draft a timesheet adjustment',
  coverage_plan: 'Draft a coverage plan',
};
