/**
 * AI Enrichment: pure logic (no imports, no I/O) so it can be unit tested
 * with `node --test`. Model-output parsing and validation, Wikidata grounding
 * filters, Portable Text → plain text, and queue batching.
 *
 * Ported from Coywolf SEO for WordPress (class-coywolf-seo-ai.php and
 * class-coywolf-seo-image-ai.php): the model extracts entity MENTIONS only
 * (never identifiers); real Wikidata candidates are looked up
 * deterministically; the model may only choose among those candidates; and
 * each chosen item's P31 (instance of) claims are checked against the
 * expected type.
 */

export const ENTITY_TYPES = ["Person", "Organization", "Place", "Thing"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const MAX_ENTITIES = 12;
export const DESCRIPTION_MAX = 155;
export const ALT_MAX = 250;
export const CAPTION_MAX = 300;

/** Q-number of a Wikimedia disambiguation page and of "human". */
const DISAMBIGUATION = "Q4167410";
const HUMAN = "Q5";

export interface Mention {
	surface: string;
	name: string;
	type: EntityType;
	description: string;
	primary: boolean;
}

export interface Candidate {
	id: string;
	label: string;
	description: string;
}

export interface GroundedMention extends Mention {
	qid: string;
	candidates: Candidate[];
}

export interface WikidataDetails {
	p31: string[];
	wikipedia: string;
	website: string;
}

/** A stored, verified entity. */
export interface Entity {
	name: string;
	type: EntityType;
	description: string;
	qid: string;
	wikipedia: string;
	website: string;
	primary: boolean;
}

export interface ImageText {
	alt: string;
	caption: string;
	title: string;
}

// ── Model output ─────────────────────────────────────────────────

/** Decode a model response that should be bare JSON, tolerating code fences and leading prose. */
export function decodeJson(text: unknown): unknown {
	if (text !== null && typeof text === "object") return text; // Workers AI may already return parsed JSON.
	let s = String(text ?? "").trim();
	s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
	const start = s.search(/[[{]/);
	if (start < 0) return null;
	s = s.slice(start);
	try {
		return JSON.parse(s);
	} catch {
		// Trailing prose after the JSON: cut at the last matching closer.
		const closer = s[0] === "[" ? "]" : "}";
		const end = s.lastIndexOf(closer);
		if (end <= 0) return null;
		try {
			return JSON.parse(s.slice(0, end + 1));
		} catch {
			return null;
		}
	}
}

/** Strip tags and control characters, collapse whitespace, cap length (on code points). */
export function cleanText(value: unknown, max = 500): string {
	if (typeof value !== "string" && typeof value !== "number") return "";
	let s = String(value)
		.replace(/<[^>]*>/g, " ")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/gu, " ")
		.trim();
	const chars = [...s];
	if (chars.length > max) s = chars.slice(0, max).join("").trim();
	return s;
}

/** Parse and sanitize the entity-extraction response (a JSON array of mentions). */
export function parseMentions(text: unknown): Mention[] {
	const rows = decodeJson(text);
	const list = Array.isArray(rows) ? rows : rows && typeof rows === "object" && Array.isArray((rows as { entities?: unknown }).entities) ? (rows as { entities: unknown[] }).entities : null;
	if (!list) return [];
	const out: Mention[] = [];
	const seen = new Set<string>();
	for (const row of list) {
		if (!row || typeof row !== "object" || Array.isArray(row)) continue;
		const r = row as Record<string, unknown>;
		const name = cleanText(r.name, 120);
		if (!name || !r.type) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const type = (ENTITY_TYPES as readonly string[]).includes(String(r.type)) ? (String(r.type) as EntityType) : "Thing";
		out.push({
			surface: cleanText(r.surface, 120),
			name,
			type,
			description: cleanText(r.description, 200),
			primary: r.primary === true || r.primary === "true",
		});
		if (out.length >= MAX_ENTITIES) break;
	}
	return out;
}

/** Parse the disambiguation response: { "Entity name": "Q123" | null }. */
export function parseChoices(text: unknown): Record<string, string | null> {
	const decoded = decodeJson(text);
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return {};
	const out: Record<string, string | null> = {};
	for (const [name, value] of Object.entries(decoded as Record<string, unknown>)) {
		out[name] = typeof value === "string" && /^Q\d+$/i.test(value.trim()) ? value.trim().toUpperCase() : null;
	}
	return out;
}

/** Normalize a generated meta description: plain single line, no wrapping quotes, ≤ max chars cut on a word. */
export function cleanDescription(text: unknown, max = DESCRIPTION_MAX): string {
	let s = cleanText(typeof text === "string" ? text : "", 2000);
	const unquote = (v: string) => v.replace(/^["'“‘]+|["'”’]+$/gu, "").trim();
	s = unquote(unquote(s).replace(/^(meta description|description)\s*:\s*/i, ""));
	const chars = [...s];
	if (chars.length <= max) return s;
	const cut = chars.slice(0, max - 1).join("");
	const space = cut.lastIndexOf(" ");
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/u, "")}…`;
}

/** Parse the image-text response ({ alt_text, title, caption, description }). Throws when nothing usable came back. */
export function parseImageText(text: unknown): ImageText {
	if (typeof text === "string" && !text.trim()) {
		throw new Error("The AI service returned an empty response (it may have run out of output tokens). Try again, or pick a different model.");
	}
	const fields = decodeJson(text);
	if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
		throw new Error("The AI service returned a response that could not be parsed. Try again.");
	}
	const f = fields as Record<string, unknown>;
	const alt = cleanText(f.alt_text ?? f.alt, ALT_MAX).replace(/^(an? )?(image|photo|picture|graphic) of /i, "");
	const result: ImageText = {
		alt: alt ? alt[0].toUpperCase() + alt.slice(1) : "",
		caption: cleanText(f.caption, CAPTION_MAX),
		title: cleanText(f.title, 120),
	};
	if (!result.alt && !result.title) throw new Error("The AI service did not return usable image text. Try again.");
	return result;
}

// ── Wikidata grounding ───────────────────────────────────────────

/** Parse a wbsearchentities response into candidates. */
export function parseSearch(body: unknown): Candidate[] {
	const search = (body as { search?: unknown })?.search;
	if (!Array.isArray(search)) return [];
	const out: Candidate[] = [];
	for (const hit of search) {
		const id = (hit as { id?: unknown })?.id;
		if (typeof id !== "string" || !/^Q\d+$/.test(id)) continue;
		out.push({
			id,
			label: cleanText((hit as { label?: unknown }).label, 200),
			description: cleanText((hit as { description?: unknown }).description, 300),
		});
	}
	return out;
}

/** Parse a wbgetentities (claims|sitelinks) response: P31 values, the Wikipedia sitelink, and P856 (official website). */
export function parseDetails(body: unknown, language: string): Record<string, WikidataDetails> {
	const entities = (body as { entities?: unknown })?.entities;
	if (!entities || typeof entities !== "object") return {};
	const wiki = `${language}wiki`;
	const out: Record<string, WikidataDetails> = {};
	for (const [qid, raw] of Object.entries(entities as Record<string, unknown>)) {
		const entity = raw as { claims?: Record<string, unknown[]>; sitelinks?: Record<string, { title?: string }> };
		const claimValues = (prop: string) =>
			(Array.isArray(entity?.claims?.[prop]) ? entity.claims[prop] : [])
				.filter((c) => (c as { rank?: string })?.rank !== "deprecated")
				.map((c) => (c as { mainsnak?: { datavalue?: { value?: unknown } } })?.mainsnak?.datavalue?.value);
		const p31 = claimValues("P31")
			.map((v) => (v as { id?: unknown })?.id)
			.filter((id): id is string => typeof id === "string");
		const website = claimValues("P856").find((v): v is string => typeof v === "string" && /^https?:\/\//i.test(v)) ?? "";
		const title = entity?.sitelinks?.[wiki]?.title;
		const wikipedia =
			typeof title === "string" && title
				? `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_")).replace(/%2F/g, "/").replace(/%3A/g, ":")}`
				: "";
		out[qid] = { p31, wikipedia, website };
	}
	return out;
}

/** Stage 2: attach candidates; a single candidate resolves immediately, several go to disambiguation. Mentions with none are dropped later. */
export function attachCandidates(mentions: Mention[], candidates: Candidate[][]): { mentions: GroundedMention[]; ambiguous: number[] } {
	const ambiguous: number[] = [];
	const grounded = mentions.map((m, i) => {
		const list = candidates[i] ?? [];
		if (list.length > 1) ambiguous.push(i);
		return { ...m, candidates: list, qid: list.length === 1 ? list[0].id : "" };
	});
	return { mentions: grounded, ambiguous };
}

/** Stage 3: trust a choice only when it is one of the real candidates. */
export function applyChoices(mentions: GroundedMention[], ambiguous: number[], choices: Record<string, string | null>): GroundedMention[] {
	const out = mentions.map((m) => ({ ...m }));
	for (const i of ambiguous) {
		const mention = out[i];
		if (!mention) continue;
		const chosen = choices[mention.name];
		if (!chosen) continue;
		if (mention.candidates.some((c) => c.id === chosen)) mention.qid = chosen;
	}
	return out;
}

/** Stage 4: drop unresolved mentions, disambiguation pages, and type mismatches (Person ⇔ human Q5). */
export function verifyEntities(mentions: GroundedMention[], details: Record<string, WikidataDetails>): Entity[] {
	const out: Entity[] = [];
	const seen = new Set<string>();
	for (const m of mentions) {
		if (!m.qid || seen.has(m.qid)) continue;
		const info = details[m.qid] ?? { p31: [], wikipedia: "", website: "" };
		if (info.p31.includes(DISAMBIGUATION)) continue;
		const human = info.p31.includes(HUMAN);
		if (m.type === "Person" && info.p31.length > 0 && !human) continue;
		if (m.type !== "Person" && human) continue;
		seen.add(m.qid);
		out.push({
			name: m.name,
			type: m.type,
			description: m.description,
			qid: m.qid,
			wikipedia: info.wikipedia,
			website: info.website,
			primary: m.primary,
		});
	}
	return out;
}

/** Schema.org nodes for stored entities: { about, mentions }. */
export function entityNodes(entities: Entity[] | undefined | null): { about: Record<string, unknown>[]; mentions: Record<string, unknown>[] } {
	const about: Record<string, unknown>[] = [];
	const mentions: Record<string, unknown>[] = [];
	for (const e of entities ?? []) {
		if (!e?.name || !e.qid || !/^Q\d+$/.test(e.qid)) continue;
		const sameAs = [`https://www.wikidata.org/wiki/${e.qid}`];
		if (e.wikipedia) sameAs.push(e.wikipedia);
		if (e.website) sameAs.push(e.website);
		const node: Record<string, unknown> = {
			"@type": (ENTITY_TYPES as readonly string[]).includes(e.type) ? e.type : "Thing",
			name: e.name,
			sameAs: sameAs.length > 1 ? sameAs : sameAs[0],
		};
		if (e.description) node.description = e.description;
		(e.primary ? about : mentions).push(node);
	}
	return { about, mentions };
}

// ── Content → plain text ─────────────────────────────────────────

/** Plain text from a Portable Text value (or any nested structure holding blocks), paragraphs separated by blank lines. */
export function portableTextToPlain(value: unknown, depth = 0): string {
	if (depth > 8 || value == null) return "";
	if (typeof value === "string") return "";
	if (Array.isArray(value)) {
		return value
			.map((v) => portableTextToPlain(v, depth + 1))
			.filter(Boolean)
			.join("\n\n");
	}
	if (typeof value !== "object") return "";
	const node = value as Record<string, unknown>;
	if (node._type === "block" && Array.isArray(node.children)) {
		return node.children
			.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
			.join("")
			.trim();
	}
	// Custom blocks: look inside nested arrays (columns, callouts…) and plain text props.
	const parts: string[] = [];
	for (const [key, child] of Object.entries(node)) {
		if (key.startsWith("_") || key === "markDefs") continue;
		if (Array.isArray(child) || (child && typeof child === "object")) {
			const text = portableTextToPlain(child, depth + 1);
			if (text) parts.push(text);
		} else if ((key === "text" || key === "caption" || key === "quote") && typeof child === "string" && child.trim()) {
			parts.push(child.trim());
		}
	}
	return parts.join("\n\n");
}

/** A bounded plain-text rendition of an entry: its text-like fields in order. */
export function entryPlainText(data: Record<string, unknown>, fields: Array<{ slug: string; type: string }>, limit = 24000): string {
	const parts: string[] = [];
	for (const field of fields) {
		const value = data[field.slug];
		if (field.type === "portableText" || field.type === "blocks") parts.push(portableTextToPlain(value));
		else if (field.type === "text" && typeof value === "string") parts.push(value.replace(/<[^>]*>/g, " "));
	}
	const text = parts
		.map((p) => p.trim())
		.filter(Boolean)
		.join("\n\n")
		.replace(/[ \t]+/g, " ");
	return [...text].slice(0, limit).join("");
}

// ── Queue ────────────────────────────────────────────────────────

export interface QueueJob {
	kind: "entry" | "media";
	collection?: string;
	entryId?: string;
	mediaId?: string;
	/** Epoch ms when the job may run (debounce / backoff). */
	due: number;
	attempts: number;
	force?: boolean;
	enqueuedAt: number;
	lastError?: string;
}

export const MAX_ATTEMPTS = 3;

export function queueId(job: Pick<QueueJob, "kind" | "collection" | "entryId" | "mediaId">): string {
	return job.kind === "media" ? `media:${job.mediaId}` : `entry:${job.collection}:${job.entryId}`;
}

/**
 * Pick the jobs to run this tick: due jobs in due order, at most `perTick`,
 * and never more model calls than the day's remaining allowance (each job
 * costs up to `callsPerJob` calls).
 */
export function planBatch(
	jobs: Array<{ id: string; data: QueueJob }>,
	opts: { now: number; perTick: number; remainingCalls: number; callsPerJob: (job: QueueJob) => number },
): Array<{ id: string; data: QueueJob }> {
	const due = jobs.filter((j) => j.data.due <= opts.now).sort((a, b) => a.data.due - b.data.due || a.id.localeCompare(b.id));
	const out: Array<{ id: string; data: QueueJob }> = [];
	let budget = Math.max(0, opts.remainingCalls);
	for (const job of due) {
		if (out.length >= opts.perTick) break;
		const cost = opts.callsPerJob(job.data);
		if (cost > budget) break; // Keep order: don't let a cheaper later job jump the line.
		budget -= cost;
		out.push(job);
	}
	return out;
}

/** Retry schedule after a failure: 5, 20, 80 minutes; null when the job should be dropped. */
export function retryAt(job: QueueJob, now: number): number | null {
	const attempts = job.attempts + 1;
	if (attempts >= MAX_ATTEMPTS) return null;
	return now + 5 * 60_000 * 4 ** (attempts - 1);
}

/** Merge a re-enqueue into an existing job: push the debounce later, keep attempts reset, keep force if either asked. */
export function mergeJob(existing: QueueJob | null, next: QueueJob): QueueJob {
	if (!existing) return next;
	return { ...next, force: Boolean(existing.force || next.force), enqueuedAt: Math.min(existing.enqueuedAt, next.enqueuedAt), attempts: 0 };
}

/** UTC day key for the daily call counter. */
export function dayKey(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}
