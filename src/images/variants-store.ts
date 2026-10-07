/**
 * Stored image sizes: the per-image records, and the backfill that makes
 * missing sizes for the whole media library.
 *
 * Records live in plugin storage (collection `imageVariants`, id = media id)
 * and are read and written through the raw D1 binding: page renders read them
 * joined to the media table in one statement (imageInfo in pack.ts), and the
 * writers run after the response (waitUntil), outside any plugin context.
 *
 * The backfill (existing images) only runs when the site turned it on
 * (`imagesVariantsBulk`, Clean Image URLs page): making sizes for a whole
 * library costs Cloudflare transformations, so it's opt-in. It makes widths
 * only; crops are added to a record as pages first use them (addCrops).
 *
 * The backfill's progress is one option row (VARIANTS_STATE_OPTION). Batches
 * are claimed with a compare-and-swap on its `cursor` (the last media id
 * handed out), so the hourly job, the admin's "Make missing sizes now" and an
 * import running at the same time never work on the same images. When no
 * image is left it cleans up (the previous version's files, legacy video
 * posters) and is done; a done run starts over a day later (to retry
 * failures) or at once from the admin.
 */
import { PLUGIN_ID } from "../core/features.js";
import {
	type ImagesBinding,
	VARIANTS_VERSION,
	VARIANT_MIME_TYPES,
	type VariantBucket,
	type VariantDoc,
	deleteVariants,
	deleteVersion,
	generateVariants,
	ineligibleReason,
} from "./variants.js";

export const VARIANTS_COLLECTION = "imageVariants";
export const VARIANTS_STATE_OPTION = `plugin:${PLUGIN_ID}:images:variantsState`;
/** A finished run starts over after this long (picks up failures and anything the hooks missed). */
export const RESTART_AFTER_MS = 24 * 60 * 60_000;
/** Images claimed at a time. */
const BATCH = 5;

/** The slice of D1 used here (node:sqlite stands in for it in tests). */
export interface Db {
	prepare(sql: string): {
		bind(...values: unknown[]): {
			run(): Promise<{ meta?: { changes?: number } }>;
			first<T = unknown>(): Promise<T | null>;
			all<T = unknown>(): Promise<{ results: T[] }>;
		};
	};
}

const MIME_LIST = VARIANT_MIME_TYPES.map((m) => `'${m}'`).join(",");
/** SQL: the media row `m` has no record (`s`) of this version. */
const INCOMPLETE = `(s.data IS NULL OR json_extract(s.data, '$.v') IS NOT ?1)`;
const JOIN = `LEFT JOIN _plugin_storage AS s ON s.plugin_id = '${PLUGIN_ID}' AND s.collection = '${VARIANTS_COLLECTION}' AND s.id = m.id`;
const READY = `(m.status IS NULL OR m.status = 'ready') AND m.mime_type IN (${MIME_LIST})`;

// ── Records ──────────────────────────────────────────────────────

export async function writeVariantRecord(db: Db, id: string, doc: VariantDoc): Promise<void> {
	const now = new Date().toISOString();
	await db
		.prepare(
			`INSERT INTO _plugin_storage (plugin_id, collection, id, data, revision, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
			ON CONFLICT (plugin_id, collection, id) DO UPDATE SET data = excluded.data, revision = excluded.revision, updated_at = excluded.updated_at`,
		)
		.bind(PLUGIN_ID, VARIANTS_COLLECTION, id, JSON.stringify(doc), crypto.randomUUID(), now)
		.run();
}

/**
 * Add crops made on first use to an image's current record. Merged in SQL
 * (the stored list plus the new names, deduplicated), so crops another
 * isolate added meanwhile are kept. No-op when the record is gone, skipped or
 * of another version (the files are then removed with the image, or replaced
 * by the next version's).
 */
