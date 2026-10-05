// Pause/play for autoplaying videos holds to the visitor's choice until Stream's player is ready.
// Run: node --test test/video-pause.test.mjs
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { playerControl } = await import("../src/videos/pause.ts");

/** A Stream player whose commands are ignored until `ready()`, and that autoplays when it is. */
function fakePlayer() {
	const listeners = new Map();
	const p = {
		ready: false,
		paused: true,
		calls: [],
		addEventListener(event, listener) {
			listeners.set(event, [...(listeners.get(event) ?? []), listener]);
		},
		emit(event) {
			for (const listener of listeners.get(event) ?? []) listener();
		},
		play() {
			p.calls.push("play");
			if (p.ready) p.paused = false;
			return Promise.resolve();
		},
		pause() {
			p.calls.push("pause");
			if (p.ready) p.paused = true;
		},
		start() {
			// The iframe finishes loading and autoplay kicks in.
			p.ready = true;
			p.emit("loadeddata");
			p.paused = false;
			p.emit("play");
			p.emit("playing");
		},
	};
	return p;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("pausing before the SDK and player are ready keeps the video paused once it autoplays", async () => {
	const player = fakePlayer();
	let resolve;
	const control = playerControl(new Promise((r) => (resolve = r)));
	control(false); // The first press, before the SDK has loaded.
	resolve(player);
	await tick();
	assert.deepEqual(player.calls, ["pause"], "applied as soon as the player exists (ignored: not ready)");
	player.start();
	assert.equal(player.paused, true, "autoplay starting later is paused again");
});

test("pressing play again lets it play, and later player events don't pause it", async () => {
	const player = fakePlayer();
	const control = playerControl(Promise.resolve(player));
	control(false);
	await tick();
	player.start();
	assert.equal(player.paused, true);
	control(true);
	await tick();
	assert.equal(player.paused, false);
	player.emit("playing");
	assert.equal(player.paused, false);
});

test("listeners are added once however many presses, and a missing SDK does nothing", async () => {
	const player = fakePlayer();
	let added = 0;
	const add = player.addEventListener.bind(player);
	player.addEventListener = (e, f) => (added++, add(e, f));
	const control = playerControl(Promise.resolve(player));
	control(false);
	control(true);
	control(false);
	await tick();
	assert.equal(added, 4);
	assert.doesNotThrow(() => playerControl(Promise.resolve(null))(false));
	const throwing = { addEventListener() {}, play() {}, pause() {
		throw new Error("not ready");
	} };
	playerControl(Promise.resolve(throwing))(false);
	await tick();
});
