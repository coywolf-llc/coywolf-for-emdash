/**
 * Cache warming: after the page cache is cleared (a deploy, a full purge),
 * visit every URL in the sitemap so the next visitor gets a cached page.
 *
 * Workers Cache is tiered: a page fetched once is stored in the data center
 * that fetched it and in the region's upper tier, which every data center in
 * that region consults on a miss. Warming from the Worker therefore warms the
 * region it runs in (with Smart Placement, the one near the database); other
 * regions still fill on their first visit.
 *
 * The work rides on real traffic: after the site answers a page request, the
 * Worker claims a small batch from the queue and visits it in the background
 * (waitUntil). Cron Triggers can't do this: they run in whatever data center
 * has spare capacity (often on another continent), far from the database and
 * the readers, and placement hints don't apply to them. Visits from request
 * context run where the traffic is (with Smart Placement, near the database),
 * so they warm the region the readers and crawlers come from.
 *
 * The job's progress lives in one small option row, the URLs in rows of
 * their own written once per run. Batches are claimed with a compare-and-swap
 * on the progress row (moving its `next` index), so isolates working in
 * parallel never take the same pages. A new purge restarts it (new
 * generation) and clears older runs' URL rows.
 */

/** Option rows: the switch, and the job's progress (its URLs are in WARM_QUEUE_PREFIX rows). */
export const WARM_SETTING = "pageCacheWarm";
export const WARM_STATE_OPTION = "plugin:coywolf-pack:pageCache:warmState";

export interface WarmState {
	/** Changes on every (re)start; a running batch stops when it no longer matches. */
	generation: string;
	startedAt: string;
	/** "collect" until the sitemap has been read, then "warm" until the queue is empty. */
	phase: "collect" | "warm" | "done" | "failed";
	/** When an isolate took the collect step (so a stalled one can be retried). */
	collectingAt?: string;
	/** Index of the next URL to hand to a batch (URLs 0…next-1 are claimed). */
	next: number;
	total: number;
	warmed: number;
	failed: number;
	finishedAt?: string;
	error?: string;
	reason: string;
	/** Read from a row in the format before 0.26 (progress only; nothing works on it). */
	legacy?: boolean;
}

/** Most URLs one job warms (a guard for huge sitemaps). */
export const MAX_URLS = 5000;

