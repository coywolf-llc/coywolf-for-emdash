// Code block themes are readable: every text color reaches 4.5:1 (WCAG 1.4.3) on its theme's background.
// Run: node --test test/code-themes.test.mjs
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { HLJS_THEMES } = await import("../src/codeBlocks/themes.generated.ts");
const { themeCss, themeOptions } = await import("../src/codeBlocks/themes.ts");
const { contrastRatio, parseColor, readableOn, themeBase, themeTextColors } = await import("../src/codeBlocks/contrast.ts");

const MIN = 4.5;
const hex = (c) => `#${c.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;

test("the original themes do need fixing (so the check below means something)", () => {
	const comment = themeTextColors(HLJS_THEMES["atom-one-light"].css).find((c) => c.selector.includes(".hljs-comment"));
	assert.ok(contrastRatio(comment.color, comment.background) < MIN);
});

for (const id of Object.keys(HLJS_THEMES)) {
	test(`${id}: body text, comments and every other token color reach 4.5:1`, () => {
		const css = themeCss(id);
		const base = themeBase(css);
		assert.ok(contrastRatio(base.color, base.background) >= MIN, `body text ${hex(base.color)} on ${hex(base.background)}`);
		const colors = themeTextColors(css);
		assert.ok(colors.some((c) => /\.hljs-comment\b/.test(c.selector)), "has a comment color");
		for (const c of colors) {
			const ratio = contrastRatio(c.color, c.background);
			assert.ok(ratio >= MIN, `${c.selector}: ${hex(c.color)} on ${hex(c.background)} is ${ratio.toFixed(2)}:1`);
		}
		const line = parseColor(/--cw-line:(#[0-9a-f]{6})/.exec(css)?.[1] ?? "");
		assert.ok(line && contrastRatio(line, base.background) >= MIN, "line numbers");
	});
}

test("Coywolf palettes: body text, comments and line numbers reach 4.5:1", () => {
	for (const id of ["coywolf-light", "coywolf-dark"]) {
		const css = themeCss(id);
		const v = (name) => parseColor(new RegExp(`--cw-${name}:(#[0-9a-f]{3,6})`).exec(css)[1]);
		assert.ok(contrastRatio(v("fg"), v("bg")) >= MIN, `${id} text`);
		assert.ok(contrastRatio(v("comment"), v("bg")) >= MIN, `${id} comments`);
		assert.match(css, /--cw-line:var\(--cw-comment\)/);
	}
});

test("every theme option renders CSS", () => {
	for (const { id } of themeOptions()) assert.ok(themeCss(id).includes(".cw-code"), id);
});

test("a fix keeps the hue and only moves lightness as far as needed", () => {
	const bg = parseColor("#fafafa");
	const fixed = readableOn(parseColor("#a0a1a7"), bg);
	const ratio = contrastRatio(fixed, bg);
	assert.ok(ratio >= MIN && ratio < 4.8, `${ratio}`);
	assert.deepEqual(readableOn(parseColor("#24292e"), parseColor("#ffffff")).slice(0, 3), [0x24, 0x29, 0x2e]);
});

test("line numbers use the theme's muted color, not a fixed opacity", async () => {
	const { CHROME_CSS } = await import("../src/codeBlocks/render.ts");
	assert.match(CHROME_CSS, /\.cw-line::before\{[^}]*color:var\(--cw-line,currentColor\)/);
	assert.doesNotMatch(CHROME_CSS, /\.cw-line::before\{[^}]*opacity/);
});
