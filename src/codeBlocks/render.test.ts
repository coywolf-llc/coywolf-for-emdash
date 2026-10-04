/**
 * Run: node --test src/codeBlocks/render.test.ts   (Node 22.18+ strips types)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// A literal ".ts" specifier would trip tsc (no allowImportingTsExtensions); Node needs the real file name.
const path = "./render" + ".ts";
const r: typeof import("./render.js") = await import(path);

test("escapes text in highlighted and plain output", () => {
	const html = r.renderBlock({ code: `<script>alert("x")</script> & </code>`, language: "zig" }, { label: true, copy: false, lineNumbers: false });
	assert.ok(!html.includes("<script>"));
	assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;/code&gt;"));
	const hl = r.highlightLines(`const a = "<b>";`, "javascript").join("\n");
	assert.ok(hl.includes("&lt;b&gt;"));
	assert.ok(!hl.includes("<b>"));
});

test("escapes the filename and an unknown language label", () => {
	const html = r.renderBlock({ code: "x", language: `"><img src=x>`, filename: `<i>a.ts</i>` }, { label: true, copy: false, lineNumbers: false });
	assert.ok(!html.includes("<img"));
	assert.ok(!html.includes("<i>"));
	assert.ok(html.includes("&lt;i&gt;a.ts&lt;/i&gt;"));
	assert.match(html, /class="language-img-src-x"/);
});

test("only hljs classes survive hast → HTML", () => {
	const lines = r.hastToLines({
		type: "root",
		children: [
			{
				type: "element",
				tagName: "span",
				properties: { className: ["hljs-title", "function_", "evil\" onclick=\"x", "other"] },
				children: [{ type: "text", value: "f" }],
			},
			{ type: "element", tagName: "img", properties: { src: "x", onerror: "alert(1)" }, children: [{ type: "text", value: "y" }] },
			{ type: "comment", value: "<!-- no -->" },
		],
	});
	assert.deepEqual(lines, ['<span class="hljs-title function_">f</span>y']);
});

test("unknown languages fall back to plain text", () => {
	const lang = r.resolveLanguage("klingon");
	assert.equal(lang.grammar, null);
	assert.equal(lang.id, "klingon");
	const html = r.renderBlock({ code: "if (x) { y }", language: "klingon" }, { label: false, copy: false, lineNumbers: false });
	assert.ok(!html.includes("hljs-"));
	assert.ok(html.includes("if (x) { y }"));
	assert.equal(r.resolveLanguage("").id, null);
	assert.equal(r.resolveLanguage("plaintext").label, null);
});

test("aliases and editor ids map to grammars", () => {
	assert.equal(r.resolveLanguage("ts").grammar, "typescript");
	assert.equal(r.resolveLanguage("TSX").grammar, "typescript");
	assert.equal(r.resolveLanguage("html").grammar, "xml");
	assert.equal(r.resolveLanguage("html").label, "HTML");
	assert.equal(r.resolveLanguage("dockerfile").grammar, "dockerfile");
	assert.equal(r.resolveLanguage("zig").grammar, null);
	assert.equal(r.resolveLanguage("zig").label, "Zig");
});

test("spans crossing newlines are closed and reopened per line", () => {
	const lines = r.highlightLines("/* one\n   two */\nx = 1", "javascript");
	assert.equal(lines.length, 3);
	assert.equal(lines[0], '<span class="hljs-comment">/* one</span>');
	assert.equal(lines[1], '<span class="hljs-comment">   two */</span>');
	for (const line of lines) {
		assert.equal((line.match(/<span/g) ?? []).length, (line.match(/<\/span>/g) ?? []).length, line);
	}
});

test("nested spans split across lines keep their nesting", () => {
	const lines = r.hastToLines({
		type: "root",
		children: [
			{
				type: "element",
				tagName: "span",
				properties: { className: ["hljs-string"] },
				children: [
					{ type: "text", value: "`a\n" },
					{ type: "element", tagName: "span", properties: { className: ["hljs-subst"] }, children: [{ type: "text", value: "${b\nc}" }] },
					{ type: "text", value: "`" },
				],
			},
		],
	});
	assert.deepEqual(lines, [
		'<span class="hljs-string">`a</span>',
		'<span class="hljs-string"><span class="hljs-subst">${b</span></span>',
		'<span class="hljs-string"><span class="hljs-subst">c}</span>`</span>',
	]);
});

test("line numbers wrap each line; trailing newline adds no empty line", () => {
	const html = r.renderBlock({ code: "a\nb\n", language: "plaintext" }, { label: true, copy: false, lineNumbers: true });
	assert.equal((html.match(/class="cw-line"/g) ?? []).length, 2);
	assert.ok(!html.includes("cw-code-head"), "plain text has no label");
});

test("copy button is accessible and optional", () => {
	const on = r.renderBlock({ code: "x", language: "js" }, { label: true, copy: true, lineNumbers: false });
	assert.ok(on.includes('aria-label="Copy code to clipboard"'));
	assert.ok(on.includes('role="status" aria-live="polite"'));
	assert.ok(on.includes('<span class="cw-code-label">JavaScript</span>'));
	const off = r.renderBlock({ code: "x", language: "js" }, { label: false, copy: false, lineNumbers: false });
	assert.ok(!off.includes("button"));
	assert.ok(!off.includes("cw-code-label"));
});

test("very large blocks skip highlighting", () => {
	const code = "const x = 1;\n".repeat(Math.ceil(r.MAX_HIGHLIGHT_CHARS / 13) + 1);
	assert.ok(!r.highlightLines(code, "javascript").some((l) => l.includes("<span")));
});
