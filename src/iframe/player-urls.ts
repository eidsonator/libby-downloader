/**
 * Chapter URL capture for the Libby player iframe.
 *
 * Since late October 2026 Libby sends `-odread-cmpt-params` as an empty array,
 * so chapter URLs can no longer be built from the book data: each one needs a
 * signed `?cmpt=...` query that only the player creates, right before it
 * requests that part. Instead, record the MP3 URLs the player itself requests
 * (from Resource Timing entries, which needs no patching of page code) and
 * match them to chapters by file name.
 */

/** Minimal shape of a Resource Timing entry. */
export interface ResourceEntryLike {
  name: string;
}

/**
 * The decoded file name of a chapter URL or spine path, e.g.
 * `{1434EF84-...}Fmt425-Part01.mp3`. Spine paths arrive percent-encoded and
 * captured URLs carry a query, so both sides are normalised the same way.
 */
export function partKey(urlOrPath: string, base = 'https://listen.libbyapp.com/'): string | null {
  try {
    const file = new URL(urlOrPath, base).pathname.split('/').pop() ?? '';
    const decoded = decodeURIComponent(file);
    return decoded ? decoded : null;
  } catch {
    return null;
  }
}

/** Whether a URL carries a real signed query, not `?undefined` or nothing. */
export function hasSignedQuery(url: string): boolean {
  try {
    const query = new URL(url).search;
    return /^\?.+=.+/.test(query) && !/^\?undefined$/.test(query);
  } catch {
    return false;
  }
}

/**
 * Collects signed MP3 URLs requested from the player's own origin, keyed by
 * part file name. The first URL seen for a part wins.
 */
export class PlayerUrlStore {
  private readonly urls = new Map<string, string>();

  constructor(private readonly origin: string) {}

  record(url: string): void {
    if (!url.startsWith(this.origin + '/') || !/\.mp3(\?|$)/i.test(url)) return;
    if (!hasSignedQuery(url)) return;
    const key = partKey(url, this.origin);
    if (key && !this.urls.has(key)) this.urls.set(key, url);
  }

  recordEntries(entries: Iterable<ResourceEntryLike>): void {
    for (const entry of entries) {
      if (entry && typeof entry.name === 'string') this.record(entry.name);
    }
  }

  /** The captured URL for a spine path, if the player has requested it. */
  urlFor(spinePath: string): string | undefined {
    const key = partKey(spinePath, this.origin);
    return key ? this.urls.get(key) : undefined;
  }

  get size(): number {
    return this.urls.size;
  }
}
