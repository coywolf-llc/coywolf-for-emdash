/**
 * Cost estimate for stored image sizes (Clean Image URLs page): what making
 * them for the existing library costs once, what storing them costs a month,
 * and what serving the same sizes through the media host's /s/ resizing would
 * cost a month instead. Pure functions (the admin page computes everything
 * after one fetch); they plan each image with the generator's own rules.
 *
 * Cloudflare bills a "unique transformation" once per calendar month per
 * image and set of options: 5,000 free a month, then $0.50 per 1,000 (Images
 * Paid). For /s/ URLs the format is chosen per visitor (format=auto), which
 * counts once, so each size of each image costs one transformation a month.
 * A stored size is made once with explicit formats: WebP and AVIF count as
 * two (AVIF isn't made beyond 1,200 pixels, so those sizes count once).
 */
import { avifEncoded, eligible, plannedWidths, scaledHeight } from "./variants.js";

export const PRICE_PER_TRANSFORM = 0.5 / 1000;
export const FREE_TRANSFORMS = 5000;
/** R2 Standard storage, per GB-month (10 GB a month are free). */
export const R2_PER_GB_MONTH = 0.015;
/** Rough average file size of one stored copy (WebP or AVIF) at each width, in bytes. */
export const AVERAGE_FILE_BYTES: Record<number, number> = { 400: 25_000, 640: 50_000, 800: 75_000, 1200: 140_000, 1600: 230_000 };
/** Different sizes of one image a visitor's device typically asks for (phones, tablets, desktops). */
export const SIZES_PER_VISITED_IMAGE = 3;
/** Share of a site's pages that search engines fetch in a month (an assumption). */
export const CRAWLED_SHARE = 0.8;

/** What storing one image's widths takes: sizes, files, one-time transformations, and bytes. */
export function planImage(width: number, height: number | null | undefined): { sizes: number; files: number; transforms: number; bytes: number } {
	const widths = plannedWidths(width);
	let transforms = 0;
	let bytes = 0;
	for (const w of widths) {
		transforms += avifEncoded(w, scaledHeight(w, width, height)) ? 2 : 1;
		bytes += 2 * (AVERAGE_FILE_BYTES[w] ?? 100_000);
	}
	return { sizes: widths.length, files: widths.length * 2, transforms, bytes };
}

export interface LibraryRow {
	mime_type: string | null;
	width: number | null;
	height: number | null;
	size: number | null;
	/** 1 when the image already has its stored sizes. */
	current: number;
}

export interface LibrarySummary {
	/** Images that can get stored sizes. */
	images: number;
	/** Of those, how many already have them. */
	done: number;
	/** Sizes (widths) of all eligible images: what /s/ could be asked for each month. */
	sizes: number;
	/** Files stored for all eligible images (two per size). */
	files: number;
	/** Bytes stored for all eligible images (about). */
	bytes: number;
	/** One-time transformations still to make (images without their sizes yet). */
	transforms: number;
	/** Files still to make. */
	filesLeft: number;
}

export function summarizeLibrary(rows: LibraryRow[]): LibrarySummary {
	const out: LibrarySummary = { images: 0, done: 0, sizes: 0, files: 0, bytes: 0, transforms: 0, filesLeft: 0 };
	for (const row of rows) {
		if (!eligible(row.mime_type, row.width, row.size)) continue;
		const plan = planImage(row.width as number, row.height);
		out.images++;
		out.sizes += plan.sizes;
		out.files += plan.files;
		out.bytes += plan.bytes;
		if (row.current) out.done++;
		else {
			out.transforms += plan.transforms;
			out.filesLeft += plan.files;
		}
	}
	return out;
}

/** Cost of transformations made in one month: `free` of them are free (0 when the month's free ones are already used). */
export function transformCost(transforms: number, free = FREE_TRANSFORMS): number {
	return Math.max(0, transforms - free) * PRICE_PER_TRANSFORM;
}

/** The one-time fee: from "all 5,000 free ones still available" to "none left this month". */
export function oneTimeCost(transforms: number): { min: number; max: number } {
	return { min: transformCost(transforms), max: transformCost(transforms, 0) };
}

/** Storage a month for `bytes` (before R2's free 10 GB). */
export function storageCost(bytes: number): number {
	return (bytes / 1e9) * R2_PER_GB_MONTH;
}

export interface TrafficInput {
	/** Page views a month. */
	views: number;
	/** Published pages. */
	pages: number;
	/** Images that can get stored sizes. */
	images: number;
	/** Sizes those images have in total (summary.sizes). */
	sizes: number;
	/** Bytes of all stored sizes (summary.bytes). */
	bytes: number;
	/** Search engines fetch most pages each month. */
	crawlers: boolean;
}

export interface TrafficEstimate {
	/** Different pages visited in a month. */
	pagesVisited: number;
	/** Different images shown in a month. */
	imagesShown: number;
	/** Transformations a month without stored sizes (each size shown, plus one Open Graph image per page). */
	withoutTransforms: number;
	withoutCost: number;
	/** Transformations a month with stored sizes (only the Open Graph image per page). */
	withTransforms: number;
	/** Their cost plus storage. */
	withCost: number;
	/** Saved a month. */
	savings: number;
}

/**
 * A month of traffic, roughly: with V views spread evenly over P pages, about
 * P × (1 − e^(−V/P)) different pages are seen (real traffic favors some pages,
 * so fewer); search engines that crawl the site fetch at least 80% of them.
 * Images are spread evenly over pages; each image shown is asked for in about
 * three sizes (fewer when it has fewer).
 */
export function trafficEstimate(input: TrafficInput): TrafficEstimate {
	const pages = Math.max(0, input.pages);
	const views = Math.max(0, input.views);
	let pagesVisited = pages ? pages * (1 - Math.exp(-views / pages)) : 0;
	if (input.crawlers) pagesVisited = Math.max(pagesVisited, CRAWLED_SHARE * pages);
	pagesVisited = Math.round(Math.min(pages, pagesVisited));
	const imagesShown = pages ? Math.round(Math.min(input.images, (input.images * pagesVisited) / pages)) : 0;
	const perImage = input.images ? Math.min(SIZES_PER_VISITED_IMAGE, input.sizes / input.images) : 0;
	const withTransforms = pagesVisited;
	const withoutTransforms = Math.round(imagesShown * perImage) + pagesVisited;
	const withoutCost = transformCost(withoutTransforms);
	const withCost = transformCost(withTransforms) + storageCost(input.bytes);
	return { pagesVisited, imagesShown, withoutTransforms, withoutCost, withTransforms, withCost, savings: withoutCost - withCost };
}

/** Months until the one-time fee is paid back by `savings` a month: 1 means the first month; null when it never is. */
export function paybackMonths(oneTime: number, savings: number): number | null {
	if (oneTime <= 0) return 1;
	if (savings <= 0) return null;
	return Math.max(1, Math.ceil(oneTime / savings));
}

/** Most a month without stored sizes: every size of every image asked for once that month. */
export function monthlyWithoutMax(sizes: number): number {
	return transformCost(sizes);
}
