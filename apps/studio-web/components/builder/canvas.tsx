'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useOnSelectionChange,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeTypes,
  type XYPosition,
} from '@xyflow/react';
import {
  demoWorkflows,
  emptyLayout,
  validateWorkflow,
  workflowNodeTypeSchema,
  type CanvasLayout,
  type EdgePort,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from '@wfm/workflows';
import Link from 'next/link';
import { apiFetch, ApiFailure } from '@/lib/api';
import { useDemoActor } from '@/components/demo-actor-provider';
import { Button } from '@/components/ui/button';
import { BuilderNode } from './builder-node';
import { DiagnosticsPanel } from './diagnostics-panel';
import { Inspector, type TriggerEventOption } from './inspector';
import { Palette } from './palette';
import { Toolbar, type SaveState } from './toolbar';
import {
  accentVarByNodeType,
  defaultEventType,
  defaultNode,
  demoTemplateId,
  diagnosticsByNode,
  edgeKey,
  emptyDefinitionFor,
  isEdgePort,
  legalPortsFor,
  nextNodeId,
  readLocalDraft,
  clearLocalDraft,
  toFlowEdges,
  toFlowNodes,
  type BuilderFlowNode,
  type BuilderSnapshot,
} from './state';
import { serializeSnapshot, useBuilderStore } from './use-builder-store';
import {
  diagnosticsFromDetails,
  toSaveBody,
  type TriggerDescriptor,
  type WorkflowDetail,
  type WorkflowMutationResult,
} from './api-types';

const NODE_TYPES: NodeTypes = { wfm: BuilderNode };

function SelectionSync({ onSelect }: { onSelect: (nodeId: string | null) => void }) {
  useOnSelectionChange({
    onChange: ({ nodes }) => onSelect(nodes.length === 1 ? nodes[0]!.id : null),
  });
  return null;
}

function Banner({ tone, children }: { tone: 'warning' | 'danger'; children: ReactNode }) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 px-4 py-2 text-xs"
      style={{
        backgroundColor: tone === 'warning' ? 'var(--color-warning-soft)' : 'var(--color-danger-soft)',
        color: tone === 'warning' ? 'var(--color-warning)' : 'var(--color-danger)',
      }}
    >
      {children}
    </div>
  );
}

function FlowCanvas({
  flowNodes,
  flowEdges,
  nodeTypeById,
  selectedId,
  onSelectNode,
  onAddNodeType,
  onConnect,
  onNodesDelete,
  onEdgesDelete,
  onNodeDragStop,
  onViewportChange,
}: {
  flowNodes: BuilderFlowNode[];
  flowEdges: Edge[];
  nodeTypeById: Record<string, WorkflowNodeType>;
  selectedId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onAddNodeType: (nodeType: WorkflowNodeType, position: XYPosition) => void;
  onConnect: (edge: WorkflowEdge) => void;
  onNodesDelete: (nodeIds: string[]) => void;
  onEdgesDelete: (edgeIds: string[]) => void;
  onNodeDragStop: (moves: Record<string, XYPosition>) => void;
  onViewportChange: (viewport: CanvasLayout['viewport']) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const connectionAllowed = useCallback(
    (connection: Connection | Edge): boolean => {
      const { source, target, sourceHandle } = connection;
      if (!source || !target || source === target) return false;
      const sourceType = nodeTypeById[source];
      const targetType = nodeTypeById[target];
      if (!sourceType || !targetType) return false;
      if (targetType === 'trigger' || sourceType === 'end') return false;
      if (!isEdgePort(sourceHandle ?? 'always')) return false;
      return legalPortsFor(sourceType).includes(isEdgePort(sourceHandle) ? sourceHandle : 'always');
    },
    [nodeTypeById],
  );

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData('application/wfm-node-type');
    const parsedType = workflowNodeTypeSchema.safeParse(raw);
    if (!parsedType.success) return;
    const bounds = wrapperRef.current?.getBoundingClientRect();
    const position = screenToFlowPosition({
      x: (bounds?.left ?? 0) + (bounds?.width ?? window.innerWidth) / 2 - 110,
      y: (bounds?.top ?? 0) + (bounds?.height ?? window.innerHeight) / 2 - 44,
    });
    onAddNodeType(parsedType.data, position);
  };

  return (
    <div
      ref={wrapperRef}
      className="relative min-h-0 min-w-0 flex-1"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={handleDrop}
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        deleteKeyCode={['Backspace', 'Delete']}
        isValidConnection={connectionAllowed}
        onConnect={(connection: Connection) => {
          const { source, target, sourceHandle } = connection;
          if (!source || !target || source === target) return;
          const sourceType = nodeTypeById[source];
          const targetType = nodeTypeById[target];
          if (!sourceType || !targetType) return;
          if (targetType === 'trigger' || sourceType === 'end') return;
          const port: EdgePort = isEdgePort(sourceHandle) ? sourceHandle : 'always';
          if (!legalPortsFor(sourceType).includes(port)) return;
          onConnect({ from: source, to: target, port });
        }}
        onNodesDelete={(deleted) => onNodesDelete(deleted.map((node) => node.id))}
        onEdgesDelete={(deleted) => onEdgesDelete(deleted.map((edge) => edge.id))}
        onNodeDragStop={(_event, _node, draggedNodes) => {
          const moves: Record<string, XYPosition> = {};
          for (const dragged of draggedNodes ?? []) moves[dragged.id] = dragged.position;
          onNodeDragStop(moves);
        }}
        onMoveEnd={(_event, viewport) => onViewportChange(viewport)}
        onPaneClick={() => onSelectNode(null)}
        minZoom={0.3}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="var(--color-canvas-grid)" />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap
          pannable
          zoomable
          position="top-right"
          maskColor="var(--color-canvas)"
          bgColor="var(--color-surface)"
          nodeColor={(node) => {
            const type = (node.data as { node?: { type?: string } }).node?.type;
            const parsed = workflowNodeTypeSchema.safeParse(type);
            return accentVarByNodeType[parsed.success ? parsed.data : 'end'];
          }}
          nodeStrokeWidth={0}
        />
        <SelectionSync onSelect={onSelectNode} />
      </ReactFlow>
      {selectedId === null && (
        <p className="pointer-events-none absolute bottom-4 left-4 rounded-md bg-[var(--color-surface)] px-2 py-1 text-[10px] text-[var(--color-ink-faint)]">
          Select a node to edit · ⌘Z undo · ⌘⇧Z redo · ⌘S save · Delete removes the selection
        </p>
      )}
    </div>
  );
}

