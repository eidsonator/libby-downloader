/**
 * Iframe extractor for Libby Downloader
 * Runs in MAIN world (page context) with direct access to window.BIF
 * Extracts book metadata and chapter URLs from Libby's player
 *
 * Note: This script runs in MAIN world and gets bundled as IIFE by Vite.
 * Types are available at compile time but stripped at runtime.
 */

import type { BookData, BookMetadata, Chapter } from '../types/extension-book';
import { MessageTypes } from '../types/messages';
import { isTrustedParentMessage } from '../shared/validators';
import { PlayerUrlStore } from './player-urls';

// Extend window interface for Libby-specific globals
declare global {
  interface Window {
    BIF?: BIFObject;
    getBIF?: () => Promise<BIFObject>;
  }
}

/** A position in the book: spine index plus the fraction through that part. */
interface BIFPlace {
  seek?: () => void;
}

/**
 * BIF (Book Information File) object from Libby
 */
interface BIFObject {
  map: {
    title: {
      main: string;
      subtitle?: string;
    };
    creator: Array<{
      name: string;
      role: string;
    }>;
    spine: Array<{
      '-odread-original-path': string;
      'audio-duration'?: number;
      duration?: number;
    }>;
    description?: string;
    nav?: {
      toc?: Array<{
        title: string;
        path: string;
      }>;
    };
  };
  objects: {
    spool: {
      components: Array<{
        meta: {
          path: string;
          '-odread-spine-position': number;
          'audio-duration'?: number;
          duration?: number;
        };
        spinePosition: number;
        duration?: number;
      }>;
      focus?: {
        floc?: number;
      };
    };
    compass?: {
      at: (location: { floc: number }) => BIFPlace | null | undefined;
    };
  };
  root?: {
    querySelector: (selector: string) => Element | null;
  };
}

console.log('[Libby Downloader] Iframe script loaded');

// Record the signed chapter URLs the player requests. Resource Timing sees
// every request the page makes, so nothing in the page has to be patched.
// The observer keeps recording after the timing buffer fills; the direct
// read covers anything the observer missed.
const playerUrls = new PlayerUrlStore(location.origin);

function harvestResourceEntries(): void {
  try {
    playerUrls.recordEntries(performance.getEntriesByType('resource'));
  } catch {
    // Resource Timing unavailable: rely on the observer
  }
}

try {
  new PerformanceObserver((list) => playerUrls.recordEntries(list.getEntries())).observe({
    type: 'resource',
    buffered: true,
  });
} catch {
  // PerformanceObserver unavailable: harvestResourceEntries() still works
}

// Listen for extraction requests
window.addEventListener('message', async (event: MessageEvent) => {
  // Only process extraction requests
  if (!event.data || event.data.type !== MessageTypes.EXTRACT_LIBBY_BOOK) return;
  // Only the embedding Libby page may request extraction; the reply carries
  // chapter URLs, so it goes back to that origin alone.
  if (!isTrustedParentMessage(event)) {
    console.warn('[Libby Downloader] Ignoring extraction request from', event.origin);
    return;
  }
  const replyOrigin = event.origin;

  console.log('[Libby Downloader] Extraction requested');

  // Gathering chapter URLs can take a minute; each update tells the parent
  // page that extraction is still going so it doesn't time out.
  const reportProgress = (done: number, total: number): void => {
    window.parent.postMessage(
      { type: MessageTypes.EXTRACTION_PROGRESS, progress: { done, total } },
      replyOrigin
    );
  };

  try {
    // Extract book data
    const bookData = await extractBookData(reportProgress);

    console.log(
      `[Libby Downloader] Extraction complete: "${bookData.metadata.title}" (${bookData.chapters.length} chapters)`
    );

    window.parent.postMessage(
      {
        type: MessageTypes.EXTRACTION_SUCCESS,
        data: bookData,
      },
      replyOrigin
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Libby Downloader] Extraction failed:', error);
    window.parent.postMessage(
      {
        type: MessageTypes.EXTRACTION_ERROR,
        error: errorMessage,
      },
      replyOrigin
    );
  }
});

/**
 * Extract book data from BIF object
 */
async function extractBookData(
  onProgress: (done: number, total: number) => void
): Promise<BookData> {
  // Get BIF object
  const BIF = await getBIF();

  if (!BIF) {
    throw new Error('BIF object not found. The audiobook player may not have loaded properly.');
  }

  // Make the player request every part, so each one has a signed URL
  await gatherPlayerUrls(BIF, onProgress);

  // Extract metadata (null-safe, case-insensitive with fallbacks)
  const creators = BIF.map.creator ?? [];
  const authors = resolveAuthors(creators);
  const narrators = creators.filter((c) => c.role?.toLowerCase() === 'narrator').map((c) => c.name);
  const totalDuration = BIF.map.spine.reduce(
    (sum, spine) => sum + (spine['audio-duration'] || 0),
    0
  );

  let coverUrl = '';
  try {
    const imageElem = BIF.root?.querySelector('image');
    if (imageElem) coverUrl = imageElem.getAttribute('href') || '';
  } catch (e) {
    console.warn('[Libby Downloader] Could not extract cover URL:', e);
  }

  // Extract chapters with full URLs
  const chapters: Chapter[] = [];
  const missingParts: number[] = [];
  let cumulativeTime = 0;

  for (const spine of BIF.objects.spool.components) {
    const url = playerUrls.urlFor(spine.meta.path);
    if (!url) {
      missingParts.push(spine.meta['-odread-spine-position'] + 1);
      continue;
    }

    // Try different possible duration properties (fallback to 0 if not available)
    const duration = spine.meta['audio-duration'] || spine.meta.duration || spine.duration || 0;

    chapters.push({
      index: spine.meta['-odread-spine-position'],
      title: `Part ${spine.meta['-odread-spine-position'] + 1}`,
      url: url,
      duration: duration,
      startTime: cumulativeTime,
    });

    cumulativeTime += duration;
  }

  if (missingParts.length > 0) {
    throw new Error(
      `The player didn't load audio for part ${missingParts.join(', ')} of ` +
        `${BIF.objects.spool.components.length}. Play the book for a few seconds and try again.`
    );
  }

  // Get chapter titles from TOC
  if (BIF.map.nav?.toc) {
    const spineToIndex = BIF.map.spine.map((x) => x['-odread-original-path']);
    for (const tocChapter of BIF.map.nav.toc) {
      const spinePath = tocChapter.path.split('#')[0];
      const spineIndex = spineToIndex.indexOf(spinePath);
      if (spineIndex !== -1 && chapters[spineIndex]) {
        chapters[spineIndex].title = tocChapter.title;
      }
    }
  }

  // Build complete book metadata
  const metadata: BookMetadata = {
    title: BIF.map.title.main,
    authors: authors,
    narrators: narrators,
    duration: Math.round(totalDuration / 60),
    coverUrl: coverUrl,
    description: BIF.map.description,
  };

  // Build complete book data
  return {
    metadata,
    chapters,
  };
}

