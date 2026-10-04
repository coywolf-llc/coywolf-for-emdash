/**
 * AI Enrichment worker: analyzes entries (entities + meta descriptions) and
 * images (alt text + captions) from the queue. Runs on the cron tick (and the
 * admin's "Run now"), never inside a save: hooks only enqueue.
 */
import type { CollectionSchemaInfo, PluginContext } from "emdash";

import { type FeatureMap, ctxFeatures, isOn } from "../core/features.js";
import {
	type Entity,
	type GroundedMention,
	type QueueJob,
	applyChoices,
	attachCandidates,
	cleanDescription,
	entryPlainText,
	parseChoices,
	parseImageText,
	parseMentions,
	planBatch,
	queueId,
	retryAt,
	verifyEntities,
} from "./logic.js";
import { DESCRIBE_SYSTEM, DISAMBIGUATE_SYSTEM, EXTRACT_SYSTEM, IMAGE_SYSTEM, articlePrompt, disambiguatePrompt, imagePrompt } from "./prompts.js";
import { type ChatRequest, chat } from "./providers.js";
import {
	type AiOptions,
	type AiSettings,
	type BulkState,
	DailyLimitError,
	type EntryRecord,
	type MediaRecord,
	type UsageRow,
	bindings,
	bulkKey,
	callsToday,
	col,
	enqueue,
	entryKey,
	logUsage,
	providerConfig,
	pruneUsage,
	readSettings,
	takeCall,
	withLock,
} from "./store.js";
import { entityDetails, searchCandidates } from "./wikidata.js";

type Settings = AiSettings & { apiKey: string };

/** Image bytes sent to a model: at most this many (larger images are downscaled with the Images binding, or skipped). */
const MAX_IMAGE_BYTES = 3_670_016;
const MAX_EDGE = 1568;
const DIRECT_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export class SkipError extends Error {}

// ── Helpers ──────────────────────────────────────────────────────

const schemaCache = new Map<string, { info: CollectionSchemaInfo | null; at: number }>();

async function collectionInfo(ctx: PluginContext, slug: string): Promise<CollectionSchemaInfo | null> {
	const hit = schemaCache.get(slug);
	if (hit && Date.now() - hit.at < 60_000) return hit.info;
	const info = (await ctx.schema?.getCollection(slug)) ?? null;
	schemaCache.set(slug, { info, at: Date.now() });
	return info;
}

