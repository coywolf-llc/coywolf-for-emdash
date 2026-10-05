// Run: node --test test/form-uploads.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";
import { fakeBucket, fakeCollection, fakeFormsPlugin, fakeKv, fakeMediaLibrary, fileForm } from "./fixtures/forms-plugin.mjs";

const lib = await import("../src/formUploads/lib.ts");
const { wrapFormsPlugin, sweep, migrateBatch } = await import("../src/formUploads/wrap.ts");
const { privateFormUploads, FEATURES } = await import("../src/formUploads/pack.ts");

// ── Pure helpers ─────────────────────────────────────────────────

test("sanitizeFilename keeps a safe base name and the extension", () => {
	const s = lib.sanitizeFilename;
	assert.equal(s("screenshot.png"), "screenshot.png");
	assert.equal(s("../../etc/passwd"), "passwd");
	assert.equal(s("C:\\Users\\me\\Desktop\\bug report.PDF"), "bug report.PDF");
	assert.equal(s('a<b>c:d"e|f?g*.txt'), "a_b_c_d_e_f_g_.txt");
	assert.equal(s("evil\u0000name\r\n.txt"), "evilname.txt");
	assert.equal(s("\u202egnp.exe"), "gnp.exe", "bidi override stripped");
	assert.equal(s(".htaccess"), "htaccess", "no hidden files");
	assert.equal(s("report.pdf. . "), "report.pdf");
	assert.equal(s("CON.txt"), "_CON.txt");
	assert.equal(s(""), "upload");
	assert.equal(s(null), "upload");
	assert.equal(s("...."), "upload");
	const long = `${"x".repeat(300)}.jpeg`;
	assert.equal(s(long).length, 120);
	assert.ok(s(long).endsWith(".jpeg"));
	assert.equal(s("  café   menu .pdf"), "café menu .pdf");
});

