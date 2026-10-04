/**
 * Category and page parents from a WordPress export (WXR). EmDash's importer
 * creates every category flat (no parent) and drops pages' parents, so
 * WordPress's hierarchical URLs (/news/seo/a-post/, /apps/coywolf-seo/) are
 * lost. The WordPress import page reads them here, then:
 *
 * - categories: sets each term's parent through EmDash's own taxonomy API
 *   (plugins can read terms but not update them), after a dry run
 *   (planCategoryParents);
 * - pages: EmDash entries have no parent, so it prints a `pageParents` map
 *   for coywolfPlugin() (used by the `{pagepath}` URL token).
 *
 * In the export, `<wp:category>` holds `<wp:category_nicename>` (slug) and
 * `<wp:category_parent>` (the parent's slug); `<wp:term>` entries with
 * `<wp:term_taxonomy>category</wp:term_taxonomy>` use `<wp:term_slug>` and
 * `<wp:term_parent>`. Pages are `<item>`s with `<wp:post_type>page</wp:post_type>`
 * and `<wp:post_parent>` (the parent's post id; 0 = none).
 *
 * Pure, no imports: runs in the admin (browser), a Node script and tests.
 */

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

function text(body: string): string {
	if (!body.includes("<![CDATA[")) return body.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&");
	let out = "";
	for (const m of body.matchAll(CDATA)) out += m[1];
	return out;
}

function tag(block: string, name: string): string {
	const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
	return m ? text(m[1] as string).trim() : "";
}

/** WordPress stores slugs percent-encoded (non-ASCII); EmDash keeps the decoded form. */
function slugText(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** WordPress stores term names HTML-escaped (`Tips &amp; Tricks`). */
const decodeName = (name: string) => name.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export interface WxrCategory {
	slug: string;
	name: string;
	/** The parent's slug, "" for a top-level category. */
	parent: string;
}

/** Every category in an export, with its parent's slug. */
export function wxrCategories(xml: string): WxrCategory[] {
	const out = new Map<string, WxrCategory>();
	for (const m of xml.matchAll(/<wp:category>([\s\S]*?)<\/wp:category>/g)) {
		const block = m[1] as string;
		const slug = slugText(tag(block, "wp:category_nicename"));
		if (slug && !out.has(slug)) out.set(slug, { slug, name: decodeName(tag(block, "wp:cat_name")) || slug, parent: slugText(tag(block, "wp:category_parent")) });
	}
	for (const m of xml.matchAll(/<wp:term>([\s\S]*?)<\/wp:term>/g)) {
		const block = m[1] as string;
		if (tag(block, "wp:term_taxonomy") !== "category") continue;
		const slug = slugText(tag(block, "wp:term_slug"));
		if (slug && !out.has(slug)) out.set(slug, { slug, name: decodeName(tag(block, "wp:term_name")) || slug, parent: slugText(tag(block, "wp:term_parent")) });
	}
	return [...out.values()];
}

export interface WxrPage {
	id: number;
	slug: string;
	title: string;
	/** The parent page's slug, "" for a top-level page (or a parent not in the export). */
	parent: string;
}

/** Pages in an export (not trashed or auto-drafts), with their parent page's slug. */
export function wxrPages(xml: string): WxrPage[] {
	const raw: Array<{ id: number; slug: string; title: string; parentId: number }> = [];
	for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const item = m[1] as string;
		if (tag(item, "wp:post_type") !== "page") continue;
		const status = tag(item, "wp:status");
		if (status === "trash" || status === "auto-draft" || status === "inherit") continue;
		const slug = slugText(tag(item, "wp:post_name"));
		if (!slug) continue;
		raw.push({ id: Number(tag(item, "wp:post_id")) || 0, slug, title: tag(item, "title"), parentId: Number(tag(item, "wp:post_parent")) || 0 });
	}
	const slugById = new Map(raw.filter((p) => p.id).map((p) => [p.id, p.slug]));
	return raw.map((p) => ({ id: p.id, slug: p.slug, title: p.title, parent: (p.parentId && slugById.get(p.parentId)) || "" }));
}

