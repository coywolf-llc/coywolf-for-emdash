/** Lets tsc type-check imports of .astro components (Astro compiles them; tsc only needs their shape). */
declare module "*.astro" {
	// biome-ignore lint/suspicious/noExplicitAny: Astro component factory.
	const Component: (props: any) => any;
	export default Component;
}
