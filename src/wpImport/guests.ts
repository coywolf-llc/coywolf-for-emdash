/**
 * Guest authors from the Coywolf Guest Author WordPress plugin. It stores one
 * guest per post in post meta (no users, no taxonomy):
 *
 *   _guest_author            name (an empty name means "no guest")
 *   _guest_author_url        website (optional)
 *   _guest_author_bio        biographical info (optional, may hold HTML)
 *   _guest_author_avatar_id  attachment id of the avatar (optional)
 *
 * and overrides the post's byline with it. EmDash's importer credits the post
 * to its WordPress user instead, so the WordPress import page reads the guests
 * from the export (wxrGuestAuthors), groups them into bylines (groupGuests),
 * and credits each post to its guest's byline through EmDash's own admin API
 * (bylines are EmDash core data that plugins can only read).
 *
 * Pure, no imports beyond siblings: runs in the admin (browser), a Node script
 * and tests.
 */

export interface GuestAuthor {
	/** WordPress post id. */
	postId: number | null;
	postType: string;
	/** The post's slug, which EmDash's importer keeps. */
	slug: string;
	title: string;
	name: string;
	url: string;
	/** Plain text. */
	bio: string;
	avatarId: number | null;
	avatarUrl: string;
}

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

function cdataText(body: string): string {
	if (!body.includes("<![CDATA[")) return body.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&");
	let text = "";
	for (const m of body.matchAll(CDATA)) text += m[1];
	return text;
}

function tag(item: string, name: string): string | null {
	const m = item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
	return m ? cdataText(m[1] as string) : null;
}

/** An item's post meta (key → value; the first value wins). */
export function itemMeta(item: string): Map<string, string> {
	const meta = new Map<string, string>();
	for (const m of item.matchAll(/<wp:postmeta>([\s\S]*?)<\/wp:postmeta>/g)) {
		const key = tag(m[1] as string, "wp:meta_key");
		const value = tag(m[1] as string, "wp:meta_value");
		if (key !== null && value !== null && !meta.has(key)) meta.set(key, value);
	}
	return meta;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };

/** The plugin's schema helper strips tags from the bio (wp_strip_all_tags); EmDash bylines hold plain text too. */
export function bioText(html: string): string {
	return html
		.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<br\s*\/?>|<\/p>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
			if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
			const n = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
		})
		.replace(/[ \t]+/g, " ")
		.replace(/\s*\n\s*/g, "\n")
		.trim();
}

/** Every post with a guest author in a WXR export. `attachments` maps attachment ids to URLs (for avatars). */
export function wxrGuestAuthors(xml: string, attachments?: Map<number, string>): GuestAuthor[] {
	const out: GuestAuthor[] = [];
	for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const item = m[1] as string;
		if (!item.includes("_guest_author")) continue;
		const meta = itemMeta(item);
		const name = (meta.get("_guest_author") ?? "").trim();
		if (!name) continue;
		const avatarId = Number(meta.get("_guest_author_avatar_id"));
		const url = (meta.get("_guest_author_url") ?? "").trim();
		out.push({
			postId: Number(tag(item, "wp:post_id")) || null,
			postType: (tag(item, "wp:post_type") ?? "post").trim(),
			slug: (tag(item, "wp:post_name") ?? "").trim(),
			title: (tag(item, "title") ?? "").trim(),
			name,
			url: /^https?:\/\/\S+$/i.test(url) ? url : "",
			bio: bioText(meta.get("_guest_author_bio") ?? ""),
			avatarId: Number.isInteger(avatarId) && avatarId > 0 ? avatarId : null,
			avatarUrl: Number.isInteger(avatarId) && avatarId > 0 ? (attachments?.get(avatarId) ?? "") : "",
		});
	}
	return out;
}

/** EmDash's collection for a WordPress post type (its importer's mapping for posts and pages). */
export function collectionFor(postType: string): string {
	return postType === "post" ? "posts" : postType === "page" ? "pages" : postType;
}

/** A byline slug for a name: lowercase letters, digits and hyphens, starting with a letter. */
export function bylineSlug(name: string): string {
	const slug = name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^[^a-z]+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug || "guest";
}

/** One guest byline to create (or find), with the posts it's credited on. */
export interface GuestByline {
	name: string;
	slug: string;
	url: string;
	bio: string;
	/** Avatar file name (to find it in the media library) and its WordPress URL. */
	avatarFile: string;
	avatarUrl: string;
	posts: GuestAuthor[];
}

const nameKey = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Group posts by guest (same name, case-insensitive). Each byline takes the
 * first non-empty URL, bio and avatar among its posts.
 */
export function groupGuests(guests: GuestAuthor[]): GuestByline[] {
	const groups = new Map<string, GuestByline>();
	for (const g of guests) {
		const key = nameKey(g.name);
		let group = groups.get(key);
		if (!group) {
			group = { name: g.name.trim().replace(/\s+/g, " "), slug: bylineSlug(g.name), url: "", bio: "", avatarFile: "", avatarUrl: "", posts: [] };
			groups.set(key, group);
		}
		group.url ||= g.url;
		group.bio ||= g.bio;
		if (!group.avatarUrl && g.avatarUrl) {
			group.avatarUrl = g.avatarUrl;
			group.avatarFile = decodeURIComponent(g.avatarUrl.split(/[?#]/)[0]?.split("/").pop() ?? "");
		}
		group.posts.push(g);
	}
	return [...groups.values()];
}

/** Does an existing byline's name match a guest? */
export function sameName(a: string, b: string): boolean {
	return nameKey(a) === nameKey(b);
}