/** slug → parent slug, for the entries that have a parent (and aren't their own parent). */
export function parentsMap(items: Array<{ slug: string; parent: string }>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const item of items) if (item.parent && item.parent !== item.slug && !Object.hasOwn(out, item.slug)) out[item.slug] = item.parent;
	return out;
}

/** A term as EmDash's taxonomy API lists it (flattened). */
export interface SiteTerm {
	id: string;
	slug: string;
	label?: string;
	/** The parent's translation_group (or row id), null at the top level. */
	parentId: string | null;
	translationGroup?: string | null;
	locale?: string;
	children?: SiteTerm[];
}

/** EmDash lists hierarchical taxonomies as a tree: flatten it (first row per slug wins). */
export function flattenTerms(terms: SiteTerm[]): SiteTerm[] {
	const out = new Map<string, SiteTerm>();
	const walk = (nodes: SiteTerm[], depth: number) => {
		if (depth > 64) return;
		for (const node of nodes) {
			if (!out.has(node.slug)) out.set(node.slug, node);
			if (node.children?.length) walk(node.children, depth + 1);
		}
	};
	walk(terms, 0);
	return [...out.values()];
}

export interface ParentPlan {
	slug: string;
	name: string;
	/** The parent WordPress had. */
	parent: string;
	/** The parent on the site now ("" = none). */
	current: string;
	/** The site's term id (to update) and the parent term's id (to set). */
	termId?: string;
	parentTermId?: string;
	/** set: the parent will be set; done: already right; missing: the term or its parent isn't on the site. */
	action: "set" | "done" | "missing";
	note?: string;
	result?: string;
}

/**
 * What restoring WordPress's category parents would change, per category
 * with a parent in WordPress. Categories that are already right are "done",
 * so running it again changes nothing.
 */
export function planCategoryParents(categories: WxrCategory[], siteTerms: SiteTerm[]): ParentPlan[] {
	const terms = flattenTerms(siteTerms);
	const bySlug = new Map(terms.map((t) => [t.slug, t]));
	const slugByRef = new Map<string, string>();
	for (const t of terms) {
		slugByRef.set(t.id, t.slug);
		if (t.translationGroup && !slugByRef.has(t.translationGroup)) slugByRef.set(t.translationGroup, t.slug);
	}
	const plans: ParentPlan[] = [];
	for (const c of categories) {
		if (!c.parent || c.parent === c.slug) continue;
		const term = bySlug.get(c.slug);
		const parent = bySlug.get(c.parent);
		const current = term?.parentId ? (slugByRef.get(term.parentId) ?? term.parentId) : "";
		const plan: ParentPlan = { slug: c.slug, name: c.name, parent: c.parent, current, termId: term?.id, parentTermId: parent?.id, action: "set" };
		if (!term) {
			plan.action = "missing";
			plan.note = `No category “${c.slug}” on the site`;
		} else if (!parent) {
			plan.action = "missing";
			plan.note = `The parent “${c.parent}” isn't on the site`;
		} else if (current === c.parent) {
			plan.action = "done";
		}
		plans.push(plan);
	}
	// Parents before children, so each update finds its parent in place.
	const depth = (slug: string) => {
		let d = 0;
		const seen = new Set<string>();
		let up = categories.find((c) => c.slug === slug)?.parent;
		while (up && !seen.has(up) && d < 64) {
			seen.add(up);
			d++;
			up = categories.find((c) => c.slug === up)?.parent;
		}
		return d;
	};
	return plans.sort((a, b) => depth(a.slug) - depth(b.slug) || a.slug.localeCompare(b.slug));
}

/** A ready-to-paste coywolfPlugin() option, e.g. `pageParents: { "coywolf-seo": "apps" },`. */
export function optionSnippet(name: string, map: Record<string, string>): string {
	const entries = Object.entries(map).sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
	if (!entries.length) return `${name}: {},`;
	return `${name}: {\n${entries.map(([k, v]) => `\t${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}\n},`;
}

/** The same as a `termParents` option for one taxonomy: `termParents: { category: { … } },`. */
export function termParentsSnippet(taxonomy: string, map: Record<string, string>): string {
	const inner = optionSnippet(taxonomy, map).replace(/,$/, "").replace(/\n/g, "\n\t");
	return `termParents: {\n\t${inner},\n},`;
}
