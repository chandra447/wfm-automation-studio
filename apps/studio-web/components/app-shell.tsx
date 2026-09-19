'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { demoActors, useDemoActor } from './demo-actor-provider';
import { cn } from '@/lib/utils';

const links = [
  { href: '/', label: 'Overview' },
  { href: '/builder', label: 'Workflow builder' },
  { href: '/triggers', label: 'Triggers' },
  { href: '/runs', label: 'Runs' },
  { href: '/approvals', label: 'Approvals' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { actor, setActorId } = useDemoActor();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-6 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-6 py-3">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--color-primary)]" />
          <span className="text-sm font-semibold tracking-tight">WFM Automation Studio</span>
        </div>

        <nav className="flex items-center gap-1">
          {links.map((link) => {
            const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]',
                  active && 'bg-[var(--color-surface-raised)] text-[var(--color-ink)]',
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <label className="text-xs text-[var(--color-ink-faint)]" htmlFor="demo-actor">
            Acting as
          </label>
          <select
            id="demo-actor"
            value={actor.id}
            onChange={(event) => setActorId(event.target.value)}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-xs text-[var(--color-ink)]"
          >
            {demoActors.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}
