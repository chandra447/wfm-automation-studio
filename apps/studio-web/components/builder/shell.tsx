'use client';

import type { ReactNode } from 'react';
import type { Icon } from '@phosphor-icons/react';
import { Plus, X } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface RailItem {
  id: string;
  label: string;
  icon: Icon;
  /** Count rendered on the button — the validation item carries the error count. */
  badge?: number;
  /** `bottom` items sit below the separator, next to the add action. */
  group?: 'main' | 'bottom';
}

export interface ShellPanel {
  id: string;
  title: string;
  content: ReactNode;
}

export interface FloatingPanelProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

/**
 * The one floating container every builder panel is rendered into. It owns the
 * chrome — rounded corners, border, shadow, header, scroll region — so a panel
 * component renders its body only, and the shell decides where it sits.
 */
export function FloatingPanel({ title, onClose, children, className }: FloatingPanelProps) {
  return (
    <section
      aria-label={title}
      className={cn(
        'flex min-h-0 w-[300px] flex-col overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-2xl shadow-black/50',
        className,
      )}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
        <h2 className="truncate text-xs font-semibold tracking-wide text-[var(--color-ink-faint)] uppercase">
          {title}
        </h2>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Close ${title}`}
          className="-mr-1 shrink-0 rounded-md text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      {/* A definite height for panels that pin their own header or footer (the
          chat composer, the palette's search box): the panel's max height caps
          this box, so the body scrolls once the content outgrows the screen. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </section>
  );
}

function RailButton({ item, active, onClick }: { item: RailItem; active: boolean; onClick: () => void }) {
  const Glyph = item.icon;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={item.label}
      aria-pressed={active}
      title={item.label}
      onClick={onClick}
      className={cn(
        'relative rounded-full',
        active
          ? 'bg-[var(--color-primary-soft)] text-[var(--color-primary)]'
          : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
      )}
    >
      <Glyph />
      {item.badge !== undefined && item.badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-danger)] px-1 text-[9px] font-semibold text-[var(--color-canvas)]">
          {item.badge}
        </span>
      )}
    </Button>
  );
}

export interface BuilderShellProps {
  rail: readonly RailItem[];
  /** Rail ids to tint; a panel and the validation pill can both be active. */
  active: readonly string[];
  onActivate: (id: string) => void;
  onAddNode: () => void;
  /**
   * Every floating panel the rail can show. All of them stay mounted — a panel
   * that owns live state (the chat transcript, the palette's search) must
   * survive a switch to another panel — and only `activePanel` is visible.
   */
  panels: readonly ShellPanel[];
  activePanel: string | null;
  onClosePanel: () => void;
  topBar: ReactNode;
  banners?: ReactNode;
  bottomLeft?: ReactNode;
  bottomRight?: ReactNode;
  /** Floating panels anchored to the right edge, stacked top to bottom. */
  side?: ReactNode;
  /** The canvas. Everything else in this component floats over it. */
  children: ReactNode;
}

/**
 * Builder chrome: the graph fills the content area and every other surface —
 * the rail, its panel, the top bar, the banners, the validation pill, the zoom
 * control, the inspector — floats above it with its own shadow. Nothing is
 * docked, so the canvas keeps the whole screen at every width.
 */
export function BuilderShell({
  rail,
  active,
  onActivate,
  onAddNode,
  panels,
  activePanel,
  onClosePanel,
  topBar,
  banners,
  bottomLeft,
  bottomRight,
  side,
  children,
}: BuilderShellProps) {
  const mainRail = rail.filter((item) => item.group !== 'bottom');
  const bottomRail = rail.filter((item) => item.group === 'bottom');

  return (
    <div className="relative h-[calc(100vh-3.5625rem)] min-h-0 overflow-hidden bg-[var(--color-canvas)]">
      <div className="absolute inset-0">{children}</div>

      {/* Top chrome floats as one column so a banner lands under the top bar
          rather than behind it. The column ignores the pointer; its children
          opt back in, leaving the canvas draggable either side of the bar. */}
      <div className="pointer-events-none absolute inset-x-0 top-3 z-40 flex flex-col gap-2 px-4">
        <div className="pointer-events-auto">{topBar}</div>
        {banners !== undefined && <div className="pointer-events-auto flex flex-col gap-2">{banners}</div>}
      </div>

      <nav
        aria-label="Builder panels"
        className="absolute top-1/2 left-3 z-30 flex w-11 -translate-y-1/2 flex-col items-center gap-1 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-1.5 shadow-2xl shadow-black/50"
      >
        {mainRail.map((item) => (
          <RailButton
            key={item.id}
            item={item}
            active={active.includes(item.id)}
            onClick={() => onActivate(item.id)}
          />
        ))}
        <span aria-hidden className="my-0.5 h-px w-6 bg-[var(--color-border-subtle)]" />
        {bottomRail.map((item) => (
          <RailButton
            key={item.id}
            item={item}
            active={active.includes(item.id)}
            onClick={() => onActivate(item.id)}
          />
        ))}
        <Button
          size="icon"
          aria-label="Add a step"
          title="Add a step"
          className="rounded-full"
          onClick={onAddNode}
        >
          <Plus />
        </Button>
      </nav>

      {/* The left panel stops above the bottom row of chrome. `hidden` rather
          than unmounted so a panel's own state survives every switch. */}
      <div
        className={cn(
          'absolute top-[4.25rem] bottom-[4.5rem] left-[4.5rem] z-20 flex flex-col justify-center',
          activePanel === null && 'hidden',
        )}
      >
        {panels.map((entry) => (
          <FloatingPanel
            key={entry.id}
            title={entry.title}
            onClose={onClosePanel}
            className={cn('max-h-full', entry.id !== activePanel && 'hidden')}
          >
            {entry.content}
          </FloatingPanel>
        ))}
      </div>

      {side !== undefined && (
        <div className="absolute top-[4.25rem] right-4 bottom-[7.5rem] z-20 flex flex-col items-end gap-3">
          {side}
        </div>
      )}

      {bottomLeft !== undefined && <div className="absolute bottom-4 left-4 z-30">{bottomLeft}</div>}
      {bottomRight !== undefined && <div className="absolute right-[11.5rem] bottom-4 z-30">{bottomRight}</div>}
    </div>
  );
}
