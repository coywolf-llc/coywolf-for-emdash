// A stand-in for @emdash-cms/plugin-forms 0.2.x: the same ctx.media calls as
// its submit handler (src/handlers/submit.ts), submission delete
// (src/handlers/submissions.ts) and retention cleanup (src/handlers/cron.ts),
// with the same resolved-plugin shape definePlugin() returns.

export function fakeFormsPlugin() {
	const submit = async (ctx) => {
		const input = ctx.input;
		let formId = input.formId;
		let form = await ctx.storage.forms.get(formId);
		if (!form) {
			const bySlug = await ctx.storage.forms.query({ where: { slug: formId }, limit: 1 });
			if (bySlug.items[0]) {
				formId = bySlug.items[0].id;
				form = bySlug.items[0].data;
			}
		}
		if (!form) throw new Error("Form not found");
		if (input.data._hp) return { success: true, message: form.settings.confirmationMessage };
		const fields = form.pages.flatMap((p) => p.fields);
		for (const field of fields) {
			if (field.type === "file" && field.required && !input.files?.[field.name]) return { success: false, errors: [{ field: field.name, message: "Required" }] };
		}
		const pending = fields.filter((f) => f.type === "file" && input.files?.[f.name]).map((field) => ({ field, fileData: input.files[field.name] }));
		if (pending.length > 0 && !(ctx.media && "upload" in ctx.media)) throw new Error("File uploads are not configured");
		const files = [];
		for (const { field, fileData } of pending) {
			if (field.validation?.maxFileSize && fileData.bytes.byteLength > field.validation.maxFileSize) throw new Error(`File too large for ${field.label}`);
		}
		try {
			for (const { field, fileData } of pending) {
				const uploaded = await ctx.media.upload(fileData.filename, fileData.contentType, fileData.bytes.buffer);
				files.push({ fieldName: field.name, filename: fileData.filename, contentType: fileData.contentType, size: fileData.bytes.byteLength, mediaId: uploaded.mediaId });
				if (ctx.__failAfterUpload) throw new Error("boom");
			}
		} catch (error) {
			await Promise.allSettled(files.map((file) => ctx.media.delete(file.mediaId)));
			throw error;
		}
		const id = `sub${String(++ctx.__seq.n).padStart(4, "0")}`;
		await ctx.storage.submissions.put(id, {
			formId,
			data: input.data,
			files: files.length ? files : undefined,
			status: "new",
			starred: false,
			createdAt: new Date(Date.now() + ctx.__seq.n).toISOString(),
			meta: {},
		});
		return { success: true, message: form.settings.confirmationMessage };
	};

	const submissionDelete = async (ctx) => {
		const existing = await ctx.storage.submissions.get(ctx.input.id);
		if (!existing) throw new Error("Submission not found");
		if (existing.files && ctx.media && "delete" in ctx.media) {
			for (const file of existing.files) await ctx.media.delete(file.mediaId).catch(() => {});
		}
		await ctx.storage.submissions.delete(ctx.input.id);
		return { deleted: true };
	};

	const cleanup = async (ctx) => {
		const all = await ctx.storage.submissions.query({ limit: 100 });
		for (const item of all.items) {
			for (const file of item.data.files ?? []) await ctx.media.delete(file.mediaId).catch(() => {});
			await ctx.storage.submissions.delete(item.id);
		}
	};

	return {
		id: "emdash-forms",
		version: "0.2.9",
		capabilities: ["email:send", "media:write", "network:request"],
		storage: {},
		admin: { pages: [{ path: "/", label: "Forms" }] },
		hooks: {
			cron: {
				priority: 100,
				timeout: 5000,
				dependencies: [],
				errorPolicy: "abort",
				exclusive: false,
				pluginId: "emdash-forms",
				handler: async (event, ctx) => {
					if (event.name === "cleanup") await cleanup(ctx);
				},
			},
		},
		routes: {
			submit: { public: true, input: { safeParse: (v) => ({ success: true, data: v }) }, handler: submit },
			"submissions/delete": { handler: submissionDelete },
			"forms/list": { handler: async () => ({ items: [] }) },
		},
	};
}

