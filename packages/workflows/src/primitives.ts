import { z } from 'zod';

/**
 * DSL primitives shared by the kind declarations and the definition schema.
 * They live below both so a kind file can use them without importing the module
 * that assembles the kinds, which would be a cycle.
 */

export const nodeIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'node ids are lower_snake_case');

/** Ports carry the outcome of a node; edges label which port they leave from. */
export const edgePortSchema = z.enum(['always', 'true', 'false', 'passed', 'failed', 'approved', 'rejected']);

export type EdgePort = z.infer<typeof edgePortSchema>;

/**
 * The canvas card's nominal size. A card is as tall as its fields make it, so
 * the height is a layout hint for spacing rather than a measurement: what
 * depends on it is where an added node lands and where a dropped node centres.
 */
export const NODE_WIDTH = 300;
export const NODE_HEIGHT = 180;
