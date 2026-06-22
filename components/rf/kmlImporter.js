// =====================================================
// RF PLANNER — KMZ / KML IMPORTER
// Phase 1: Extract placemarks (name + lat/lng) from a KMZ file.
// =====================================================

import JSZip from "jszip";

// ---------- 1. Read KMZ file → KML text ----------
export async function readKmzAsKml(file) {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // Most KMZ files contain doc.kml at the root
  // But sometimes it lives under a folder, so we search for any .kml file
  let kmlFileName = null;
  zip.forEach((relativePath, zipEntry) => {
    if (!zipEntry.dir && relativePath.toLowerCase().endsWith(".kml")) {
      // Prefer doc.kml if present
      if (!kmlFileName || relativePath.toLowerCase().endsWith("doc.kml")) {
        kmlFileName = relativePath;
      }
    }
  });

  if (!kmlFileName) {
    throw new Error("No .kml file found inside the KMZ.");
  }

  const kmlText = await zip.file(kmlFileName).async("text");
  return kmlText;
}

// ---------- 2. Parse KML text → array of placemarks ----------
export function parseKmlPlacemarks(kmlText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(kmlText, "application/xml");

  // Check for parse errors
  const errorNode = xml.querySelector("parsererror");
  if (errorNode) {
    throw new Error("Failed to parse KML — file may be malformed.");
  }

  const placemarks = xml.getElementsByTagName("Placemark");
  const results = [];

  for (const pm of placemarks) {
    // Name
    const nameEl = pm.getElementsByTagName("name")[0];
    const name = nameEl ? nameEl.textContent.trim() : `Site-${results.length + 1}`;

    // Coordinates — could be inside Point, LineString, or Polygon
    // For Phase 1 we ONLY handle <Point><coordinates>lng,lat,elev</coordinates></Point>
    const pointEl = pm.getElementsByTagName("Point")[0];
    if (!pointEl) continue;

    const coordsEl = pointEl.getElementsByTagName("coordinates")[0];
    if (!coordsEl) continue;

    const raw = coordsEl.textContent.trim();
    if (!raw) continue;

    // KML format: "lng,lat,elev" (elev optional)
    const parts = raw.split(",").map(s => parseFloat(s.trim()));
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) continue;

    const lng = parts[0];
    const lat = parts[1];

    results.push({ name, lat, lng });
  }

  return results;
}

// ---------- 3. Combined helper: KMZ file → placemark list ----------
export async function readKmzToPlacemarks(file) {
  const kmlText = await readKmzAsKml(file);
  return parseKmlPlacemarks(kmlText);
}