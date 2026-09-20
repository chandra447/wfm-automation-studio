'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { CanvasLayout, WorkflowEdge, WorkflowNode } from '@wfm/workflows';
import { clearLocalDraft, edgeKey, writeLocalDraft, type BuilderSnapshot } from './state';

/**
 * The canvas state is the snapshot — definition plus layout — and every edit
 * funnels through applyChange so the undo stack (last 50, coalesced per field)
 * and the localStorage crash-recovery mirror stay consistent.
 */

export interface BuilderStore {
  snapshot: BuilderSnapshot;
  canUndo: boolean;
  canRedo: boolean;
  addNode: (node: WorkflowNode, position: { x: number; y: number }) => void;
  updateNode: (node: WorkflowNode, coalesceKey?: string) => void;
  deleteNodes: (nodeIds: readonly string[]) => void;
  addEdge: (edge: WorkflowEdge) => void;
  deleteEdges: (edgeIds: readonly string[]) => void;
  updatePositions: (positions: Record<string, { x: number; y: number }>) => void;
  updateViewport: (viewport: CanvasLayout['viewport']) => void;
  updateMeta: (patch: { name?: string; description?: string; enabled?: boolean }) => void;
  reset: (snapshot: BuilderSnapshot, opts?: { clean?: boolean }) => void;
  markSaved: () => void;
  undo: () => void;
  redo: () => void;
}

const HISTORY_LIMIT = 50;
const COALESCE_WINDOW_MS = 1200;

function cloneSnapshot(snapshot: BuilderSnapshot): BuilderSnapshot {
  return { definition: structuredClone(snapshot.definition), layout: structuredClone(snapshot.layout) };
}

