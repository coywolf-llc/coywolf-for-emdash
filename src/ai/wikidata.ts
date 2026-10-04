/**
 * Wikidata lookups for entity grounding: wbsearchentities for real candidates,
 * wbgetentities for P31 (instance of), P856 (official website) and the
 * Wikipedia sitelink. Public API, no key. Search results are cached per
 * isolate so repeated names (and bulk runs) cost no extra subrequests.
 */
import { type Candidate, type WikidataDetails, parseDetails, parseSearch } from "./logic.js";

export const WIKIDATA_HOST = "www.wikidata.org";
const API = `https://${WIKIDATA_HOST}/w/api.php`;
const CACHE_MAX = 500;
const searchCache = new Map<string, Candidate[]>();

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson(fetcher: Fetch, params: Record<string, string>, userAgent: string): Promise<unknown> {
	const url = `${API}?${new URLSearchParams({ format: "json", ...params })}`;
	try {
		const response = await fetcher(url, { headers: { "user-agent": userAgent, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

export async function searchCandidates(fetcher: Fetch, name: string, language: string, userAgent: string): Promise<Candidate[]> {
	const key = `${language}|${name.toLowerCase()}`;
	const hit = searchCache.get(key);
	if (hit) return hit;
	const body = await getJson(fetcher, { action: "wbsearchentities", language, uselang: language, type: "item", limit: "5", search: name }, userAgent);
	if (body === null) return []; // Don't cache failures.
	const candidates = parseSearch(body);
	if (searchCache.size >= CACHE_MAX) searchCache.delete(searchCache.keys().next().value as string);
	searchCache.set(key, candidates);
	return candidates;
}

export async function entityDetails(fetcher: Fetch, qids: string[], language: string, userAgent: string): Promise<Record<string, WikidataDetails> | null> {
	const ids = [...new Set(qids.filter((q) => /^Q\d+$/.test(q)))].slice(0, 50);
	if (!ids.length) return {};
	const body = await getJson(fetcher, { action: "wbgetentities", props: "claims|sitelinks", sitefilter: `${language}wiki`, ids: ids.join("|") }, userAgent);
	return body ? parseDetails(body, language) : null; // null: verification unavailable, so the caller retries later.
}
