/**
 * IndexNow (pure part): key handling, the submission payload, and a batcher
 * that collects changed URLs for a short window, dedupes them, and submits
 * them in one request.
 *
 * Coywolf SEO pinged Bing once per URL; here several changes in quick
 * succession (a save followed by a publish, a bulk edit) go out as one POST,
 * which every IndexNow endpoint accepts (up to 10,000 URLs).
 */

export const INDEXNOW_ENDPOINTS = {
	"api.indexnow.org": "https://api.indexnow.org/indexnow",
	"www.bing.com": "https://www.bing.com/indexnow",
} as const;
export type IndexNowEndpoint = keyof typeof INDEXNOW_ENDPOINTS;

/** IndexNow keys: 8–128 characters of a–z, A–Z, 0–9 and "-". */
export const KEY_PATTERN = /^[a-zA-Z0-9-]{8,128}$/;
export const MAX_URLS_PER_REQUEST = 10_000;

/** A new 32-character lowercase hex key. */
export function generateKey(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The key a `/<key>.txt` request asks for, or null when the path isn't key-shaped. */
export function keyFromPath(pathname: string): string | null {
	const match = /^\/([a-zA-Z0-9-]{8,128})\.txt$/.exec(pathname);
	return match ? match[1] : null;
}

export interface IndexNowPayload {
	host: string;
	key: string;
	keyLocation: string;
	urlList: string[];
}

/**
 * The POST body for a batch. URLs on other hosts are dropped: IndexNow
 * rejects a batch whose URLs don't all belong to the key's host.
 */
export function buildPayload(siteUrl: string, key: string, urls: string[]): IndexNowPayload | null {
	const site = new URL(siteUrl);
	const urlList = [...new Set(urls)].filter((url) => {
		try {
			return new URL(url).host === site.host;
		} catch {
			return false;
		}
	});
	if (!urlList.length) return null;
	return {
		host: site.host,
		key,
		keyLocation: `${site.origin}/${key}.txt`,
		urlList: urlList.slice(0, MAX_URLS_PER_REQUEST),
	};
}

export interface BatcherOptions {
	/** How long to wait for more URLs before submitting. */
	windowMs: number;
	/** Keep work alive past the response (EmDash's `after()` / waitUntil). */
	defer: (task: () => Promise<void>) => void;
	sleep?: (ms: number) => Promise<void>;
}

export type BatchSender = (urls: string[]) => Promise<void>;

/**
 * Collects URLs for `windowMs`, then hands the deduped list to the most
 * recent sender. One pending batch per isolate.
 */
export class IndexNowBatcher {
	private pending = new Set<string>();
	private sender: BatchSender | null = null;
	private scheduled = false;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly options: BatcherOptions;

	constructor(options: BatcherOptions) {
		this.options = options;
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	get size(): number {
		return this.pending.size;
	}

	add(urls: string | string[], sender: BatchSender): void {
		for (const url of Array.isArray(urls) ? urls : [urls]) if (url) this.pending.add(url);
		if (!this.pending.size) return;
		this.sender = sender;
		if (this.scheduled) return;
		this.scheduled = true;
		this.options.defer(async () => {
			await this.sleep(this.options.windowMs);
			await this.flush();
		});
	}

	/** Submit what's pending now. */
	async flush(): Promise<void> {
		this.scheduled = false;
		const urls = [...this.pending];
		const sender = this.sender;
		this.pending.clear();
		this.sender = null;
		if (urls.length && sender) await sender(urls);
	}
}
