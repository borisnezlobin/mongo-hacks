const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDay(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dayDelta = Math.floor((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - startOfToday) / 86_400_000);
  if (dayDelta === 0) return 'Today';
  if (dayDelta === -1) return 'Yesterday';
  if (dayDelta === 1) return 'Tomorrow';
  if (dayDelta < 0 && dayDelta > -7) return `${-dayDelta} days ago`;
  if (dayDelta > 0 && dayDelta < 7) return `In ${dayDelta} days`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const suffix = hours >= 12 ? 'pm' : 'am';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${minutes} ${suffix}`;
}

export function formatDue(iso: string | undefined): string {
  if (!iso) return 'No date yet';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'No date yet';
  const minutesAway = Math.round((date.getTime() - Date.now()) / 60_000);
  if (minutesAway <= 0) return 'Due now';
  if (minutesAway < 60) return `In ${minutesAway} min`;
  const day = formatDay(iso);
  return day === 'Today' ? `Today, ${formatTime(iso)}` : `${day}, ${formatTime(iso)}`;
}

export function formatDuration(startIso: string, endIso?: string): string {
  if (!endIso) return '';
  const minutes = Math.max(1, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000));
  return `${minutes} min`;
}

/** m:ss. The recording clock and the transcript's turn offsets are the same format. */
export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

export function formatOffset(milliseconds: number): string {
  return formatClock(milliseconds / 1000);
}

export function attributeLabel(attribute: string): string {
  const spaced = attribute.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

/**
 * How long ago, in the words a person would use.
 *
 * The presence card says "Last talked 3 weeks ago", so this has to round to
 * something a glance can read. Precision past the largest unit is noise: a
 * caption reading "24 days and 6 hours ago" tells the owner nothing they were
 * asking about.
 */
export function formatAgo(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const elapsed = now - then;
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < 2 * DAY) return 'yesterday';
  if (elapsed < WEEK) return plural(Math.floor(elapsed / DAY), 'day');
  if (elapsed < MONTH) return plural(Math.floor(elapsed / WEEK), 'week');
  if (elapsed < YEAR) return plural(Math.floor(elapsed / MONTH), 'month');
  return plural(Math.floor(elapsed / YEAR), 'year');
}
