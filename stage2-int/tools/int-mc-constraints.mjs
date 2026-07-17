export function resolveTopologyAwareStatusEstimate({
  contactActive,
  directlyObserved,
  observedStatus,
  derivedStatus,
} = {}) {
  if (!contactActive) return "down";
  if (directlyObserved) return observedStatus || derivedStatus || "up";
  return derivedStatus || "up";
}
