export type CatchResourceStatus =
	| "active"
	| "exhausted"
	| "expired"
	| "suspended"
	| "manually_destroyed"
	| "deleted";

const INACTIVE_STATUSES = new Set<CatchResourceStatus>([
	"exhausted",
	"expired",
	"suspended",
	"manually_destroyed",
]);

export function canTransitionCatchResource(
	from: CatchResourceStatus,
	to: CatchResourceStatus,
): boolean {
	return (from === "active" && INACTIVE_STATUSES.has(to)) ||
		(INACTIVE_STATUSES.has(from) && to === "deleted");
}

export function transitionCatchResource(
	from: CatchResourceStatus,
	to: CatchResourceStatus,
): CatchResourceStatus {
	if (!canTransitionCatchResource(from, to)) {
		throw new Error(`Illegal CATCH resource transition: ${from} -> ${to}`);
	}

	return to;
}
