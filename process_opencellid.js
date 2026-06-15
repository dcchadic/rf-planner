// process_opencellid.js
// Processes OpenCelliD CSV files into a carrier overlay JSON for the RF Planner
// Run: node process_opencellid.js

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ========== MCC/MNC → CARRIER MAPPING ==========
const CARRIER_MAP = {
  // AT&T
  "310-410": "att", "310-280": "att", "310-070": "att", "310-080": "att",
  "310-150": "att", "310-170": "att", "310-380": "att", "310-560": "att",
  "310-670": "att", "310-680": "att", "310-950": "att", "311-180": "att",
  // FirstNet (AT&T public safety)
  "313-100": "att",
  // Verizon
  "311-480": "verizon", "310-004": "verizon", "310-010": "verizon",
  "310-012": "verizon", "310-013": "verizon", "310-350": "verizon",
  "310-590": "verizon", "310-820": "verizon", "310-890": "verizon",
  "310-910": "verizon",
  // T-Mobile (includes Sprint legacy)
  "310-260": "tmobile", "310-120": "tmobile", "310-160": "tmobile",
  "310-200": "tmobile", "310-210": "tmobile", "310-220": "tmobile",
  "310-230": "tmobile", "310-240": "tmobile", "310-250": "tmobile",
  "310-270": "tmobile", "310-310": "tmobile", "310-490": "tmobile",
  "310-660": "tmobile", "310-800": "tmobile", "311-490": "tmobile",
  // Sprint (now T-Mobile)
  "310-120": "tmobile", "311-490": "tmobile", "311-870": "tmobile",
  "312-530": "tmobile",
  // US Cellular (now T-Mobile affiliated)
  "311-580": "tmobile", "310-730": "tmobile",
  // Dish / Boost (T-Mobile MVNO)
  "311-230": "tmobile",
  // Verizon additional
  "311-270": "verizon", "311-280": "verizon", "311-281": "verizon",
  "311-282": "verizon", "311-283": "verizon", "311-284": "verizon",
  "311-285": "verizon", "311-286": "verizon", "311-287": "verizon",
  "311-288": "verizon", "311-289": "verizon",
  "312-770": "verizon",
  // AT&T additional / Cricket
  "310-016": "att", "310-030": "att", "310-090": "att",
  "310-180": "att", "310-380": "att",
  "311-040": "att",  // Commnet/AT&T
  // T-Mobile additional
  "310-026": "tmobile", "310-300": "tmobile", "310-580": "tmobile",
  "310-770": "tmobile", "311-660": "tmobile",
  // Verizon Visible
  "311-480": "verizon",
};

// ========== STATE BOUNDING BOXES (lat/lng) ==========
// These are approximate bounding boxes for the 11 oil field states
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
        lng >= bounds.minLng && lng <= bounds.maxLng) {
      return true;
    }
  }
  return false;
}

// ========== GRID-BASED DEDUPLICATION ==========
// Group cells into ~500m grid squares to reduce density
function gridKey(lat, lng) {
  // ~500m grid: 0.005 degrees lat ≈ 556m, 0.006 degrees lng ≈ 500m at 35°N
  return `${Math.round(lat / 0.005) * 0.005},${Math.round(lng / 0.006) * 0.006}`;
}

async function processFile(filePath, towers, stats) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineCount = 0;
    let matchCount = 0;

    rl.on("line", (line) => {
      lineCount++;
      const parts = line.split(",");
      if (parts.length < 8) return;

      const [radio, mcc, mnc, area, cell, unit, lng, lat] = parts;
      const mccMnc = `${mcc}-${mnc}`;
      const carrier = CARRIER_MAP[mccMnc];

      if (!carrier) return;

      const latNum = parseFloat(lat);
      const lngNum = parseFloat(lng);

      if (isNaN(latNum) || isNaN(lngNum)) return;
      if (!isInOilFieldStates(latNum, lngNum)) return;

      matchCount++;
      const key = `${carrier}-${gridKey(latNum, lngNum)}`;

      // Keep only the first (or best) cell per grid square per carrier
      if (!towers.has(key)) {
        towers.set(key, {
          lat: Math.round(latNum * 10000) / 10000,
          lng: Math.round(lngNum * 10000) / 10000,
          carrier: carrier,
          radio: radio
        });
      }
    });

    rl.on("close", () => {
      stats.totalLines += lineCount;
      stats.matchedLines += matchCount;
      console.log(`  ${path.basename(filePath)}: ${lineCount.toLocaleString()} lines, ${matchCount.toLocaleString()} matched`);
      resolve();
    });

    rl.on("error", reject);
  });
}

async function main() {
  console.log("");
  console.log("========================================");
  console.log("  OpenCelliD → RF Planner Processor");
  console.log("========================================");
  console.log("");

  // Find CSV files
  const csvFiles = ["310.csv", "311.csv", "312.csv", "313.csv", "314.csv"];
  const existingFiles = csvFiles.filter(f => fs.existsSync(f));

  if (existingFiles.length === 0) {
    console.log("ERROR: No OpenCelliD CSV files found!");
    console.log("Place 310.csv, 311.csv, 312.csv, 313.csv, 314.csv in this folder.");
    return;
  }

  console.log(`Found ${existingFiles.length} CSV files: ${existingFiles.join(", ")}`);
  console.log("Processing (this may take a minute for large files)...");
  console.log("");

  const towers = new Map();
  const stats = { totalLines: 0, matchedLines: 0 };

  for (const file of existingFiles) {
    await processFile(file, towers, stats);
  }

  // Convert map to array
  const towerArray = Array.from(towers.values());

  // Count by carrier
  const carrierCounts = {};
  for (const t of towerArray) {
    carrierCounts[t.carrier] = (carrierCounts[t.carrier] || 0) + 1;
  }

  // Save
  const outputPath = path.join("public", "opencellid_towers.json");
  fs.writeFileSync(outputPath, JSON.stringify(towerArray));

  const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);

  console.log("");
  console.log("========================================");
  console.log("  Processing Complete!");
  console.log("========================================");
  console.log("");
  console.log(`  Total CSV lines:     ${stats.totalLines.toLocaleString()}`);
  console.log(`  Matched (Big 3):     ${stats.matchedLines.toLocaleString()}`);
  console.log(`  After dedup (grid):  ${towerArray.length.toLocaleString()}`);
  console.log("");
  console.log("  --- By Carrier ---");
  console.log(`  AT&T:     ${(carrierCounts.att || 0).toLocaleString()}`);
  console.log(`  Verizon:  ${(carrierCounts.verizon || 0).toLocaleString()}`);
  console.log(`  T-Mobile: ${(carrierCounts.tmobile || 0).toLocaleString()}`);
  console.log("");
  console.log(`  Output: ${outputPath} (${sizeMB} MB)`);
  console.log("========================================");
}

main().catch(console.error);
