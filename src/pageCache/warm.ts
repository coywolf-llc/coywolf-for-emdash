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
 *
 * EmDash clears cached pages by tag when content, menus, taxonomies or site
 * settings change, and list pages carry their collection's tag, so one saved
 * post clears the home page, the archives and many posts. The pack middleware
 * sees those clears (cache.invalidate) and schedules a new run a minute after
 * the last one (scheduleRewarm), so a burst of edits makes one run.
 *
 * A page whose render used a stopgap (a video's Stream poster while its copy
 * on the media host is made, see src/videos/poster.ts) comes back with
 * STOPGAP_HEADER and isn't cached. Such pages are listed in the progress row
 * (`revisit`, at most MAX_REVISIT) and visited again once the main queue is
 * done and REVISIT_DELAY_MS has passed, so they end up cached with the normal
 * lifetime. Each gets at most MAX_REVISIT_ROUNDS more visits.
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
	/** Read from a row in the format before 0.26 (progress only; the next claim converts it, see migrateLegacy). */
	legacy?: boolean;
	/** Pages to visit again (their render used a stopgap): [url, revisits so far]. */
	revisit?: Array<[string, number]>;
	/** Not before then (ISO), so the posters' copies are made and listed first. */
	revisitAfter?: string;
	/** Revisits handed to batches and not yet recorded, and when the last were claimed. */
	revisitBusy?: number;
	revisitBusyAt?: string;
	/** Pages visited again and cached with the normal lifetime; pages still on a stopgap after their last revisit (or past MAX_REVISIT). */
	rewarmed?: number;
	revisitGaveUp?: number;
	/** When the last batch was claimed (a batch never recorded stops keeping the run open BATCH_STALE_MS later). */
	claimedAt?: string;
	/** Content changed (see scheduleRewarm): start a new run ("edit") once this time (ISO) has passed. */
	rewarmAfter?: string;
	/** However long edits keep coming, the new run starts by then (ISO). */
	rewarmBy?: string;
}

/** Most URLs one job warms (a guard for huge sitemaps). */
export const MAX_URLS = 5000;

/** Response header the pack middleware adds to the warmer's visit of a page rendered with a stopgap (that render isn't cached). */
export const STOPGAP_HEADER = "X-Coywolf-Stopgap";
/** Most pages waiting for a revisit (keeps the progress row small); longer URLs aren't listed. */
export const MAX_REVISIT = 200;
const MAX_REVISIT_URL = 500;
/** Wait before a revisit: the poster copy and its listing run in the background of the first visit. */
export const REVISIT_DELAY_MS = 20_000;
/** Revisits per page at most. */
export const MAX_REVISIT_ROUNDS = 2;
/** Revisits claimed this long ago and never recorded (the isolate stopped) no longer keep the run open. */
const REVISIT_STALE_MS = 2 * 60_000;
/** Same for a batch of the main queue: its pages count as failed and the run finishes. */
export const BATCH_STALE_MS = 2 * 60_000;
/** A run starts this long after the last content edit (edits in a burst, autosaves… make one run). */
export const REWARM_DELAY_MS = 60_000;
/** …and at most this long after the first edit of a burst, however long it goes on. */
export const REWARM_MAX_DELAY_MS = 5 * 60_000;

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
		// A `queue` array means the older format, even with a numeric `next`: during a deploy an
		// old-version isolate can finish a new run's collect step by spreading the new state and
		// adding `queue` (no URL rows). claimWork migrates it (migrateLegacy).
		if (typeof state.next === "number" && !Array.isArray(state.queue)) return state as WarmState;
		const left = Array.isArray(state.queue) ? state.queue.length : 0;
		const { queue: _queue, ...rest } = state;
		return { ...rest, next: Math.max(0, (state.total ?? 0) - left), legacy: true } as WarmState;
	} catch {
		return null;
	}
}

/**
 * Turn a state row in the older format into the current one, so the run goes
 * on: a pending collect step stays pending; a warm phase's remaining `queue`
 * is written to URL rows under a new generation (a stale cleanup of the old
 * one can't delete them) and counted from zero. Finished runs are left as
 * they are. True when the row now holds a current-format state.
 */
