const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1_440;

/** Nothing resolved yet reads as "—", never as "0m", which would claim it was instant. */
export function formatDuration(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes >= MINUTES_PER_DAY) return `${Math.round(minutes / MINUTES_PER_DAY)}d`;
  if (minutes >= MINUTES_PER_HOUR) return `${Math.round(minutes / MINUTES_PER_HOUR)}h`;
  return `${Math.round(minutes)}m`;
}
