/**
 * The crawler directory: a bundled baseline (src/robots/data/bots.json, built
 * from Cloudflare Radar's bot directory with each robots.txt token checked
 * against the operator's documentation) plus an overlay refreshed weekly
 * from the Radar API (see ./radar.ts).
 *
 * Radar publishes user-agent *patterns*, not robots.txt tokens, so a bot that
 * first appears through the API gets a token derived from its pattern and is
 * marked unverified until a person checks it (the baseline is updated by
 * hand with a source URL).
 *
 * No imports, so the tests can run this file under plain Node.
 */

export type BotStatus = "verified" | "unverified";
/** How the token was confirmed: operator docs, the bot's published UA string, derived from a pattern, or checked by an admin on this site. */
export type BotEvidence = "operator-docs" | "user-agent" | "heuristic" | "none" | "manual";

export interface BotEntry {
	slug: string;
	name: string;
	operator: string;
	/** Radar category, e.g. AI_CRAWLER. */
	category: string;
	description: string;
	/** The robots.txt product token (`User-agent:` value). */
	token: string;
	aliases?: string[];
	status: BotStatus;
	evidence: BotEvidence;
	sourceUrl?: string;
	/** ISO date the token was last checked against `sourceUrl`. */
	verifiedAt?: string;
	note?: string;
	/** "radar" (in Cloudflare's directory), "curated" (operator-documented token Radar doesn't list) or "custom" (added on this site). */
	origin: "radar" | "curated" | "custom";
	/** Who verified it on this site (admin overrides). */
	verifiedBy?: string;
	/** The name before an admin renamed it. */
	originalName?: string;
	/** Set when the bot was last seen in, or has left, the Radar directory (from the weekly sync). */
	radarSeenAt?: string;
	delisted?: boolean;
	/** Other Radar slugs that share this token and were merged into this entry. */
	mergedSlugs?: string[];
}

/** A record from GET /client/v4/radar/bots. */
export interface RadarBot {
	slug: string;
	name: string;
	operator?: string;
	category?: string;
	description?: string;
	kind?: string;
	userAgentPatterns?: string[];
}

/** What the sync stores per slug (plugin storage), over the baseline. */
export interface BotOverlay {
	slug: string;
	name?: string;
	operator?: string;
	category?: string;
	description?: string;
	/** Only for bots the baseline doesn't have. */
	token?: string | null;
	patterns?: string[];
	firstSeenAt?: string;
	radarSeenAt?: string;
	delisted?: boolean;
}

export const CATEGORY_LABELS: Record<string, string> = {
	AI_CRAWLER: "AI crawler",
	AI_ASSISTANT: "AI assistant",
	AI_SEARCH: "AI search",
	SEARCH_ENGINE_CRAWLER: "Search engine",
	SEARCH_ENGINE_OPTIMIZATION: "SEO tool",
	MONITORING_AND_ANALYTICS: "Monitoring and analytics",
	ADVERTISING_AND_MARKETING: "Advertising and marketing",
	SOCIAL_MEDIA_MARKETING: "Social media marketing",
	PAGE_PREVIEW: "Link preview",
	FEED_FETCHER: "Feed reader",
	ACADEMIC_RESEARCH: "Academic research",
	SECURITY: "Security",
	ACCESSIBILITY: "Accessibility",
	AGGREGATOR: "Aggregator",
	ARCHIVER: "Archiver",
	WEBHOOKS: "Webhooks",
	OTHER: "Other",
};

export function categoryLabel(category: string): string {
	return (
		CATEGORY_LABELS[category] ??
		category
			.toLowerCase()
			.split("_")
			.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
			.join(" ")
	);
}

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Best guess at a robots.txt token from Radar's UA patterns ("Barkrowler/",
 * "meta-externaltest/1\.1") or the bot name. Null when nothing is token-shaped.
 */
export function deriveToken(patterns: string[] | undefined, name: string): string | null {
	for (const p of patterns ?? []) {
		const t = p.replace(/\\/g, "").replace(/\/.*$/, "").trim();
		if (TOKEN_RE.test(t) && t.toLowerCase() !== "user_agent") return t;
	}
	const n = name.trim();
	return TOKEN_RE.test(n) ? n : null;
}

const clip = (s: string | undefined) => {
	const t = (s ?? "").replace(/\s+/g, " ").trim();
	return t.length > 240 ? `${t.slice(0, 237).trimEnd()}…` : t;
};

