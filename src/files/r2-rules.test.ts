/**
 * Run: node --test src/files/*.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error -- Node's type stripping needs the real .ts extension.
import { parseDownloadPath } from "./format.ts";
// @ts-expect-error -- Node's type stripping needs the real .ts extension.
import { corsProblems, parseCors, partSizeFor } from "./r2-rules.ts";

const MiB = 1024 * 1024;

test("part sizes stay at or above 8 MiB and under 10,000 parts", () => {
	assert.equal(partSizeFor(1), 8 * MiB);
	assert.equal(partSizeFor(100 * MiB), 8 * MiB);
	const huge = 200 * 1024 * MiB; // 200 GiB
	const size = partSizeFor(huge);
	assert.ok(Math.ceil(huge / size) <= 10_000);
	assert.equal(size % MiB, 0);
});

const xml = (rules: string) => `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration>${rules}</CORSConfiguration>`;

test("CORS: a complete rule passes", () => {
	const rules = parseCors(
		xml(
			"<CORSRule><AllowedOrigin>https://example.com</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader></CORSRule>",
		),
	);
	assert.deepEqual(rules[0], { origins: ["https://example.com"], methods: ["PUT", "GET"], headers: ["*"], expose: ["etag"] });
	assert.deepEqual(corsProblems(rules, "https://example.com"), []);
	assert.deepEqual(corsProblems(rules, "https://other.com"), ["No CORS rule allows the origin https://other.com."]);
});

test("CORS: wildcard origins, missing ETag and headers", () => {
	const rules = parseCors(xml("<CORSRule><AllowedOrigin>https://*.example.com</AllowedOrigin><AllowedMethod>PUT</AllowedMethod></CORSRule>"));
	const problems = corsProblems(rules, "https://www.example.com");
	assert.equal(problems.length, 2);
	assert.match(problems[0], /Content-Type/);
	assert.match(problems[1], /ETag/);
	assert.deepEqual(corsProblems([], "https://a.com"), ["The bucket has no CORS policy."]);
	const getOnly = parseCors(xml("<CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod></CORSRule>"));
	assert.match(corsProblems(getOnly, "https://a.com")[0], /PUT/);
});

test("download paths", () => {
	assert.deepEqual(parseDownloadPath("/download/fabcdefghijklmno/report.pdf", "download"), { id: "fabcdefghijklmno", filename: "report.pdf" });
	assert.deepEqual(parseDownloadPath("/download/01J9ZQ3W4X5Y6Z7A8B9C0D1E2F", "download"), { id: "01J9ZQ3W4X5Y6Z7A8B9C0D1E2F", filename: null });
	assert.equal(parseDownloadPath("/download/", "download"), null);
	assert.equal(parseDownloadPath("/download/not-an-id/x.pdf", "download"), null);
	assert.equal(parseDownloadPath("/download/fabcdefghijklmno/a/b", "download"), null);
	assert.equal(parseDownloadPath("/downloads/fabcdefghijklmno/x", "download"), null);
	assert.equal(parseDownloadPath("/download/%E0%A4%A/x", "download"), null);
});
