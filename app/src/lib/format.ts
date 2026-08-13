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

export function attributeLabel(attribute: string): string {
  const spaced = attribute.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