async function migrateLegacy(db: D1Database, raw: string, now: number): Promise<boolean> {
	let legacy: LegacyState;
	try {
		legacy = JSON.parse(raw) as LegacyState;
	} catch {
		return false;
	}
	const { queue, ...rest } = legacy;
	if (rest.phase === "collect") return swap(db, raw, { ...rest, next: 0, total: 0 });
	if (rest.phase !== "warm") return false;
	const urls = Array.isArray(queue) ? queue.filter((u): u is string => typeof u === "string") : [];
	if (!urls.length) {
		return swap(db, raw, { ...rest, phase: "done", next: 0, total: 0, finishedAt: rest.finishedAt ?? new Date(now).toISOString() });
	}
	const generation = newWarmState(rest.reason, new Date(now)).generation;
	await writeWarmQueue(db, generation, urls);
	const migrated: WarmState = { ...rest, generation, next: 0, total: urls.length, warmed: 0, failed: 0 };
	if (await swap(db, raw, migrated)) return true;
	await deleteQueue(db, { run: generation }).catch(() => undefined);
	return false;
}

export async function readWarmState(db: D1Database): Promise<WarmState | null> {
	const raw = await readRaw(db);
	return raw ? parseState(raw) : null;
}

/** URLs of a run not yet handed to a batch. */
export function remainingUrls(state: WarmState): number {
	return state.phase === "warm" ? Math.max(0, state.total - state.next) : 0;
}

/** Pages of a run waiting for (or in) a revisit. */
export function pendingRevisits(state: WarmState): number {
	return state.phase === "warm" ? (state.revisit?.length ?? 0) + (state.revisitBusy ?? 0) : 0;
}

/** Add pages to visit again (deduplicated, capped; ones that don't fit are given up on), and push the wait back. */
function addRevisits(state: WarmState, entries: Array<[string, number]>, now: number): WarmState {
	if (!entries.length) return state;
	const list = [...(state.revisit ?? [])];
	const listed = new Set(list.map(([url]) => url));
	let gaveUp = state.revisitGaveUp ?? 0;
	for (const [url, round] of entries) {
		if (listed.has(url)) continue;
		if (list.length >= MAX_REVISIT || url.length > MAX_REVISIT_URL) {
			gaveUp++;
			continue;
		}
		listed.add(url);
		list.push([url, round]);
	}
	return { ...state, revisit: list.length ? list : undefined, revisitAfter: new Date(now + REVISIT_DELAY_MS).toISOString(), revisitGaveUp: gaveUp || undefined };
}

/** Every URL visited and recorded, and no revisit waiting or (recently) under way. */
function runFinished(state: WarmState, now: number): boolean {
	if (state.phase !== "warm" || state.next < state.total || state.warmed + state.failed < state.total || state.revisit?.length) return false;
	return !state.revisitBusy || !state.revisitBusyAt || now - Date.parse(state.revisitBusyAt) >= REVISIT_STALE_MS;
}

function finished(state: WarmState, now: number): WarmState {
	const lost = state.revisitBusy ?? 0;
	return {
		...state,
		phase: "done",
		finishedAt: new Date(now).toISOString(),
		revisit: undefined,
		revisitAfter: undefined,
		revisitBusy: undefined,
		revisitBusyAt: undefined,
		revisitGaveUp: (state.revisitGaveUp ?? 0) + lost || undefined,
	};
}

