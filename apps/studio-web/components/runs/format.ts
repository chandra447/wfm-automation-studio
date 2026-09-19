/** Formatting helpers shared by the runs and approvals surfaces. */

const currencyFormatter = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
});

export function formatCents(cents: number): string {
  return currencyFormatter.format(cents / 100);
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatDuration(startedAt: string, finishedAt: string | null, now = Date.now()): string {
  const started = new Date(startedAt).getTime();
  const ended = finishedAt === null ? now : new Date(finishedAt).getTime();
  const seconds = Math.max(0, Math.round((ended - started) / 1000));
  if (seconds < 1) return '<1s';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

export function formatCountdown(targetIso: string, now = Date.now()): string {
  const ms = new Date(targetIso).getTime() - now;
  if (ms <= 0) return 'expired';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m remaining`;
  }
  if (minutes > 0) return `${minutes}m ${seconds}s remaining`;
  return `${seconds}s remaining`;
}
