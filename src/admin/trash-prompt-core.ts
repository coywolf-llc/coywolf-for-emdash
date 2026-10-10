/**
 * The trash prompt's plumbing (feature "redirects.trashPrompt"), kept free of
 * React so Node can test it. EmDash gives plugins no event for "an editor just
 * trashed or unpublished something", so the admin module watches the admin's
 * own content API calls: a successful DELETE /_emdash/api/content/:collection/:id
 * (move to trash) or POST .../:id/unpublish. After a short pause (a bulk trash
 * is one DELETE per entry) it reads the pending decisions the server recorded
 * for those entries and hands them to the prompt.
 */

/** A pending decision, as the `redirects/removed` route lists it. */
export interface Pending {
	id: string;
	collection: string;
	url: string;
	title: string;
	reason: "deleted" | "unpublished";
	at: string;
}

export interface Removal {
	/** Pending decision id: "<collection>:<entry id>". */
	id: string;
	reason: "deleted" | "unpublished";
}

const CONTENT_PATH = /^\/_emdash\/api\/content\/([^/]+)\/([^/]+)(\/unpublish)?\/?$/;

/** The removal an admin API request makes, or null. Permanent deletes, restores, and everything else are null. */
export function removalFromRequest(method: string, url: string): Removal | null {
	let pathname: string;
	try {
		pathname = new URL(url, "http://admin.invalid").pathname;
	} catch {
		return null;
	}
	const match = CONTENT_PATH.exec(pathname);
	if (!match) return null;
	const verb = method.toUpperCase();
	const reason = match[3] ? (verb === "POST" ? "unpublished" : null) : verb === "DELETE" ? "deleted" : null;
	if (!reason) return null;
	try {
		return { id: `${decodeURIComponent(match[1])}:${decodeURIComponent(match[2])}`, reason };
	} catch {
		return null;
	}
}

const WATCHED = Symbol.for("coywolf-pack.trash-prompt.fetch");

type FetchHost = { fetch: typeof fetch; [WATCHED]?: true };

/**
 * Wrap `host.fetch` (window) once so every successful removal request calls
 * onRemoved. The wrapper returns the original Response untouched and never
 * reads its body; a failing matcher or callback is swallowed. False when the
 * host was already wrapped.
 */
export function watchContentRemovals(onRemoved: (removal: Removal) => void, host: FetchHost = globalThis as unknown as FetchHost): boolean {
	if (host[WATCHED] || typeof host.fetch !== "function") return false;
	const original = host.fetch;
	const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const response = await original.call(host, input, init);
		try {
			if (response.ok) {
				const request = typeof input === "object" && "url" in input ? input : null;
				const method = init?.method ?? request?.method ?? "GET";
				const url = typeof input === "string" ? input : request ? request.url : String(input);
				const removal = removalFromRequest(method, url);
				if (removal) onRemoved(removal);
			}
		} catch {
			// Never get in the way of the admin's own request.
		}
		return response;
	};
	host.fetch = wrapped as typeof fetch;
	host[WATCHED] = true;
	return true;
}

export interface CollectorOptions {
	/** The pending decisions, or null when there's nothing to show (feature off, no permission, error). */
	fetchPending: () => Promise<Pending[] | null>;
	onReady: (items: Pending[]) => void;
	/** Pause after the last removal before looking (bulk trash sends one request per entry). */
	debounceMs?: number;
	/** Extra looks while some removals aren't recorded yet (unpublish records after its response). */
	retryMs?: number[];
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

/**
 * Collect removals and report the ones the server recorded a decision for.
 * Removals the server didn't record (drafts, entries without a URL) are
 * dropped. A trash is recorded before its response, so only an unpublish
 * that isn't listed yet is worth looking again for.
 */
export function collectRemovals(options: CollectorOptions): (removal: Removal) => void {
	const debounceMs = options.debounceMs ?? 700;
	const retryMs = options.retryMs ?? [600, 1500];
	const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	let queued = new Map<string, Removal["reason"]>();
	let timer: unknown = null;

	const look = async (removals: Map<string, Removal["reason"]>, attempt: number) => {
		let list: Pending[] | null = null;
		try {
			list = await options.fetchPending();
		} catch {
			list = null;
		}
		if (!list) return;
		const found = list.filter((item) => removals.has(item.id));
		const missingUnpublish = [...removals].some(([id, reason]) => reason === "unpublished" && !found.some((item) => item.id === id));
		if (missingUnpublish && attempt < retryMs.length) {
			setTimer(() => void look(removals, attempt + 1), retryMs[attempt]);
			return;
		}
		if (found.length) options.onReady(found);
	};

	return (removal) => {
		queued.set(removal.id, removal.reason);
		if (timer !== null) clearTimer(timer);
		timer = setTimer(() => {
			timer = null;
			const removals = queued;
			queued = new Map();
			void look(removals, 0);
		}, debounceMs);
	};
}
