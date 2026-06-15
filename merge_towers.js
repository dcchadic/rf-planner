// merge_towers.js
// Merges FCC tower heights with OpenCelliD carrier data into one unified overlay
// Run: node merge_towers.js

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ========== MCC/MNC → CARRIER MAPPING ==========
const CARRIER_MAP = {
  // AT&T
  "310-410": "att", "310-280": "att", "310-070": "att", "310-080": "att",
  "310-150": "att", "310-170": "att", "310-380": "att", "310-560": "att",
  "310-670": "att", "310-680": "att", "310-950": "att", "311-180": "att",
  "310-016": "att", "310-030": "att", "310-090": "att",
  "310-180": "att", "311-040": "att",
  "313-100": "att",  // FirstNet
  // Verizon
  "311-480": "verizon", "310-004": "verizon", "310-010": "verizon",
  "310-012": "verizon", "310-013": "verizon", "310-350": "verizon",
  "310-590": "verizon", "310-820": "verizon", "310-890": "verizon",
  "310-910": "verizon",
  "311-270": "verizon", "311-280": "verizon", "311-281": "verizon",
  "311-282": "verizon", "311-283": "verizon", "311-284": "verizon",
  "311-285": "verizon", "311-286": "verizon", "311-287": "verizon",
  "311-288": "verizon", "311-289": "verizon", "312-770": "verizon",
  // T-Mobile (includes Sprint, US Cellular)
  "310-260": "tmobile", "310-120": "tmobile", "310-160": "tmobile",
  "310-200": "tmobile", "310-210": "tmobile", "310-220": "tmobile",
  "310-230": "tmobile", "310-240": "tmobile", "310-250": "tmobile",
  "310-270": "tmobile", "310-310": "tmobile", "310-490": "tmobile",
  "310-660": "tmobile", "310-800": "tmobile", "311-490": "tmobile",
  "311-870": "tmobile", "312-530": "tmobile",
  "311-580": "tmobile", "310-730": "tmobile",  // US Cellular → T-Mobile
  "310-026": "tmobile", "310-300": "tmobile", "310-580": "tmobile",
  "310-770": "tmobile", "311-660": "tmobile",
  "311-230": "tmobile",  // Dish/Boost
  "313-340": "tmobile",  // T-Mobile 5G
};

// ========== STATE BOUNDING BOXES ==========
const STATE_BOUNDS = {
  TX: { minLat: 25.84, maxLat: 36.50, minLng: -106.65, maxLng: -93.51 },
  NM: { minLat: 31.33, maxLat: 37.00, minLng: -109.05, maxLng: -103.00 },
  OK: { minLat: 33.62, maxLat: 37.00, minLng: -103.00, maxLng: -94.43 },
  LA: { minLat: 28.93, maxLat: 33.02, minLng: -94.04, maxLng: -88.82 },
  ND: { minLat: 45.94, maxLat: 49.00, minLng: -104.05, maxLng: -96.55 },
  SD: { minLat: 42.48, maxLat: 45.94, minLng: -104.06, maxLng: -96.44 },
  CO: { minLat: 36.99, maxLat: 41.00, minLng: -109.05, maxLng: -102.04 },
  PA: { minLat: 39.72, maxLat: 42.27, minLng: -80.52, maxLng: -74.69 },
  WV: { minLat: 37.20, maxLat: 40.64, minLng: -82.64, maxLng: -77.72 },
  UT: { minLat: 36.99, maxLat: 42.00, minLng: -114.05, maxLng: -109.04 },
  CA: { minLat: 32.53, maxLat: 42.01, minLng: -124.48, maxLng: -114.13 },
};

function isInOilFieldStates(lat, lng) {
  for (const bounds of Object.values(STATE_BOUNDS)) {
    if (lat >= bounds.minLat && lat <= bounds.maxLat &&
        lng >= bounds.minLng && lng <= bounds.maxLng) return true;
  }
  return false;
}

