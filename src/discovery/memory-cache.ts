/**
 * A small per-isolate cache for middleware results, bounded by size rather
 * than entry count: total bytes are capped, large values aren't kept, and
 * misses (null results, e.g. a .md request for a random path) get their own
 * small LRU so they can't crowd out real documents.
 */

export interface MemoryCacheOptions {
	ttlMs: number;
	/** Total size of cached values. */
	maxBytes: number;
	/** Values larger than this aren't cached. */
	maxEntryBytes: number;
	/** How many miss (null) results to remember. */
	maxMisses: number;
	now?: () => number;
}

interface Slot {
	value: unknown;
	bytes: number;
	expires: number;
}

/** Approximate size: UTF-16 string length × 2 of the JSON form. */
export function sizeOf(value: unknown): number {
	try {
		return (JSON.stringify(value) ?? "").length * 2;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

export class MemoryCache {
	private readonly hits = new Map<string, Slot>();
	private readonly misses = new Map<string, number>();
	private bytes = 0;
	private readonly options: MemoryCacheOptions;
	private readonly now: () => number;

	constructor(options: MemoryCacheOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	get totalBytes(): number {
		return this.bytes;
	}

	get size(): { hits: number; misses: number } {
		return { hits: this.hits.size, misses: this.misses.size };
	}

	/** `undefined` = not cached; `null` = a remembered miss. */
	get(key: string): unknown | null | undefined {
		const now = this.now();
		const slot = this.hits.get(key);
		if (slot) {
			if (slot.expires > now) {
				// Refresh LRU position.
				this.hits.delete(key);
				this.hits.set(key, slot);
				return slot.value;
			}
			this.remove(key);
		}
		const miss = this.misses.get(key);
		if (miss !== undefined) {
			if (miss > now) return null;
			this.misses.delete(key);
		}
		return undefined;
	}

	set(key: string, value: unknown): void {
		this.remove(key);
		this.misses.delete(key);
		const expires = this.now() + this.options.ttlMs;
		if (value === null || value === undefined) {
			while (this.misses.size >= this.options.maxMisses) this.misses.delete(this.misses.keys().next().value as string);
			if (this.options.maxMisses > 0) this.misses.set(key, expires);
			return;
		}
		const bytes = sizeOf(value);
		if (bytes > this.options.maxEntryBytes || bytes > this.options.maxBytes) return;
		while (this.bytes + bytes > this.options.maxBytes && this.hits.size) this.remove(this.hits.keys().next().value as string);
		this.hits.set(key, { value, bytes, expires });
		this.bytes += bytes;
	}

	private remove(key: string): void {
		const slot = this.hits.get(key);
		if (!slot) return;
		this.hits.delete(key);
		this.bytes -= slot.bytes;
	}
}
