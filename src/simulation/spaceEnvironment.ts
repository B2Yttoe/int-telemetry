import { jday, shadowFraction, sunPos } from "../vendor/satellitePure";
import type { Vector3Km } from "./types";

const round = (value: number, digits = 3) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function vectorMagnitude(vector: Vector3Km) {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

export function normalizeVector(vector: Vector3Km): Vector3Km {
  const magnitude = vectorMagnitude(vector);
  if (magnitude === 0) return { x: 1, y: 0, z: 0 };
  return {
    x: vector.x / magnitude,
    y: vector.y / magnitude,
    z: vector.z / magnitude,
  };
}

export function sunVectorEci(date: Date): Vector3Km {
  const sun = sunPos(jday(date)).rsun;
  return {
    x: sun.x,
    y: sun.y,
    z: sun.z,
  };
}

export function sunDirectionEci(date: Date): Vector3Km {
  return normalizeVector(sunVectorEci(date));
}

export function sunlightState(eci: Vector3Km, date: Date) {
  const sun = sunVectorEci(date);
  const shadow = shadowFraction(sun, eci);
  const exposure = clamp(1 - shadow, 0, 1);
  return {
    solarExposure: round(exposure, 3),
    inSunlight: exposure > 0.05,
    inEclipse: exposure <= 0.05,
    sunDirectionEci: sunDirectionEci(date),
  };
}