// Grid key for dedup (~500m squares)
function gridKey(lat, lng) {
  return `${Math.round(lat / 0.005) * 0.005},${Math.round(lng / 0.006) * 0.006}`;
}

// Distance in meters between two lat/lng points
function distMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ========== SPATIAL INDEX (grid-based) ==========
function buildFCCIndex(fccTowers) {
  const index = {};
  for (let i = 0; i < fccTowers.length; i++) {
    const t = fccTowers[i];
    // Use coarser grid (~1km) for FCC lookup
    const key = `${Math.round(t.lat / 0.01) * 0.01},${Math.round(t.lng / 0.01) * 0.01}`;
    if (!index[key]) index[key] = [];
    index[key].push(i);
  }
  return index;
}

function findNearestFCC(lat, lng, fccTowers, fccIndex, maxDist = 500) {
  // Check this grid cell and 8 neighbors
  const gridLat = Math.round(lat / 0.01) * 0.01;
  const gridLng = Math.round(lng / 0.01) * 0.01;
  
  let bestIdx = -1;
  let bestDist = maxDist;

  for (let dlat = -0.01; dlat <= 0.01; dlat += 0.01) {
    for (let dlng = -0.01; dlng <= 0.01; dlng += 0.01) {
      const key = `${(gridLat + dlat).toFixed(2)},${(gridLng + dlng).toFixed(2)}`;
      const candidates = fccIndex[key];
      if (!candidates) continue;

      for (const idx of candidates) {
        const t = fccTowers[idx];
        const d = distMeters(lat, lng, t.lat, t.lng);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = idx;
        }
      }
    }
  }

  return bestIdx >= 0 ? { index: bestIdx, dist: bestDist } : null;
}

// ========== PROCESS OPENCELLID CSV ==========
async function processCSV(filePath, cellSites) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) { resolve(); return; }
    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let count = 0;

    rl.on("line", (line) => {
      const parts = line.split(",");
      if (parts.length < 8) return;
      const [radio, mcc, mnc, area, cell, unit, lng, lat] = parts;
      const carrier = CARRIER_MAP[`${mcc}-${mnc}`];
      if (!carrier) return;

      const latNum = parseFloat(lat);
      const lngNum = parseFloat(lng);
      if (isNaN(latNum) || isNaN(lngNum)) return;
      if (!isInOilFieldStates(latNum, lngNum)) return;

      const key = `${carrier}-${gridKey(latNum, lngNum)}`;
      if (!cellSites.has(key)) {
        cellSites.set(key, { lat: latNum, lng: lngNum, carrier, radio });
        count++;
      }
    });

    rl.on("close", () => {
      console.log(`  ${path.basename(filePath)}: ${count.toLocaleString()} unique cell sites`);
      resolve();
    });
    rl.on("error", reject);
  });
}

