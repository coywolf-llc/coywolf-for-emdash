/**
 * Stopgap renders: a page that showed an image (or video poster) from a
 * temporary source, because its stored copy isn't made yet, is marked so the
 * pack middleware caches it for minutes, not days. The next render, once the
 * copy exists, uses it. No imports, so tests can load it.
 */

/** Astro.locals key: this request rendered media whose stored copy is still being made. */
export const PENDING_MEDIA_LOCAL = "__cwPendingPoster";
/**
 * Per isolate: stopgap renders for callers that didn't pass `locals`. The
 * middleware compares it before and after a render; a concurrent render in the
 * same isolate can shorten another page's lifetime too, which only costs a
 * re-render.
 */
let pendingRenders = 0;

/** Note that this render used a stopgap for an image or poster whose stored copy isn't made yet. */
export function markPendingMedia(locals?: object | null): void {
	if (locals && typeof locals === "object") (locals as Record<string, unknown>)[PENDING_MEDIA_LOCAL] = true;
	else pendingRenders++;
}

/** How many stopgap renders this isolate has made without `locals` (see markPendingMedia). */
export function pendingMediaRenders(): number {
	return pendingRenders;
}

/** Whether a request rendered a stopgap: flagged on its locals, or counted since `before`. */
export function renderedPendingMedia(locals: unknown, before: number): boolean {
	return Boolean((locals as Record<string, unknown> | undefined)?.[PENDING_MEDIA_LOCAL]) || pendingRenders !== before;
}

/** Reset the count (tests). */
export function resetPendingMedia(): void {
	pendingRenders = 0;
}