export function newWarmState(reason: string, now = new Date()): WarmState {
	return { generation: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`, startedAt: now.toISOString(), phase: "collect", next: 0, total: 0, warmed: 0, failed: 0, reason };
}

/** <loc> values of a sitemap or sitemap index (XML entities decoded). */
export function sitemapLocs(xml: string): { isIndex: boolean; locs: string[] } {
	const isIndex = /<sitemapindex[\s>]/i.test(xml);
	const locs = [...xml.matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi)].map((m) =>
		m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
	);
	return { isIndex, locs };
}

/** Most links taken from the home page (its menus and section pages). */
export const MAX_HOME_LINKS = 200;

/**
 * Same-origin page links in the home page: menus, footers and section pages
 * (category archives such as /notes/) that sitemaps often leave out. Skips
 * EmDash/plugin routes, feeds, files and URLs with a query string.
 */
export function homeLinks(html: string, origin: string, max = MAX_HOME_LINKS): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
		if (out.length >= max) break;
		const raw = (m[1] ?? m[2] ?? "").replace(/&amp;/g, "&").trim();
		if (!raw || raw.startsWith("#")) continue;
		let url: URL;
		try {
			url = new URL(raw, origin);
		} catch {
			continue;
		}
		if (url.origin !== origin || url.search) continue;
		const path = url.pathname;
		if (/^\/_/.test(path) || /\/feed\/?$/.test(path) || /\.[a-z0-9]{2,5}$/i.test(path)) continue;
		url.hash = "";
		out.push(url.href);
	}
	return out;
}

/**
 * The URLs to warm, same-origin only, without duplicates, home page first,
 * then in sitemap order (newest posts first on most sites), capped.
 */
export function warmOrder(origin: string, urls: string[], max = MAX_URLS): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	const add = (raw: string) => {
		let url: URL;
		try {
			url = new URL(raw, origin);
		} catch {
			return;
		}
		if (url.origin !== origin) return;
		url.hash = "";
		const key = url.href;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(key);
	};
	add(`${origin}/`);
	for (const u of urls) {
		if (out.length >= max) break;
		add(u);
	}
	return out.slice(0, max);
}

interface Fetcher {
	fetch(request: Request): Promise<Response>;
}

/** Read the sitemap (following a sitemap index one level) into the warm order. */
export async function collectUrls(self: Fetcher, origin: string): Promise<string[]> {
	const read = async (url: string) => {
		const res = await self.fetch(new Request(url, { headers: { "User-Agent": WARMER_AGENT } }));
		return res.ok ? res.text() : "";
	};
	// Pages the home page links to (menus, section pages) come right after it.
	const linked = homeLinks(await read(`${origin}/`), origin);
	const root = sitemapLocs(await read(`${origin}/sitemap.xml`));
	let urls = root.locs;
	if (root.isIndex) {
		urls = [];
		for (const child of root.locs.slice(0, 50)) {
			if (new URL(child, origin).origin !== origin) continue;
			urls.push(...sitemapLocs(await read(child)).locs);
			if (urls.length >= MAX_URLS) break;
		}
	}
	return warmOrder(origin, [...linked, ...urls]);
}

// ── Storage (option rows; works from middleware, routes and the minute task) ──
//
// The job's state is one small row (the progress). The URLs to visit are
// written once per run, in chunks of QUEUE_CHUNK, to rows of their own that
// never change; claiming a batch only moves the progress row's `next` index,
// so each claim rewrites a few hundred bytes instead of the whole queue.

/** Prefix of a run's URL rows: `<prefix><generation>:<chunk index>`. */
export const WARM_QUEUE_PREFIX = "plugin:coywolf-pack:pageCache:warmQueue:";
/** URLs per queue row (about 50 KB of JSON at most). */
export const QUEUE_CHUNK = 500;

const queueRow = (generation: string, chunk: number) => `${WARM_QUEUE_PREFIX}${generation}:${chunk}`;

/** A state row from before the queue moved to rows of its own (`queue` held the URLs left). */
type LegacyState = Omit<WarmState, "next"> & { next?: number; queue?: string[] };

function parseState(raw: string): WarmState | null {
	try {
		const state = JSON.parse(raw) as LegacyState;
		if (typeof state.next === "number") return state as WarmState;
		// Older format: report it, but it can't be worked on (the next deploy or clear starts a new run).
		const left = Array.isArray(state.queue) ? state.queue.length : 0;
		const { queue: _queue, ...rest } = state;
		return { ...rest, next: state.total - left, legacy: true } as WarmState;
	} catch {
		return null;
	}
}

export async function readWarmState(db: D1Database): Promise<WarmState | null> {
	const raw = await readRaw(db);
	return raw ? parseState(raw) : null;
}

/** URLs of a run not yet handed to a batch. */
export function remainingUrls(state: WarmState): number {
	return state.phase === "warm" ? Math.max(0, state.total - state.next) : 0;
}

export async function writeWarmState(db: D1Database, state: WarmState): Promise<void> {
	await db
		.prepare("INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
		.bind(WARM_STATE_OPTION, JSON.stringify(state))
		.run();
}

/** Delete a run's URL rows, or every run's but `keep`'s. */
async function deleteQueue(db: D1Database, generation: string | null, keep?: string): Promise<void> {
	if (generation) {
		await db.prepare("DELETE FROM options WHERE name LIKE ?").bind(`${WARM_QUEUE_PREFIX}${generation}:%`).run();
		return;
	}
	await db
		.prepare("DELETE FROM options WHERE name LIKE ? AND name NOT LIKE ?")
		.bind(`${WARM_QUEUE_PREFIX}%`, `${WARM_QUEUE_PREFIX}${keep ?? ""}:%`)
		.run();
}

/** Write a run's URLs to its queue rows (immutable for the run). */
export async function writeWarmQueue(db: D1Database, generation: string, urls: string[]): Promise<void> {
	const statements = [];
	for (let i = 0; i * QUEUE_CHUNK < urls.length; i++) {
		statements.push(
			db
				.prepare("INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
				.bind(queueRow(generation, i), JSON.stringify(urls.slice(i * QUEUE_CHUNK, (i + 1) * QUEUE_CHUNK))),
		);
	}
	if (statements.length) await db.batch(statements);
}

/** Queue rows read in this isolate, for the current run only (they never change within a run). */
const chunkCache = new Map<string, string[]>();
let chunkGeneration = "";

/** URLs `start` (inclusive) to `end` (exclusive) of a run's queue; fewer if its rows are gone (a newer run cleaned them up). */
async function queueSlice(db: D1Database, generation: string, start: number, end: number): Promise<string[]> {
	if (chunkGeneration !== generation) {
		chunkCache.clear();
		chunkGeneration = generation;
	}
	const first = Math.floor(start / QUEUE_CHUNK);
	const last = Math.floor((end - 1) / QUEUE_CHUNK);
	const missing: string[] = [];
	for (let i = first; i <= last; i++) if (!chunkCache.has(queueRow(generation, i))) missing.push(queueRow(generation, i));
	if (missing.length) {
		const { results } = await db
			.prepare(`SELECT name, value FROM options WHERE name IN (${missing.map(() => "?").join(",")})`)
			.bind(...missing)
			.all<{ name: string; value: string }>();
		for (const row of results ?? []) {
			try {
				chunkCache.set(row.name, JSON.parse(row.value) as string[]);
			} catch {
				// An unreadable row: its URLs are skipped.
			}
		}
	}
	const out: string[] = [];
	for (let i = first; i <= last; i++) {
		const urls = chunkCache.get(queueRow(generation, i));
		if (!urls) continue;
		const from = Math.max(start - i * QUEUE_CHUNK, 0);
		const to = Math.min(end - i * QUEUE_CHUNK, QUEUE_CHUNK);
		out.push(...urls.slice(from, to));
	}
	return out;
}

/** Queue a fresh warm-up (replacing any running one, and clearing older runs' URL rows). Page traffic does the work. */
export async function startWarm(db: D1Database, reason: string): Promise<WarmState> {
	const state = newWarmState(reason);
	await writeWarmState(db, state);
	await deleteQueue(db, null, state.generation).catch((error) => console.error("coywolf-pack: could not clear old warm queues", error));
	return state;
}

// ── Claims (compare-and-swap on the progress row) ──

async function readRaw(db: D1Database): Promise<string | null> {
	const row = await db.prepare("SELECT value FROM options WHERE name = ?").bind(WARM_STATE_OPTION).first<{ value: string }>();
	return row?.value ?? null;
}

/** Replace the row only if nobody changed it since `before` was read. */
async function swap(db: D1Database, before: string, after: WarmState): Promise<boolean> {
	const result = await db.prepare("UPDATE options SET value = ? WHERE name = ? AND value = ?").bind(JSON.stringify(after), WARM_STATE_OPTION, before).run();
	return (result.meta?.changes ?? 0) > 0;
}

export type Claim = { kind: "collect"; state: WarmState } | { kind: "warm"; state: WarmState; urls: string[] } | null;

const COLLECT_STALE_MS = 2 * 60_000;

/** Take the next piece of work, if any: reading the sitemap, or a batch of URLs. */
export async function claimWork(db: D1Database, batchSize: number, now = Date.now()): Promise<Claim> {
	const raw = await readRaw(db);
	if (!raw) return null;
	const state = parseState(raw);
	if (!state || state.legacy) return null;
	if (state.phase === "collect") {
		if (state.collectingAt && now - Date.parse(state.collectingAt) < COLLECT_STALE_MS) return null;
		const next = { ...state, collectingAt: new Date(now).toISOString() };
		return (await swap(db, raw, next)) ? { kind: "collect", state: next } : null;
	}
	if (state.phase !== "warm" || state.next >= state.total) return null;
	const end = Math.min(state.next + batchSize, state.total);
	const next = { ...state, next: end };
	if (!(await swap(db, raw, next))) return null;
	const urls = await queueSlice(db, state.generation, state.next, end);
	// URLs whose row is gone count as failed, so the run still finishes.
	if (urls.length < end - state.next) await recordBatch(db, state.generation, 0, end - state.next - urls.length, now);
	return { kind: "warm", state: next, urls };
}

/** Store the sitemap's URLs for the run that claimed the collect step. */
export async function finishCollect(db: D1Database, generation: string, urls: string[], origin: string): Promise<void> {
	if (urls.length) await writeWarmQueue(db, generation, urls);
	for (let attempt = 0; attempt < 3; attempt++) {
		const raw = await readRaw(db);
		const state = raw ? parseState(raw) : null;
		if (!raw || !state || state.generation !== generation || state.phase !== "collect") break;
		const next: WarmState = urls.length
			? { ...state, phase: "warm", next: 0, total: urls.length, collectingAt: undefined }
			: { ...state, phase: "failed", error: `No pages found in ${origin}/sitemap.xml.`, collectingAt: undefined };
		if (await swap(db, raw, next)) return;
	}
	// Superseded by a newer run (or never stored): don't leave its URLs behind.
	if (urls.length) await deleteQueue(db, generation).catch(() => undefined);
}

/** Count a finished batch; marks the run done (and drops its URL rows) when nothing is left. */
export async function recordBatch(db: D1Database, generation: string, warmed: number, failed: number, now = Date.now()): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const raw = await readRaw(db);
		if (!raw) return;
		const state = parseState(raw);
		if (!state || state.legacy || state.generation !== generation) return;
		const next: WarmState = { ...state, warmed: state.warmed + warmed, failed: state.failed + failed };
		const finished = next.phase === "warm" && next.next >= next.total && next.warmed + next.failed >= next.total;
		if (finished) {
			next.phase = "done";
			next.finishedAt = new Date(now).toISOString();
		}
		if (await swap(db, raw, next)) {
			if (finished) await deleteQueue(db, generation).catch(() => undefined);
			return;
		}
	}
}

/** Visit URLs through the Worker's own service binding (which shares its cache). */
export async function visit(self: Fetcher, urls: string[]): Promise<{ warmed: number; failed: number }> {
	const results = await Promise.all(
		urls.map(async (url) => {
			try {
				const res = await self.fetch(new Request(url, { headers: { "User-Agent": WARMER_AGENT } }));
				await res.arrayBuffer();
				return res.ok || (res.status >= 300 && res.status < 400);
			} catch {
				return false;
			}
		}),
	);
	return { warmed: results.filter(Boolean).length, failed: results.filter((ok) => !ok).length };
}

export const WARMER_AGENT = "CoywolfPack-CacheWarmer";

/**
 * One step of warming, run in the background of a page request: claim a piece
 * of work and do it, within a time budget. Returns what it did (for tests/logs).
 */
export async function warmStep(db: D1Database, self: Fetcher, origin: string, options: { budgetMs: number; batchSize: number; now?: () => number }): Promise<string> {
	const now = options.now ?? Date.now;
	const deadline = now() + options.budgetMs;
	let did = "idle";
	while (now() < deadline) {
		const claim = await claimWork(db, options.batchSize, now());
		if (!claim) return did;
		if (claim.kind === "collect") {
			const urls = await collectUrls(self, origin).catch(() => []);
			await finishCollect(db, claim.state.generation, urls, origin);
			did = "collected";
			continue;
		}
		const { warmed, failed } = await visit(self, claim.urls);
		await recordBatch(db, claim.state.generation, warmed, failed, now());
		did = "warmed";
	}
	return did;
}
