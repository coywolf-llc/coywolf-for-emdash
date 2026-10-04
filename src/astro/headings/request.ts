/** Per-request state for the heading components (ids already used, things emitted once). */
const taken = new WeakMap<Request, Set<string>>();
const emitted = new WeakMap<Request, Set<string>>();

/** Ids used by headings rendered so far in this request, so derived ids stay unique on the page. */
export function takenIds(request: Request): Set<string> {
	let set = taken.get(request);
	if (!set) taken.set(request, (set = new Set()));
	return set;
}

/** True the first time `name` is asked for in this request. */
export function firstInRequest(request: Request, name: string): boolean {
	let set = emitted.get(request);
	if (!set) emitted.set(request, (set = new Set()));
	if (set.has(name)) return false;
	set.add(name);
	return true;
}
