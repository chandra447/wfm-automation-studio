/** Canvas geometry: React Flow positions and viewport, stored with the version. */
export interface CanvasLayout {
  viewport: { x: number; y: number; zoom: number };
  positions: Record<string, { x: number; y: number }>;
}

export function emptyLayout(): CanvasLayout {
  return { viewport: { x: 0, y: 0, zoom: 1 }, positions: {} };
}