export function useBuilderStore(workflowId: string, initial: BuilderSnapshot): BuilderStore {
  const [snapshot, setSnapshot] = useState<BuilderSnapshot>(initial);
  const snapshotRef = useRef<BuilderSnapshot>(initial);
  const pastRef = useRef<BuilderSnapshot[]>([]);
  const futureRef = useRef<BuilderSnapshot[]>([]);
  const lastKeyRef = useRef<string | null>(null);
  const lastTimeRef = useRef(0);
  const [historyTick, setHistoryTick] = useState(0);

  const commit = useCallback(
    (next: BuilderSnapshot, coalesceKey?: string) => {
      const previous = snapshotRef.current;
      const now = Date.now();
      const coalesced =
        coalesceKey !== undefined && coalesceKey === lastKeyRef.current && now - lastTimeRef.current < COALESCE_WINDOW_MS;
      if (!coalesced) {
        pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), cloneSnapshot(previous)];
        futureRef.current = [];
      }
      lastKeyRef.current = coalesceKey ?? null;
      lastTimeRef.current = now;
      snapshotRef.current = next;
      setSnapshot(next);
      setHistoryTick((tick) => tick + 1);
      writeLocalDraft(workflowId, next);
    },
    [workflowId],
  );

  const addNode = useCallback(
    (node: WorkflowNode, position: { x: number; y: number }) => {
      const next = cloneSnapshot(snapshotRef.current);
      if (next.definition.nodes.some((candidate) => candidate.id === node.id)) return;
      commit(
        {
          definition: { ...next.definition, nodes: [...next.definition.nodes, node] },
          layout: { ...next.layout, positions: { ...next.layout.positions, [node.id]: position } },
        },
        `add:${node.id}`,
      );
    },
    [commit],
  );

  const updateNode = useCallback(
    (node: WorkflowNode, coalesceKey?: string) => {
      const next = cloneSnapshot(snapshotRef.current);
      if (!next.definition.nodes.some((candidate) => candidate.id === node.id)) return;
      commit(
        {
          definition: {
            ...next.definition,
            nodes: next.definition.nodes.map((candidate) => (candidate.id === node.id ? node : candidate)),
          },
          layout: next.layout,
        },
        coalesceKey ?? `node:${node.id}`,
      );
    },
    [commit],
  );

  const deleteNodes = useCallback(
    (nodeIds: readonly string[]) => {
      const next = cloneSnapshot(snapshotRef.current);
      const doomed = new Set(nodeIds);
      if (doomed.size === 0) return;
      commit({
        definition: {
          ...next.definition,
          nodes: next.definition.nodes.filter((candidate) => !doomed.has(candidate.id)),
          edges: next.definition.edges.filter((edge) => !doomed.has(edge.from) && !doomed.has(edge.to)),
        },
        layout: next.layout,
      });
    },
    [commit],
  );

  const addEdge = useCallback(
    (edge: WorkflowEdge) => {
      const next = cloneSnapshot(snapshotRef.current);
      if (next.definition.edges.some((candidate) => edgeKey(candidate) === edgeKey(edge))) return;
      commit({
        definition: { ...next.definition, edges: [...next.definition.edges, edge] },
        layout: next.layout,
      });
    },
    [commit],
  );

  const deleteEdges = useCallback(
    (edgeIds: readonly string[]) => {
      const next = cloneSnapshot(snapshotRef.current);
      const doomed = new Set(edgeIds);
      if (doomed.size === 0) return;
      commit({
        definition: { ...next.definition, edges: next.definition.edges.filter((edge) => !doomed.has(edgeKey(edge))) },
        layout: next.layout,
      });
    },
    [commit],
  );

  const updatePositions = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      const next = cloneSnapshot(snapshotRef.current);
      commit({ definition: next.definition, layout: { ...next.layout, positions: { ...next.layout.positions, ...positions } } });
    },
    [commit],
  );

  const updateViewport = useCallback(
    (viewport: CanvasLayout['viewport']) => {
      const next = cloneSnapshot(snapshotRef.current);
      snapshotRef.current = { definition: next.definition, layout: { ...next.layout, viewport } };
      setSnapshot(snapshotRef.current);
      writeLocalDraft(workflowId, snapshotRef.current);
    },
    [workflowId],
  );

  const updateMeta = useCallback(
    (patch: { name?: string; description?: string; enabled?: boolean }) => {
      const next = cloneSnapshot(snapshotRef.current);
      commit({
        definition: { ...next.definition, ...patch },
        layout: next.layout,
      });
    },
    [commit],
  );

  const reset = useCallback(
    (next: BuilderSnapshot, opts?: { clean?: boolean }) => {
      const cloned = cloneSnapshot(next);
      pastRef.current = [];
      futureRef.current = [];
      lastKeyRef.current = null;
      snapshotRef.current = cloned;
      setSnapshot(cloned);
      setHistoryTick((tick) => tick + 1);
      if (opts?.clean) {
        // A clean snapshot is the server's own state, so there is nothing to
        // recover: leaving a mirror here is what made every load offer to
        // restore a draft that was never unsaved in the first place.
        clearLocalDraft(workflowId);
      }
    },
    [workflowId],
  );

  const markSaved = useCallback(() => {
    writeLocalDraft(workflowId, snapshotRef.current);
  }, [workflowId]);

  const undo = useCallback(() => {
    const previous = pastRef.current.at(-1);
    if (!previous) return;
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [cloneSnapshot(snapshotRef.current), ...futureRef.current].slice(0, HISTORY_LIMIT);
    snapshotRef.current = cloneSnapshot(previous);
    setSnapshot(snapshotRef.current);
    setHistoryTick((tick) => tick + 1);
    writeLocalDraft(workflowId, snapshotRef.current);
    lastKeyRef.current = null;
  }, [workflowId]);

  const redo = useCallback(() => {
    const next = futureRef.current[0];
    if (!next) return;
    futureRef.current = futureRef.current.slice(1);
    pastRef.current = [...pastRef.current, cloneSnapshot(snapshotRef.current)];
    snapshotRef.current = cloneSnapshot(next);
    setSnapshot(snapshotRef.current);
    setHistoryTick((tick) => tick + 1);
    writeLocalDraft(workflowId, snapshotRef.current);
    lastKeyRef.current = null;
  }, [workflowId]);

  return useMemo(
    () => ({
      snapshot,
      canUndo: pastRef.current.length > 0,
      canRedo: futureRef.current.length > 0,
      addNode,
      updateNode,
      deleteNodes,
      addEdge,
      deleteEdges,
      updatePositions,
      updateViewport,
      updateMeta,
      reset,
      markSaved,
      undo,
      redo,
    }),
    // historyTick re-renders consumers when only the undo stacks changed.
    [snapshot, historyTick, addNode, updateNode, deleteNodes, addEdge, deleteEdges, updatePositions, updateViewport, updateMeta, reset, markSaved, undo, redo],
  );
}

export function serializeSnapshot(snapshot: BuilderSnapshot): string {
  return JSON.stringify({ definition: snapshot.definition, layout: snapshot.layout });
}
