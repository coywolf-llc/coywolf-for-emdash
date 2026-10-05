/**
 * Instant title matching in the browser (live results' title index): the
 * matcher, title highlighting and the merge of local and server results.
 * Plain ES2020 inside String.raw (no backticks or "${"), embedded in the live
 * results script and evaluated as-is by the tests, so both run the same code.
 *
 * Matching folds case and diacritics ("ecole" finds "École"). Every typed
 * word has to match. Ranking, best first:
 *   0. the title starts with what was typed (word by word),
 *   1. every word starts a word in the title,
 *   2. every word (3+ characters) appears somewhere in the title,
 * then the earlier the first match, the shorter the title, and the newer the
 * entry (the index is newest first).
 */
export const MATCH_SOURCE = String.raw`function () {
	"use strict";
	var MARKS = /[̀-ͯ]/g;
	var SPLIT = /[^\p{L}\p{N}]+/u;
	var WORDCHAR = /[\p{L}\p{N}]/u;
	var ASCII = /^[\x00-\x7f]*$/;

	function fold(text) {
		text = String(text || "");
		return ASCII.test(text) ? text.toLowerCase() : text.normalize("NFD").replace(MARKS, "").toLowerCase();
	}

	/** Folded text and, for each folded position, the original position it came from. */
	function foldMap(text) {
		var out = "";
		var map = [];
		for (var i = 0; i < text.length; ) {
			var cp = text.codePointAt(i);
			var ch = String.fromCodePoint(cp);
			var f = fold(ch);
			for (var k = 0; k < f.length; k++) map.push(i);
			out += f;
			i += ch.length;
		}
		map.push(text.length);
		return { text: out, map: map };
	}

	function words(folded) {
		return folded.split(SPLIT).filter(Boolean);
	}

	/** Index rows ([title, url, typeIndex]) ready to match. */
	function prepare(index) {
		var types = (index && index.types) || [];
		var rows = (index && index.entries) || [];
		var out = [];
		for (var i = 0; i < rows.length; i++) {
			var r = rows[i];
			if (!r || typeof r[0] !== "string" || typeof r[1] !== "string") continue;
			var f = fold(r[0]);
			out.push({ title: r[0], url: r[1], type: types[r[2]] || "", folded: f, spaced: " " + words(f).join(" ") });
		}
		return out;
	}

	function queryWords(query) {
		var seen = {};
		return words(fold(query)).filter(function (w) {
			if (seen[w]) return false;
			seen[w] = 1;
			return true;
		});
	}

	/** Ranked matches: [{ entry, tier }], at most limit. */
	function match(prepared, query, limit) {
		var terms = queryWords(query);
		if (!terms.length) return [];
		var phrase = " " + terms.join(" ");
		var hits = [];
		for (var i = 0; i < prepared.length; i++) {
			var e = prepared[i];
			var tier = -1;
			if (e.spaced.indexOf(phrase) === 0) tier = 0;
			else {
				var prefix = true;
				var loose = true;
				for (var t = 0; t < terms.length; t++) {
					var term = terms[t];
					var starts = e.spaced.indexOf(" " + term) !== -1;
					if (!starts) prefix = false;
					if (!starts && (term.length < 3 || e.folded.indexOf(term) === -1)) loose = false;
				}
				tier = prefix ? 1 : loose ? 2 : -1;
			}
			if (tier < 0) continue;
			var pos = tier === 2 ? e.folded.indexOf(terms[0]) : e.spaced.indexOf(" " + terms[0]);
			hits.push({ entry: e, tier: tier, pos: pos < 0 ? 999 : pos, i: i });
		}
		hits.sort(function (a, b) {
			return a.tier - b.tier || a.pos - b.pos || a.entry.title.length - b.entry.title.length || a.i - b.i;
		});
		return hits.slice(0, limit);
	}

	function escapeHtml(text) {
		return String(text).replace(/[&<>"']/g, function (c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
		});
	}

	/** Words to highlight, as the server picks them: two or more characters, longest first, at most 10. */
	function highlightTerms(query) {
		return queryWords(query)
			.filter(function (w) {
				return Array.from(w).length >= 2;
			})
			.sort(function (a, b) {
				return b.length - a.length;
			})
			.slice(0, 10);
	}

	/** The title, escaped, with matches in <mark>: at word starts, or anywhere when anywhere is true. */
	function highlight(title, query, anywhere) {
		var terms = highlightTerms(query);
		if (!terms.length) return escapeHtml(title);
		var fm = foldMap(title);
		var ranges = [];
		var at = 0;
		while (at < fm.text.length) {
			var found = null;
			if (anywhere || at === 0 || !WORDCHAR.test(fm.text.charAt(at - 1))) {
				for (var t = 0; t < terms.length; t++) {
					if (fm.text.substr(at, terms[t].length) === terms[t]) {
						found = terms[t];
						break;
					}
				}
			}
			if (found) {
				ranges.push([fm.map[at], fm.map[at + found.length]]);
				at += found.length;
			} else at++;
		}
		var out = "";
		var last = 0;
		for (var r = 0; r < ranges.length; r++) {
			if (ranges[r][0] < last) continue;
			out += escapeHtml(title.slice(last, ranges[r][0])) + "<mark>" + escapeHtml(title.slice(ranges[r][0], ranges[r][1])) + "</mark>";
			last = ranges[r][1];
		}
		return out + escapeHtml(title.slice(last));
	}

	/** Local results in the server's item shape (no excerpt), marked local. */
	function localItems(prepared, query, limit) {
		return match(prepared, query, limit).map(function (h) {
			return { title: h.entry.title, titleHtml: highlight(h.entry.title, query, h.tier === 2), url: h.entry.url, type: h.entry.type, snippet: "", local: true };
		});
	}

	function urlKey(url) {
		return String(url || "").replace(/[?#].*$/, "").replace(/\/+$/, "");
	}

	// Server results merged into the local ones without reshuffling them: a local row the server
	// also found is replaced by the server's (with its excerpt) in place, the server's other results
	// follow, and when that's too many, local rows the server didn't confirm give way from the bottom.
	function merge(local, server, limit) {
		var byUrl = {};
		server.forEach(function (s) {
			var k = urlKey(s.url);
			if (!byUrl[k]) byUrl[k] = s;
		});
		var used = {};
		var out = [];
		local.forEach(function (l) {
			var k = urlKey(l.url);
			if (used[k]) return;
			used[k] = 1;
			out.push(byUrl[k] || l);
		});
		server.forEach(function (s) {
			var k = urlKey(s.url);
			if (used[k]) return;
			used[k] = 1;
			out.push(s);
		});
		for (var i = out.length - 1; out.length > limit && i >= 0; i--) {
			if (out[i].local) out.splice(i, 1);
		}
		return out.slice(0, limit);
	}

	return { fold: fold, prepare: prepare, match: match, highlight: highlight, localItems: localItems, merge: merge };
}`;
