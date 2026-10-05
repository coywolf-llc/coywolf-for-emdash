// Run: node --test test/schema-metadata.test.mjs
// Schema & Social's page:metadata output for a full page (authors, publisher
// Person, main subject, theme videos and reviews, AI entities), compared with
// a recorded copy, so reordering its reads can't change a byte of it.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

const { schemaContributions, invalidateSchemaConfig } = await import("../src/schema/module.ts");
const { registerFeatures } = await import("../src/core/features.ts");
// AI Enrichment's switches (its module isn't loaded here), so getEntryEntities sees "ai.entities" on.
registerFeatures([
	{ id: "ai", label: "AI", description: "", default: false },
	{ id: "ai.entities", label: "Entities", description: "", default: false },
]);

const FIXTURE = new URL("./fixtures/schema-metadata.json", import.meta.url);
const ORIGIN = "https://example.com";

const bylines = {
	b1: { id: "b1", slug: "jon", displayName: "Jon Henshaw", bio: "Writes things.", websiteUrl: "https://jon.example", avatarMediaId: "m1" },
	b2: { id: "b2", slug: "ana", displayName: "Ana Lopez", bio: null, websiteUrl: null, avatarMediaId: "m2" },
	b3: { id: "b3", slug: "sam", displayName: "Sam Lee", bio: "Subject.", websiteUrl: null, avatarMediaId: null },
};

/** A plugin context whose reads resolve after a tick, logging each call. */
function fakeCtx(log, stats = { inFlight: 0, most: 0 }) {
	const later = (name, value) => {
		log.push(name);
		stats.most = Math.max(stats.most, ++stats.inFlight);
		return new Promise((resolve) =>
			setTimeout(() => {
				stats.inFlight--;
				resolve(value);
			}, 1),
		);
	};
	const store = (name, rows) => ({
		get: (id) => later(`${name}.get:${id}`, rows[id] ?? null),
		getMany: (ids) => later(`${name}.getMany:${ids.join(",")}`, new Map(ids.filter((id) => rows[id]).map((id) => [id, rows[id]]))),
	});
	return {
		site: { url: ORIGIN, name: "Example", locale: "en-US" },
		log: { warn: (msg, data) => log.push(`warn:${msg}:${JSON.stringify(data)}`), info() {}, error() {} },
		settings: {
			list: (prefix) => later(`settings.list:${prefix}`, [{ key: "schemaAuthorUrlPattern", value: "/author/{slug}/" }]),
			get: (key) => later(`settings.get:${key}`, key === "features" ? { ai: true, "ai.entities": true } : null),
		},
		storage: {
			schemaDocs: store("schemaDocs", {
				site: { publisherType: "person", personBylineId: "b1", orgRows: [] },
				types: { posts: { pageType: "WebPage", articleType: "BlogPosting" } },
			}),
			schemaEntries: store("schemaEntries", { "posts:e1": { collection: "posts", entryId: "e1", mainSubject: "byline:b3" } }),
			schemaAuthors: store("schemaAuthors", {
				b1: { rows: [{ prop: "jobTitle", value: "Founder" }] },
				b2: { rows: [{ prop: "image", value: "https://cdn.example/ana.jpg" }] },
				b3: { rows: [{ prop: "knowsAbout", value: "Wolves", profileOnly: true }] },
			}),
			aiEntries: store("aiEntries", {
				"posts:e1": { entities: [{ name: "Coyote", qid: "Q44299", type: "Thing", primary: true }, { name: "Wolf", qid: "Q18498", type: "Thing", primary: false }] },
			}),
		},
		bylines: {
			get: (id) => later(`bylines.get:${id}`, bylines[id] ?? null),
			getEntriesBylines: (collection, ids) => later(`bylines.getEntriesBylines:${collection}:${ids}`, [{ bylines: [{ byline: bylines.b1 }, { byline: bylines.b2 }] }]),
		},
		media: { get: (id) => later(`media.get:${id}`, { url: `/_emdash/api/media/file/${id}.jpg` }) },
		content: { get: (collection, id) => later(`content.get:${collection}:${id}`, { data: {} }) },
	};
}

const page = {
	url: `${ORIGIN}/my-post/`,
	path: "/my-post/",
	locale: "en-US",
	kind: "content",
	pageType: "article",
	title: "My Post | Example",
	pageTitle: "My Post",
	description: "About my post.",
	canonical: `${ORIGIN}/my-post/`,
	image: "https://cdn.example/cover.jpg",
	content: { collection: "posts", id: "e1", slug: "my-post" },
	seo: { ogImage: null, robots: null },
	articleMeta: { publishedTime: "2026-01-02T03:04:05Z", modifiedTime: "2026-02-03T04:05:06Z", author: "Jon Henshaw" },
	siteName: "Example",
	siteUrl: ORIGIN,
	coywolf: {
		videos: [{ name: "A video", description: "Watch it.", thumbnailUrl: "https://cdn.example/v.jpg", uploadDate: "2026-01-01", contentUrl: "https://cdn.example/v.mp4" }],
		reviews: [{ itemName: "Trail camera", itemType: "Product", rating: 4, summary: "Good." }],
	},
};

const features = {
	schema: true,
	"schema.graph": true,
	"schema.breadcrumbs": true,
	"schema.robots": true,
	"schema.openGraph": true,
	"schema.authors": true,
	"reviews.schema": true,
	"ai.entities": true,
};

test("page:metadata output is unchanged (recorded graph)", async () => {
	invalidateSchemaConfig();
	const log = [];
	const out = await schemaContributions(fakeCtx(log), page, {}, features);
	const json = `${JSON.stringify(out, null, "\t")}\n`;
	if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, json);
	assert.equal(json, readFileSync(FIXTURE, "utf8"));
	assert.ok(!log.some((l) => l.startsWith("warn:")), log.join("\n"));
});

test("page:metadata runs independent reads at once", async () => {
	invalidateSchemaConfig();
	const stats = { inFlight: 0, most: 0 };
	await schemaContributions(fakeCtx([], stats), page, {}, features);
	// The entry override, credited bylines and AI entities row are read together (one after another before).
	assert.ok(stats.most >= 3, `at most ${stats.most} reads at once`);
});
