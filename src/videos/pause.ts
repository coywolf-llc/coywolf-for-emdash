/**
 * Pause/play for a Stream player that may not be ready yet (browser code, used
 * by CoywolfVideo.astro). A press can come before Stream's SDK has loaded or
 * before the player inside the iframe is ready to take commands, and an
 * autoplaying video can start after a pause() that came too early. So the
 * visitor's choice is recorded, applied once the player exists, and applied
 * again whenever the player starts or becomes ready while the choice is
 * "paused".
 */

export interface ControllablePlayer {
	addEventListener(event: string, listener: () => void): void;
	play(): unknown;
	pause(): unknown;
}

/** Player events after which a paused choice is enforced again. */
export const HOLD_EVENTS = ["loadeddata", "canplay", "play", "playing"] as const;

/** A setter for the wanted state (true: playing) of the player `player` resolves to. */
export function playerControl(player: Promise<ControllablePlayer | null>): (playing: boolean) => void {
	let want: boolean | null = null;
	let hooked = false;
	const apply = (p: ControllablePlayer) => {
		try {
			void Promise.resolve(want ? p.play() : p.pause()).catch(() => undefined);
		} catch {
			// Not ready yet: the next player event applies it again.
		}
	};
	return (playing) => {
		want = playing;
		void player.then((p) => {
			if (!p) return;
			if (!hooked) {
				hooked = true;
				for (const event of HOLD_EVENTS) p.addEventListener(event, () => want === false && apply(p));
			}
			apply(p);
		});
	};
}