// ── In-memory stand-ins for EmDash plugin storage, KV and R2 ──────

export function fakeCollection(initial = {}) {
	const rows = new Map(Object.entries(initial));
	return {
		rows,
		async get(id) {
			return rows.has(id) ? structuredClone(rows.get(id)) : null;
		},
		async put(id, data) {
			rows.set(id, structuredClone(data));
		},
		async delete(id) {
			return rows.delete(id);
		},
		async getMany(ids) {
			return new Map(ids.filter((id) => rows.has(id)).map((id) => [id, structuredClone(rows.get(id))]));
		},
		async deleteMany(ids) {
			let n = 0;
			for (const id of ids) if (rows.delete(id)) n++;
			return n;
		},
		async query(options = {}) {
			let items = [...rows.entries()].map(([id, data]) => ({ id, data: structuredClone(data) }));
			for (const [key, value] of Object.entries(options.where ?? {})) items = items.filter((i) => i.data[key] === value);
			if (options.orderBy?.createdAt === "desc") items.sort((a, b) => b.data.createdAt.localeCompare(a.data.createdAt));
			const start = options.cursor ? Number(options.cursor) : 0;
			const limit = options.limit ?? 50;
			const page = items.slice(start, start + limit);
			const more = start + limit < items.length;
			return { items: page, hasMore: more, cursor: more ? String(start + limit) : undefined };
		},
	};
}

export function fakeKv() {
	const map = new Map();
	return {
		map,
		async get(key) {
			return map.has(key) ? structuredClone(map.get(key)) : null;
		},
		async set(key, value) {
			map.set(key, structuredClone(value));
		},
		async delete(key) {
			return map.delete(key);
		},
		async list(prefix = "") {
			return [...map.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) }));
		},
	};
}

export function fakeBucket() {
	const objects = new Map();
	const wrap = (key, o, range) => {
		const bytes = range ? o.bytes.slice(range.offset, range.offset + range.length) : o.bytes;
		return { key, size: o.bytes.byteLength, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata, arrayBuffer: async () => bytes.slice().buffer };
	};
	return {
		objects,
		async put(key, bytes, opts = {}) {
			objects.set(key, { bytes: new Uint8Array(bytes), httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata });
		},
		async get(key, opts) {
			const o = objects.get(key);
			return o ? wrap(key, o, opts?.range) : null;
		},
		async head(key) {
			const o = objects.get(key);
			return o ? wrap(key, o) : null;
		},
		async delete(keys) {
			for (const key of [keys].flat()) objects.delete(key);
		},
	};
}

/** The media library as the Forms plugin sees it (ctx.media with media:write). */
export function fakeMediaLibrary() {
	const items = new Map();
	let n = 0;
	return {
		items,
		async upload(filename, contentType, bytes) {
			const id = `media${++n}`;
			items.set(id, { id, filename, mimeType: contentType, size: bytes.byteLength, bytes: new Uint8Array(bytes), storageKey: `${id}.bin` });
			return { mediaId: id, storageKey: `${id}.bin`, url: `/_emdash/api/media/file/${id}.bin` };
		},
		async delete(id) {
			return items.delete(id);
		},
		async get(id) {
			const i = items.get(id);
			return i ? { id, filename: i.filename, mimeType: i.mimeType, size: i.size } : null;
		},
		async list() {
			return { items: [...items.values()] };
		},
	};
}

export const fileForm = (id, slug, extra = {}) => ({
	name: `Form ${slug}`,
	slug,
	status: "active",
	settings: { confirmationMessage: "Thanks!", spamProtection: "honeypot" },
	pages: [
		{
			fields: [
				{ name: "email", label: "Email", type: "email", required: true },
				{ name: "screenshot", label: "Screenshot", type: "file", required: false, validation: { maxFileSize: 6 * 1024 * 1024 } },
				...(extra.fields ?? []),
			],
		},
	],
	submissionCount: 0,
	lastSubmissionAt: null,
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
});