export async function writeWarmState(db: D1Database, state: WarmState): Promise<void> {
	await db
		.prepare("INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
		.bind(WARM_STATE_OPTION, JSON.stringify(state))
		.run();
}

/**
 * Names starting with `prefix` are those in [prefix, prefixEnd): the same
 * string with its last character moved one up (prefixes here end in ":", so
 * the end is ";"). Range comparisons rather than LIKE: D1 refuses LIKE
 * patterns over 50 bytes ("LIKE or GLOB pattern too complex"), and a queue
 * row's name is longer than that, so the LIKE deletes this replaced never
 * deleted anything. A range also uses the options table's primary key.
 */
const prefixEnd = (prefix: string) => prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

/**
 * Delete warm queue rows: `{ run }` deletes one run's rows; `{ upTo }` deletes
 * that run's rows and every older run's (generations start with their start
 * time in milliseconds, 13 digits, so they sort by age), leaving any newer
 * run's alone; `{ keep }` deletes every run's rows but that run's.
 */
async function deleteQueue(db: D1Database, which: { run: string } | { upTo: string } | { keep: string }): Promise<void> {
	if ("run" in which) {
		const prefix = `${WARM_QUEUE_PREFIX}${which.run}:`;
		await db.prepare("DELETE FROM options WHERE name >= ? AND name < ?").bind(prefix, prefixEnd(prefix)).run();
		return;
	}
	if ("upTo" in which) {
		await db.prepare("DELETE FROM options WHERE name >= ? AND name < ?").bind(WARM_QUEUE_PREFIX, prefixEnd(`${WARM_QUEUE_PREFIX}${which.upTo}:`)).run();
		return;
	}
	const keep = `${WARM_QUEUE_PREFIX}${which.keep}:`;
	await db
		.prepare("DELETE FROM options WHERE name >= ? AND name < ? AND NOT (name >= ? AND name < ?)")
		.bind(WARM_QUEUE_PREFIX, prefixEnd(WARM_QUEUE_PREFIX), keep, prefixEnd(keep))
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
	await deleteQueue(db, { keep: state.generation }).catch((error) => console.error("coywolf-pack: could not clear old warm queues", error));
	return state;
}

/**
 * Content changed (EmDash cleared cached pages by tag): warm again
 * REWARM_DELAY_MS after the last such change, REWARM_MAX_DELAY_MS after the
 * first at most. Only marks the progress row (`rewarmAfter`); the run starts
 * from the traffic-driven warm steps once it's due (claimWork), so a burst of
 * edits makes one run. A run in progress goes on meanwhile and is replaced
 * when the new one starts. Returns the row as written (null if it couldn't be).
 */
export async function scheduleRewarm(db: D1Database, now = Date.now()): Promise<WarmState | null> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const raw = await readRaw(db);
		if (!raw) {
			// No run yet: a finished, empty one carrying the schedule.
			const state: WarmState = {
				...newWarmState("edit", new Date(now)),
				phase: "done",
				rewarmAfter: new Date(now + REWARM_DELAY_MS).toISOString(),
				rewarmBy: new Date(now + REWARM_MAX_DELAY_MS).toISOString(),
			};
			const result = await db
				.prepare("INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO NOTHING")
				.bind(WARM_STATE_OPTION, JSON.stringify(state))
				.run();
			if ((result.meta?.changes ?? 0) > 0) return state;
			continue;
		}
		const state = parseState(raw);
		if (!state || state.legacy) return null;
		const by = state.rewarmBy ? Date.parse(state.rewarmBy) : now + REWARM_MAX_DELAY_MS;
		const next: WarmState = { ...state, rewarmAfter: new Date(Math.min(now + REWARM_DELAY_MS, by)).toISOString(), rewarmBy: new Date(by).toISOString() };
		if (await swap(db, raw, next)) return next;
	}
	return null;
}

/**
 * Whether a progress row (as last read with the feature switches) may have
 * work for a warm step: a run under way, or a rewarm that's due. True when
 * unknown (undefined) or unreadable; false when there's no row.
 */
