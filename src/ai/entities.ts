/**
 * Read the grounded entities for an entry, for Schema.org output.
 *
 * The Schema module calls `getEntryEntities(ctx, collection, id)` (inside the
 * plugin context) or `getEntryEntities(db, collection, id)` with the site's
 * D1 database (outside it, e.g. an Astro component), and merges `about` and
 * `mentions` into its Article/WebPage node. Returns empty lists when the
 * "ai.entities" feature is off or nothing has been analyzed yet.
 */
import type { PluginContext, StorageCollection } from "emdash";

import { PLUGIN_ID, ctxFeatures, isOn, siteFeatures } from "../core/features.js";
import { type Entity, entityNodes } from "./logic.js";
import type { EntryRecord } from "./store.js";

export interface EntryEntities {
	entities: Entity[];
	about: Record<string, unknown>[];
	mentions: Record<string, unknown>[];
}

const EMPTY: EntryEntities = { entities: [], about: [], mentions: [] };

type Source = Pick<PluginContext, "storage" | "settings"> | D1Database;

function isD1(source: Source): source is D1Database {
	return typeof (source as D1Database).prepare === "function";
}

export async function getEntryEntities(source: Source, collection: string, id: string): Promise<EntryEntities> {
	try {
		let record: EntryRecord | null = null;
		if (isD1(source)) {
			if (!isOn(await siteFeatures(), "ai.entities")) return EMPTY;
			const row = await source
				.prepare("SELECT data FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id = ?")
				.bind(PLUGIN_ID, "aiEntries", `${collection}:${id}`)
				.first<{ data: string }>();
			record = row?.data ? (JSON.parse(row.data) as EntryRecord) : null;
		} else {
			if (!isOn(await ctxFeatures(source), "ai.entities")) return EMPTY;
			const entries = (source.storage as Record<string, StorageCollection>).aiEntries as StorageCollection<EntryRecord> | undefined;
			record = (await entries?.get(`${collection}:${id}`)) ?? null;
		}
		const entities = Array.isArray(record?.entities) ? record.entities : [];
		return { entities, ...entityNodes(entities) };
	} catch {
		return EMPTY; // Schema output must never fail because of enrichment.
	}
}
