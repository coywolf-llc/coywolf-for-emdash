/**
 * Backup storage layout (shared with .github/workflows/backup.yml):
 *
 *   d1/<stamp>/<file>.sql.gz   database dump
 *   d1/<stamp>/manifest.json   what the dump is and where it came from
 *   media/current/<key>        mirror of the media bucket
 *   media/changed/<stamp>/<key> media replaced or deleted since the previous run
 */

export interface Manifest {
	stamp: string;
	database?: string;
	file: string;
	bytes: number;
	sha256: string;
	/** "github-actions" (external nightly job), "scheduled" (plugin), or "admin" (Back up now). */
	source?: string;
	timeTravelBookmark?: string;
	gitSha?: string;
	tables?: number;
	rows?: number;
	media?: { copied: number; preserved: number; total: number; pending?: number };
}

export interface BackupEntry extends Manifest {
	createdAt: string;
}

export const STAMP = /^\d{4}-\d{2}-\d{2}T\d{4}Z$/;
export const FILE = /^[a-z0-9._-]+$/i;

/** 2026-10-03T1802Z — sortable, safe in object keys and URLs. */
export function makeStamp(date = new Date()): string {
	const iso = date.toISOString();
	return `${iso.slice(0, 13)}${iso.slice(14, 16)}Z`;
}

export function stampToDate(stamp: string): Date {
	return new Date(`${stamp.slice(0, 13)}:${stamp.slice(13, 15)}:00Z`);
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
	const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function writeDump(
	bucket: R2Bucket,
	stamp: string,
	file: string,
	body: Uint8Array<ArrayBuffer>,
	extra: Partial<Manifest>,
): Promise<Manifest> {
	const manifest: Manifest = {
		...extra,
		stamp,
		file,
		bytes: body.byteLength,
		sha256: await sha256(body),
	};
	await bucket.put(`d1/${stamp}/${file}`, body, { httpMetadata: { contentType: "application/gzip" } });
	await bucket.put(`d1/${stamp}/manifest.json`, JSON.stringify(manifest, null, 1), {
		httpMetadata: { contentType: "application/json" },
	});
	return manifest;
}

/** Every backup with a manifest, newest first. */
export async function listBackups(bucket: R2Bucket): Promise<BackupEntry[]> {
	const stamps: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: "d1/", delimiter: "/", cursor });
		for (const prefix of page.delimitedPrefixes) {
			const stamp = prefix.slice(3, -1);
			if (STAMP.test(stamp)) stamps.push(stamp);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	const entries = await Promise.all(
		stamps.map(async (stamp) => {
			const object = await bucket.get(`d1/${stamp}/manifest.json`);
			if (!object) return null;
			try {
				const manifest = (await object.json()) as Manifest;
				return { ...manifest, stamp, createdAt: stampToDate(stamp).toISOString() };
			} catch {
				return null;
			}
		}),
	);
	return entries.filter((e): e is BackupEntry => e !== null).sort((a, b) => b.stamp.localeCompare(a.stamp));
}

/**
 * Mirror the media bucket into media/current/, moving anything replaced or
 * deleted since the last run to media/changed/<stamp>/ (same as the nightly
 * job's `rclone sync --backup-dir`). Compares by ETag.
 *
 * Copies at most `maxChanges` files per run so a large first mirror stays under
 * the Workers subrequest limit; the rest are reported as `pending` and copied
 * on the next run.
 */
export async function mirrorMedia(media: R2Bucket, backups: R2Bucket, stamp: string, maxChanges = 300) {
	const source = new Map<string, string>();
	let cursor: string | undefined;
	do {
		const page = await media.list({ cursor });
		for (const object of page.objects) source.set(object.key, object.etag);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	const mirror = new Map<string, string>();
	do {
		const page = await backups.list({ prefix: "media/current/", cursor });
		for (const object of page.objects) mirror.set(object.key.slice("media/current/".length), object.etag);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	let copied = 0;
	let preserved = 0;
	const keep = async (key: string) => {
		const old = await backups.get(`media/current/${key}`);
		if (!old) return;
		await backups.put(`media/changed/${stamp}/${key}`, old.body, { httpMetadata: old.httpMetadata });
		preserved++;
	};

	let changes = 0;
	let pending = 0;
	for (const [key, etag] of source) {
		if (mirror.get(key) === etag) continue;
		if (changes >= maxChanges) {
			pending++;
			continue;
		}
		changes++;
		if (mirror.has(key)) await keep(key);
		const object = await media.get(key);
		if (!object) continue;
		await backups.put(`media/current/${key}`, object.body, { httpMetadata: object.httpMetadata });
		copied++;
	}
	for (const key of mirror.keys()) {
		if (source.has(key)) continue;
		if (changes >= maxChanges) {
			pending++;
			continue;
		}
		changes++;
		await keep(key);
		await backups.delete(`media/current/${key}`);
	}
	return { copied, preserved, total: source.size, pending };
}

/**
 * Copy media files that are in the backup mirror but missing from the media
 * bucket. Never overwrites. Copies at most `max` files per call so one request
 * stays well inside Worker limits; `pending` is what's left for the next call
 * (a coywolf.com restore trial copied 2,021 files in one request and took
 * over five minutes).
 */
export async function restoreMissingMedia(
	media: R2Bucket,
	backups: R2Bucket,
	max = 200,
): Promise<{ restored: number; checked: number; pending: number }> {
	const present = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await media.list({ cursor });
		for (const o of page.objects) present.add(o.key);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	let restored = 0;
	let checked = 0;
	let pending = 0;
	do {
		const page = await backups.list({ prefix: "media/current/", cursor });
		for (const o of page.objects) {
			checked++;
			const key = o.key.slice("media/current/".length);
			if (present.has(key)) continue;
			if (restored >= max) {
				pending++;
				continue;
			}
			const object = await backups.get(o.key);
			if (!object) continue;
			await media.put(key, object.body, { httpMetadata: object.httpMetadata });
			restored++;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return { restored, checked, pending };
}

/** Delete database backups and replaced-media copies older than `days`. Returns the number of stamps pruned. */
export async function pruneBackups(bucket: R2Bucket, days: number): Promise<number> {
	const cutoff = makeStamp(new Date(Date.now() - days * 86_400_000));
	let pruned = 0;
	for (const prefix of ["d1/", "media/changed/"]) {
		let cursor: string | undefined;
		do {
			const page = await bucket.list({ prefix, delimiter: "/", cursor });
			for (const dir of page.delimitedPrefixes) {
				const stamp = dir.slice(prefix.length, -1);
				if (!STAMP.test(stamp) || stamp >= cutoff) continue;
				await deletePrefix(bucket, dir);
				if (prefix === "d1/") pruned++;
			}
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
	}
	return pruned;
}

async function deletePrefix(bucket: R2Bucket, prefix: string) {
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor });
		if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}
