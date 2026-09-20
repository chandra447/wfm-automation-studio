'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useOnSelectionChange,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type Node,
  type NodeTypes,
  type XYPosition,
} from '@xyflow/react';
import { ChatCircle, CornersOut, GearSix, ListChecks, Minus, Plus, SquaresFour } from '@phosphor-icons/react';
import {
  demoWorkflows,
  edgeRefusal,
  emptyLayout,
  validateWorkflow,
  workflowNodeTypeSchema,
  type CanvasLayout,
  type Diagnostic,
  type EdgePort,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from '@wfm/workflows';
import Link from 'next/link';
import { apiFetch, ApiFailure } from '@/lib/api';
import { useDemoActor } from '@/components/demo-actor-provider';
import { Button } from '@/components/ui/button';
import { BuilderNode, BuilderNodeProvider } from './builder-node';
import { ChatPanel } from './chat-panel';
import { type ControlOption, type OptionSources } from './control-options';
import { DataPalette } from './data-palette';
import { DiagnosticsPanel } from './diagnostics-panel';
import { TemplateFieldProvider, useTemplateFields } from './field-renderer';
import { Inspector } from './inspector';
import { Palette } from './palette';
import { BuilderShell, FloatingPanel, type RailItem, type ShellPanel } from './shell';
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
  NODE_SIZE,
  nextNodeId,
  readLocalDraft,
  clearLocalDraft,
  createFlowNodeCache,
  toFlowEdges,
  toFlowNodes,
  type BuilderFlowNode,
  type BuilderSnapshot,
} from './state';
import { serializeSnapshot, useBuilderStore } from './use-builder-store';
import {
  diagnosticsFromDetails,
  toSaveBody,
  type ModelDescriptor,
  type TriggerDescriptor,
  type WorkflowDetail,
  type WorkflowMutationResult,
} from './api-types';

const NODE_TYPES: NodeTypes = { wfm: BuilderNode };

/**
 * The minimap is handed React Flow's raw node data rather than a
 * `BuilderFlowNode`, so the kind is narrowed before it picks an accent.
 */
function minimapColor(node: Node): string {
  const data = node.data.node;
  if (typeof data !== 'object' || data === null || !('type' in data)) return accentVarByNodeType.end;
  const parsed = workflowNodeTypeSchema.safeParse(data.type);
  return accentVarByNodeType[parsed.success ? parsed.data : 'end'];
}

/** The data catalogue is a tool for template fields, so it appears with one. */
function TemplateDataPanel(props: {
  eventType: string;
  triggerEvents: readonly ControlOption[];
  headers: Record<string, string>;
}) {
  const { active } = useTemplateFields();
  if (active === null) return null;
  return (
    <div className="flex max-h-[45vh] min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-2xl shadow-black/50 [&>aside]:min-h-0 [&>aside]:shrink [&>aside]:border-l-0">
      <DataPalette {...props} />
    </div>
  );
}

function SelectionSync({ onSelect }: { onSelect: (nodeId: string | null) => void }) {
  useOnSelectionChange({
    onChange: ({ nodes }) => onSelect(nodes.length === 1 ? nodes[0]!.id : null),
  });
  return null;
}

/**
 * The zoom readout lives in the shell's bottom-right slot, which is outside
 * `<ReactFlow>` but inside its provider — the viewport hook reads the same
 * store the canvas writes, so the percentage tracks every pan and wheel event.
 */
function ZoomControl() {
  const { zoom } = useViewport();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const buttonClass = 'rounded-md text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]';
  return (
    <div className="flex items-center gap-0.5 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-1 shadow-2xl shadow-black/50">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom out"
        className={buttonClass}
        onClick={() => void zoomOut()}
      >
        <Minus />
      </Button>
      <span className="w-11 text-center text-[11px] tabular-nums text-[var(--color-ink-muted)]">
        {Math.round(zoom * 100)}%
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom in"
        className={buttonClass}
        onClick={() => void zoomIn()}
      >
        <Plus />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Fit view"
        className={buttonClass}
        onClick={() => void fitView({ duration: 200, padding: 0.2 })}
      >
        <CornersOut />
      </Button>
    </div>
  );
}

/**
 * Focus is an agent affordance rather than a selection: a turn that asks the
 * canvas to point at nodes frames them and changes nothing else. Like the zoom
 * readout it reads the store the canvas writes, so it sits inside the provider,
 * and `fitView` resolves once the nodes are measured, so a turn that also
 * created them still lands.
 */
