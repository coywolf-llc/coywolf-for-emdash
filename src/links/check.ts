/**
 * Check one URL over HTTP: HEAD first, GET when HEAD fails or is refused,
 * redirects followed by hand (up to MAX_HOPS) so the chain can be shown.
 * Every request counts against a per-run budget, since Workers cap
 * subrequests per invocation.
 */
import { type CheckOutcome, type Hop, classify, isBotWall, isPublicTarget } from "./classify.js";

const TIMEOUT_MS = 10_000;
const MAX_HOPS = 5;

// A current desktop Chrome with matching headers: many sites answer bots with 403/429/999.
export const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const BROWSER_HEADERS: Record<string, string> = {
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
	"Sec-CH-UA": '"Chromium";v="140", "Google Chrome";v="140", "Not?A_Brand";v="99"',
	"Sec-CH-UA-Mobile": "?0",
	"Sec-CH-UA-Platform": '"Windows"',
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1",
};

/** Requests left in this run. */
export interface Budget {
	left: number;
}

export class BudgetExhausted extends Error {}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

async function follow(
	start: URL,
	method: "HEAD" | "GET",
	budget: Budget,
	userAgent: string,
	fetcher: Fetcher,
): Promise<{ chain: Hop[]; blocked: boolean; error?: string }> {
	const chain: Hop[] = [];
	let url = start;
	for (let hop = 0; hop <= MAX_HOPS; hop++) {
		if (!isPublicTarget(url)) return { chain, blocked: false, error: "Points to a private or local address" };
		if (budget.left <= 0) throw new BudgetExhausted();
		budget.left--;
		let response: Response;
		try {
			response = await fetcher(url.href, {
				method,
				redirect: "manual",
				headers: { ...BROWSER_HEADERS, "User-Agent": userAgent },
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch (error) {
			const name = (error as Error)?.name;
			const message = name === "TimeoutError" || name === "AbortError" ? "Timed out after 10 seconds" : describe(error);
			return { chain, blocked: false, error: message };
		}
		// Don't download bodies.
		await response.body?.cancel().catch(() => {});
		chain.push({ url: url.href, code: response.status });
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			try {
				url = new URL(location, url);
			} catch {
				return { chain, blocked: false, error: `Invalid redirect location: ${location.slice(0, 200)}` };
			}
			continue;
		}
		return { chain, blocked: isBotWall(response.status, response.headers) };
	}
	return { chain, blocked: false, error: `More than ${MAX_HOPS} redirects` };
}

function describe(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/dns|getaddrinfo|ENOTFOUND|resolve/i.test(message)) return "Domain doesn't resolve (DNS)";
	if (/certificate|ssl|tls/i.test(message)) return "TLS/certificate error";
	if (/refused|ECONNREFUSED/i.test(message)) return "Connection refused";
	return message.slice(0, 200) || "Request failed";
}

/** Check a URL. Throws BudgetExhausted when the run is out of requests before an answer. */
export async function checkUrl(url: URL, budget: Budget, options: { userAgent?: string; fetcher?: Fetcher } = {}): Promise<CheckOutcome> {
	const userAgent = options.userAgent?.replace(/[\r\n\t\0]+/g, " ").trim() || BROWSER_UA;
	const fetcher: Fetcher = options.fetcher ?? ((u, init) => fetch(u, init));
	const head = await follow(url, "HEAD", budget, userAgent, fetcher);
	const headLast = head.chain[head.chain.length - 1];
	// Many servers mishandle HEAD (405, 404, 403, errors): confirm problems with GET.
	if (head.error?.startsWith("Points to") || (!head.error && headLast && headLast.code < 400 && !head.blocked)) {
		return classify(head.chain, head.blocked, head.error);
	}
	if (budget.left <= 0) throw new BudgetExhausted();
	const get = await follow(url, "GET", budget, userAgent, fetcher);
	return classify(get.chain, get.blocked, get.error);
}
