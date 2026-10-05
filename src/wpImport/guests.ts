/**
 * Bylines WordPress showed that EmDash's importer doesn't carry over. The
 * importer credits each post to its WordPress user (`dc:creator`) only, so it
 * misses:
 *
 * - co-authors and guest authors from Co-Authors Plus and PublishPress
 *   Authors. Both attach `author` taxonomy terms to the post
 *   (`<category domain="author" nicename="…">`). Co-Authors Plus keeps guest
 *   profiles as `guest-author` posts (meta cap-display_name, cap-user_login,
 *   cap-website, cap-description, _thumbnail_id) and names a user's term
 *   after their login (slug `cap-<login>`); PublishPress Authors keeps
 *   profiles in term meta (user_url, description, avatar);
 * - guests from the Coywolf Guest Author plugin, which stores one guest per
 *   post in post meta (no users, no taxonomy) and overrides the byline:
 *     _guest_author            name (an empty name means "no guest")
 *     _guest_author_url        website (optional)
 *     _guest_author_bio        biographical info (optional, may hold HTML)
 *     _guest_author_avatar_id  attachment id of the avatar (optional)
 *
 * The WordPress import page reads them from the export (wxrGuestAuthors),
 * groups them into bylines (groupGuests) and posts (postCredits), and credits
 * each post through EmDash's own admin API (bylines are EmDash core data that
 * plugins can only read).
 *
 * Pure, no imports: runs in the admin (browser), a Node script and tests.
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
	/** Order among the post's authors (0 = first). */
	position?: number;
	/** Where it came from: the Coywolf Guest Author plugin, or author terms (Co-Authors Plus, PublishPress Authors). */
	source?: "guest-author" | "co-authors";
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

/** Bios as plain text (EmDash bylines hold plain text; the Coywolf plugin's schema helper strips tags too). */
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

interface AuthorProfile {
	name: string;
	url: string;
	bio: string;
	avatarId: number | null;
	/** The WordPress user's login, when the author is a user. */
	login: string;
}

const validUrl = (url: string) => (/^https?:\/\/\S+$/i.test(url.trim()) ? url.trim() : "");
const attachmentId = (v: string | undefined) => {
	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : null;
};

function decodeSlug(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/** WordPress users in the export: login → display name. */
function wxrUsers(xml: string): Map<string, string> {
	const users = new Map<string, string>();
	for (const m of xml.matchAll(/<wp:author>([\s\S]*?)<\/wp:author>/g)) {
		const login = (tag(m[1] as string, "wp:author_login") ?? "").trim();
		if (login) users.set(login, (tag(m[1] as string, "wp:author_display_name") ?? "").trim() || login);
	}
	return users;
}

/** Author profiles by term slug: Co-Authors Plus guest-author posts and PublishPress Authors terms. */
function authorProfiles(xml: string, users: Map<string, string>): Map<string, AuthorProfile> {
	const profiles = new Map<string, AuthorProfile>();
	for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const item = m[1] as string;
		if ((tag(item, "wp:post_type") ?? "").trim() !== "guest-author") continue;
		const meta = itemMeta(item);
		const login = (meta.get("cap-user_login") ?? "").trim();
		const profile: AuthorProfile = {
			name: (meta.get("cap-display_name") ?? "").trim() || (tag(item, "title") ?? "").trim() || login,
			url: validUrl(meta.get("cap-website") ?? ""),
			bio: bioText(meta.get("cap-description") ?? ""),
			avatarId: attachmentId(meta.get("_thumbnail_id")),
			login: "",
		};
		if (!profile.name) continue;
		const slug = decodeSlug((tag(item, "wp:post_name") ?? "").trim());
		if (slug) profiles.set(slug, profile);
		if (login) profiles.set(`cap-${login.toLowerCase()}`, profile);
	}
	for (const m of xml.matchAll(/<wp:term>([\s\S]*?)<\/wp:term>/g)) {
		const term = m[1] as string;
		if ((tag(term, "wp:term_taxonomy") ?? "").trim() !== "author") continue;
		const slug = decodeSlug((tag(term, "wp:term_slug") ?? "").trim());
		if (!slug || profiles.has(slug)) continue;
		const meta = new Map<string, string>();
		for (const tm of term.matchAll(/<wp:termmeta>([\s\S]*?)<\/wp:termmeta>/g)) {
			const key = tag(tm[1] as string, "wp:meta_key");
			const value = tag(tm[1] as string, "wp:meta_value");
			if (key !== null && value !== null && !meta.has(key)) meta.set(key, value);
		}
		const name = (tag(term, "wp:term_name") ?? "").trim();
		// Co-Authors Plus names a user's term after their login: show the user's display name.
		const login = slug.startsWith("cap-") && users.has(name) ? name : "";
		profiles.set(slug, {
			name: login ? (users.get(login) as string) : name,
			url: validUrl(meta.get("user_url") ?? ""),
			bio: bioText(meta.get("description") ?? ""),
			avatarId: attachmentId(meta.get("avatar")),
			login,
		});
	}
	return profiles;
}