/** Collections the module works on: the configured list, or every routable, visible one. */
export async function targetCollections(ctx: PluginContext, s: Settings): Promise<string[]> {
	if (s.collections.length) return s.collections;
	const all = (await ctx.schema?.listCollections()) ?? [];
	return all.filter((c) => c.routable && !c.hidden).map((c) => c.slug);
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function signature(s: Settings, features: FeatureMap): string {
	return `p:${s.provider}|m:${s.textModel}|ent:${isOn(features, "ai.entities") ? 1 : 0}|desc:${isOn(features, "ai.descriptions") ? 1 : 0}`;
}

export interface EntryText {
	title: string;
	text: string;
	hash: string;
	info: CollectionSchemaInfo;
}

/** Title, plain text, and change hash of an entry; null when it has no text worth analyzing. */
export async function entryText(ctx: PluginContext, collection: string, data: Record<string, unknown>, s: Settings, features: FeatureMap): Promise<EntryText | null> {
	const info = await collectionInfo(ctx, collection);
	if (!info) return null;
	const titleField = info.titleField ?? "title";
	const title = typeof data[titleField] === "string" ? (data[titleField] as string).trim() : "";
	const fields = [...info.fields].sort((a, b) => a.sortOrder - b.sortOrder).filter((f) => f.slug !== titleField);
	const text = entryPlainText(data, fields);
	if (!text.trim()) return null;
	return { title, text, info, hash: await sha256(`${title}\n${text}\n${signature(s, features)}`) };
}

const language = (ctx: PluginContext) => (ctx.site?.locale || "en").slice(0, 2).toLowerCase() || "en";
const userAgent = (ctx: PluginContext) => `CoywolfPack/1 (EmDash plugin; ${ctx.site?.url || "unknown site"})`;
const fetcher = (ctx: PluginContext) => (url: string, init?: RequestInit) => (ctx.http ? ctx.http.fetch(url, init) : fetch(url, init));

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** One model call: counted against the daily cap and written to the usage log. */
async function callModel(
	ctx: PluginContext,
	options: AiOptions,
	s: Settings,
	feature: UsageRow["feature"],
	req: ChatRequest,
	ref: string,
): Promise<string> {
	if (!(await takeCall(ctx, s.maxCallsPerDay))) throw new DailyLimitError();
	const cfg = await providerConfig(ctx, options, s, Boolean(req.image));
	try {
		const result = await chat(cfg, req);
		await logUsage(ctx, { feature, provider: s.provider, model: cfg.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, ok: true, ref });
		return result.text;
	} catch (error) {
		await logUsage(ctx, { feature, provider: s.provider, model: cfg.model, inputTokens: 0, outputTokens: 0, ok: false, error: String((error as Error).message ?? error).slice(0, 300), ref });
		throw error;
	}
}

// ── Entries ──────────────────────────────────────────────────────

async function groundEntities(ctx: PluginContext, options: AiOptions, s: Settings, t: EntryText, ref: string): Promise<Entity[]> {
	const mentions = parseMentions(await callModel(ctx, options, s, "entities", { system: EXTRACT_SYSTEM, user: articlePrompt(t.title, t.text), maxTokens: 2000 }, ref));
	if (!mentions.length) return [];
	const lang = language(ctx);
	const f = fetcher(ctx);
	const ua = userAgent(ctx);
	// Stage 2: real candidates, a few lookups at a time.
	const candidates = [];
	for (let i = 0; i < mentions.length; i += 4) {
		candidates.push(...(await Promise.all(mentions.slice(i, i + 4).map((m) => searchCandidates(f, m.name, lang, ua)))));
	}
	let { mentions: grounded, ambiguous } = attachCandidates(mentions, candidates);
	// Stage 3: the model chooses among real candidates only.
	if (ambiguous.length) {
		const subset: GroundedMention[] = ambiguous.map((i) => grounded[i]);
		const choices = parseChoices(await callModel(ctx, options, s, "entities", { system: DISAMBIGUATE_SYSTEM, user: disambiguatePrompt(subset, t.title, t.text), maxTokens: 1000 }, ref));
		grounded = applyChoices(grounded, ambiguous, choices);
	}
	// Stage 4: type verification against P31.
	const resolved = grounded.filter((m) => m.qid);
	if (!resolved.length) return [];
	const details = await entityDetails(f, resolved.map((m) => m.qid), lang, ua);
	if (!details) throw new Error("Wikidata didn't answer, so the entities couldn't be verified. Retrying later.");
	return verifyEntities(resolved, details);
}

export async function analyzeEntry(ctx: PluginContext, options: AiOptions, s: Settings, features: FeatureMap, job: QueueJob): Promise<"done" | "skipped"> {
	const collection = job.collection!;
	const id = job.entryId!;
	const item = await ctx.content?.get(collection, id);
	if (!item || item.status !== "published") return "skipped";
	const t = await entryText(ctx, collection, item.data, s, features);
	if (!t) return "skipped";

	const records = col<EntryRecord>(ctx, "aiEntries");
	const key = entryKey(collection, id);
	const previous = await records.get(key);
	if (!job.force && previous?.status === "ok" && previous.hash === t.hash) return "skipped";

	const ref = key;
	const wantEntities = isOn(features, "ai.entities");
	const hasDescription = Boolean(item.seo?.description?.trim());
	const wantDescription = isOn(features, "ai.descriptions") && t.info.hasSeo && !hasDescription;

	const entities = wantEntities ? await groundEntities(ctx, options, s, t, ref) : (previous?.entities ?? []);

	let description = previous?.description ?? "";
	let descriptionStatus: EntryRecord["descriptionStatus"] = hasDescription && previous?.descriptionStatus !== "applied" ? "none" : (previous?.descriptionStatus ?? "none");
	if (wantDescription) {
		description = cleanDescription(await callModel(ctx, options, s, "descriptions", { system: DESCRIBE_SYSTEM, user: articlePrompt(t.title, t.text), maxTokens: 300 }, ref));
		descriptionStatus = description ? "suggested" : "none";
		if (description && s.descriptionsMode === "apply") {
			descriptionStatus = (await applyDescription(ctx, collection, id, description, false)) ? "applied" : "none";
		}
	}

	await records.put(key, {
		collection,
		entryId: id,
		title: t.title,
		hash: t.hash,
		status: "ok",
		error: "",
		entities,
		description,
		descriptionStatus,
		updated: new Date().toISOString(),
	});
	return "done";
}

/**
 * Write a meta description into EmDash's SEO panel (a SEO-only update touches
 * nothing else). Unless `replace`, only when the entry still has none, so a
 * description an editor wrote meanwhile is never overwritten.
 */
export async function applyDescription(ctx: PluginContext, collection: string, id: string, description: string, replace: boolean): Promise<boolean> {
	const content = ctx.content;
	if (!content?.update) throw new Error("Content write access is unavailable.");
	const fresh = await content.get(collection, id);
	if (!fresh || fresh.seo === undefined) return false;
	if (!replace && fresh.seo.description?.trim()) return false;
	await content.update(collection, id, { seo: { description } });
	return true;
}

// ── Images ───────────────────────────────────────────────────────

async function imagePayload(ctx: PluginContext, options: AiOptions, media: { id: string; mimeType: string; width?: number | null; height?: number | null }) {
	if (!ctx.media?.readBytes) throw new Error("Media byte access is unavailable.");
	const { images } = await bindings(options);
	const bigEdge = Math.max(media.width ?? 0, media.height ?? 0) > MAX_EDGE * 2;
	let bytes: Uint8Array;
	try {
		bytes = (await ctx.media.readBytes(media.id, { maxBytes: images ? 16 * 1024 * 1024 : MAX_IMAGE_BYTES })).bytes;
	} catch (error) {
		throw new SkipError(images ? `The image couldn't be read: ${(error as Error).message}` : "The image is larger than 3.5 MB. Add an Images binding (see README) to analyze large images.");
	}
	let mimeType = media.mimeType;
	if (images && (bytes.byteLength > 1_000_000 || bigEdge || !DIRECT_MIMES.has(mimeType))) {
		const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();
		const result = await images
			.input(stream)
			.transform({ width: MAX_EDGE, height: MAX_EDGE, fit: "scale-down" })
			.output({ format: "image/jpeg", quality: 85 });
		bytes = new Uint8Array(await result.response().arrayBuffer());
		mimeType = "image/jpeg";
	}
	if (!DIRECT_MIMES.has(mimeType)) throw new SkipError(`${mimeType} images can't be analyzed without an Images binding.`);
	if (bytes.byteLength > MAX_IMAGE_BYTES) throw new SkipError("The image is too large to analyze.");
	return { mimeType, base64: base64(bytes) };
}

export async function analyzeMedia(ctx: PluginContext, options: AiOptions, s: Settings, job: QueueJob): Promise<"done" | "skipped"> {
	const id = job.mediaId!;
	const media = await ctx.media?.get(id);
	const records = col<MediaRecord>(ctx, "aiMedia");
	if (!media) {
		await records.delete(id).catch(() => false);
		return "skipped";
	}
	const base: Omit<MediaRecord, "status" | "suggestion" | "written" | "error"> = { mediaId: id, filename: media.filename, url: media.url, updated: new Date().toISOString() };
	if (!media.mimeType.startsWith("image/") || media.mimeType === "image/svg+xml") {
		await records.put(id, { ...base, suggestion: null, status: "skipped", written: [], error: "Only raster images get image text." });
		return "skipped";
	}
	const needsAlt = !media.alt?.trim();
	const needsCaption = s.imageCaption && !media.caption?.trim();
	if (!job.force && !s.imageOverwrite && !needsAlt && !needsCaption) return "skipped";

	let payload: { mimeType: string; base64: string };
	try {
		payload = await imagePayload(ctx, options, media);
	} catch (error) {
		if (!(error instanceof SkipError)) throw error;
		await records.put(id, { ...base, suggestion: null, status: "skipped", written: [], error: error.message });
		return "skipped";
	}
	const raw = await callModel(
		ctx,
		options,
		s,
		"imageText",
		{
			system: IMAGE_SYSTEM,
			user: imagePrompt({ filename: media.filename, site: ctx.site?.name ?? "", locale: ctx.site?.locale || "en", extra: s.imageInstructions }),
			image: payload,
			maxTokens: 1024,
		},
		`media:${id}`,
	);
	const suggestion = parseImageText(raw);

	let written: string[] = [];
	if (s.imageMode === "apply") written = await applyImageText(ctx, id, suggestion, { caption: s.imageCaption, overwrite: s.imageOverwrite });
	await records.put(id, { ...base, suggestion, status: written.length ? "applied" : "suggested", written, error: "" });
	return "done";
}

/** Write alt text (and optionally the caption) to a media item. Human-entered values are kept unless `overwrite`. */
export async function applyImageText(
	ctx: PluginContext,
	id: string,
	text: { alt?: string; caption?: string },
	opts: { caption: boolean; overwrite: boolean },
): Promise<string[]> {
	if (!ctx.media?.updateMetadata) throw new Error("Media metadata write access is unavailable.");
	const fresh = await ctx.media.get(id);
	if (!fresh) return [];
	const patch: { alt?: string; caption?: string } = {};
	if (text.alt && (opts.overwrite || !fresh.alt?.trim())) patch.alt = text.alt;
	if (opts.caption && text.caption && (opts.overwrite || !fresh.caption?.trim())) patch.caption = text.caption;
	if (!Object.keys(patch).length) return [];
	await ctx.media.updateMetadata(id, patch);
	return Object.keys(patch);
}

// ── Bulk scan ────────────────────────────────────────────────────

/** Turn part of a bulk run into queue jobs (up to ~200 items per call). */
export async function advanceBulk(ctx: PluginContext, s: Settings, features: FeatureMap, kind: BulkState["kind"]): Promise<void> {
	const state = await ctx.kv.get<BulkState>(bulkKey(kind));
	if (!state || state.finished) return;
	const now = Date.now();
	let pages = 2;
	if (kind === "entries") {
		const records = col<EntryRecord>(ctx, "aiEntries");
		while (pages-- > 0 && state.collections.length) {
			const collection = state.collections[0];
			const page = await ctx.content!.list(collection, { where: { status: "published" }, limit: 100, cursor: state.cursor });
			const stored = await records.getMany(page.items.map((i) => entryKey(collection, i.id)));
			for (const item of page.items) {
				if (!state.force) {
					const t = await entryText(ctx, collection, item.data, s, features);
					const prev = stored.get(entryKey(collection, item.id));
					if (!t || (prev?.status === "ok" && prev.hash === t.hash)) {
						state.skipped++;
						continue;
					}
				}
				await enqueue(ctx, { kind: "entry", collection, entryId: item.id, due: now, force: state.force });
				state.queued++;
			}
			if (page.hasMore && page.cursor) state.cursor = page.cursor;
			else {
				state.collections.shift();
				state.cursor = undefined;
			}
		}
		if (!state.collections.length) state.finished = new Date().toISOString();
	} else {
		while (pages-- > 0 && !state.finished) {
			const page = await ctx.media!.list({ mimeType: "image/", limit: 100, cursor: state.cursor });
			for (const m of page.items) {
				const lacking = !m.alt?.trim() || (s.imageCaption && !m.caption?.trim());
				if (m.mimeType === "image/svg+xml" || (!state.force && !lacking)) {
					state.skipped++;
					continue;
				}
				await enqueue(ctx, { kind: "media", mediaId: m.id, due: now, force: state.force });
				state.queued++;
			}
			if (page.hasMore && page.cursor) state.cursor = page.cursor;
			else state.finished = new Date().toISOString();
		}
	}
	await ctx.kv.set(bulkKey(kind), state);
}

// ── Tick ─────────────────────────────────────────────────────────

export interface TickResult {
	processed: number;
	skipped: number;
	failed: number;
	stoppedForLimit: boolean;
	busy?: boolean;
}

const callsPerJob = (features: FeatureMap) => (job: QueueJob) =>
	job.kind === "media" ? 1 : (isOn(features, "ai.entities") ? 2 : 0) + (isOn(features, "ai.descriptions") ? 1 : 0) || 1;

/** Process due jobs. `maxJobs` overrides the per-tick setting (the admin's Run now uses 1). */
export async function tick(ctx: PluginContext, options: AiOptions, opts: { maxJobs?: number; budgetMs: number }): Promise<TickResult> {
	const result = await withLock(ctx, opts.budgetMs + 120_000, async () => {
		const out: TickResult = { processed: 0, skipped: 0, failed: 0, stoppedForLimit: false };
		const started = Date.now();
		const features = await ctxFeatures(ctx);
		const s = await readSettings(ctx, options);
		const entriesOn = isOn(features, "ai.entities") || isOn(features, "ai.descriptions");
		const imagesOn = isOn(features, "ai.imageText");

		for (const kind of ["entries", "media"] as const) {
			if (kind === "entries" ? !entriesOn : !imagesOn) continue;
			await advanceBulk(ctx, s, features, kind).catch((error) => ctx.log.warn("AI bulk scan failed", { kind, error: String(error) }));
		}

		const queue = col<QueueJob>(ctx, "aiQueue");
		const page = await queue.query({ where: { due: { lte: Date.now() } }, orderBy: { due: "asc" }, limit: 50 });
		// Jobs for switched-off features wait in the queue until they're back on.
		const runnable = page.items.filter((j) => (j.data.kind === "media" ? imagesOn : entriesOn));
		const batch = planBatch(runnable, {
			now: Date.now(),
			perTick: opts.maxJobs ?? s.jobsPerTick,
			remainingCalls: s.maxCallsPerDay - (await callsToday(ctx)),
			callsPerJob: callsPerJob(features),
		});
		if (runnable.length && !batch.length) out.stoppedForLimit = true;

		for (const { id, data: job } of batch) {
			if (Date.now() - started > opts.budgetMs) break;
			try {
				const status = job.kind === "media" ? await analyzeMedia(ctx, options, s, job) : await analyzeEntry(ctx, options, s, features, job);
				await queue.delete(id);
				if (status === "done") out.processed++;
				else out.skipped++;
			} catch (error) {
				if (error instanceof DailyLimitError) {
					out.stoppedForLimit = true;
					break; // The job stays queued for tomorrow.
				}
				out.failed++;
				const message = String((error as Error)?.message ?? error).slice(0, 500);
				ctx.log.warn("AI job failed", { job: id, error: message });
				const next = retryAt(job, Date.now());
				if (next === null) {
					await queue.delete(id);
					await recordFailure(ctx, job, message);
				} else {
					await queue.put(id, { ...job, attempts: job.attempts + 1, due: next, lastError: message });
				}
			}
		}
		await pruneUsage(ctx).catch(() => undefined);
		return out;
	});
	return result ?? { processed: 0, skipped: 0, failed: 0, stoppedForLimit: false, busy: true };
}

async function recordFailure(ctx: PluginContext, job: QueueJob, error: string): Promise<void> {
	const updated = new Date().toISOString();
	if (job.kind === "media") {
		const records = col<MediaRecord>(ctx, "aiMedia");
		const prev = await records.get(job.mediaId!);
		await records.put(job.mediaId!, {
			mediaId: job.mediaId!,
			filename: prev?.filename ?? "",
			url: prev?.url ?? "",
			suggestion: prev?.suggestion ?? null,
			status: "error",
			written: prev?.written ?? [],
			error,
			updated,
		});
		return;
	}
	const records = col<EntryRecord>(ctx, "aiEntries");
	const key = entryKey(job.collection!, job.entryId!);
	const prev = await records.get(key);
	// Keep what earlier runs found; an empty hash makes the next save retry.
	await records.put(key, {
		collection: job.collection!,
		entryId: job.entryId!,
		title: prev?.title ?? "",
		hash: "",
		status: "error",
		error,
		entities: prev?.entities ?? [],
		description: prev?.description ?? "",
		descriptionStatus: prev?.descriptionStatus ?? "none",
		updated,
	});
}

export { queueId };
