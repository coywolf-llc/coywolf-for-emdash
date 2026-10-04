/**
 * Read a WordPress Cloudflare Stream embed (a Custom HTML block) into the
 * player settings the Coywolf Video block uses. Handles the shapes found on
 * Coywolf's sites:
 *
 * - the responsive wrapper `<div style="position: relative; padding-top: 56.25%">`
 *   around a Stream `<iframe>` (customer subdomain or iframe.videodelivery.net),
 *   with player options in the query string (autoplay, loop, muted,
 *   controls=false, preload, poster=…?time=…);
 * - the older `<stream src="UID" autoplay loop mute>` element plus its script;
 * - a wrapper whose iframe was stripped long ago (only the sizing survives),
 *   optionally in a `<figure>` with a caption;
 * - `max-width:360px` / `width:344px` wrappers (phone recordings).
 *
 * Pure, no imports.
 */

export interface StreamEmbed {
	uid: string | null;
	host: string | null;
	/** padding-top percentage (height / width × 100). */
	aspect: number | null;
	/** A fixed or maximum width in px from the wrapper. */
	maxWidth: number | null;
	autoplay: boolean;
	loop: boolean;
	muted: boolean;
	controls: boolean;
	preload: "auto" | "metadata" | "none" | null;
	posterTime: number | null;
	startTime: number | null;
	/** <figcaption> text. */
	caption: string | null;
	/** The iframe's title attribute. */
	title: string | null;
}

const UID = /^[0-9a-f]{32}$/;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#039": "'", "#8217": "’", "#8216": "‘", "#8220": "“", "#8221": "”", "#8211": "–", "#8212": "—" };

export function decodeHtml(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
		const named = ENTITIES[e.toLowerCase()];
		if (named) return named;
		if (e[0] === "#") {
			const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
			return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
		}
		return all;
	});
}

export const textOf = (html: string) =>
	decodeHtml(html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();

const attr = (tag: string, name: string): string | null => {
	const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
	return m ? decodeHtml(m[1] ?? m[2] ?? m[3] ?? "") : null;
};
const hasAttr = (tag: string, name: string) => new RegExp(`\\s${name}(?:\\s*=|[\\s>/])`, "i").test(tag);

const truthy = (v: string | null) => v !== null && v !== "false" && v !== "0";

function secondsParam(value: string | null): number | null {
	if (!value) return null;
	const m = value.trim().match(/^(\d+(?:\.\d+)?)s?$/);
	return m ? Number(m[1]) : null;
}

/** Whether a Custom HTML block is a Stream embed (iframe or <stream> element). */
export function hasStreamPlayer(html: string): boolean {
	return /(?:cloudflarestream\.com|videodelivery\.net)\/[0-9a-f]{32}|<stream\s[^>]*src="[0-9a-f]{32}"/i.test(html);
}

/**
 * Parse an embed. Returns null when the HTML holds anything besides the
 * player, its wrapper, script and caption (so real content is never folded
 * into a video block), or when there's neither a player nor a sizing wrapper.
 */
export function parseStreamEmbed(html: string): StreamEmbed | null {
	if (typeof html !== "string" || html.length > 20_000) return null;
	const caption = html.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
	const rest = html
		.replace(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/gi, "")
		.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
		.replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, "")
		.replace(/<stream\b[\s\S]*?<\/stream\s*>/gi, "");
	if (textOf(rest)) return null;
	if (/<(?!\/?(?:div|figure|p|br)\b)[a-z]/i.test(rest)) return null;

	const embed: StreamEmbed = {
		uid: null,
		host: null,
		aspect: null,
		maxWidth: null,
		autoplay: false,
		loop: false,
		muted: false,
		controls: true,
		preload: null,
		posterTime: null,
		startTime: null,
		caption: caption ? textOf(caption[1] as string) || null : null,
		title: null,
	};

	const pad = html.match(/padding-top:\s*([\d.]+)%/i);
	if (pad) embed.aspect = Number(pad[1]);
	const width = html.match(/(?:max-width|[^-]width):\s*(\d+)px/i);
	if (width) embed.maxWidth = Number(width[1]);

	const iframe = html.match(/<iframe\b[^>]*>/i)?.[0];
	const stream = html.match(/<stream\b[^>]*>/i)?.[0];
	if (iframe) {
		const src = attr(iframe, "src") ?? "";
		const m = src.match(/^(?:https?:)?\/\/(customer-[a-z0-9]+\.cloudflarestream\.com|iframe\.videodelivery\.net)\/([0-9a-f]{32})(?:\/iframe)?\/?(?:\?(.*))?$/i);
		if (!m) return null;
		embed.uid = (m[2] as string).toLowerCase();
		embed.host = /^customer-/i.test(m[1] as string) ? (m[1] as string).toLowerCase() : null;
		const params = new URLSearchParams(m[3] ?? "");
		embed.autoplay = truthy(params.get("autoplay"));
		embed.loop = truthy(params.get("loop"));
		embed.muted = truthy(params.get("muted"));
		embed.controls = params.get("controls") !== "false";
		const preload = params.get("preload");
		embed.preload = preload === "true" || preload === "auto" ? "auto" : preload === "none" ? "none" : preload === "metadata" ? "metadata" : null;
		const poster = params.get("poster");
		if (poster) {
			try {
				embed.posterTime = secondsParam(new URL(poster).searchParams.get("time"));
			} catch {
				embed.posterTime = null;
			}
		}
		embed.startTime = secondsParam(params.get("startTime"));
		embed.title = attr(iframe, "title") || null;
	} else if (stream) {
		const uid = (attr(stream, "src") ?? "").toLowerCase();
		if (!UID.test(uid)) return null;
		embed.uid = uid;
		embed.autoplay = hasAttr(stream, "autoplay");
		embed.loop = hasAttr(stream, "loop");
		embed.muted = hasAttr(stream, "mute") || hasAttr(stream, "muted");
		embed.controls = hasAttr(stream, "controls") || !embed.autoplay;
		embed.preload = hasAttr(stream, "preload") ? "auto" : null;
		const poster = attr(stream, "poster");
		if (poster) {
			try {
				embed.posterTime = secondsParam(new URL(poster).searchParams.get("time"));
			} catch {
				embed.posterTime = null;
			}
		}
	} else if (embed.aspect === null && embed.maxWidth === null) {
		return null;
	}
	return embed;
}
