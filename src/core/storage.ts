/**
 * Batched plugin-storage reads and deletes. EmDash's getMany and deleteMany
 * put every id in one `IN (…)` list next to the plugin id and collection
 * name, and D1 refuses statements with more than 100 bound values, so a
 * large list fails with "too many SQL variables". These keep each statement
 * well under the limit.
 */
import type { StorageCollection } from "emdash";

/** Ids per statement: 90 + plugin id + collection stays under D1's 100. */
export const STORAGE_IN_LIMIT = 90;

export async function getManyBatched<T>(collection: StorageCollection<T>, ids: readonly string[]): Promise<Map<string, T>> {
	const out = new Map<string, T>();
	const unique = [...new Set(ids)];
	for (let i = 0; i < unique.length; i += STORAGE_IN_LIMIT) {
		for (const [id, data] of await collection.getMany(unique.slice(i, i + STORAGE_IN_LIMIT))) out.set(id, data);
	}
	return out;
}

export async function deleteManyBatched<T>(collection: StorageCollection<T>, ids: readonly string[]): Promise<number> {
	let deleted = 0;
	const unique = [...new Set(ids)];
	for (let i = 0; i < unique.length; i += STORAGE_IN_LIMIT) deleted += await collection.deleteMany(unique.slice(i, i + STORAGE_IN_LIMIT));
	return deleted;
}
