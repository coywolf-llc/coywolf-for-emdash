/**
 * Unsaved-changes comparison for settings pages: a draft is dirty when it no
 * longer matches the last saved snapshot. Key order doesn't matter, so a
 * draft rebuilt with its keys in another order still counts as unchanged.
 */

/** JSON with object keys sorted, so equal values always serialize the same. */
export function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
			: v,
	);
}

/** True when `draft` differs from `saved`. Nothing saved yet (still loading) is never dirty. */
export function isDirty(draft: unknown, saved: unknown): boolean {
	if (saved === undefined || saved === null) return false;
	return stableStringify(draft) !== stableStringify(saved);
}