export function warmMayHaveWork(raw: string | null | undefined, now = Date.now()): boolean {
	if (raw === undefined) return true;
	if (raw === null) return false;
	try {
		const state = JSON.parse(raw) as { phase?: unknown; rewarmAfter?: unknown };
		if (state.phase !== "done" && state.phase !== "failed") return true;
		return typeof state.rewarmAfter === "string" && now >= Date.parse(state.rewarmAfter);
	} catch {
		return true;
	}
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

export type Claim =
	| { kind: "collect"; state: WarmState }
	| { kind: "warm"; state: WarmState; urls: string[] }
	| { kind: "revisit"; state: WarmState; pages: Array<[string, number]> }
	| { kind: "wait"; state: WarmState; until: string }
	| null;

const COLLECT_STALE_MS = 2 * 60_000;

/** Take the next piece of work, if any: reading the sitemap, or a batch of URLs. */
export async function claimWork(db: D1Database, batchSize: number, now = Date.now()): Promise<Claim> {
	let raw = await readRaw(db);
	if (!raw) return null;
	let state = parseState(raw);
	if (state?.legacy) {
		// Written by an isolate still running the older version (during a deploy): convert it, then claim.
		if (!(await migrateLegacy(db, raw, now))) return null;
		raw = await readRaw(db);
		state = raw ? parseState(raw) : null;
	}
	if (!raw || !state || state.legacy) return null;
	if (state.rewarmAfter && now >= Date.parse(state.rewarmAfter)) {
		// Content changed a minute ago: a new run (it supersedes one in progress; pages that
		// one already warmed and nothing invalidated since are cache hits, so they cost little).
		const fresh = newWarmState("edit", new Date(now));
		if (!(await swap(db, raw, fresh))) return null;
		await deleteQueue(db, { keep: fresh.generation }).catch((error) => console.error("coywolf-pack: could not clear old warm queues", error));
		raw = JSON.stringify(fresh);
		state = fresh;
	}
	if (state.phase === "collect") {
		if (state.collectingAt && now - Date.parse(state.collectingAt) < COLLECT_STALE_MS) return null;
		const next = { ...state, collectingAt: new Date(now).toISOString() };
		return (await swap(db, raw, next)) ? { kind: "collect", state: next } : null;
	}
	if (state.phase !== "warm") return null;
	if (state.next >= state.total) return claimRevisit(db, raw, state, batchSize, now);
	const end = Math.min(state.next + batchSize, state.total);
	const next = { ...state, next: end, claimedAt: new Date(now).toISOString() };
	if (!(await swap(db, raw, next))) return null;
	const urls = await queueSlice(db, state.generation, state.next, end);
	// URLs whose row is gone count as failed, so the run still finishes.
	if (urls.length < end - state.next) await recordBatch(db, state.generation, 0, end - state.next - urls.length, now);
	return { kind: "warm", state: next, urls };
}

/**
 * Once the queue is handed out: pages to visit again, when their wait is over
 * ("wait" until then, so steps don't spin). Also finishes a run kept open only
 * by revisits that were claimed and never recorded.
 */
async function claimRevisit(db: D1Database, raw: string, state: WarmState, batchSize: number, now: number): Promise<Claim> {
	const list = state.revisit ?? [];
	if (!list.length) {
		// A batch claimed long ago and never recorded (its isolate stopped, or its record lost every
		// retry): its pages count as failed, so the run finishes and its URL rows go.
		const missing = state.total - state.warmed - state.failed;
		const lost = missing > 0 && now - Date.parse(state.claimedAt ?? state.startedAt) >= BATCH_STALE_MS ? missing : 0;
		const settled = lost ? { ...state, failed: state.failed + lost } : state;
		if ((lost || state.revisitBusy) && runFinished(settled, now) && (await swap(db, raw, finished(settled, now)))) {
			await deleteQueue(db, { upTo: state.generation }).catch((error) => console.error("coywolf-pack: could not clear warm queues", error));
		}
		return null;
	}
	if (state.revisitAfter && now < Date.parse(state.revisitAfter)) return { kind: "wait", state, until: state.revisitAfter };
	const pages = list.slice(0, batchSize);
	const rest = list.slice(batchSize);
	const next: WarmState = { ...state, revisit: rest.length ? rest : undefined, revisitBusy: (state.revisitBusy ?? 0) + pages.length, revisitBusyAt: new Date(now).toISOString() };
	return (await swap(db, raw, next)) ? { kind: "revisit", state: next, pages } : null;
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
	if (urls.length) await deleteQueue(db, { run: generation }).catch(() => undefined);
}

/**
 * Count a finished batch, listing its `stopgap` pages for a revisit; marks the
 * run done (and drops its URL rows) when nothing is left.
 */
export async function recordBatch(db: D1Database, generation: string, warmed: number, failed: number, now = Date.now(), stopgap: string[] = []): Promise<void> {
	await recordProgress(db, generation, now, (state) =>
		// A run already finished (a lost batch's isolate recording late) keeps its counts.
		state.phase === "warm"
			? addRevisits({ ...state, warmed: state.warmed + warmed, failed: state.failed + failed }, stopgap.map((url): [string, number] => [url, 0]), now)
			: null,
	);
}

export interface Visited {
	url: string;
	ok: boolean;
	/** The page was rendered with a stopgap (STOPGAP_HEADER), so it wasn't cached. */
	stopgap: boolean;
}

/**
 * Count a finished revisit batch: pages still on a stopgap go back on the list
 * until they've had MAX_REVISIT_ROUNDS revisits, then are given up on.
 */
export async function recordRevisit(db: D1Database, generation: string, results: Array<Visited & { round: number }>, now = Date.now()): Promise<void> {
	await recordProgress(db, generation, now, (state) => {
		if (state.phase !== "warm") return null;
		const again = results.filter((r) => r.stopgap && r.round + 1 < MAX_REVISIT_ROUNDS).map((r): [string, number] => [r.url, r.round + 1]);
		const rewarmed = results.filter((r) => r.ok && !r.stopgap).length;
		const gaveUp = results.length - rewarmed - again.length;
		const busy = Math.max(0, (state.revisitBusy ?? 0) - results.length);
		return addRevisits(
			{
				...state,
				revisitBusy: busy || undefined,
				revisitBusyAt: busy ? state.revisitBusyAt : undefined,
				rewarmed: (state.rewarmed ?? 0) + rewarmed || undefined,
				revisitGaveUp: (state.revisitGaveUp ?? 0) + gaveUp || undefined,
			},
			again,
			now,
		);
	});
}

/** Apply `update` to the run's progress row (compare-and-swap, retried), then finish the run if nothing is left. */
async function recordProgress(db: D1Database, generation: string, now: number, update: (state: WarmState) => WarmState | null): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const raw = await readRaw(db);
		if (!raw) return;
		const state = parseState(raw);
		if (!state || state.legacy || state.generation !== generation) return;
		let next = update(state);
		if (!next) return;
		const done = runFinished(next, now);
		if (done) next = finished(next, now);
		if (await swap(db, raw, next)) {
			if (done) await deleteQueue(db, { upTo: generation }).catch((error) => console.error("coywolf-pack: could not clear warm queues", error));
			return;
		}
	}
}