export async function addCrops(db: Db, id: string, names: string[]): Promise<boolean> {
	if (!names.length) return false;
	const result = await db
		.prepare(
			`UPDATE _plugin_storage SET
				data = json_set(data, '$.c', json((SELECT json_group_array(value) FROM (SELECT value FROM json_each(_plugin_storage.data, '$.c') UNION SELECT value FROM json_each(?1))))),
				revision = ?2, updated_at = ?3
			WHERE plugin_id = ?4 AND collection = ?5 AND id = ?6 AND json_extract(data, '$.v') = ?7 AND json_extract(data, '$.skip') IS NULL`,
		)
		.bind(JSON.stringify(names), crypto.randomUUID(), new Date().toISOString(), PLUGIN_ID, VARIANTS_COLLECTION, id, VARIANTS_VERSION)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

export async function deleteVariantRecord(db: Db, id: string): Promise<void> {
	await db.prepare("DELETE FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id = ?").bind(PLUGIN_ID, VARIANTS_COLLECTION, id).run();
}

export interface MediaRow {
	id: string;
	storage_key: string;
	mime_type: string | null;
	width: number | null;
	height: number | null;
	size: number | null;
	focal_x: number | null;
	focal_y: number | null;
}

export interface VariantDeps {
	db: Db;
	bucket: VariantBucket;
	images: ImagesBinding;
}

/**
 * Make (or skip) one image's widths and record them (crops come later, on first use). "done", "skipped" (it can't
 * have stored sizes: recorded so it isn't tried again), or "failed" (nothing
 * recorded; tried again on the next run).
 */
export async function processMedia(deps: VariantDeps, row: MediaRow): Promise<"done" | "skipped" | "failed"> {
	const reason = ineligibleReason(row.mime_type, row.width, row.size);
	if (reason) {
		await writeVariantRecord(deps.db, row.id, { v: VARIANTS_VERSION, w: [], skip: reason, at: new Date().toISOString() });
		return "skipped";
	}
	try {
		const doc = await generateVariants({
			bucket: deps.bucket,
			images: deps.images,
			key: row.storage_key,
			id: row.id,
			width: row.width as number,
			height: row.height,
			focal: row.focal_x != null && row.focal_y != null ? { x: row.focal_x, y: row.focal_y } : null,
		});
		await writeVariantRecord(deps.db, row.id, doc);
		return "done";
	} catch (error) {
		console.error(`coywolf-pack images: couldn't make stored sizes for ${row.storage_key}`, error);
		return "failed";
	}
}

const ROW_COLUMNS = "m.id, m.storage_key, m.mime_type, m.width, m.height, m.size, m.focal_x, m.focal_y";

/** One media item's row, if it's a ready image of a type that gets stored sizes. */
export async function mediaRow(db: Db, id: string): Promise<MediaRow | null> {
	return db.prepare(`SELECT ${ROW_COLUMNS} FROM media AS m WHERE m.id = ?1 AND ${READY}`).bind(id).first<MediaRow>();
}

/** Remove a deleted media item's copies (this version and the previous one) and its record. */
export async function forgetMedia(deps: { db: Db; bucket: VariantBucket }, id: string): Promise<void> {
	await deleteVariants(deps.bucket, [VARIANTS_VERSION, VARIANTS_VERSION - 1], id);
	await deleteVariantRecord(deps.db, id);
}

// ── Backfill ─────────────────────────────────────────────────────

export interface VariantsState {
	version: number;
	/** Last media id handed to a batch. */
	cursor: string;
	done: number;
	skipped: number;
	failed: number;
	phase: "running" | "cleanup" | "done";
	startedAt: string;
	finishedAt?: string;
	error?: string;
}

export async function readVariantsState(db: Db): Promise<{ raw: string | null; state: VariantsState | null }> {
	const row = await db.prepare("SELECT value FROM options WHERE name = ?1").bind(VARIANTS_STATE_OPTION).first<{ value: string }>();
	const raw = row?.value ?? null;
	try {
		return { raw, state: raw ? (JSON.parse(raw) as VariantsState) : null };
	} catch {
		return { raw, state: null };
	}
}

/** Replace the row only if nobody changed it since `before` was read (null: only if it doesn't exist). */
async function swap(db: Db, before: string | null, after: VariantsState): Promise<boolean> {
	const value = JSON.stringify(after);
	const result =
		before === null
			? await db.prepare("INSERT INTO options (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO NOTHING").bind(VARIANTS_STATE_OPTION, value).run()
			: await db.prepare("UPDATE options SET value = ?1 WHERE name = ?2 AND value = ?3").bind(value, VARIANTS_STATE_OPTION, before).run();
	return (result.meta?.changes ?? 0) > 0;
}

/** Apply `update` to the current row (compare-and-swap, retried). */
async function updateState(db: Db, update: (state: VariantsState) => VariantsState | null): Promise<VariantsState | null> {
	for (let i = 0; i < 10; i++) {
		const { raw, state } = await readVariantsState(db);
		if (!state) return null;
		const next = update(state);
		if (!next) return state;
		if (await swap(db, raw, next)) return next;
	}
	return null;
}

const freshState = (now: number): VariantsState => ({
	version: VARIANTS_VERSION,
	cursor: "",
	done: 0,
	skipped: 0,
	failed: 0,
	phase: "running",
	startedAt: new Date(now).toISOString(),
});

/** Start a new run unless one is under way (or, without `force`, one finished less than a day ago). */
export async function startVariantsRun(db: Db, options: { force?: boolean; now?: number } = {}): Promise<VariantsState> {
	const now = options.now ?? Date.now();
	for (let i = 0; i < 10; i++) {
		const { raw, state } = await readVariantsState(db);
		const stale = !state || state.version !== VARIANTS_VERSION;
		const restart =
			stale ||
			(state.phase === "done" && (options.force || !state.finishedAt || now - Date.parse(state.finishedAt) >= RESTART_AFTER_MS));
		if (!restart) return state as VariantsState;
		const next = freshState(now);
		if (await swap(db, raw, next)) return next;
	}
	return (await readVariantsState(db)).state ?? freshState(now);
}

/** Claim the next batch of images missing their sizes; null when another isolate moved the cursor first. */
async function claim(db: Db): Promise<{ state: VariantsState; rows: MediaRow[] } | null> {
	const { raw, state } = await readVariantsState(db);
	if (!state || state.phase !== "running") return { state: state as VariantsState, rows: [] };
	const { results } = await db
		.prepare(`SELECT ${ROW_COLUMNS} FROM media AS m ${JOIN} WHERE m.id > ?2 AND ${READY} AND ${INCOMPLETE} ORDER BY m.id LIMIT ${BATCH}`)
		.bind(VARIANTS_VERSION, state.cursor)
		.all<MediaRow>();
	const next: VariantsState = results.length ? { ...state, cursor: results[results.length - 1].id } : { ...state, phase: "cleanup" };
	return (await swap(db, raw, next)) ? { state: next, rows: results } : null;
}

export interface BackfillDeps extends VariantDeps {
	/** Copy legacy video posters' sizes during cleanup; true when none are left. */
	upgradePosters?: (deadline: number) => Promise<boolean>;
}

/**
 * Work on the current run until `budgetMs` has passed or `maxImages` images were
 * handled: claim a batch, make its sizes, record the counts; when none are
 * left, clean up and finish. Returns the state at the end.
 */
export async function backfillStep(deps: BackfillDeps, options: { budgetMs: number; maxImages?: number; now?: () => number }): Promise<VariantsState | null> {
	const clock = options.now ?? Date.now;
	const deadline = clock() + options.budgetMs;
	let handled = 0;
	let state = await startVariantsRun(deps.db, { now: clock() });
	while (clock() < deadline && handled < (options.maxImages ?? Number.POSITIVE_INFINITY)) {
		if (state.phase === "done") break;
		if (state.phase === "cleanup") {
			const left = deadline - clock();
			const versionsDone = await deleteVersion(deps.bucket, VARIANTS_VERSION - 1, left).catch(() => false);
			const postersDone = deps.upgradePosters ? await deps.upgradePosters(deadline).catch(() => false) : true;
			if (!versionsDone || !postersDone) break;
			state = (await updateState(deps.db, (s) => (s.phase === "cleanup" ? { ...s, phase: "done", finishedAt: new Date(clock()).toISOString() } : null))) ?? state;
			break;
		}
		const claimed = await claim(deps.db);
		if (!claimed) {
			state = (await readVariantsState(deps.db)).state ?? state;
			continue;
		}
		state = claimed.state;
		if (!claimed.rows.length) continue;
		const counts = { done: 0, skipped: 0, failed: 0 };
		for (const row of claimed.rows) counts[await processMedia(deps, row)]++;
		handled += claimed.rows.length;
		state =
			(await updateState(deps.db, (s) => ({ ...s, done: s.done + counts.done, skipped: s.skipped + counts.skipped, failed: s.failed + counts.failed }))) ?? state;
	}
	return state;
}

/** Library counts for the admin: images that can have stored sizes, how many have them, how many are skipped. */
export async function variantCounts(db: Db): Promise<{ total: number; stored: number; skipped: number }> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS total,
				SUM(CASE WHEN NOT ${INCOMPLETE} AND json_extract(s.data, '$.skip') IS NULL THEN 1 ELSE 0 END) AS stored,
				SUM(CASE WHEN NOT ${INCOMPLETE} AND json_extract(s.data, '$.skip') IS NOT NULL THEN 1 ELSE 0 END) AS skipped
			FROM media AS m ${JOIN} WHERE ${READY}`,
		)
		.bind(VARIANTS_VERSION)
		.first<{ total: number; stored: number | null; skipped: number | null }>();
	return { total: row?.total ?? 0, stored: row?.stored ?? 0, skipped: row?.skipped ?? 0 };
}

/** One media-library image for the cost estimate; `current` is 1 when it already has a record of this version. */
export interface EstimateRow {
	mime_type: string | null;
	width: number | null;
	height: number | null;
	size: number | null;
	current: number;
}

/** Every ready image of a type that can get stored sizes (admin only: one scan of the media table). */
export async function estimateRows(db: Db): Promise<EstimateRow[]> {
	const { results } = await db
		.prepare(`SELECT m.mime_type, m.width, m.height, m.size, CASE WHEN ${INCOMPLETE} THEN 0 ELSE 1 END AS current FROM media AS m ${JOIN} WHERE ${READY}`)
		.bind(VARIANTS_VERSION)
		.all<EstimateRow>();
	return results;
}

/** Published entries of the site's routable collections (its pages, for the traffic estimate); null when it can't be counted. */
export async function publishedCount(db: Db): Promise<number | null> {
	try {
		const { results } = await db.prepare("SELECT slug FROM _emdash_collections WHERE routable = 1").bind().all<{ slug: string }>();
		const tables = results.map((r) => r.slug).filter((slug) => /^[a-z0-9_]+$/.test(slug));
		if (!tables.length) return 0;
		const sum = tables.map((slug) => `(SELECT COUNT(*) FROM "ec_${slug}" WHERE status = 'published' AND deleted_at IS NULL)`).join(" + ");
		const row = await db.prepare(`SELECT ${sum} AS n`).bind().first<{ n: number }>();
		return row?.n ?? 0;
	} catch {
		return null;
	}
}