function FocusViewport({ nodeIds }: { nodeIds: readonly string[] }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (nodeIds.length === 0) return;
    void fitView({ nodes: nodeIds.map((id) => ({ id })), duration: 400, padding: 0.3 });
  }, [nodeIds, fitView]);
  return null;
}

function Banner({ tone, children }: { tone: 'warning' | 'danger'; children: ReactNode }) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2 text-xs shadow-2xl shadow-black/50"
      style={{
        backgroundColor: tone === 'warning' ? 'var(--color-warning-soft)' : 'var(--color-danger-soft)',
        borderColor: tone === 'warning' ? 'var(--color-warning)' : 'var(--color-danger)',
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
  sources,
  viewportSeed,
  initialViewport,
  selectedId,
  onSelectNode,
  onAddNodeType,
  onConnect,
  onNodesDelete,
  onEdgesDelete,
  onNodeDragStop,
  onNodeChange,
  onViewportChange,
  connectionAllowed,
}: {
  flowNodes: BuilderFlowNode[];
  flowEdges: Edge[];
  sources: OptionSources;
  viewportSeed: string;
  initialViewport: CanvasLayout['viewport'];
  selectedId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onAddNodeType: (nodeType: WorkflowNodeType, position: XYPosition) => void;
  onConnect: (edge: WorkflowEdge) => void;
  onNodesDelete: (nodeIds: string[]) => void;
  onEdgesDelete: (edgeIds: string[]) => void;
  onNodeDragStop: (moves: Record<string, XYPosition>) => void;
  onNodeChange: (node: WorkflowNode, coalesceKey?: string) => void;
  onViewportChange: (viewport: CanvasLayout['viewport']) => void;
  /** Whether a drag may land. The rule is the DSL's, so it is asked once, above. */
  connectionAllowed: (connection: Connection | Edge) => boolean;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData('application/wfm-node-type');
    const parsedType = workflowNodeTypeSchema.safeParse(raw);
    if (!parsedType.success) return;
    const bounds = wrapperRef.current?.getBoundingClientRect();
    const position = screenToFlowPosition({
      x: (bounds?.left ?? 0) + (bounds?.width ?? window.innerWidth) / 2 - NODE_SIZE.width / 2,
      y: (bounds?.top ?? 0) + (bounds?.height ?? window.innerHeight) / 2 - NODE_SIZE.height / 2,
    });
    onAddNodeType(parsedType.data, position);
  };

  return (
    <div
      ref={wrapperRef}
      className="relative h-full min-h-0 w-full"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={handleDrop}
    >
      {/* The card edits its own fields, so it needs the field options and the
          store's write path; the canvas supplies both through the provider. */}
      <BuilderNodeProvider sources={sources} onChange={onNodeChange}>
        <ReactFlow
          key={viewportSeed}
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          defaultViewport={initialViewport}
          deleteKeyCode={['Backspace', 'Delete']}
          isValidConnection={connectionAllowed}
          onConnect={(connection: Connection) => {
            const { source, target, sourceHandle } = connection;
            if (!source || !target || source === target) return;
            const port: EdgePort = isEdgePort(sourceHandle) ? sourceHandle : 'always';
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
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="var(--color-canvas-grid)" />
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            style={{ width: 140, height: 92 }}
            nodeColor={minimapColor}
            nodeStrokeWidth={0}
          />
          <SelectionSync onSelect={onSelectNode} />
        </ReactFlow>
      </BuilderNodeProvider>
      {selectedId === null && (
        <p className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-[10px] text-[var(--color-ink-faint)] shadow-lg">
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
  // The agent's highlight, deliberately apart from `selectedId`: pointing at a
  // node must not open the inspector, and the author's next click clears it.
  const [focusedIds, setFocusedIds] = useState<readonly string[]>([]);
  const [restoreOffer, setRestoreOffer] = useState<{ savedAt: number; snapshot: BuilderSnapshot } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [serverDiagnostics, setServerDiagnostics] = useState<readonly Diagnostic[] | null>(null);
  const [savedSerialized, setSavedSerialized] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [triggerEvents, setTriggerEvents] = useState<readonly ControlOption[]>([]);
  const [models, setModels] = useState<readonly ControlOption[]>([]);
  // Closed by default: the pill states the count, and the list is there when
  // the author asks for it rather than covering the graph on every load.
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  // No panel open on load: the rail is the invitation, and the graph is what
  // the author came to look at.
  const [panelId, setPanelId] = useState<string | null>(null);
  // Closing the inspector hides it without clearing the selection, so the panel
  // remembers which node the author dismissed.
  const [inspectorDismissedFor, setInspectorDismissedFor] = useState<string | null>(null);

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
  // One cache for the life of the page: it is what keeps node identities stable
  // across the re-renders that would otherwise un-initialise the canvas.
  const flowNodeCache = useRef(createFlowNodeCache());
  const flowNodes = useMemo(
    () => toFlowNodes(snapshot.definition, snapshot.layout, grouped, selectedId, flowNodeCache.current, focusedIds),
    [snapshot, grouped, selectedId, focusedIds],
  );
  const flowEdges = useMemo(() => toFlowEdges(snapshot.definition), [snapshot.definition]);
  const selectedNode: WorkflowNode | null = useMemo(
    () => snapshot.definition.nodes.find((candidate) => candidate.id === selectedId) ?? null,
    [snapshot.definition, selectedId],
  );
  const sources = useMemo<OptionSources>(() => ({ triggerEvents, models }), [triggerEvents, models]);
  const triggerEventType = useMemo(() => {
    const trigger = snapshot.definition.nodes.find((node) => node.type === 'trigger');
    return trigger && trigger.type === 'trigger' ? trigger.config.eventType : defaultEventType();
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
        // Read the mirror before adopting the server baseline: a clean reset
        // clears it, so reading afterwards would silently drop a draft that a
        // previous session never managed to save.
        const local = readLocalDraft(workflowId);
        if (local && local.savedAt > Date.parse(detail.workflow.updatedAt) + 2_000) {
          setRestoreOffer({ savedAt: local.savedAt, snapshot: local.snapshot });
        }
        storeRef.current.reset(baseSnapshot, { clean: true });
        setSavedSerialized(serializeSnapshot(baseSnapshot));
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
        setTriggerEvents(triggers.map((trigger) => ({ value: trigger.eventType, label: trigger.eventType })));
      } catch {
        if (!alive) return;
        setTriggerEvents([{ value: defaultEventType(), label: defaultEventType() }]);
      }
    })();
    void (async () => {
      try {
        const catalogue = await apiFetch<ModelDescriptor[]>('/models', { headers: headersRef.current });
        if (!alive) return;
        setModels(catalogue.map((model) => ({ value: model.id, label: `${model.label} · ${model.provider}` })));
      } catch {
        if (!alive) return;
        setModels([]);
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

  /**
   * Whether a drag may land. The rule is the DSL's, so the canvas asks it
   * rather than keeping its own copy: a port carries one target, a trigger
   * takes no input, and an end node emits nothing. `ignore` is the edge being
   * re-checked, which must not refuse itself.
   */
  const connectionAllowed = useCallback(
    (connection: Connection | Edge): boolean => {
      const { source, target, sourceHandle } = connection;
      if (!source || !target) return false;
      const port: EdgePort = isEdgePort(sourceHandle) ? sourceHandle : 'always';
      const candidate = { from: source, to: target, port };
      return edgeRefusal(snapshot.definition, candidate, { ignore: candidate }) === null;
    },
    [snapshot.definition],
  );

  const selectNode = useCallback((nodeId: string | null) => {
    setSelectedId(nodeId);
    setInspectorDismissedFor(null);
    // The author's own selection takes over from the agent's highlight, so the
    // canvas never carries a stale one behind a fresh inspector. Keeping the
    // reference when there is nothing to clear spares a canvas re-render.
    setFocusedIds((current) => (current.length === 0 ? current : []));
  }, []);

  const deleteNode = useCallback((nodeId: string) => {
    storeRef.current.deleteNodes([nodeId]);
    setSelectedId((current) => (current === nodeId ? null : current));
  }, []);

  /** Palette clicks land where the old docked column put them: mid-canvas. */
  const addNodeAtViewport = useCallback(
    (nodeType: WorkflowNodeType) => {
      const current = storeRef.current.snapshot;
      const id = nextNodeId(current.definition.nodes.map((node) => node.id), nodeType);
      const viewport = current.layout.viewport;
      storeRef.current.addNode(
        { ...defaultNode(nodeType), id },
        { x: (-viewport.x + 360) / viewport.zoom, y: (-viewport.y + 240) / viewport.zoom },
      );
      selectNode(id);
    },
    [selectNode],
  );

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

  const rail: readonly RailItem[] = [
    { id: 'nodes', label: 'Nodes', icon: SquaresFour },
    { id: 'chat', label: 'Chat', icon: ChatCircle },
    { id: 'logs', label: 'Validation', icon: ListChecks, badge: errorCount },
    { id: 'meta', label: 'Workflow settings', icon: GearSix, group: 'bottom' },
  ];
  const activeRail = [panelId, diagnosticsOpen ? 'logs' : null].filter((id): id is string => id !== null);

  const panels: readonly ShellPanel[] = [
    { id: 'nodes', title: 'Nodes', content: <Palette disabled={!loaded} onAdd={addNodeAtViewport} /> },
    {
      id: 'chat',
      title: 'Chat',
      content: (
        <ChatPanel
          workflowId={workflowId}
          headers={headers}
          snapshot={snapshot}
          eventType={triggerEventType}
          disabled={!loaded || offline}
          onApplied={(next, nextDiagnostics, focus) => {
            // The agent's graph is unsaved work like any other edit, so it is
            // mirrored and the previous graph stays undoable.
            store.applyExternal(next);
            setServerDiagnostics(null);
            // Pointing is not selecting: the ring and the frame are the whole
            // affordance, so the inspector and `selectedId` stay untouched.
            setFocusedIds(focus.nodeIds);
            if (nextDiagnostics.length > 0) setDiagnosticsOpen(true);
          }}
        />
      ),
    },
    {
      id: 'meta',
      title: 'Workflow',
      content: (
        <Inspector
          node={null}
          definition={snapshot.definition}
          sources={sources}
          onChange={store.updateNode}
          onMetaChange={store.updateMeta}
          onDeleteNode={deleteNode}
        />
      ),
    },
  ];

  const inspectorOpen = selectedNode !== null && selectedId !== inspectorDismissedFor;

  return (
    <TemplateFieldProvider>
      <ReactFlowProvider>
        <BuilderShell
          rail={rail}
          active={activeRail}
          onActivate={(id) => {
            if (id === 'logs') {
              setDiagnosticsOpen((open) => !open);
              return;
            }
            setPanelId((current) => (current === id ? null : id));
          }}
          onAddNode={() => addNodeAtViewport('action')}
          panels={panels}
          activePanel={panelId}
          onClosePanel={() => setPanelId(null)}
          topBar={
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
          }
          banners={
            <>
              {restoreOffer !== null && !conflict && (
                <Banner tone="warning">
                  <span>
                    A newer local draft from {new Date(restoreOffer.savedAt).toLocaleTimeString()} was found on this
                    machine.
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
                  <span>
                    Studio API unreachable — editing a local copy of the template; nothing is saved to the server.
                  </span>
                </Banner>
              )}
            </>
          }
          bottomLeft={
            <DiagnosticsPanel
              diagnostics={serverDiagnostics ? [...serverDiagnostics, ...diagnostics] : diagnostics}
              open={diagnosticsOpen}
              onToggle={() => setDiagnosticsOpen((open) => !open)}
              onSelectNode={selectNode}
              hasServerRejection={serverDiagnostics !== null && serverDiagnostics.length > 0}
            />
          }
          bottomRight={
            <>
              <ZoomControl />
              <FocusViewport nodeIds={focusedIds} />
            </>
          }
          side={
            <>
              {inspectorOpen && (
                <FloatingPanel title="Node" onClose={() => setInspectorDismissedFor(selectedId)}>
                  <Inspector
                    node={selectedNode}
                    definition={snapshot.definition}
                    sources={sources}
                    onChange={store.updateNode}
                    onMetaChange={store.updateMeta}
                    onDeleteNode={deleteNode}
                  />
                </FloatingPanel>
              )}
              {/* The data palette is not ours to restyle, so the shell frames it
                  as-is: the wrapper clips its square edges into the floating
                  card and lets it shrink so its own scroll region still works. */}
              <TemplateDataPanel eventType={triggerEventType} triggerEvents={triggerEvents} headers={headers} />
            </>
          }
        >
          <FlowCanvas
            flowNodes={flowNodes}
            flowEdges={flowEdges}
            sources={sources}
            viewportSeed={offline ? `offline:${workflowId}` : loaded ? `loaded:${workflowId}` : 'pending'}
            initialViewport={snapshot.layout.viewport}
            selectedId={selectedId}
            onSelectNode={selectNode}
            onAddNodeType={(nodeType, position) => {
              const id = nextNodeId(snapshot.definition.nodes.map((node) => node.id), nodeType);
              store.addNode({ ...defaultNode(nodeType), id }, position);
              selectNode(id);
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
            onNodeChange={store.updateNode}
            onViewportChange={store.updateViewport}
            connectionAllowed={connectionAllowed}
          />
        </BuilderShell>
      </ReactFlowProvider>
    </TemplateFieldProvider>
  );
}
