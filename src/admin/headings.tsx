/**
 * Headings & TOC settings: site defaults for heading anchors, the Table of
 * Contents block, and breadcrumbs. Blocks can override most of them.
 */
import { Banner, Button, Checkbox, Input, Loader, Select } from "@cloudflare/kumo";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

const API = "/_emdash/api/plugins/coywolf-pack/headings";

interface Settings {
	prefix: string;
	copyLink: boolean;
	scrollOffset: number;
	scrollUnit: "px" | "rem";
	toc: {
		title: string;
		levels: number[];
		listStyle: "none" | "bulleted" | "numbered";
		display: "open" | "collapsible" | "collapsed";
		minHeadings: number;
		smoothScroll: boolean;
	};
	breadcrumbs: {
		separator: string;
		customSeparator: string;
		homeLabel: string;
		showHome: boolean;
		showCurrent: boolean;
	};
}

const SEPARATORS = [
	{ value: "slash", label: "/  Slash" },
	{ value: "chevron", label: "›  Chevron" },
	{ value: "guillemet", label: "»  Guillemet" },
	{ value: "bullet", label: "•  Bullet" },
	{ value: "arrow", label: "→  Arrow" },
	{ value: "gt", label: ">  Greater-than" },
];

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

function Section(props: { title: string; description: string; children: React.ReactNode }) {
	const id = `cw-headings-${props.title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
	return (
		<section className="rounded-lg border border-kumo-line" aria-labelledby={id}>
			<div className="border-b border-kumo-line p-4">
				<h2 id={id} className="text-base font-semibold">
					{props.title}
				</h2>
				<p className="mt-1 text-sm text-kumo-subtle">{props.description}</p>
			</div>
			<div className="space-y-4 p-4">{props.children}</div>
		</section>
	);
}

export function HeadingsPage() {
	const [settings, setSettings] = React.useState<Settings | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [notice, setNotice] = React.useState<string | null>(null);
	const [saving, setSaving] = React.useState(false);

	React.useEffect(() => {
		void (async () => {
			try {
				const response = await apiFetch(`${API}/settings`);
				setSettings((await parseApiResponse<{ settings: Settings }>(response, "Couldn't load settings")).settings);
			} catch (cause) {
				setError(errorText(cause, "Couldn't load settings"));
			}
		})();
	}, []);

	const set = (patch: Partial<Settings>) => setSettings((s) => (s ? { ...s, ...patch } : s));
	const setToc = (patch: Partial<Settings["toc"]>) => setSettings((s) => (s ? { ...s, toc: { ...s.toc, ...patch } } : s));
	const setCrumbs = (patch: Partial<Settings["breadcrumbs"]>) =>
		setSettings((s) => (s ? { ...s, breadcrumbs: { ...s.breadcrumbs, ...patch } } : s));

	async function save() {
		if (!settings) return;
		setSaving(true);
		setError(null);
		setNotice(null);
		try {
			const response = await apiFetch(`${API}/settings/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ settings }),
			});
			setSettings((await parseApiResponse<{ settings: Settings }>(response, "Couldn't save")).settings);
			setNotice("Settings saved. Pages pick them up within a minute.");
		} catch (cause) {
			setError(errorText(cause, "Couldn't save"));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">Headings &amp; TOC</h1>
				<p className="text-sm leading-5 text-pretty text-kumo-subtle">
					Defaults for heading anchors, the Table of Contents block, and breadcrumbs. Turn each one on under Features. Anchors
					are saved with the content, so they stay the same when a heading is reworded.
				</p>
			</header>

			<div aria-live="polite">{notice && <Banner variant="default" role="status" title={notice} />}</div>
			{error && <Banner variant="error" role="alert" description={error} />}

			{!settings && !error && (
				<div className="flex justify-center py-12">
					<Loader />
				</div>
			)}

			{settings && (
				<form
					className="space-y-6"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<Section title="Heading anchors" description="Ids added to H2–H6 headings so readers can link to a section.">
						<Input
							label="Id prefix"
							description='Generated ids look like "jump-pricing". Changing the prefix affects new headings only; existing anchors stay put.'
							value={settings.prefix}
							pattern="[A-Za-z][A-Za-z0-9_\-]{0,19}|"
							maxLength={20}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ prefix: e.target.value })}
						/>
						<Checkbox
							label='Show a "copy link to section" button when hovering or focusing a heading'
							checked={settings.copyLink}
							onCheckedChange={(checked: boolean) => set({ copyLink: checked })}
						/>
						<div className="flex flex-wrap items-end gap-3">
							<Input
								label="Scroll offset"
								description="Space kept above a heading you jump to, for sticky headers. 0 for none."
								type="number"
								min={0}
								max={500}
								value={String(settings.scrollOffset)}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ scrollOffset: Number(e.target.value) || 0 })}
							/>
							<Select
								label="Unit"
								value={settings.scrollUnit}
								onValueChange={(value: string | null) => set({ scrollUnit: value === "rem" ? "rem" : "px" })}
								items={[
									{ value: "px", label: "px" },
									{ value: "rem", label: "rem" },
								]}
							/>
						</div>
					</Section>

					<Section title="Table of Contents" description="Defaults for Table of Contents blocks. Each block can override the title, levels, list style, and display.">
						<Input
							label="Title"
							value={settings.toc.title}
							maxLength={100}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToc({ title: e.target.value })}
						/>
						<fieldset>
							<legend className="mb-2 text-sm font-medium">Heading levels</legend>
							<div className="flex flex-wrap gap-4">
								{[2, 3, 4, 5, 6].map((level) => (
									<Checkbox
										key={level}
										label={`H${level}`}
										checked={settings.toc.levels.includes(level)}
										onCheckedChange={(checked: boolean) =>
											setToc({
												levels: checked
													? [...settings.toc.levels, level].sort((a, b) => a - b)
													: settings.toc.levels.filter((l) => l !== level),
											})
										}
									/>
								))}
							</div>
						</fieldset>
						<Select
							label="List style"
							value={settings.toc.listStyle}
							onValueChange={(value: string | null) => setToc({ listStyle: (value ?? "none") as Settings["toc"]["listStyle"] })}
							items={[
								{ value: "none", label: "Plain" },
								{ value: "bulleted", label: "Bulleted" },
								{ value: "numbered", label: "Numbered (1, 1.1, 1.1.1)" },
							]}
						/>
						<Select
							label="Display"
							value={settings.toc.display}
							onValueChange={(value: string | null) => setToc({ display: (value ?? "open") as Settings["toc"]["display"] })}
							items={[
								{ value: "open", label: "Always open" },
								{ value: "collapsible", label: "Collapsible, open" },
								{ value: "collapsed", label: "Collapsible, collapsed" },
							]}
						/>
						<Input
							label="Minimum headings"
							description="Hide the table when it would list fewer headings than this."
							type="number"
							min={1}
							max={10}
							value={String(settings.toc.minHeadings)}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToc({ minHeadings: Number(e.target.value) || 1 })}
						/>
						<Checkbox
							label="Smooth scrolling (skipped for visitors who prefer reduced motion)"
							checked={settings.toc.smoothScroll}
							onCheckedChange={(checked: boolean) => setToc({ smoothScroll: checked })}
						/>
					</Section>

					<Section title="Breadcrumbs" description="Defaults for the Breadcrumbs block and the Breadcrumbs theme component.">
						<Select
							label="Separator"
							value={settings.breadcrumbs.separator}
							onValueChange={(value: string | null) => setCrumbs({ separator: value ?? "slash" })}
							items={SEPARATORS}
						/>
						<Input
							label="Custom separator"
							description="Up to 8 characters. Overrides the separator above when set."
							value={settings.breadcrumbs.customSeparator}
							maxLength={8}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCrumbs({ customSeparator: e.target.value })}
						/>
						<Input
							label="Home label"
							value={settings.breadcrumbs.homeLabel}
							maxLength={60}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCrumbs({ homeLabel: e.target.value })}
						/>
						<Checkbox
							label="Start the trail with the home page"
							checked={settings.breadcrumbs.showHome}
							onCheckedChange={(checked: boolean) => setCrumbs({ showHome: checked })}
						/>
						<Checkbox
							label="End the trail with the current page"
							checked={settings.breadcrumbs.showCurrent}
							onCheckedChange={(checked: boolean) => setCrumbs({ showCurrent: checked })}
						/>
					</Section>

					<div className="flex justify-end">
						<Button type="submit" variant="primary" disabled={saving}>
							{saving ? "Saving…" : "Save settings"}
						</Button>
					</div>
				</form>
			)}
		</div>
	);
}