/** Baseline + overlay → the directory the admin shows. Bots without a token are left out. */
export function mergeDirectory(baseline: BotEntry[], overlays: BotOverlay[]): BotEntry[] {
	const bySlug = new Map(baseline.map((b) => [b.slug, { ...b }]));
	for (const o of overlays) {
		const base = bySlug.get(o.slug);
		if (base) {
			if (o.name) base.name = o.name;
			if (o.operator) base.operator = o.operator;
			if (o.category) base.category = o.category;
			if (o.description) base.description = o.description;
			if (o.radarSeenAt) base.radarSeenAt = o.radarSeenAt;
			if (o.delisted) base.delisted = true;
			continue;
		}
		if (!o.token) continue;
		bySlug.set(o.slug, {
			slug: o.slug,
			name: o.name ?? o.slug,
			operator: o.operator ?? "",
			category: o.category ?? "OTHER",
			description: o.description ?? "",
			token: o.token,
			status: "unverified",
			evidence: "heuristic",
			sourceUrl: `https://radar.cloudflare.com/bots/directory/${encodeURIComponent(o.slug)}`,
			note: "Added from Cloudflare Radar; the token was derived from its user-agent pattern and hasn't been checked against the operator's documentation.",
			origin: "radar",
			radarSeenAt: o.radarSeenAt,
			delisted: o.delisted,
		});
	}
	return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

export interface RadarMergeResult {
	/** Overlay documents to write (only ones that changed). */
	writes: BotOverlay[];
	added: number;
	updated: number;
	delisted: number;
	total: number;
}

const sameOverlay = (a: BotOverlay | undefined, b: BotOverlay) => {
	if (!a) return false;
	const { radarSeenAt: _x, ...ra } = a;
	const { radarSeenAt: _y, ...rb } = b;
	return JSON.stringify(ra, Object.keys(ra).sort()) === JSON.stringify(rb, Object.keys(rb).sort());
};

/**
 * Merge a Radar listing into the stored overlay. Only differences from the
 * baseline are stored, and a document is rewritten only when its content
 * changed (radarSeenAt alone doesn't count), so a quiet week costs no writes.
 */
export function mergeRadar(baseline: BotEntry[], existing: BotOverlay[], radar: RadarBot[], now: string): RadarMergeResult {
	const base = new Map(baseline.map((b) => [b.slug, b]));
	// Radar slugs merged into another entry (same token) count as that entry.
	const primary = new Map<string, string>();
	for (const b of baseline) for (const s of b.mergedSlugs ?? []) primary.set(s, b.slug);
	const prev = new Map(existing.map((o) => [o.slug, o]));
	const live = new Set<string>();
	const writes: BotOverlay[] = [];
	let added = 0;
	let updated = 0;
	let delisted = 0;

	for (const bot of radar) {
		if (!bot?.slug || typeof bot.slug !== "string") continue;
		const merged = primary.get(bot.slug);
		if (merged) {
			live.add(merged);
			continue;
		}
		live.add(bot.slug);
		const b = base.get(bot.slug);
		const fields = {
			name: bot.name?.trim() || undefined,
			operator: bot.operator?.trim() || undefined,
			category: bot.category?.trim() || undefined,
			description: clip(bot.description) || undefined,
		};
		let next: BotOverlay;
		if (b) {
			next = { slug: bot.slug };
			if (fields.name && fields.name !== b.name) next.name = fields.name;
			if (fields.operator && fields.operator !== b.operator) next.operator = fields.operator;
			if (fields.category && fields.category !== b.category) next.category = fields.category;
			if (fields.description && fields.description !== b.description) next.description = fields.description;
			if (Object.keys(next).length === 1 && !prev.has(bot.slug)) continue; // Matches the baseline.
		} else {
			const old = prev.get(bot.slug);
			next = {
				slug: bot.slug,
				...fields,
				token: deriveToken(bot.userAgentPatterns, bot.name ?? ""),
				patterns: (bot.userAgentPatterns ?? []).slice(0, 10),
				firstSeenAt: old?.firstSeenAt ?? now,
			};
			if (!old && next.token) added++;
		}
		next.radarSeenAt = now;
		const old = prev.get(bot.slug);
		if (sameOverlay(old, next)) continue;
		if (b) updated++;
		writes.push(next);
	}

	// Radar-sourced bots that left the directory stay usable (robots.txt rules may name them) but are flagged.
	for (const b of baseline) {
		if (b.origin !== "radar" || live.has(b.slug)) continue;
		const old = prev.get(b.slug);
		if (old?.delisted) continue;
		writes.push({ ...(old ?? { slug: b.slug }), delisted: true });
		delisted++;
	}
	for (const o of existing) {
		if (base.has(o.slug) || live.has(o.slug) || o.delisted) continue;
		writes.push({ ...o, delisted: true });
		delisted++;
	}

	return { writes, added, updated, delisted, total: live.size };
}

/** An admin's change to one directory entry (or a bot they added), kept in plugin storage. */
export interface BotOverride {
	/** Directory slug, or "custom-<token>" for bots added on this site. */
	slug: string;
	name?: string;
	verified?: { sourceUrl: string; note?: string; at: string; by?: string };
	custom?: {
		token: string;
		category: string;
		operator?: string;
		sourceUrl?: string;
		notes?: string;
		createdAt: string;
		createdBy?: string;
	};
}

export const customSlug = (token: string) => `custom-${token.toLowerCase().replace(/[^a-z0-9._-]/g, "-")}`;

/** Directory (bundled + Radar) with this site's overrides and custom bots applied. */
export function applyOverrides(directory: BotEntry[], overrides: BotOverride[]): BotEntry[] {
	const bySlug = new Map(directory.map((b) => [b.slug, { ...b }]));
	for (const o of overrides) {
		if (o.custom) {
			bySlug.set(o.slug, {
				slug: o.slug,
				name: o.name || o.custom.token,
				operator: o.custom.operator ?? "",
				category: o.custom.category || "OTHER",
				description: o.custom.notes ?? "",
				token: o.custom.token,
				status: o.verified ? "verified" : "unverified",
				evidence: o.verified ? "manual" : "none",
				sourceUrl: o.verified?.sourceUrl || o.custom.sourceUrl,
				verifiedAt: o.verified?.at,
				verifiedBy: o.verified?.by,
				note: o.verified?.note ?? o.custom.notes,
				origin: "custom",
			});
			continue;
		}
		const b = bySlug.get(o.slug);
		if (!b) continue;
		if (o.name && o.name !== b.name) {
			b.originalName = b.name;
			b.name = o.name;
		}
		if (o.verified) {
			b.status = "verified";
			b.evidence = "manual";
			b.sourceUrl = o.verified.sourceUrl;
			b.verifiedAt = o.verified.at;
			b.verifiedBy = o.verified.by;
			if (o.verified.note) b.note = o.verified.note;
		}
	}
	return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}
