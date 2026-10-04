/**
 * Live preview of a site block in an isolated frame, so its CSS can't restyle
 * the admin page (and the admin's can't restyle it). No scripts run in the
 * frame; <details> still opens and closes natively.
 */
import { Button } from "@cloudflare/kumo";
import * as React from "react";

export function PreviewFrame(props: { title: string; css: string; html: string; width?: "wide" | "phone" }) {
	const frame = React.useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = React.useState(160);
	const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light dark}body{margin:0;padding:16px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5;background:Canvas;color:CanvasText}a{color:LinkText}</style><style>${props.css}</style></head><body>${props.html}</body></html>`;
	const measure = React.useCallback(() => {
		// The body, not the root: the root is never shorter than the frame, so it can't shrink.
		const body = frame.current?.contentDocument?.body;
		if (body) setHeight(Math.min(1200, Math.max(60, Math.ceil(body.getBoundingClientRect().height))));
	}, []);
	// Re-measure when <details> opens or closes inside the frame.
	const onLoad = () => {
		measure();
		frame.current?.contentDocument?.addEventListener("toggle", measure, true);
	};
	return (
		<iframe
			ref={frame}
			title={props.title}
			// No scripts; same origin only so the frame's height can be measured.
			sandbox="allow-same-origin"
			srcDoc={doc}
			onLoad={onLoad}
			className="block rounded-lg border border-kumo-line bg-white"
			style={{ width: props.width === "phone" ? 375 : "100%", maxWidth: "100%", height }}
		/>
	);
}

/** "Preview" heading with Wide/Phone toggles, then the frame and a note. */
export function PreviewSection(props: { id: string; title: string; css: string; html: string; note?: React.ReactNode; empty?: React.ReactNode }) {
	const [width, setWidth] = React.useState<"wide" | "phone">("wide");
	return (
		<section aria-labelledby={props.id} className="min-w-0">
			<div className="mb-2 flex items-center justify-between gap-2">
				<h3 id={props.id} className="text-sm font-medium">
					Preview
				</h3>
				<div className="flex gap-1" role="group" aria-label="Preview width">
					<Button type="button" size="sm" variant={width === "wide" ? "primary" : "secondary"} aria-pressed={width === "wide"} onClick={() => setWidth("wide")}>
						Wide
					</Button>
					<Button type="button" size="sm" variant={width === "phone" ? "primary" : "secondary"} aria-pressed={width === "phone"} onClick={() => setWidth("phone")}>
						Phone
					</Button>
				</div>
			</div>
			{props.html ? (
				<PreviewFrame title={props.title} css={props.css} html={props.html} width={width} />
			) : (
				<p className="rounded-lg border border-dashed border-kumo-line p-4 text-sm text-kumo-subtle">{props.empty}</p>
			)}
			{props.note && <p className="mt-2 text-xs text-kumo-subtle">{props.note}</p>}
		</section>
	);
}