/** Visit URLs through the Worker's own service binding (which shares its cache). */
export async function visit(self: Fetcher, urls: string[]): Promise<{ warmed: number; failed: number; results: Visited[] }> {
	const results = await Promise.all(
		urls.map(async (url): Promise<Visited> => {
			try {
				const res = await self.fetch(new Request(url, { headers: { "User-Agent": WARMER_AGENT } }));
				await res.arrayBuffer();
				return { url, ok: res.ok || (res.status >= 300 && res.status < 400), stopgap: res.headers.get(STOPGAP_HEADER) === "1" };
			} catch {
				return { url, ok: false, stopgap: false };
			}
		}),
	);
	return { warmed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

const sameOrigin = (url: string, origin: string) => {
	try {
		return new URL(url).origin === origin;
	} catch {
		return false;
	}
};

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
		// Revisits wait for the posters' copies: later steps (driven by traffic) check again.
		if (claim.kind === "wait") return did === "idle" ? "waiting" : did;
		if (claim.kind === "revisit") {
			const { results } = await visit(self, claim.pages.map(([url]) => url));
			await recordRevisit(db, claim.state.generation, results.map((r, i) => ({ ...r, round: claim.pages[i][1] })), now());
			did = "revisited";
			continue;
		}
		const { warmed, failed, results } = await visit(self, claim.urls);
		const stopgap = results.filter((r) => r.ok && r.stopgap && sameOrigin(r.url, origin)).map((r) => r.url);
		await recordBatch(db, claim.state.generation, warmed, failed, now(), stopgap);
		did = "warmed";
	}
	return did;
}
