/**
 * Code Blocks page: pick the site's code block theme with a live preview, and
 * turn the label, copy button and line numbers on or off (the same switches as
 * the Features page).
 */
import { Banner, Button, Loader, Select, Switch } from "@cloudflare/kumo";
import { FloppyDisk } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

const API = "/_emdash/api/plugins/coywolf-pack";

interface ThemeOption {
	id: string;
	label: string;
	group: string;
}

type Switches = Record<string, boolean>;

const SWITCHES: Array<{ id: string; label: string; description: string }> = [
	{ id: "codeBlocks", label: "Enhanced code blocks", description: "Highlight code blocks on the site with the theme below." },
	{ id: "codeBlocks.label", label: "Language label", description: "Show the language (e.g. TypeScript) above each block." },
	{ id: "codeBlocks.copy", label: "Copy button", description: "A copy-to-clipboard button on each block." },
	{ id: "codeBlocks.lineNumbers", label: "Line numbers", description: "Number each line. Numbers aren't copied." },
];

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

async function post<T>(path: string, body: unknown, fallback: string): Promise<T> {
	const response = await apiFetch(`${API}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return parseApiResponse<T>(response, fallback);
}

export function CodeBlocksPage() {
	const [themes, setThemes] = React.useState<ThemeOption[] | null>(null);
	const [saved, setSaved] = React.useState<{ theme: string; switches: Switches } | null>(null);
	const [theme, setTheme] = React.useState("");
	const [switches, setSwitches] = React.useState<Switches>({});
	const [preview, setPreview] = React.useState<{ css: string; html: string } | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [status, setStatus] = React.useState("");
	const [saving, setSaving] = React.useState(false);

	React.useEffect(() => {
		void (async () => {
			try {
				const [settings, features] = await Promise.all([
					apiFetch(`${API}/codeBlocks/settings`).then((r) =>
						parseApiResponse<{ theme: string; themes: ThemeOption[] }>(r, "Couldn't load settings"),
					),
					apiFetch(`${API}/features/list`).then((r) =>
						parseApiResponse<{ modules: Array<{ id: string; features: Array<{ id: string; enabled: boolean }> }> }>(
							r,
							"Couldn't load features",
						),
					),
				]);
				const mine = features.modules.find((m) => m.id === "codeBlocks")?.features ?? [];
				const state = Object.fromEntries(SWITCHES.map((s) => [s.id, mine.find((f) => f.id === s.id)?.enabled ?? false]));
				setThemes(settings.themes);
				setTheme(settings.theme);
				setSwitches(state);
				setSaved({ theme: settings.theme, switches: state });
			} catch (cause) {
				setError(errorText(cause, "Couldn't load settings"));
			}
		})();
	}, []);

	// Live preview, rendered by the same code as the site.
	React.useEffect(() => {
		if (!theme) return;
		let cancelled = false;
		const timer = setTimeout(() => {
			post<{ css: string; html: string }>(
				"codeBlocks/preview",
				{
					theme,
					label: switches["codeBlocks.label"] ?? false,
					copy: switches["codeBlocks.copy"] ?? false,
					lineNumbers: switches["codeBlocks.lineNumbers"] ?? false,
				},
				"Couldn't load the preview",
			)
				.then((result) => !cancelled && setPreview(result))
				.catch((cause) => !cancelled && setError(errorText(cause, "Couldn't load the preview")));
		}, 120);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [theme, switches]);

	const changedSwitches = saved ? Object.fromEntries(Object.entries(switches).filter(([id, on]) => saved.switches[id] !== on)) : {};
	const dirty = saved !== null && (theme !== saved.theme || Object.keys(changedSwitches).length > 0);

	// Unsaved-changes guard.
	React.useEffect(() => {
		if (!dirty) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	async function save() {
		if (!saved) return;
		setSaving(true);
		setError(null);
		setStatus("Saving…");
		try {
			if (theme !== saved.theme) await post("codeBlocks/save", { theme }, "Couldn't save the theme");
			if (Object.keys(changedSwitches).length) await post("features/save", { features: changedSwitches }, "Couldn't save the switches");
			setSaved({ theme, switches });
			setStatus("Saved. The site picks up changes within a minute.");
		} catch (cause) {
			setStatus("");
			setError(errorText(cause, "Couldn't save"));
		} finally {
			setSaving(false);
		}
	}

	const groups = themes ? [...new Set(themes.map((t) => t.group))] : [];
	const mainOn = switches.codeBlocks ?? false;

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
					<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">Code Blocks</h1>
					<div className="flex shrink-0 justify-end">
						<Button variant="primary" icon={<FloppyDisk />} disabled={!dirty || saving} onClick={() => void save()}>
							Save
						</Button>
					</div>
					<p className="col-span-2 text-sm leading-5 text-pretty text-kumo-subtle">
						Syntax highlighting for code blocks on the site, done on the server, so visitors download no highlighting
						script. Only the chosen theme's styles are sent, and only on pages with code.
					</p>
				</div>
			</header>

			{error && <Banner variant="error" role="alert" description={error} />}
			<p className="sr-only" role="status" aria-live="polite">
				{status}
			</p>
			{status && !saving && <p className="text-sm text-kumo-subtle">{status}</p>}

			{!themes && !error && (
				<div className="flex justify-center py-12">
					<Loader />
				</div>
			)}

			{themes && (
				<div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
					<div className="space-y-6">
						<Select
							label="Theme"
							value={theme}
							onValueChange={(value: string | null) => value && setTheme(value)}
							items={themes.map((t) => ({ value: t.id, label: t.label }))}
						>
							{groups.map((group) => (
								<Select.Group key={group}>
									<Select.GroupLabel>{group}</Select.GroupLabel>
									{themes
										.filter((t) => t.group === group)
										.map((t) => (
											<Select.Option key={t.id} value={t.id}>
												{t.label}
											</Select.Option>
										))}
								</Select.Group>
							))}
						</Select>

						<section className="rounded-lg border border-kumo-line" aria-label="Options">
							<ul className="divide-y divide-kumo-line">
								{SWITCHES.map((s, i) => {
									const disabled = saving || (i > 0 && !mainOn);
									return (
										<li key={s.id} className={`flex items-start justify-between gap-4 px-4 py-3 ${i > 0 ? "pl-8" : ""}`}>
											<div className="min-w-0">
												<h2 className={i === 0 ? "text-base font-semibold" : "text-sm font-medium"}>{s.label}</h2>
												<p className="mt-0.5 text-sm text-kumo-subtle">{s.description}</p>
											</div>
											<Switch
												size={i === 0 ? undefined : "sm"}
												aria-label={`${s.label}: ${switches[s.id] ? "on" : "off"}`}
												checked={(switches[s.id] ?? false) && (i === 0 || mainOn)}
												disabled={disabled}
												onCheckedChange={(on: boolean) => setSwitches((cur) => ({ ...cur, [s.id]: on }))}
											/>
										</li>
									);
								})}
							</ul>
						</section>
					</div>

					<section aria-labelledby="cw-code-preview-title" className="min-w-0">
						<h2 id="cw-code-preview-title" className="mb-2 text-sm font-medium">
							Preview
						</h2>
						{!mainOn && (
							<p className="mb-2 text-sm text-kumo-subtle">
								Enhanced code blocks are off, so the site shows EmDash's plain code blocks. This is how they'll look when on.
							</p>
						)}
						{preview ? (
							// The markup comes from this plugin's own renderer (escaped text and hljs spans only).
							<div inert className="text-left">
								<style>{preview.css}</style>
								<div dangerouslySetInnerHTML={{ __html: preview.html }} />
							</div>
						) : (
							<div className="flex justify-center py-12">
								<Loader />
							</div>
						)}
						<p className="mt-2 text-xs text-kumo-subtle">
							"Light/dark by system" themes follow your computer's appearance setting, as they will for visitors.
						</p>
					</section>
				</div>
			)}
		</div>
	);
}
