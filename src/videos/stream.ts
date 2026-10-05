/**
 * Minimal Cloudflare Stream API client (the parts the Videos module uses).
 * Same endpoints and token as EmDash's cloudflareStream() media provider,
 * which this module doesn't depend on: that provider resolves its
 * credentials from env at import time and has no captions, downloads or
 * webhook calls.
 */
const API = "https://api.cloudflare.com/client/v4";

export interface StreamCredentials {
	accountId: string;
	token: string;
}

export interface StreamVideo {
	uid: string;
	thumbnail?: string;
	preview?: string;
	readyToStream?: boolean;
	status?: { state?: string; pctComplete?: string; errorReasonText?: string };
	meta?: Record<string, unknown>;
	created?: string;
	modified?: string;
	uploaded?: string;
	size?: number;
	duration?: number;
	input?: { width?: number; height?: number };
	allowedOrigins?: string[];
	requireSignedURLs?: boolean;
	playback?: { hls?: string; dash?: string };
}

export interface StreamCaption {
	language: string;
	label?: string;
	generated?: boolean;
	status?: string;
}

export class StreamError extends Error {
	// A plain field, not a parameter property, so `node --test` can load this file (type stripping).
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

interface Envelope<T> {
	success?: boolean;
	errors?: Array<{ message?: string }>;
	result?: T;
}

export function streamClient(creds: StreamCredentials) {
	const base = `${API}/accounts/${encodeURIComponent(creds.accountId)}/stream`;
	const auth = { Authorization: `Bearer ${creds.token}` };

	async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
		const init: RequestInit = { method, headers: { ...auth, ...headers } };
		if (body instanceof FormData) init.body = body;
		else if (body !== undefined) {
			init.body = JSON.stringify(body);
			(init.headers as Record<string, string>)["Content-Type"] = "application/json";
		}
		const res = await fetch(`${base}${path}`, init);
		let data: Envelope<T> | null = null;
		try {
			data = (await res.json()) as Envelope<T>;
		} catch {
			data = null;
		}
		if (!res.ok || data?.success === false) {
			const message = data?.errors?.map((e) => e.message).filter(Boolean).join(" ") || `Cloudflare Stream returned HTTP ${res.status}.`;
			throw new StreamError(message, res.status);
		}
		return (data?.result ?? null) as T;
	}

	const id = (uid: string) => `/${encodeURIComponent(uid)}`;

	return {
		list: (limit = 1000) => call<StreamVideo[]>("GET", `?limit=${limit}&asc=false`),
		get: (uid: string) => call<StreamVideo>("GET", id(uid)),
		update: (uid: string, fields: Record<string, unknown>) => call<StreamVideo>("POST", id(uid), { uid, ...fields }),
		directUpload: (opts: { maxDurationSeconds: number; name: string }) =>
			call<{ uploadURL: string; uid: string }>("POST", "/direct_upload", { maxDurationSeconds: opts.maxDurationSeconds, meta: { name: opts.name } }),

		/** One-time tus upload URL for large files (the browser uploads straight to Stream). */
		async tusUpload(opts: { length: number; maxDurationSeconds: number; name: string }): Promise<{ uploadURL: string; uid: string | null }> {
			const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
			const res = await fetch(`${base}?direct_user=true`, {
				method: "POST",
				headers: {
					...auth,
					"Tus-Resumable": "1.0.0",
					"Upload-Length": String(opts.length),
					"Upload-Metadata": `name ${b64(opts.name)},maxdurationseconds ${b64(String(opts.maxDurationSeconds))}`,
				},
			});
			const location = res.headers.get("Location");
			if (!res.ok || !location) throw new StreamError(`Cloudflare Stream refused the upload (HTTP ${res.status}).`, res.status);
			return { uploadURL: location, uid: res.headers.get("stream-media-id") };
		},

		getDownloads: (uid: string) => call<{ default?: { status?: string; url?: string; percentComplete?: number } }>("GET", `${id(uid)}/downloads`),
		createDownload: (uid: string) => call<{ default?: { status?: string; url?: string; percentComplete?: number } }>("POST", `${id(uid)}/downloads`),
		deleteDownload: (uid: string) => call<unknown>("DELETE", `${id(uid)}/downloads`),

		listCaptions: (uid: string) => call<StreamCaption[]>("GET", `${id(uid)}/captions`),
		uploadCaption(uid: string, lang: string, vtt: string) {
			const form = new FormData();
			form.append("file", new Blob([vtt], { type: "text/vtt" }), `${lang}.vtt`);
			return call<StreamCaption>("PUT", `${id(uid)}/captions/${encodeURIComponent(lang)}`, form);
		},
		generateCaption: (uid: string, lang: string) => call<StreamCaption>("POST", `${id(uid)}/captions/${encodeURIComponent(lang)}/generate`),
		deleteCaption: (uid: string, lang: string) => call<unknown>("DELETE", `${id(uid)}/captions/${encodeURIComponent(lang)}`),
		async captionVtt(uid: string, lang: string): Promise<string> {
			const res = await fetch(`${base}${id(uid)}/captions/${encodeURIComponent(lang)}/vtt`, { headers: auth });
			if (!res.ok) throw new StreamError(`Could not download the ${lang} captions (HTTP ${res.status}).`, res.status);
			return res.text();
		},

		setWebhook: (notificationUrl: string) => call<{ notificationUrl?: string; secret?: string }>("PUT", "/webhook", { notificationUrl }),
		getWebhook: () => call<{ notificationUrl?: string } | null>("GET", "/webhook"),
		deleteWebhook: () => call<unknown>("DELETE", "/webhook"),
	};
}

export type StreamClient = ReturnType<typeof streamClient>;
