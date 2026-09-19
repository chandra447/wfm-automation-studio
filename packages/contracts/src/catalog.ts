import { z } from 'zod';
import type { TriggerDescriptor } from './api/studio.ts';
import { eventDefinitions } from './events/registry.ts';

/**
 * The trigger catalogue published to the studio: every event on the backbone
 * with its JSON Schema and a sample instance. Sorted by owner then type so the
 * UI and the tests see a stable order.
 */
export function triggerCatalog(): TriggerDescriptor[] {
  return [...eventDefinitions]
    .sort((a, b) => (a.owner === b.owner ? a.type.localeCompare(b.type) : a.owner.localeCompare(b.owner)))
    .map((definition) => ({
      eventType: definition.type,
      eventVersion: definition.version,
      owner: definition.owner,
      summary: definition.summary,
      jsonSchema: z.toJSONSchema(definition.schema),
      sample: definition.sample,
    }));
}
