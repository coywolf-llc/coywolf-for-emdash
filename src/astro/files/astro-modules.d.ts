// Lets tsc type `.astro` imports (Astro's language tools do this in editors).
// A function declaration so duplicate declarations from other modules merge as overloads.
declare module "*.astro" {
	export default function AstroComponent(props: Record<string, unknown>): unknown;
}
