'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Demo actor switching. Approvals are role-checked on the server; this lets the
 * reviewer prove it by acting as someone without the role.
 */
export interface DemoActor {
  id: string;
  label: string;
  userId: string;
  roles: string[];
  employeeId?: string;
}

export const demoActors: DemoActor[] = [
  { id: 'roster-manager', label: 'Sam Whitfield, Roster Manager', userId: 'manager@demo.test', roles: ['roster_manager'] },
  { id: 'operations-lead', label: 'Dana Okoro, Operations Lead', userId: 'ops.lead@demo.test', roles: ['operations_lead'] },
  { id: 'people-ops', label: 'Ravi Menon, People Ops', userId: 'people-ops@demo.test', roles: ['people_ops'] },
  {
    id: 'employee',
    label: 'Marcus Webb, Registered Nurse',
    userId: 'marcus.webb@demo.test',
    roles: ['employee'],
    employeeId: '44444444-4444-4444-8444-000000000003',
  },
];

export interface ActorContextValue {
  actor: DemoActor;
  setActorId: (id: string) => void;
  headers: Record<string, string>;
}

const ActorContext = createContext<ActorContextValue | null>(null);
const STORAGE_KEY = 'wfm.demo.actor';

export function DemoActorProvider({ children }: { children: ReactNode }) {
  const [actorId, setActorId] = useState<string>(demoActors[0]?.id ?? 'roster-manager');

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && demoActors.some((candidate) => candidate.id === stored)) setActorId(stored);
  }, []);

  const select = useCallback((id: string) => {
    setActorId(id);
    window.localStorage.setItem(STORAGE_KEY, id);
  }, []);

  const value = useMemo<ActorContextValue>(() => {
    const actor = demoActors.find((candidate) => candidate.id === actorId) ?? demoActors[0]!;
    return {
      actor,
      setActorId: select,
      headers: {
        'x-tenant-id': process.env.NEXT_PUBLIC_TENANT_ID ?? '11111111-1111-4111-8111-111111111111',
        'x-user-id': actor.userId,
        'x-user-roles': actor.roles.join(','),
        ...(actor.employeeId ? { 'x-employee-id': actor.employeeId } : {}),
      },
    };
  }, [actorId, select]);

  return <ActorContext.Provider value={value}>{children}</ActorContext.Provider>;
}

export function useDemoActor(): ActorContextValue {
  const context = useContext(ActorContext);
  if (!context) throw new Error('useDemoActor must be used inside DemoActorProvider');
  return context;
}
