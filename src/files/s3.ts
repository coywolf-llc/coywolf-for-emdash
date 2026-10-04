/**
 * The few R2 S3-API calls large uploads need: start, complete and abort a
 * multipart upload, presign part uploads for the browser, read the bucket's
 * CORS rules, and delete an object. Requests are signed with ./sigv4.ts.
 */
import { type CorsRule, encodeXml, parseCors, xmlValue } from "./r2-rules.js";
import { EMPTY_SHA256, type SigV4Credentials, presignUrl, sha256Hex, signRequest } from "./sigv4.js";

export { corsPolicyFor, corsProblems, partSizeFor } from "./r2-rules.js";

export interface R2Config extends SigV4Credentials {
	accountId: string;
	bucket: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const PART_URL_TTL = 3600;
export function r2Host(accountId: string): string {
	return `${accountId}.r2.cloudflarestorage.com`;
}

export class S3Error extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message);
	}
}

export function r2Client(config: R2Config, fetchImpl: Fetch) {
	const host = r2Host(config.accountId);
	const objectPath = (key: string) => `/${config.bucket}/${key}`;

	async function call(
		method: string,
		path: string,
		options: { query?: Record<string, string>; headers?: Record<string, string>; body?: string } = {},
	): Promise<{ status: number; text: string; headers: Headers }> {
		const payloadHash = options.body ? await sha256Hex(options.body) : EMPTY_SHA256;
		const signed = await signRequest(
			{ method, host, path, query: options.query, headers: options.headers, region: "auto" },
			config,
			payloadHash,
		);
		const response = await fetchImpl(signed.url, { method, headers: signed.headers, body: options.body });
		const text = await response.text();
		if (!response.ok) {
			const code = xmlValue(text, "Code");
			const message = xmlValue(text, "Message") ?? `R2 answered ${response.status}`;
			throw new S3Error(code ? `${code}: ${message}` : message, response.status, code);
		}
		return { status: response.status, text, headers: response.headers };
	}

	return {
		async createMultipart(key: string, contentType: string): Promise<string> {
			const { text } = await call("POST", objectPath(key), {
				query: { uploads: "" },
				headers: { "content-type": contentType || "application/octet-stream" },
			});
			const uploadId = xmlValue(text, "UploadId");
			if (!uploadId) throw new S3Error("R2 didn't return an upload ID.", 502);
			return uploadId;
		},

		async signParts(key: string, uploadId: string, partNumbers: number[]): Promise<Array<{ partNumber: number; url: string }>> {
			return Promise.all(
				partNumbers.map(async (partNumber) => ({
					partNumber,
					url: (
						await presignUrl(
							{ method: "PUT", host, path: objectPath(key), query: { partNumber: String(partNumber), uploadId }, region: "auto" },
							config,
							PART_URL_TTL,
						)
					).url,
				})),
			);
		},

		async completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<string | undefined> {
			const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
			const body = `<CompleteMultipartUpload>${sorted
				.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${encodeXml(p.etag)}</ETag></Part>`)
				.join("")}</CompleteMultipartUpload>`;
			const { text } = await call("POST", objectPath(key), {
				query: { uploadId },
				headers: { "content-type": "application/xml" },
				body,
			});
			// S3 can answer 200 with an <Error> body.
			if (text.includes("<Error>")) throw new S3Error(xmlValue(text, "Message") ?? "Completing the upload failed.", 500, xmlValue(text, "Code"));
			return xmlValue(text, "ETag");
		},

		async abortMultipart(key: string, uploadId: string): Promise<void> {
			try {
				await call("DELETE", objectPath(key), { query: { uploadId } });
			} catch (error) {
				if (!(error instanceof S3Error && error.status === 404)) throw error;
			}
		},

		async headObject(key: string): Promise<{ size: number; etag: string | null } | null> {
			try {
				const { headers } = await call("HEAD", objectPath(key));
				return { size: Number(headers.get("content-length") ?? 0), etag: headers.get("etag") };
			} catch (error) {
				if (error instanceof S3Error && error.status === 404) return null;
				throw error;
			}
		},

		async deleteObject(key: string): Promise<void> {
			await call("DELETE", objectPath(key));
		},

		/** The bucket's CORS rules, or [] when none are set. */
		async getCors(): Promise<CorsRule[]> {
			try {
				const { text } = await call("GET", `/${config.bucket}`, { query: { cors: "" } });
				return parseCors(text);
			} catch (error) {
				if (error instanceof S3Error && (error.code === "NoSuchCORSConfiguration" || error.status === 404)) return [];
				throw error;
			}
		},
	};
}

