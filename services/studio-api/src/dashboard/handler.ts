import { parseActorContext, type Dashboard } from '@wfm/contracts';
import { connectStudioDb, type StudioDb } from '../engine/db.ts';
import { loadDashboard } from './queries.ts';

/**
 * Transport for `GET /dashboard`: the actor comes from the request headers and
 * decides the tenant, exactly as every other route does. The connection is
 * process-wide and shared with whatever else reads the studio database.
 */

let studio: StudioDb | undefined;

function studioDb(): StudioDb {
  if (studio === undefined) {
    const url = process.env.STUDIO_DATABASE_URL;
    if (!url) throw new Error('STUDIO_DATABASE_URL is required');
    studio = connectStudioDb(url);
  }
  return studio;
}

export async function dashboardHandler(headers: Record<string, string | undefined>): Promise<Dashboard> {
  const actor = parseActorContext(headers);
  return loadDashboard(studioDb().db, actor.tenantId);
}
