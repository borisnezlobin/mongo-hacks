import { API_BASE_URL } from './config';

/**
 * One place that knows how to build a URL against the server.
 *
 * There were four of these — the REST client, the websocket builder, the enrollment
 * upload, and the Amelia audio player each joined paths their own way, so a trailing
 * slash in EXPO_PUBLIC_API_URL broke a different one each time.
 *
 * The host is mutable because the app discovers which of several candidate
 * addresses actually answers (see discoverApiBase). Everything routes through
 * here, so the whole app moves at once when it does.
 */

let activeBase = API_BASE_URL;

export function getApiBase(): string {
  return activeBase;
}

export function setApiBase(base: string): void {
  activeBase = base.replace(/\/+$/, '');
}

export function apiUrl(path: string, params?: Record<string, string | undefined>): string {
  const base = activeBase.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  if (!params) return `${base}${suffix}`;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, value);
  const query = search.toString();
  return query ? `${base}${suffix}?${query}` : `${base}${suffix}`;
}

/** Absolute URLs (an S3 link for Amelia's audio) pass through untouched. */
export function resolveUrl(candidate: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : apiUrl(candidate);
}

export function streamUrl(base: string = activeBase): string {
  return `${base.replace(/^http/, 'ws').replace(/\/+$/, '')}/stream`;
}