export function BuilderCanvasPage({ workflowId }: { workflowId: string }) {
  const { headers } = useDemoActor();
  const templateId = demoTemplateId(workflowId);

  const initial = useMemo<BuilderSnapshot>(() => {
    const template =
      templateId === 'payroll-exception' ? demoWorkflows[1] : templateId === 'coverage-rescue' ? demoWorkflows[0] : null;
    if (template) {
      return { definition: structuredClone(template.definition), layout: structuredClone(template.layout) };
    }
    return { definition: emptyDefinitionFor(defaultEventType()), layout: emptyLayout() };
  }, [templateId]);
  const store = useBuilderStore(workflowId, initial);

  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restoreOffer, setRestoreOffer] = useState<{ savedAt: number; snapshot: BuilderSnapshot } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [serverDiagnostics, setServerDiagnostics] = useState<ReturnType<typeof diagnosticsFromDetails> | null>(null);
  const [savedSerialized, setSavedSerialized] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [triggerEvents, setTriggerEvents] = useState<readonly TriggerEventOption[]>([]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(true);

  const storeRef = useRef(store);
  storeRef.current = store;
  const offlineRef = useRef(false);
  offlineRef.current = offline;
  const conflictRef = useRef(false);
  conflictRef.current = conflict;
  const headersRef = useRef(headers);
  headersRef.current = headers;
  const saveBusyRef = useRef(false);

  const { snapshot } = store;
  const serialized = useMemo(() => serializeSnapshot(snapshot), [snapshot]);
  const serializedRef = useRef(serialized);
  serializedRef.current = serialized;
  const dirty = savedSerialized !== null && serialized !== savedSerialized;
  const diagnostics = useMemo(() => validateWorkflow(snapshot.definition), [snapshot.definition]);
  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const grouped = useMemo(() => diagnosticsByNode(diagnostics), [diagnostics]);
  const flowNodes = useMemo(() => toFlowNodes(snapshot.definition, snapshot.layout, grouped), [snapshot, grouped]);
  const flowEdges = useMemo(() => toFlowEdges(snapshot.definition), [snapshot.definition]);
  const selectedNode: WorkflowNode | null = useMemo(
    () => snapshot.definition.nodes.find((candidate) => candidate.id === selectedId) ?? null,
    [snapshot.definition, selectedId],
  );
  const nodeTypeById = useMemo(() => {
    const table: Record<string, WorkflowNodeType> = {};
    for (const node of snapshot.definition.nodes) table[node.id] = node.type;
    return table;
  }, [snapshot.definition]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const detail = await apiFetch<WorkflowDetail>(`/workflows/${workflowId}`, { headers: headersRef.current });
        if (!alive) return;
        const base = detail.versions.filter((version) => version.status === 'draft').at(-1) ?? detail.versions.at(-1);
        if (!base) {
          setLoadError('The workflow exists but has no saved version yet.');
          return;
        }
        const published = detail.versions
          .filter((version) => version.status === 'published')
          .map((version) => version.versionNumber);
        setPublishedVersion(published.length > 0 ? Math.max(...published) : null);
        const baseSnapshot = { definition: base.definition, layout: base.layout };
        storeRef.current.reset(baseSnapshot, { clean: true });
        setSavedSerialized(serializeSnapshot(baseSnapshot));
        const local = readLocalDraft(workflowId);
        if (local && local.savedAt > Date.parse(detail.workflow.updatedAt) + 2_000) {
          setRestoreOffer({ savedAt: local.savedAt, snapshot: local.snapshot });
        }
        setLoaded(true);
      } catch (error) {
        if (!alive) return;
        if (templateId !== null) {
          setOffline(true);
          setSavedSerialized(serializeSnapshot(storeRef.current.snapshot));
          setLoaded(true);
          return;
        }
        setLoadError(
          error instanceof ApiFailure
            ? error.message
            : 'Studio API is unreachable. Open a template offline from the workflow list.',
        );
      }
    })();
    void (async () => {
      try {
        const triggers = await apiFetch<TriggerDescriptor[]>('/triggers', { headers: headersRef.current });
        if (!alive) return;
        setTriggerEvents(triggers.map((trigger) => ({ eventType: trigger.eventType, owner: trigger.owner })));
      } catch {
        if (!alive) return;
        setTriggerEvents([{ eventType: defaultEventType(), owner: 'local catalogue' }]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workflowId, templateId]);

  const saveNow = useCallback(async () => {
    if (offlineRef.current || conflictRef.current || saveBusyRef.current) return;
    const target = storeRef.current.snapshot;
    saveBusyRef.current = true;
    setSaveBusy(true);
    try {
      await apiFetch<WorkflowMutationResult>(`/workflows/${workflowId}/draft`, {
        method: 'PUT',
        headers: headersRef.current,
        body: toSaveBody(target),
      });
      const saved = serializeSnapshot(target);
      if (serializeSnapshot(storeRef.current.snapshot) === saved) {
        setSavedSerialized(saved);
        setLastSavedAt(Date.now());
      }
      setSaveFailed(false);
      setServerDiagnostics(null);
    } catch (error) {
      if (error instanceof ApiFailure) {
        if (error.status === 409) {
          setConflict(true);
          setDiagnosticsOpen(true);
        } else if (error.status === 422) {
          setServerDiagnostics(diagnosticsFromDetails(error.details));
          setDiagnosticsOpen(true);
        } else {
          setSaveFailed(true);
        }
      } else {
        setSaveFailed(true);
      }
    } finally {
      saveBusyRef.current = false;
      setSaveBusy(false);
    }
  }, []);

  const publishNow = useCallback(async () => {
    if (offlineRef.current || conflictRef.current) return;
    const hasErrors = validateWorkflow(storeRef.current.snapshot.definition).some(
      (diagnostic) => diagnostic.severity === 'error',
    );
    if (hasErrors) return;
    if (serializeSnapshot(storeRef.current.snapshot) !== savedSerialized) await saveNow();
    setPublishing(true);
    try {
      const result = await apiFetch<WorkflowMutationResult>(`/workflows/${workflowId}/publish`, {
        method: 'POST',
        headers: headersRef.current,
      });
      setPublishedVersion(result.versionNumber);
      setServerDiagnostics(null);
    } catch (error) {
      if (error instanceof ApiFailure) {
        if (error.status === 409) setConflict(true);
        else if (error.status === 422) setServerDiagnostics(diagnosticsFromDetails(error.details));
        else setSaveFailed(true);
      } else {
        setSaveFailed(true);
      }
    } finally {
      setPublishing(false);
    }
  }, [savedSerialized, saveNow, workflowId]);

  useEffect(() => {
    if (offlineRef.current || conflictRef.current || savedSerialized === null) return;
    if (serializedRef.current === savedSerialized) return;
    const timer = setTimeout(() => void saveNow(), 1500);
    return () => clearTimeout(timer);
  }, [serialized, savedSerialized, saveNow, offline, conflict]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
      } else if (mod && key === 'y') {
        event.preventDefault();
        store.redo();
      } else if (mod && key === 's') {
        event.preventDefault();
        void saveNow();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [store, saveNow]);

  const restoreDraft = () => {
    if (!restoreOffer) return;
    store.reset(restoreOffer.snapshot);
    setSavedSerialized(null);
    setRestoreOffer(null);
    setConflict(false);
    setServerDiagnostics(null);
  };

  const discardLocalDraft = () => {
    if (!restoreOffer) return;
    clearLocalDraft(workflowId);
    setRestoreOffer(null);
  };

  const reloadFromServer = () => {
    setConflict(false);
    setServerDiagnostics(null);
    setSavedSerialized(null);
    window.location.reload();
  };

  if (loadError !== null && !loaded) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="max-w-md text-sm text-[var(--color-ink-muted)]">{loadError}</p>
        <div className="flex items-center gap-2">
          <Link href="/builder">
            <Button variant="outline" size="sm">
              ← All workflows
            </Button>
          </Link>
          <Link href="/builder/coverage-rescue">
            <Button size="sm">Open the coverage-rescue template offline</Button>
          </Link>
        </div>
      </div>
    );
  }

  const saveState: SaveState = conflict
    ? 'conflict'
    : saveBusy
      ? 'saving'
      : saveFailed
        ? 'failed'
        : dirty || savedSerialized === null
          ? 'dirty'
          : 'clean';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        definition={snapshot.definition}
        saveState={saveState}
        lastSavedAt={lastSavedAt}
        offline={offline}
        publishedVersion={publishedVersion}
        errorCount={errorCount}
        canUndo={store.canUndo}
        canRedo={store.canRedo}
        saving={saveBusy}
        publishing={publishing}
        onRename={(name) => store.updateMeta({ name })}
        onUndo={store.undo}
        onRedo={store.redo}
        onSaveNow={() => void saveNow()}
        onPublish={() => void publishNow()}
      />
      {restoreOffer !== null && !conflict && (
        <Banner tone="warning">
          <span>
            A newer local draft from {new Date(restoreOffer.savedAt).toLocaleTimeString()} was found on this machine.
          </span>
          <Button size="xs" onClick={restoreDraft}>
            Restore draft
          </Button>
          <Button size="xs" variant="ghost" onClick={discardLocalDraft}>
            Discard
          </Button>
        </Banner>
      )}
      {conflict && (
        <Banner tone="danger">
          <span>This workflow changed on the server while you were editing.</span>
          <Button size="xs" variant="outline" onClick={reloadFromServer}>
            Reload from server
          </Button>
        </Banner>
      )}
      {offline && (
        <Banner tone="warning">
          <span>Studio API unreachable — editing a local copy of the template; nothing is saved to the server.</span>
        </Banner>
      )}
      <div className="flex min-h-0 flex-1">
        <Palette
          disabled={!loaded}
          onAdd={(nodeType) => {
            const id = nextNodeId(snapshot.definition.nodes.map((node) => node.id), nodeType);
            const viewport = snapshot.layout.viewport;
            store.addNode(
              { ...defaultNode(nodeType), id },
              { x: (-viewport.x + 360) / viewport.zoom, y: (-viewport.y + 240) / viewport.zoom },
            );
            setSelectedId(id);
          }}
        />
        <ReactFlowProvider>
          <FlowCanvas
            flowNodes={flowNodes}
            flowEdges={flowEdges}
            nodeTypeById={nodeTypeById}
            selectedId={selectedId}
            onSelectNode={setSelectedId}
            onAddNodeType={(nodeType, position) => {
              const id = nextNodeId(snapshot.definition.nodes.map((node) => node.id), nodeType);
              store.addNode({ ...defaultNode(nodeType), id }, position);
              setSelectedId(id);
            }}
            onConnect={(edge) => store.addEdge(edge)}
            onNodesDelete={store.deleteNodes}
            onEdgesDelete={(edgeIds) => {
              const doomed = new Set(edgeIds);
              store.deleteEdges(
                snapshot.definition.edges.filter((edge) => doomed.has(edgeKey(edge))).map((edge) => edgeKey(edge)),
              );
            }}
            onNodeDragStop={store.updatePositions}
            onViewportChange={store.updateViewport}
          />
        </ReactFlowProvider>
        <Inspector
          node={selectedId === null ? null : selectedNode}
          definition={snapshot.definition}
          triggerEvents={triggerEvents}
          onChange={store.updateNode}
          onMetaChange={store.updateMeta}
          onDeleteNode={(nodeId) => {
            store.deleteNodes([nodeId]);
            if (selectedId === nodeId) setSelectedId(null);
          }}
        />
      </div>
      <DiagnosticsPanel
        diagnostics={serverDiagnostics ? [...serverDiagnostics, ...diagnostics] : diagnostics}
        open={diagnosticsOpen}
        onToggle={() => setDiagnosticsOpen((open) => !open)}
        onSelectNode={(nodeId) => setSelectedId(nodeId)}
        hasServerRejection={serverDiagnostics !== null && serverDiagnostics.length > 0}
      />
    </div>
  );
}