/**
 * Get BIF object with retry logic
 */
async function getBIF(): Promise<BIFObject | null> {
  let BIF = window.BIF;

  if (!BIF && typeof window.getBIF === 'function') {
    console.log('[Libby Downloader] Calling getBIF()');
    BIF = await window.getBIF();
  }

  if (!BIF) {
    // Poll for BIF
    console.log('[Libby Downloader] Polling for window.BIF');
    for (let i = 0; i < 20; i++) {
      if (window.BIF) {
        BIF = window.BIF;
        console.log(`[Libby Downloader] Found BIF after ${i + 1} attempts`);
        break;
      }
      await sleep(500);
    }
  }

  return BIF || null;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until a check passes, polling every intervalMs, for up to timeoutMs.
 */
async function waitUntil(
  check: () => boolean,
  timeoutMs: number,
  intervalMs: number
): Promise<boolean> {
  for (let waited = 0; waited < timeoutMs; waited += intervalMs) {
    if (check()) return true;
    await sleep(intervalMs);
  }
  return check();
}

/**
 * Make sure the player has requested every part, so each has a signed URL.
 *
 * Parts the player hasn't loaded yet are reached by seeking the player to a
 * random point inside each one, with a short random pause between seeks.
 * The original position is restored afterwards. Parts that still have no URL
 * are reported by the caller.
 */
async function gatherPlayerUrls(
  BIF: BIFObject,
  onProgress: (done: number, total: number) => void
): Promise<void> {
  const components = BIF.objects.spool.components;
  const hasUrl = (path: string): boolean => {
    harvestResourceEntries();
    return playerUrls.urlFor(path) !== undefined;
  };

  const missing = components.filter((c) => !hasUrl(c.meta.path));
  if (missing.length === 0) return;

  const compass = BIF.objects.compass;
  if (!compass || typeof compass.at !== 'function') {
    console.warn('[Libby Downloader] Player has no seek API; using only the parts already loaded');
    return;
  }

  console.log(`[Libby Downloader] Seeking the player through ${missing.length} unloaded parts`);
  const originalFloc = BIF.objects.spool.focus?.floc ?? 0;
  const lastPosition = components.length - 1;

  try {
    for (let i = 0; i < missing.length; i++) {
      const part = missing[i];
      const position = part.meta['-odread-spine-position'];
      onProgress(i + 1, missing.length);

      // Land somewhere inside the part; stay clear of the very end of the book
      const fraction =
        position === lastPosition ? 0.25 + Math.random() * 0.5 : 0.01 + Math.random() * 0.98;
      try {
        compass.at({ floc: position + fraction })?.seek?.();
      } catch (error) {
        console.warn(`[Libby Downloader] Seek to part ${position + 1} failed:`, error);
      }

      await waitUntil(() => hasUrl(part.meta.path), 3000, 100);
      if (i < missing.length - 1) await sleep(400 + Math.random() * 1200);
    }

    // Requests can land late; give stragglers a moment
    onProgress(missing.length, missing.length);
    await waitUntil(() => components.every((c) => hasUrl(c.meta.path)), 15000, 500);
  } finally {
    try {
      compass.at({ floc: originalFloc })?.seek?.();
    } catch (error) {
      console.warn('[Libby Downloader] Could not restore the playback position:', error);
    }
  }
}

/**
 * Resolve authors from BIF creator list with fallback chain
 * 1. Case-insensitive match for known author roles
 * 2. Any non-narrator creator
 * 3. First creator regardless of role
 * 4. 'Unknown' as last resort
 */
function resolveAuthors(creators: Array<{ name: string; role: string }>): string[] {
  const authorRoles = new Set(['author', 'aut', 'wrt', 'writer']);
  const byRole = creators
    .filter((c) => authorRoles.has(c.role?.toLowerCase() ?? ''))
    .map((c) => c.name);
  if (byRole.length > 0) return byRole;

  const nonNarrators = creators
    .filter((c) => (c.role?.toLowerCase() ?? '') !== 'narrator')
    .map((c) => c.name);
  if (nonNarrators.length > 0) return nonNarrators;

  if (creators.length > 0) return [creators[0].name];

  return ['Unknown'];
}

console.log('[Libby Downloader] Ready to extract');
