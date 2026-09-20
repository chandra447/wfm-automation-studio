import { z } from 'zod';
import { type ActorContext, type SimulatorResponse, type SimulatorScenario } from '@wfm/contracts';
import type { DomainClients } from './domain-clients.ts';
import type { Logger } from 'pino';

/**
 * Seeded ids matching the demo fixture set (packages/testkit). They live here
 * as constants because the studio engine does not depend on the testkit.
 */
const DEMO = {
  cancelledByEmployeeId: '44444444-4444-4444-8444-000000000001',
  coverageEmployeeId: '44444444-4444-4444-8444-000000000003',
  payrollShiftId: '22222222-2222-4222-8222-000000000005',
} as const;

const simulatorScenarioSchema = z.enum(['coverage_rescue', 'payroll_exception']);

/**
 * Demo scenario driver (design §12). The simulator always calls the DOMAIN
 * SERVICES over HTTP — never the bus — so the demo exercises the real path:
 * the service emits its own event, the outbox publishes it, the engine picks
 * it up, and the workflow runs from the trigger.
 */
export class Simulator {
  readonly #clients: DomainClients;
  readonly #logger: Logger;

  constructor(clients: DomainClients, logger: Logger) {
    this.#clients = clients;
    this.#logger = logger;
  }

  async run(actor: ActorContext, scenario: SimulatorScenario): Promise<SimulatorResponse> {
    const parsed = simulatorScenarioSchema.parse(scenario);
    switch (parsed) {
      case 'coverage_rescue':
        return this.#coverageRescue(actor);
      case 'payroll_exception':
        return this.#payrollException(actor);
    }
  }

  async #coverageRescue(actor: ActorContext): Promise<SimulatorResponse> {
    const shiftId = '22222222-2222-4222-8222-000000000003';
    const shift = await this.#clients.rostering.cancelShift(actor.tenantId, shiftId, {
      reason: 'Simulator: employee called in sick (coverage rescue demo)',
      cancelledByEmployeeId: DEMO.cancelledByEmployeeId,
    });
    this.#logger.info({ tenantId: actor.tenantId, shiftId }, 'coverage rescue simulated');
    return {
      scenario: 'coverage_rescue',
      shiftId: shift.shiftId,
      timesheetId: null,
      emittedEvents: ['shift.cancelled'],
      note:
        `Cancelled shift ${shift.shiftId} (${shift.roleName}) starting ${shift.startsAt}; the shift.cancelled ` +
        'event went through the rostering outbox and should start a run.',
    };
  }

  async #payrollException(actor: ActorContext): Promise<SimulatorResponse> {
    const shiftId = DEMO.payrollShiftId;
    const shift = await this.#clients.rostering.getShift(actor.tenantId, shiftId);
    // Clock out at the scheduled end, not at wall-clock now. The demo shift is
    // seeded in the past, and clocking out "now" would invent hours that were
    // never worked, so the overtime the workflow reasons about would be wrong.
    const scheduledEnd = new Date(shift.endsAt);
    const at = scheduledEnd.getTime() < Date.now() ? scheduledEnd.toISOString() : new Date().toISOString();
    const clockOut = await this.#clients.attendance.clockOut(actor.tenantId, shiftId, {
      employeeId: DEMO.coverageEmployeeId,
      shiftId: null,
      at,
      breakMinutesTaken: 0,
    });
    this.#logger.info(
      { tenantId: actor.tenantId, timesheetId: clockOut.timesheet.timesheetId, emittedEvents: clockOut.emittedEvents },
      'payroll exception simulated',
    );
    return {
      scenario: 'payroll_exception',
      shiftId,
      timesheetId: clockOut.timesheet.timesheetId,
      emittedEvents: clockOut.emittedEvents,
      note:
        `Clocked out ${clockOut.timesheet.employeeName} with no break taken; the time-attendance service ` +
        'raised the pay-affecting exceptions through its outbox.',
    };
  }
}