test("safeContentType never lets a file render as a page or script", () => {
	const t = lib.safeContentType;
	for (const active of ["text/html", "TEXT/HTML; charset=utf-8", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/xml", "application/javascript", "text/javascript", "text/css", "application/wasm", "multipart/x-mixed-replace", "", "nonsense", undefined]) {
		assert.equal(t(active), "application/octet-stream", String(active));
	}
	assert.equal(t("image/png"), "image/png");
	assert.equal(t("application/pdf"), "application/pdf");
	assert.equal(t("text/plain; charset=utf-8"), "text/plain");
	assert.equal(t("video/mp4"), "video/mp4");
});

test("private media ids", () => {
	const id = lib.newUploadId();
	assert.match(id, lib.UPLOAD_ID);
	assert.equal(lib.privateIdOf(lib.privateMediaId(id)), id);
	assert.equal(lib.privateIdOf("01JABCDEF"), null);
	assert.equal(lib.privateIdOf("coywolf-private:../../x"), null);
	assert.equal(lib.privateIdOf(42), null);
	assert.equal(lib.objectKey(id), `uploads/${id}`);
});

test("config: scope, selected forms and retention", () => {
	assert.deepEqual(lib.normalizeConfig(null), lib.DEFAULT_CONFIG);
	assert.deepEqual(lib.normalizeConfig({ scope: "selected", forms: ["a", "a", "", 3, "b"], retentionDays: 30.5 }), { scope: "selected", forms: ["a", "b"], retentionDays: 0 });
	assert.equal(lib.normalizeConfig({ retentionDays: 99999 }).retentionDays, 3650);
	const selected = lib.normalizeConfig({ scope: "selected", forms: ["f1", "ai-alt-text-feedback"] });
	assert.ok(lib.formSelected(selected, { id: "f1", slug: "x" }));
	assert.ok(lib.formSelected(selected, { id: "f9", slug: "ai-alt-text-feedback" }));
	assert.ok(!lib.formSelected(selected, { id: "f2", slug: "other" }));
	assert.ok(lib.formSelected(lib.DEFAULT_CONFIG, { id: "anything" }));
});

test("download chunks", () => {
	const MB = 1024 * 1024;
	assert.deepEqual(lib.chunkRange(10, 0), { start: 0, end: 9 });
	assert.equal(lib.chunkRange(10, 1), null);
	assert.deepEqual(lib.chunkRange(0, 0), { start: 0, end: -1 });
	assert.deepEqual(lib.chunkRange(9 * MB, 2), { start: 8 * MB, end: 9 * MB - 1 });
	assert.equal(lib.chunkRange(9 * MB, 3), null);
	assert.equal(lib.chunkRange(9 * MB, -1), null);
	assert.equal(lib.totalFromContentRange("bytes 0-99/1234"), 1234);
	assert.equal(lib.totalFromContentRange(null), null);
});

test("matchField pairs uploads with fields by name and size", () => {
	const files = { a: { filename: "x.png", bytes: { byteLength: 3 } }, b: { filename: "x.png", bytes: { byteLength: 3 } }, c: { filename: "y.pdf", bytes: { byteLength: 9 } } };
	const taken = new Set();
	assert.equal(lib.matchField(files, "x.png", 3, taken), "a");
	assert.equal(lib.matchField(files, "x.png", 3, taken), "b");
	assert.equal(lib.matchField(files, "y.pdf", 9, taken), "c");
	assert.equal(lib.matchField(files, "z", 1, taken), "");
});

test("submissionPreview skips spam fields and truncates", () => {
	assert.equal(lib.submissionPreview({ _hp: "", "cf-turnstile-response": "tok", email: "a@b.co", message: "  Hello\nthere " }), "a@b.co · Hello there");
	assert.ok(lib.submissionPreview({ m: "x".repeat(500) }).length <= 140);
});

test("sweepDecision", () => {
	const now = Date.parse("2026-10-10T00:00:00Z");
	const entry = (over) => ({ id: "a".repeat(32), uploadedAt: "2026-10-01T00:00:00Z", submissionId: "s1", ...over });
	assert.equal(lib.sweepDecision(entry(), { now, retentionDays: 0, submissionExists: true }), "keep");
	assert.equal(lib.sweepDecision(entry(), { now, retentionDays: 5, submissionExists: true }), "retention");
	assert.equal(lib.sweepDecision(entry(), { now, retentionDays: 30, submissionExists: false }), "orphan");
	assert.equal(lib.sweepDecision(entry({ submissionId: null }), { now, retentionDays: 0, submissionExists: null }), "relink");
	assert.equal(lib.sweepDecision(entry({ submissionId: null, uploadedAt: new Date(now - 60_000).toISOString() }), { now, retentionDays: 0, submissionExists: null }), "keep");
});

test("feature is registered, off by default", () => {
	assert.equal(FEATURES[0].id, "formUploads");
	assert.equal(FEATURES[0].default, false);
});

test("privateFormUploads() swaps the entrypoint and keeps the Forms descriptor", () => {
	const forms = { id: "emdash-forms", version: "0.2.9", entrypoint: "@emdash-cms/plugin-forms", adminEntry: "@emdash-cms/plugin-forms/admin", options: { defaultSpamProtection: "honeypot" }, capabilities: ["media:write"], storage: { forms: {} } };
	const wrapped = privateFormUploads(forms, { bucket: "PRIVATE" });
	assert.equal(wrapped.entrypoint, "@coywolf/emdash/forms");
	assert.equal(wrapped.id, "emdash-forms");
	assert.equal(wrapped.adminEntry, forms.adminEntry);
	assert.deepEqual(wrapped.storage, forms.storage);
	assert.deepEqual(wrapped.options, { defaultSpamProtection: "honeypot", coywolfPrivateUploads: { bucket: "PRIVATE" } });
	assert.throws(() => privateFormUploads({ ...forms, id: "other" }), /emdash-forms/);
});

// ── The wrapped Forms plugin ─────────────────────────────────────

function setup({ enabled = true, bucketBound = true, config, forms } = {}) {
	const plugin = fakeFormsPlugin();
	const bucket = fakeBucket();
	const mediaBucket = fakeBucket();
	const media = fakeMediaLibrary();
	const state = { enabled, scheduled: [] };
	const deps = {
		bucket: async () => (bucketBound ? bucket : undefined),
		mediaBucket: async () => mediaBucket,
		database: async () => ({
			prepare: () => ({ bind: (id) => ({ first: async () => (media.items.has(id) ? { storage_key: media.items.get(id).storageKey } : null) }) }),
		}),
		enabled: async () => state.enabled,
	};
	const wrapped = wrapFormsPlugin(plugin, deps);
	const storage = {
		forms: fakeCollection(forms ?? { f1: fileForm("f1", "open-graph-checker-feedback"), f2: fileForm("f2", "newsletter") }),
		submissions: fakeCollection(),
	};
	const kv = fakeKv();
	if (config) kv.map.set(lib.CONFIG_KEY, config);
	const seq = { n: 0 };
	const ctx = (input, extra = {}) => ({
		input,
		media,
		kv,
		storage,
		__seq: seq,
		cron: { schedule: async (name, opts) => state.scheduled.push([name, opts.schedule]) },
		log: { info() {}, warn() {}, error() {} },
		...extra,
	});
	return { plugin, wrapped, bucket, mediaBucket, media, storage, kv, ctx, state, deps };
}

const bytesOf = (text) => new TextEncoder().encode(text);
const submission = (formId, files = {}, data = { email: "a@example.com", message: "It broke" }) => ({
	formId,
	data,
	files: Object.fromEntries(Object.entries(files).map(([field, [filename, contentType, content]]) => [field, { filename, contentType, bytes: bytesOf(content) }])),
});

async function call(wrapped, name, ctx) {
	return wrapped.routes[name].handler(ctx);
}

test("added routes are admin-only (plugins:manage, never public); originals keep their flags", () => {
	const { wrapped } = setup();
	const added = Object.keys(wrapped.routes).filter((n) => n.startsWith(lib.ROUTE_PREFIX));
	assert.deepEqual(added.sort(), ["delete", "download", "list", "migrate", "settings", "status"].map((n) => `${lib.ROUTE_PREFIX}${n}`).sort());
	for (const name of added) {
		assert.equal(wrapped.routes[name].permission, "plugins:manage", name);
		assert.notEqual(wrapped.routes[name].public, true, name);
	}
	const dl = wrapped.routes[`${lib.ROUTE_PREFIX}download`];
	assert.equal(dl.response, "raw");
	assert.deepEqual(dl.methods, ["GET"]);
	for (const name of ["delete", "settings", "migrate"]) assert.deepEqual(wrapped.routes[`${lib.ROUTE_PREFIX}${name}`].methods, ["POST"], name);
	assert.equal(wrapped.routes.submit.public, true);
	assert.ok(wrapped.routes.submit.input, "Forms' own input schema is kept");
	assert.equal(wrapped.id, "emdash-forms");
	assert.ok(wrapped.hooks.cron.timeout >= 30_000);
});

test("submit with the feature on: file goes to the private bucket, not the media library", async () => {
	const { wrapped, bucket, media, storage, kv, ctx } = setup();
	const result = await call(wrapped, "submit", ctx(submission("open-graph-checker-feedback", { screenshot: ["bug <1>.png", "image/png", "<script>alert(1)</script>"] })));
	assert.equal(result.success, true);
	assert.equal(media.items.size, 0, "nothing in the media library");
	assert.equal(bucket.objects.size, 1);
	const [key, object] = [...bucket.objects.entries()][0];
	assert.match(key, /^uploads\/[a-f0-9]{32}$/);
	assert.equal(object.httpMetadata.contentType, "image/png");
	assert.match(object.httpMetadata.contentDisposition, /^attachment;/);

	const [subId, sub] = [...storage.submissions.rows.entries()][0];
	assert.equal(sub.files.length, 1);
	const id = lib.privateIdOf(sub.files[0].mediaId);
	assert.ok(id, "submission records the private id");

	const entry = kv.map.get(`${lib.ENTRY_PREFIX}${id}`);
	assert.equal(entry.submissionId, subId, "linked to its submission");
	assert.equal(entry.formId, "f1");
	assert.equal(entry.formSlug, "open-graph-checker-feedback");
	assert.equal(entry.fieldName, "screenshot");
	assert.equal(entry.fieldLabel, "Screenshot");
	assert.equal(entry.filename, "bug _1_.png");
	assert.equal(entry.contentType, "image/png");
	assert.equal(entry.size, 25);
});

test("types the media library wouldn't take are refused, nothing stored", async () => {
	const { wrapped, bucket, media, storage, ctx } = setup();
	for (const [name, type] of [["page.html", "text/html"], ["x.svg", "image/svg+xml"], ["run.exe", "application/x-msdownload"], ["a.png", "image/png\r\nX-Evil: 1"]]) {
		await assert.rejects(call(wrapped, "submit", ctx(submission("f1", { screenshot: [name, type, "x"] }))), /File type not allowed/, type);
	}
	assert.equal(bucket.objects.size + media.items.size + storage.submissions.rows.size, 0);
	assert.ok(lib.uploadTypeAllowed("video/mp4") && lib.uploadTypeAllowed("audio/mpeg; codecs=x") && lib.uploadTypeAllowed("application/pdf"));
	assert.ok(!lib.uploadTypeAllowed("image/svg+xml") && !lib.uploadTypeAllowed("text/plain") && !lib.uploadTypeAllowed(""));
});

test("submit with the feature off: the Forms plugin's media library behavior is unchanged", async () => {
	const { wrapped, bucket, media, storage, ctx } = setup({ enabled: false });
	await call(wrapped, "submit", ctx(submission("f1", { screenshot: ["a.png", "image/png", "png"] })));
	assert.equal(bucket.objects.size, 0);
	assert.equal(media.items.size, 1);
	assert.equal([...storage.submissions.rows.values()][0].files[0].mediaId, "media1");
});

test("only selected forms go private", async () => {
	const { wrapped, bucket, media, ctx } = setup({ config: { scope: "selected", forms: ["open-graph-checker-feedback"], retentionDays: 0 } });
	await call(wrapped, "submit", ctx(submission("f1", { screenshot: ["a.png", "image/png", "png"] })));
	await call(wrapped, "submit", ctx(submission("newsletter", { screenshot: ["b.png", "image/png", "png"] })));
	assert.equal(bucket.objects.size, 1);
	assert.equal(media.items.size, 1);
});

test("feature on but no bucket bound: fails closed, never public", async () => {
	const { wrapped, media, storage, ctx } = setup({ bucketBound: false });
	await assert.rejects(call(wrapped, "submit", ctx(submission("f1", { screenshot: ["a.png", "image/png", "png"] }))), /not configured/);
	assert.equal(media.items.size, 0);
	assert.equal(storage.submissions.rows.size, 0);
});

test("submissions without files, honeypot and validation errors store nothing", async () => {
	const { wrapped, bucket, kv, ctx } = setup();
	assert.equal((await call(wrapped, "submit", ctx(submission("f1")))).success, true);
	assert.equal((await call(wrapped, "submit", ctx({ ...submission("f1", { screenshot: ["a.png", "image/png", "x"] }), data: { _hp: "bot" } }))).success, true);
	assert.equal(bucket.objects.size, 0);
	assert.equal([...kv.map.keys()].filter((k) => k.startsWith(lib.ENTRY_PREFIX)).length, 0);
});

test("a failed submission removes the private files it uploaded (Forms' own cleanup)", async () => {
	const { wrapped, bucket, kv, ctx } = setup();
	await assert.rejects(call(wrapped, "submit", ctx(submission("f1", { screenshot: ["a.png", "image/png", "x"] }), { __failAfterUpload: true })), /boom/);
	assert.equal(bucket.objects.size, 0);
	assert.equal([...kv.map.keys()].filter((k) => k.startsWith(lib.ENTRY_PREFIX)).length, 0);
});

test("deleting a submission deletes its private files", async () => {
	const { wrapped, bucket, storage, kv, ctx } = setup();
	await call(wrapped, "submit", ctx(submission("f1", { screenshot: ["a.png", "image/png", "x"] })));
	const subId = [...storage.submissions.rows.keys()][0];
	await call(wrapped, "submissions/delete", ctx({ id: subId }));
	assert.equal(bucket.objects.size, 0);
	assert.equal([...kv.map.keys()].filter((k) => k.startsWith(lib.ENTRY_PREFIX)).length, 0);
});

test("the Forms retention cron deletes private files through the wrapped hook", async () => {
	const { wrapped, bucket, ctx } = setup();
	await call(wrapped, "submit", ctx(submission("f1", { screenshot: ["a.png", "image/png", "x"] })));
	await wrapped.hooks.cron.handler({ name: "cleanup" }, ctx(undefined));
	assert.equal(bucket.objects.size, 0);
});

test("download: admin route returns the bytes as an attachment with a safe type, in 4 MB parts", async () => {
	const { wrapped, kv, bucket, ctx } = setup();
	const big = "x".repeat(5 * 1024 * 1024);
	// An SVG moved from the media library: stored privately, never served as an image.
	const id = "c".repeat(32);
	kv.map.set(`${lib.ENTRY_PREFIX}${id}`, { id, key: `uploads/${id}`, filename: "page.svg", contentType: "image/svg+xml", size: big.length, uploadedAt: new Date().toISOString(), submissionId: null });
	await bucket.put(`uploads/${id}`, bytesOf(big));
	const part0 = await call(wrapped, `${lib.ROUTE_PREFIX}download`, ctx({ id, part: "0" }));
	assert.equal(part0.__emdashPluginResponse, true);
	const headers = Object.fromEntries(part0.headers.map(([k, v]) => [k.toLowerCase(), v]));
	assert.equal(headers["content-type"], "application/octet-stream");
	assert.equal(headers["content-disposition"], 'attachment; filename="page.svg"');
	assert.equal(headers["content-range"], `bytes 0-${4 * 1024 * 1024 - 1}/${big.length}`);
	assert.equal(part0.body.value.byteLength, 4 * 1024 * 1024);
	const part1 = await call(wrapped, `${lib.ROUTE_PREFIX}download`, ctx({ id, part: "1" }));
	assert.equal(part1.body.value.byteLength, big.length - 4 * 1024 * 1024);
	await assert.rejects(call(wrapped, `${lib.ROUTE_PREFIX}download`, ctx({ id, part: "2" })), /No such part/);
	await assert.rejects(call(wrapped, `${lib.ROUTE_PREFIX}download`, ctx({ id: "../uploads/x" })), /Invalid|match/i);
	await assert.rejects(call(wrapped, `${lib.ROUTE_PREFIX}download`, ctx({ id: "f".repeat(32) })), /not found/i);
});

test("list joins each file with its submission; delete removes one file", async () => {
	const { wrapped, bucket, ctx } = setup();
	await call(wrapped, "submit", ctx(submission("f1", { screenshot: ["a.png", "image/png", "x"] })));
	const { items } = await call(wrapped, `${lib.ROUTE_PREFIX}list`, ctx({}));
	assert.equal(items.length, 1);
	assert.equal(items[0].submission.preview, "a@example.com · It broke");
	assert.equal(items[0].formName, "Form open-graph-checker-feedback");
	assert.deepEqual(await call(wrapped, `${lib.ROUTE_PREFIX}delete`, ctx({ id: items[0].id })), { deleted: true });
	assert.equal(bucket.objects.size, 0);
	await assert.rejects(call(wrapped, `${lib.ROUTE_PREFIX}delete`, ctx({ id: items[0].id })), /not found/i);
});

test("settings save validates, stores and schedules the daily tidy", async () => {
	const { wrapped, kv, state, ctx } = setup();
	const saved = await call(wrapped, `${lib.ROUTE_PREFIX}settings`, ctx({ scope: "selected", forms: ["f1"], retentionDays: 30 }));
	assert.deepEqual(saved, { scope: "selected", forms: ["f1"], retentionDays: 30 });
	assert.deepEqual(kv.map.get(lib.CONFIG_KEY), saved);
	assert.deepEqual(state.scheduled, [[lib.SWEEP_TASK, "@daily"]]);
	await assert.rejects(call(wrapped, `${lib.ROUTE_PREFIX}settings`, ctx({ scope: "some", forms: [], retentionDays: 0 })));
});

test("status reports bindings, the switch and forms with file fields", async () => {
	const { wrapped, ctx } = setup({ enabled: false });
	const status = await call(wrapped, `${lib.ROUTE_PREFIX}status`, ctx({}));
	assert.equal(status.wrapped, true);
	assert.equal(status.enabled, false);
	assert.equal(status.bucketBound, true);
	assert.deepEqual(status.forms.map((f) => [f.slug, f.fileFields]), [["newsletter", 1], ["open-graph-checker-feedback", 1]]);
});

test("daily tidy: retention, orphans and gone submissions", async () => {
	const { wrapped, bucket, storage, kv, deps, ctx } = setup();
	await call(wrapped, "submit", ctx(submission("f1", { screenshot: ["keep.png", "image/png", "x"] })));
	await call(wrapped, "submit", ctx(submission("f1", { screenshot: ["gone.png", "image/png", "y"] })));
	// A submission deleted without the wrapper (e.g. straight from the database).
	const goneSub = [...storage.submissions.rows.entries()].find(([, s]) => s.files[0].filename === "gone.png")[0];
	storage.submissions.rows.delete(goneSub);
	// An upload whose submission never saved.
	kv.map.set(`${lib.ENTRY_PREFIX}${"b".repeat(32)}`, { id: "b".repeat(32), key: `uploads/${"b".repeat(32)}`, formId: "f1", uploadedAt: "2020-01-01T00:00:00Z", submissionId: null });
	await bucket.put(`uploads/${"b".repeat(32)}`, bytesOf("z"));

	const counts = await sweep(ctx(undefined), deps);
	assert.deepEqual(counts, { retention: 0, orphan: 2, relinked: 0 });
	assert.equal(bucket.objects.size, 1);

	kv.map.set(lib.CONFIG_KEY, { scope: "all", forms: [], retentionDays: 1 });
	const later = await sweep(ctx(undefined), deps, Date.now() + 2 * 86_400_000);
	assert.equal(later.retention, 1);
	assert.equal(bucket.objects.size, 0);
	assert.equal(storage.submissions.rows.size, 1, "retention keeps the submission");

	// The cron hook routes the tidy task to the sweep.
	assert.deepEqual(await wrapped.hooks.cron.handler({ name: lib.SWEEP_TASK }, ctx(undefined)), { retention: 0, orphan: 0, relinked: 0 });
});

test("migration moves earlier media-library uploads into the private bucket", async () => {
	const { wrapped, bucket, mediaBucket, media, storage, kv, state, deps, ctx } = setup({ enabled: false });
	await call(wrapped, "submit", ctx(submission("f1", { screenshot: ["old.png", "image/png", "old-bytes"] })));
	assert.equal(media.items.size, 1);
	const item = [...media.items.values()][0];
	await mediaBucket.put(item.storageKey, item.bytes);

	state.enabled = true;
	const status = await call(wrapped, `${lib.ROUTE_PREFIX}status`, ctx({}));
	assert.equal(status.mediaLibraryFiles, 1);

	const result = await migrateBatch(ctx(undefined), deps, 20);
	assert.deepEqual({ moved: result.moved, remaining: result.remaining, failed: result.failed.length }, { moved: 1, remaining: 0, failed: 0 });
	assert.equal(media.items.size, 0, "media library copy deleted");
	assert.equal(bucket.objects.size, 1);
	const sub = [...storage.submissions.rows.values()][0];
	const id = lib.privateIdOf(sub.files[0].mediaId);
	assert.ok(id);
	const entry = kv.map.get(`${lib.ENTRY_PREFIX}${id}`);
	assert.equal(entry.source, "media-library");
	assert.equal(entry.submissionId, [...storage.submissions.rows.keys()][0]);
	assert.equal(new TextDecoder().decode(bucket.objects.get(entry.key).bytes), "old-bytes");
});

test("migrate route refuses while the feature is off", async () => {
	const { wrapped, ctx } = setup({ enabled: false });
	await assert.rejects(call(wrapped, `${lib.ROUTE_PREFIX}migrate`, ctx({})), /Turn on/);
});
