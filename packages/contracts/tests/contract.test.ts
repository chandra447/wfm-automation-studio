import { describe, expect, test } from 'bun:test';
import { eventDefinitions, parseEvent, makeEvent, triggerCatalog } from '../src/index.ts';

describe('event contracts', () => {
  test('every catalogue sample validates against its own schema', () => {
    for (const definition of eventDefinitions) {
      const result = definition.schema.safeParse(definition.sample);
      expect(result.success, `${definition.type} sample must satisfy its schema`).toBe(true);
    }
  });

  test('the trigger catalogue exposes a JSON Schema and a sample per event', () => {
    const catalog = triggerCatalog();
    expect(catalog.length).toBe(eventDefinitions.length);
    for (const trigger of catalog) {
      expect(trigger.jsonSchema, `${trigger.eventType} has no JSON Schema`).toBeTruthy();
      expect(trigger.sample).toBeTruthy();
      expect(trigger.summary.length).toBeGreaterThan(10);
    }
  });

  test('makeEvent fills the envelope and derives the aggregate id', () => {
    const event = makeEvent(
      'shift.cancelled',
      {
        shiftId: '22222222-2222-4222-8222-000000000003',
        locationId: '33333333-3333-4333-8333-000000000001',
        startsAt: '2026-09-21T04:00:00.000Z',
        hoursUntilStart: 7.5,
        reason: 'Sick leave',
        cancelledByEmployeeId: null,
        requiredQualificationCodes: ['RN'],
        roleName: 'Registered Nurse',
      },
      { tenantId: '11111111-1111-4111-8111-111111111111' },
    );

    expect(event.aggregate).toEqual({ type: 'shift', id: '22222222-2222-4222-8222-000000000003' });
    expect(event.eventVersion).toBe(1);
    expect(event.eventType).toBe('shift.cancelled');
    expect(parseEvent(event).eventId).toBe(event.eventId);
  });

  test('unknown event types are rejected rather than ignored', () => {
    expect(() =>
      parseEvent({
        eventId: crypto.randomUUID(),
        eventType: 'shift.exploded',
        eventVersion: 1,
        occurredAt: new Date().toISOString(),
        tenantId: crypto.randomUUID(),
        aggregate: { type: 'shift', id: crypto.randomUUID() },
        actor: null,
        correlationId: crypto.randomUUID(),
        causationId: null,
        traceparent: null,
        payload: {},
      }),
    ).toThrow(/unknown event type/);
  });

  test('an unsupported version is rejected', () => {
    const event = makeEvent(
      'shift.unfilled',
      {
        shiftId: crypto.randomUUID(),
        locationId: crypto.randomUUID(),
        startsAt: '2026-09-21T04:00:00.000Z',
        hoursUntilStart: 20,
      },
      { tenantId: crypto.randomUUID() },
    );
    expect(() => parseEvent({ ...event, eventVersion: 99 })).toThrow(/unsupported version/);
  });

  test('a payload that violates the schema is rejected with the offending path', () => {
    const event = makeEvent(
      'shift.unfilled',
      {
        shiftId: crypto.randomUUID(),
        locationId: crypto.randomUUID(),
        startsAt: '2026-09-21T04:00:00.000Z',
        hoursUntilStart: 20,
      },
      { tenantId: crypto.randomUUID() },
    );
    expect(() => parseEvent({ ...event, payload: { ...event.payload, hoursUntilStart: 'soon' } })).toThrow(
      /invalid payload/,
    );
  });
});