// ========== MAIN ==========
async function main() {
  console.log("");
  console.log("==========================================================");
  console.log("  FCC + OpenCelliD Merger → Unified Tower Overlay");
  console.log("==========================================================");
  console.log("");

  // 1. Load FCC towers
  const fccPath = path.join("public", "fcc_towers.json");
  if (!fs.existsSync(fccPath)) {
    console.log("ERROR: public/fcc_towers.json not found!");
    return;
  }
  const fccTowers = JSON.parse(fs.readFileSync(fccPath, "utf-8"));
  console.log(`Loaded ${fccTowers.length.toLocaleString()} FCC towers`);

  // 2. Build spatial index
  console.log("Building spatial index...");
  const fccIndex = buildFCCIndex(fccTowers);

  // 3. Process OpenCelliD CSVs
  console.log("\nProcessing OpenCelliD files...");
  const cellSites = new Map();
  const csvFiles = ["310.csv", "311.csv", "312.csv", "313.csv", "314.csv"];
  for (const f of csvFiles) {
    await processCSV(f, cellSites);
  }
  console.log(`\nTotal unique cell sites: ${cellSites.size.toLocaleString()}`);

  // 4. Match OpenCelliD → FCC towers
  console.log("\nMatching cell sites to FCC towers...");
  const matchedFCC = new Set();  // track which FCC towers got matched
  let matched = 0, unmatched = 0;

  const mergedTowers = [];

  for (const [key, cell] of cellSites) {
    const match = findNearestFCC(cell.lat, cell.lng, fccTowers, fccIndex, 500);

    if (match) {
      const fcc = fccTowers[match.index];
      matchedFCC.add(match.index);
      mergedTowers.push({
        lat: Math.round(fcc.lat * 10000) / 10000,
        lng: Math.round(fcc.lng * 10000) / 10000,
        height: fcc.height,
        carrier: cell.carrier,
        owner: fcc.owner,
        type: "cell_tower",
        source: "merged"
      });
      matched++;
    } else {
      mergedTowers.push({
        lat: Math.round(cell.lat * 10000) / 10000,
        lng: Math.round(cell.lng * 10000) / 10000,
        height: 0,  // unknown height
        carrier: cell.carrier,
        owner: "Unknown",
        type: "cell_tower",
        source: "opencellid_only"
      });
      unmatched++;
    }
  }

  // 5. Add remaining FCC towers (no cell match = tower company / non-cellular)
  let fccOnly = 0;
  for (let i = 0; i < fccTowers.length; i++) {
    if (!matchedFCC.has(i)) {
      const fcc = fccTowers[i];
      mergedTowers.push({
        lat: Math.round(fcc.lat * 10000) / 10000,
        lng: Math.round(fcc.lng * 10000) / 10000,
        height: fcc.height,
        carrier: fcc.carriers ? fcc.carriers[0] : "non_cellular",
        owner: fcc.owner,
        type: fcc.type || "non_cellular",
        source: "fcc_only"
      });
      fccOnly++;
    }
  }

  // 6. Deduplicate merged entries by grid
  const deduped = new Map();
  for (const t of mergedTowers) {
    const key = `${t.carrier}-${gridKey(t.lat, t.lng)}`;
    // Prefer merged entries over single-source
    if (!deduped.has(key) || t.source === "merged") {
      deduped.set(key, t);
    }
  }

  const finalTowers = Array.from(deduped.values());

  // 7. Count stats
  const stats = { att: 0, verizon: 0, tmobile: 0, other: 0 };
  for (const t of finalTowers) {
    if (t.carrier === "att") stats.att++;
    else if (t.carrier === "verizon") stats.verizon++;
    else if (t.carrier === "tmobile") stats.tmobile++;
    else stats.other++;
  }

  // 8. Save
  const outputPath = path.join("public", "fcc_towers.json");
  fs.writeFileSync(outputPath, JSON.stringify(finalTowers));
  const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);

  console.log("");
  console.log("==========================================================");
  console.log("  Merge Complete!");
  console.log("==========================================================");
  console.log("");
  console.log(`  Cell sites matched to FCC:  ${matched.toLocaleString()}`);
  console.log(`  Cell sites (no FCC match):  ${unmatched.toLocaleString()}`);
  console.log(`  FCC towers (no cell match): ${fccOnly.toLocaleString()}`);
  console.log("");
  console.log("  --- Final Counts ---");
  console.log(`  AT&T:      ${stats.att.toLocaleString()}`);
  console.log(`  Verizon:   ${stats.verizon.toLocaleString()}`);
  console.log(`  T-Mobile:  ${stats.tmobile.toLocaleString()}`);
  console.log(`  Other:     ${stats.other.toLocaleString()}`);
  console.log(`  TOTAL:     ${finalTowers.length.toLocaleString()}`);
  console.log("");
  console.log(`  Output: ${outputPath} (${sizeMB} MB)`);
  console.log("");
  console.log("  The existing FCC tower overlay in the app will now");
  console.log("  show carrier colors from OpenCelliD data!");
  console.log("==========================================================");
}

main().catch(console.error);