const SKIP_TYPES = new Set(["attachment", "nav_menu_item", "revision", "guest-author", "wp_block"]);

/**
 * Every post whose byline isn't (only) its WordPress user, one record per
 * post and author: the Coywolf Guest Author plugin's guest, or the post's
 * author terms (Co-Authors Plus, PublishPress Authors) in export order. A post
 * whose only author term is its own WordPress user is left out (the importer
 * already credits it). `attachments` maps attachment ids to URLs (for avatars).
 */
export function wxrGuestAuthors(xml: string, attachments?: Map<number, string>): GuestAuthor[] {
	const out: GuestAuthor[] = [];
	const hasTerms = xml.includes('domain="author"');
	const users = hasTerms ? wxrUsers(xml) : new Map<string, string>();
	const profiles = hasTerms ? authorProfiles(xml, users) : new Map<string, AuthorProfile>();
	const avatar = (id: number | null) => (id ? (attachments?.get(id) ?? "") : "");
	for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const item = m[1] as string;
		const hasGuest = item.includes("_guest_author");
		if (!hasGuest && !(hasTerms && item.includes('domain="author"'))) continue;
		const postType = (tag(item, "wp:post_type") ?? "post").trim();
		const status = (tag(item, "wp:status") ?? "").trim();
		if (SKIP_TYPES.has(postType) || status === "trash" || status === "auto-draft") continue;
		const post = {
			postId: Number(tag(item, "wp:post_id")) || null,
			postType,
			slug: (tag(item, "wp:post_name") ?? "").trim(),
			title: (tag(item, "title") ?? "").trim(),
		};
		if (hasGuest) {
			const meta = itemMeta(item);
			const name = (meta.get("_guest_author") ?? "").trim();
			if (name) {
				const avatarId = attachmentId(meta.get("_guest_author_avatar_id"));
				out.push({
					...post,
					name,
					url: validUrl(meta.get("_guest_author_url") ?? ""),
					bio: bioText(meta.get("_guest_author_bio") ?? ""),
					avatarId,
					avatarUrl: avatar(avatarId),
					position: 0,
					source: "guest-author",
				});
				// The plugin replaced the byline, so author terms don't apply.
				continue;
			}
		}
		if (!hasTerms) continue;
		const authors: AuthorProfile[] = [];
		const seen = new Set<string>();
		for (const t of item.matchAll(/<category\s+domain="author"\s+nicename="([^"]*)"\s*>([\s\S]*?)<\/category>/g)) {
			const slug = decodeSlug(t[1] as string);
			const text = cdataText(t[2] as string).trim();
			const known = profiles.get(slug);
			const login = known?.login || (slug.startsWith("cap-") && users.has(text) ? text : "");
			const profile: AuthorProfile = known ?? { name: login ? (users.get(login) as string) : text, url: "", bio: "", avatarId: null, login };
			const key = nameKey(profile.name);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			authors.push({ ...profile, login });
		}
		if (!authors.length) continue;
		const creator = (tag(item, "dc:creator") ?? "").trim();
		const only = authors.length === 1 ? authors[0] : undefined;
		if (only && creator && (only.login === creator || (users.has(creator) && sameName(only.name, users.get(creator) as string)))) continue;
		authors.forEach((a, position) => {
			out.push({ ...post, name: a.name, url: a.url, bio: a.bio, avatarId: a.avatarId, avatarUrl: avatar(a.avatarId), position, source: "co-authors" });
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

/** One byline to create (or find), with the posts it's credited on. */
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
 * Group records by author (same name, case-insensitive). Each byline takes
 * the first non-empty URL, bio and avatar among its records.
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

/** Each post with its authors' names in order, for crediting. */
export interface PostCredit {
	collection: string;
	slug: string;
	title: string;
	names: string[];
}

/** One entry per post (by collection and slug), its authors in order and without repeats. */
export function postCredits(guests: GuestAuthor[]): PostCredit[] {
	const posts = new Map<string, { credit: PostCredit; records: GuestAuthor[] }>();
	for (const g of guests) {
		const collection = collectionFor(g.postType);
		const key = `${collection}/${g.slug}`;
		let post = posts.get(key);
		if (!post) {
			post = { credit: { collection, slug: g.slug, title: g.title, names: [] }, records: [] };
			posts.set(key, post);
		}
		post.records.push(g);
	}
	return [...posts.values()].map(({ credit, records }) => {
		for (const g of records.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
			const name = g.name.trim().replace(/\s+/g, " ");
			if (!credit.names.some((n) => sameName(n, name))) credit.names.push(name);
		}
		return credit;
	});
}

/** Does an existing byline's name match a guest? */
export function sameName(a: string, b: string): boolean {
	return nameKey(a) === nameKey(b);
}
