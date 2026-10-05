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
 * The queue lives in one option row. Batches are claimed with a
 * compare-and-swap on that row, so isolates working in parallel never take
 * the same pages. A new purge restarts it (new generation).
 */

/** Option rows: the switch, and the job's state. */
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
	queue: string[];
	total: number;
	warmed: number;
	failed: number;
	finishedAt?: string;
	error?: string;
	reason: string;
}

/** Most URLs one job warms (a guard for huge sitemaps). */
export const MAX_URLS = 5000;

export function newWarmState(reason: string, now = new Date()): WarmState {
	return { generation: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`, startedAt: now.toISOString(), phase: "collect", queue: [], total: 0, warmed: 0, failed: 0, reason };
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

// ── Storage (one option row; works from middleware, routes and the minute task) ──

export async function readWarmState(db: D1Database): Promise<WarmState | null> {
	const row = await db.prepare("SELECT value FROM options WHERE name = ?").bind(WARM_STATE_OPTION).first<{ value: string }>();
	if (!row) return null;
	try {
		return JSON.parse(row.value) as WarmState;
	} catch {
		return null;
	}
}

export async function writeWarmState(db: D1Database, state: WarmState): Promise<void> {
	await db
		.prepare("INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
		.bind(WARM_STATE_OPTION, JSON.stringify(state))
		.run();
}

/** Queue a fresh warm-up (replacing any running one). The minute task does the work. */
export async function startWarm(db: D1Database, reason: string): Promise<WarmState> {
	const state = newWarmState(reason);
	await writeWarmState(db, state);
	return state;
}

// ── Claims (compare-and-swap on the option row) ──

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
	let state: WarmState;
	try {
		state = JSON.parse(raw) as WarmState;
	} catch {
		return null;
	}
	if (state.phase === "collect") {
		if (state.collectingAt && now - Date.parse(state.collectingAt) < COLLECT_STALE_MS) return null;
		const next = { ...state, collectingAt: new Date(now).toISOString() };
		return (await swap(db, raw, next)) ? { kind: "collect", state: next } : null;
	}
	if (state.phase !== "warm" || !state.queue.length) return null;
	const urls = state.queue.slice(0, batchSize);
	const next = { ...state, queue: state.queue.slice(batchSize) };
	return (await swap(db, raw, next)) ? { kind: "warm", state: next, urls } : null;
}

/** Store the sitemap's URLs for the run that claimed the collect step. */
export async function finishCollect(db: D1Database, generation: string, urls: string[], origin: string): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const raw = await readRaw(db);
		if (!raw) return;
		const state = JSON.parse(raw) as WarmState;
		if (state.generation !== generation || state.phase !== "collect") return;
		const next: WarmState = urls.length
			? { ...state, phase: "warm", queue: urls, total: urls.length, collectingAt: undefined }
			: { ...state, phase: "failed", error: `No pages found in ${origin}/sitemap.xml.`, collectingAt: undefined };
		if (await swap(db, raw, next)) return;
	}
}

/** Count a finished batch; marks the run done when nothing is left. */
export async function recordBatch(db: D1Database, generation: string, warmed: number, failed: number, now = Date.now()): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const raw = await readRaw(db);
		if (!raw) return;
		const state = JSON.parse(raw) as WarmState;
		if (state.generation !== generation) return;
		const next: WarmState = { ...state, warmed: state.warmed + warmed, failed: state.failed + failed };
		if (!next.queue.length && next.warmed + next.failed >= next.total) {
			next.phase = "done";
			next.finishedAt = new Date(now).toISOString();
		}
		if (await swap(db, raw, next)) return;
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
