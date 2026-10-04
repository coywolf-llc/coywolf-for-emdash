/**
 * Run: node --test src/files/*.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error -- Node's type stripping needs the real .ts extension.
import * as f from "./format.ts";
// @ts-expect-error -- Node's type stripping needs the real .ts extension.
import { entryTitle, fileIdsIn, findFileBlocks } from "./walker.ts";

test("Content-Disposition: plain ASCII names", () => {
	assert.equal(f.contentDisposition("report.pdf"), 'attachment; filename="report.pdf"');
	assert.equal(f.contentDisposition("Q3 report (final).pdf"), 'attachment; filename="Q3 report (final).pdf"');
});

test("Content-Disposition: RFC 5987 for non-ASCII and unsafe characters", () => {
	assert.equal(f.contentDisposition("résumé.pdf"), `attachment; filename="resume.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`);
	assert.equal(f.contentDisposition("日本語.txt"), `attachment; filename="___.txt"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.txt`);
	assert.equal(f.contentDisposition('say "hi".txt'), `attachment; filename="say _hi_.txt"; filename*=UTF-8''say%20%22hi%22.txt`);
	assert.equal(f.contentDisposition("it's (1)*.txt"), `attachment; filename="it's (1)*.txt"`);
	assert.equal(f.contentDisposition("50%.txt"), `attachment; filename="50_.txt"; filename*=UTF-8''50%25.txt`);
	assert.equal(f.contentDisposition("a'bé.txt"), `attachment; filename="a'be.txt"; filename*=UTF-8''a%27b%C3%A9.txt`);
});

test("Content-Disposition: header injection and paths", () => {
	assert.equal(f.contentDisposition("evil\r\nSet-Cookie: x.pdf"), `attachment; filename="evil  Set-Cookie: x.pdf"`);
	assert.equal(f.contentDisposition("../../etc/passwd"), `attachment; filename="passwd"`);
	assert.equal(f.contentDisposition(""), `attachment; filename="download"`);
});

test("safe file names and download paths", () => {
	assert.equal(f.safeFilename("My Résumé (2026).PDF"), "My-Resume-2026.PDF");
	assert.equal(f.safeFilename("../x/y z.tar.gz"), "y-z.tar.gz");
	assert.equal(f.safeFilename("???"), "file");
	assert.equal(f.downloadPath("download", "fabcdefghijklmno", "a b.pdf"), "/download/fabcdefghijklmno/a-b.pdf");
	assert.equal(f.normalizeBase("/Files/"), "files");
	assert.equal(f.normalizeBase("_emdash"), "download");
	assert.equal(f.normalizeBase("a/b"), "download");
});

test("type badge mapping", () => {
	assert.deepEqual(f.iconFor("pdf"), { color: "#B42318", label: "PDF" });
	assert.deepEqual(f.iconFor("DOCX"), { color: "#155EEF", label: "DOCX" });
	assert.deepEqual(f.iconFor("xlsx"), { color: "#067647", label: "XLSX" });
	assert.deepEqual(f.iconFor("jpeg"), { color: "#C11574", label: "JPEG" });
	assert.deepEqual(f.iconFor("7z"), { color: "#6941E0", label: "7Z" });
	assert.deepEqual(f.iconFor("numbers"), { color: "#067647", label: "NUMB" });
	assert.deepEqual(f.iconFor("weird"), { color: f.DEFAULT_ICON_COLOR, label: "WEIR" });
	assert.deepEqual(f.iconFor(""), { color: f.DEFAULT_ICON_COLOR, label: "FILE" });
	assert.equal(f.extensionOf("archive.TAR.GZ"), "gz");
	assert.equal(f.extensionOf("README"), "");
});

test("sizes, colors and ids", () => {
	assert.equal(f.formatSize(0), "0 B");
	assert.equal(f.formatSize(1023), "1023 B");
	assert.equal(f.formatSize(1536), "1.5 KB");
	assert.equal(f.formatSize(5 * 1024 ** 3), "5.0 GB");
	assert.equal(f.safeColor("#0a7"), "#0a7");
	assert.equal(f.safeColor("red;}body{"), "");
	const id = f.newUploadId();
	assert.match(id, f.UPLOAD_ID);
	assert.ok(f.isFileId("01J9ZQ3W4X5Y6Z7A8B9C0D1E2F"));
	assert.ok(!f.isFileId("../etc"));
});

test("Portable Text walker finds nested coywolf-file blocks", () => {
	const content = {
		id: "c1",
		slug: "hello",
		data: {
			title: "Hello",
			body: [
				{ _type: "block", children: [{ _type: "span", text: "x" }] },
				{ _type: "coywolf-file", _key: "a", id: "fabcdefghijklmno", title: "Brochure" },
				{ _type: "columns", columns: [{ content: [{ _type: "coywolf-file", id: "01J9ZQ3W4X5Y6Z7A8B9C0D1E2F" }] }] },
				{ _type: "coywolf-file", id: "" },
				{ _type: "image", id: "01J9ZQ3W4X5Y6Z7A8B9C0D1E2G" },
			],
			sidebar: [{ _type: "coywolf-file", id: "fabcdefghijklmno" }],
		},
	};
	assert.deepEqual(findFileBlocks(content), [
		{ id: "fabcdefghijklmno", field: "body" },
		{ id: "01J9ZQ3W4X5Y6Z7A8B9C0D1E2F", field: "body" },
		{ id: "fabcdefghijklmno", field: "sidebar" },
	]);
	assert.deepEqual(fileIdsIn(content), ["fabcdefghijklmno", "01J9ZQ3W4X5Y6Z7A8B9C0D1E2F"]);
	assert.equal(entryTitle(content), "Hello");
	assert.equal(entryTitle({ id: "x", slug: "s", data: {} }), "s");
	assert.deepEqual(fileIdsIn(null), []);
});
