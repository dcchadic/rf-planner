// =====================================================
// RF PLANNER - GEO + RF MATH HELPERS
// Distance, elevation, Line-of-Sight, Fresnel.
// These are pure helper functions used by the optimizer.
// =====================================================

import mapboxgl from "mapbox-gl";

// ----- ELEVATION CACHE -----
// We store elevations we've already looked up so we don't
// re-download them every time. This makes the app much faster.
const elevationCache = {};

// =====================================================
// 1. DISTANCE
// Returns approximate distance between two coords in MILES.
// =====================================================
export function distance(a, b) {
  // Convert lng/lat difference into miles.
  // 69 is an approximation of miles per 1 degree at the equator.
  return Math.sqrt((a.lng - b.lng) ** 2 + (a.lat - b.lat) ** 2) * 69;
}

// =====================================================
// 2. SIGNAL POWER ESTIMATE
// Rough free-space loss estimate at ~900 MHz.
// Used for showing dBm on links.
// =====================================================
export function calcPower(distanceMiles) {
  return 30 + 5 + 5 - (
    20 * Math.log10(distanceMiles * 1.6 + 0.01) +
    20 * Math.log10(900) +
    32.44
  );
}

// =====================================================
// 3. ELEVATION LOOKUP (Mapbox terrain tiles)
// Returns ground elevation at a coordinate in FEET.
// Uses caching to stay fast.
// =====================================================
export async function getElevation(lng, lat) {
  const key = `${lng.toFixed(5)},${lat.toFixed(5)}`;
  if (elevationCache[key] !== undefined) return elevationCache[key];

  try {
    const zoom = 14;
    const tileSize = 256;

    const tileX = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
    const latRad = lat * Math.PI / 180;
    const tileY = Math.floor(
      (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2
      * Math.pow(2, zoom)
    );

    const pixelX = Math.floor(((lng + 180) / 360 * Math.pow(2, zoom) - tileX) * tileSize);
    const pixelY = Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom) - tileY)
      * tileSize
    );

    const tileKey = `tile_${zoom}_${tileX}_${tileY}`;

    if (!elevationCache[tileKey]) {
      const img = new Image();
      img.crossOrigin = "anonymous";

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${zoom}/${tileX}/${tileY}.pngraw?access_token=${mapboxgl.accessToken}`;
      });

      const canvas = document.createElement("canvas");
      canvas.width = tileSize;
      canvas.height = tileSize;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      elevationCache[tileKey] = ctx.getImageData(0, 0, tileSize, tileSize);
    }

    const imageData = elevationCache[tileKey];
    const idx = (pixelY * tileSize + pixelX) * 4;
    const R = imageData.data[idx];
    const G = imageData.data[idx + 1];
    const B = imageData.data[idx + 2];

    const elevMeters = -10000 + (R * 256 * 256 + G * 256 + B) * 0.1;
    const elevFeet = elevMeters * 3.281;

    elevationCache[key] = elevFeet;
    return elevFeet;
  } catch {
    return 0;
  }
}

// =====================================================
// 4. LINE OF SIGHT (LOS) CHECK
// Returns:
//   clear: true/false
//   requiredHeight: how much extra height (ft) is needed
// =====================================================
export async function checkLOS(p1, p2, h1, h2) {
  const elev1 = await getElevation(p1.lng, p1.lat);
  const elev2 = await getElevation(p2.lng, p2.lat);
  const tip1 = elev1 + h1;
  const tip2 = elev2 + h2;

  let maxBlock = 0;
  const steps = Math.max(10, Math.round((distance(p1, p2) * 5280) / 200));

  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const lng = p1.lng + (p2.lng - p1.lng) * t;
    const lat = p1.lat + (p2.lat - p1.lat) * t;
    const elev = await getElevation(lng, lat);
    const losAtPoint = tip1 + (tip2 - tip1) * t;
    const diff = elev - losAtPoint;
    if (diff > maxBlock) maxBlock = diff;
  }

  if (maxBlock > 0) {
    return { clear: false, requiredHeight: maxBlock + 5 };
  }
  return { clear: true, requiredHeight: 0 };
}

// =====================================================
// 5. FRESNEL ZONE %
// Returns the worst Fresnel clearance % across the link.
// 100 = great clearance. Below ~60 = warning.
// =====================================================
export async function calcFresnelPct(p1, p2) {
  const d = distance(p1, p2);
  const totalDistM = d * 1609.34;
  const wl = 0.333; // ~900 MHz wavelength in meters
  if (totalDistM <= 0) return 100;

  const elev1 = await getElevation(p1.lng, p1.lat);
  const elev2 = await getElevation(p2.lng, p2.lat);
  const tip1 = elev1 + p1.height;
  const tip2 = elev2 + p2.height;

  let worstPct = 100;
  const steps = 20;

  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const d1m = t * totalDistM;
    const d2m = totalDistM - d1m;
    const fR = (d1m > 0 && d2m > 0)
      ? Math.sqrt(wl * d1m * d2m / totalDistM) * 3.281
      : 0;
    if (fR <= 0) continue;

    const lng = p1.lng + (p2.lng - p1.lng) * t;
    const lat = p1.lat + (p2.lat - p1.lat) * t;
    const ev = await getElevation(lng, lat);

    const losE = tip1 + (tip2 - tip1) * t;
    const cl = losE - ev;
    const pct = (cl / fR) * 100;

    if (pct < worstPct) worstPct = pct;
  }

  return worstPct;
}