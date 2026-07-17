const EXPLICIT_TIMEZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

export function normalizeOrbitEpochUtc(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.includes("T") && !EXPLICIT_TIMEZONE.test(text) ? `${text}Z` : text;
}

export function parseOrbitEpochUtcMs(value) {
  const parsed = Date.parse(normalizeOrbitEpochUtc(value));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function orbitEpochUtcDate(value) {
  return new Date(parseOrbitEpochUtcMs(value));
}
