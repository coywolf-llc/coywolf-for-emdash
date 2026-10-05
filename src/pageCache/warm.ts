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
 * The queue lives in one option row and a minute task works through it in
 * time-boxed batches. A new purge restarts it (new generation), so a run never
 * wastes work on pages that were just cleared.
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
		const res = await self.fetch(new Request(url, { headers: { "User-Agent": "CoywolfPack-CacheWarmer" } }));
		return res.ok ? res.text() : "";
	};
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
	return warmOrder(origin, urls);
}

/**
 * Warm queued URLs until the time budget runs out, the queue is empty, or the
 * job was restarted. Visits go through the Worker's own service binding, which
 * shares the Worker's cache (a Worker can't fetch its own custom domain).
 * `isCurrent` re-reads the generation so a newer purge stops this batch.
 */
export async function warmBatch(
	self: Fetcher,
	state: WarmState,
	options: { budgetMs: number; concurrency?: number; isCurrent: () => Promise<boolean>; now?: () => number },
): Promise<WarmState> {
	const now = options.now ?? Date.now;
	const deadline = now() + options.budgetMs;
	const concurrency = options.concurrency ?? 4;
	const next = { ...state, queue: [...state.queue] };
	while (next.queue.length && now() < deadline) {
		if (!(await options.isCurrent())) return next;
		const batch = next.queue.splice(0, concurrency);
		const results = await Promise.all(
			batch.map(async (url) => {
				try {
					const res = await self.fetch(new Request(url, { headers: { "User-Agent": "CoywolfPack-CacheWarmer" } }));
					await res.arrayBuffer();
					return res.ok || (res.status >= 300 && res.status < 400);
				} catch {
					return false;
				}
			}),
		);
		for (const ok of results) ok ? next.warmed++ : next.failed++;
	}
	if (!next.queue.length) {
		next.phase = "done";
		next.finishedAt = new Date(now()).toISOString();
	}
	return next;
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
