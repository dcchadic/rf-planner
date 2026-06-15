// reclassify_towers.js  — FINAL BUILD
// Run from your rf-planner folder:  node reclassify_towers.js

const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "public", "fcc_towers.json");
const raw = fs.readFileSync(filePath, "utf-8");

// Fix any HTML-encoded ampersands in the raw JSON before parsing
const cleaned = raw.replace(/&amp;/g, "&");
const data = JSON.parse(cleaned);

// ========== CARRIER CLASSIFICATION ==========
// big3: null = IS a Big 3 carrier, "att"/"verizon"/"tmobile" = affiliated, "independent" = own network

const CARRIERS = [

  // ============ BIG 3 ============
  {
    tag: "att", big3: null, type: "cellular",
    patterns: [
      "AT&T", "AT & T", "CINGULAR", "SOUTHWESTERN BELL", "SBC ",
      "SBC COMMUNICATIONS", "BELLSOUTH", "BELL SOUTH", "PACIFIC BELL",
      "PACBELL", "AMERITECH", "NEW CINGULAR", "ATT WIRELESS",
      "AT&T MOBILITY", "AT&T WIRELESS", "ILLINOIS BELL", "INDIANA BELL",
      "MICHIGAN BELL", "NEVADA BELL", "OHIO BELL", "WISCONSIN BELL",
      "SOUTHERN BELL", "SOUTH CENTRAL BELL", "CRICKET", "LEAP WIRELESS",
      "DOBSON CELLULAR", "DOBSON COMMUNICATIONS", "CENTENNIAL COMMUNICATIONS",
      "WAYPORT", "FIRSTNET",
      "DALLAS SMSA LIMITED PARTNERSHIP",
      "HOUSTON SMSA LIMITED PARTNERSHIP",
      "CHICAGO SMSA LIMITED PARTNERSHIP",
      "LOS ANGELES SMSA LIMITED PARTNERSHIP",
      "SAN FRANCISCO SMSA", "SAN ANTONIO SMSA",
      "TYLER/LONGVIEW", "TYLER LONGVIEW",  // AT&T (SBC territory in East TX)
    ]
  },
  {
    tag: "verizon", big3: null, type: "cellular",
    patterns: [
      "VERIZON", "CELLCO PARTNERSHIP", "GTE MOBILNET", "GTE MOBILE",
      "BELL ATLANTIC", "NYNEX", "AIRTOUCH", "AIR TOUCH", "ALLTEL",
      "RURAL CELLULAR", "CONESTOGA TELEPHONE", "VODAFONE",
      "CELLULARONE", "CELLULAR ONE", "LOS ANGELES CELLULAR",
      "BALTIMORE SMSA", "WASHINGTON SMSA", "PHILADELPHIA SMSA",
      "NEW YORK SMSA", "DETROIT SMSA", "CLEVELAND SMSA",
      "DENVER SMSA", "PITTSBURGH SMSA",
      // Verizon-operated MSA/RSA partnerships
      "SACRAMENTO VALLEY LIMITED PARTNERSHIP",
      "FRESNO MSA LIMITED PARTNERSHIP",
      "NORTHWEST DAKOTA CELLULAR",
      "BADLANDS CELLULAR",
      "NORTH CENTRAL RSA", "NORTH DAKOTA RSA",
      "NORTH DAKOTA 5",
      "PENNSYLVANIA RSA 1 LIMITED PARTNERSHIP",
      "NORTHEAST PENNSYLVANIA SMSA",
      "DALLAS MTA",
      "BISMARCK MSA",  // Verizon ND MSA partnership
      "OKLAHOMA CITY SMSA",  // Verizon - OKC MSA partnership
    ]
  },
  {
    tag: "tmobile", big3: null, type: "cellular",
    patterns: [
      "T-MOBILE", "TMOBILE", "SPRINT", "VOICESTREAM", "VOICE STREAM",
      "POWERTEL", "METROPCS", "METRO PCS", "CLEARWIRE", "CLEAR WIRE",
      "WESTERN WIRELESS", "WESTERN PCS", "SUNCOM", "AERIAL COMMUNICATIONS",
      "OMNIPOINT", "COOK INLET", "NEXTEL", "BOOST MOBILE", "IOWA WIRELESS",
    ]
  },

  // ============ REGIONAL — VERIZON AFFILIATED ============
  {
    tag: "west_central_wireless", big3: "verizon", type: "cellular",
    patterns: ["WEST CENTRAL WIRELESS", "WEST CENTRAL CELLULAR",
               "RIGHT WIRELESS", "FIVE STAR WIRELESS"]
  },
  {
    tag: "appalachian_wireless", big3: "verizon", type: "cellular",
    patterns: ["APPALACHIAN WIRELESS", "EAST KENTUCKY NETWORK"]
  },
  {
    tag: "bluegrass_cellular", big3: "verizon", type: "cellular",
    patterns: ["BLUEGRASS CELLULAR"]
  },
  {
    tag: "pioneer_cellular", big3: "verizon", type: "cellular",
    patterns: ["PIONEER CELLULAR", "PIONEER TELEPHONE",
               "CELLULAR NETWORK PARTNERSHIP", "PIONEER ACQUISITION COMPANY"]
  },
  {
    tag: "bravado_wireless", big3: "verizon", type: "cellular",
    patterns: ["BRAVADO WIRELESS", "CROSS COMMUNICATIONS", "CROSS TELEPHONE"]
  },
  {
    tag: "nemont_sagebrush", big3: "verizon", type: "cellular",
    patterns: ["NEMONT", "SAGEBRUSH CELLULAR", "SAGEBRUSH TELECOM"]
  },
  {
    tag: "carolina_west", big3: "verizon", type: "cellular",
    patterns: ["CAROLINA WEST WIRELESS"]
  },
  {
    tag: "cellcom", big3: "verizon", type: "cellular",
    patterns: ["CELLCOM", "NSIGHT TELSERVICES"]
  },
  {
    tag: "strata_networks", big3: "verizon", type: "cellular",
    patterns: ["STRATA NETWORKS"]
  },
  {
    tag: "thumb_cellular", big3: "verizon", type: "cellular",
    patterns: ["THUMB CELLULAR"]
  },
  {
    tag: "chat_mobility", big3: "verizon", type: "cellular",
    patterns: ["CHAT MOBILITY", "CHARITON VALLEY"]
  },
  {
    tag: "copper_valley", big3: "verizon", type: "cellular",
    patterns: ["COPPER VALLEY TELECOM", "COPPER VALLEY WIRELESS"]
  },
  {
    tag: "plateau_wireless", big3: "verizon", type: "cellular",
    patterns: ["PLATEAU WIRELESS", "PLATEAU TELECOMMUNICATIONS",
               "PLATEAU TELECOM", "NEW MEXICO RSA", "E.N.M.R."]
  },
  {
    tag: "united_wireless", big3: "verizon", type: "cellular",
    patterns: ["UNITED WIRELESS", "UNITED TELEPHONE ASSOCIATION"]
  },

  // ============ REGIONAL — AT&T AFFILIATED ============
  {
    tag: "commnet_wireless", big3: "att", type: "cellular",
    patterns: ["COMMNET WIRELESS", "COMMNET CELLULAR",
               "ATLANTIC TELE-NETWORK", "ATN INTERNATIONAL",
               "CHOICE WIRELESS", "CHOICE PHONE"]
  },
  {
    tag: "smith_bagley", big3: "att", type: "cellular",
    patterns: ["SMITH BAGLEY", "CELLULAR ONE OF NORTHEAST ARIZONA",
               "CELLULAR ONE OF NE ARIZONA"]
  },
  {
    tag: "southern_linc", big3: "att", type: "cellular",
    patterns: ["SOUTHERN LINC", "SOUTHERN COMPANY"]
  },

  // ============ REGIONAL — T-MOBILE AFFILIATED ============
  {
    tag: "uscellular", big3: "tmobile", type: "cellular",
    patterns: ["US CELLULAR", "U.S. CELLULAR", "USCELLULAR",
               "UNITED STATES CELLULAR", "TELEPHONE AND DATA SYSTEMS"]
  },
  {
    tag: "shentel", big3: "tmobile", type: "cellular",
    patterns: ["SHENANDOAH", "SHENTEL", "NTELOS"]
  },

  // ============ REGIONAL — INDEPENDENT ============
  {
    tag: "cspire", big3: "independent", type: "cellular",
    patterns: ["C SPIRE", "C-SPIRE", "CELLULAR SOUTH", "TELAPEX"]
  },
  {
    tag: "ptci_panhandle", big3: "independent", type: "cellular",
    patterns: ["PANHANDLE TELEPHONE", "PANHANDLE TELECOM", "PTCI",
               "PANHANDLE TELECOMMUNICATIONS"]
  },
  {
    tag: "mid_tex_cellular", big3: "independent", type: "cellular",
    patterns: ["MID-TEX CELLULAR", "MID TEX CELLULAR", "MIDTEX"]
  },
  {
    tag: "east_texas_cellular", big3: "independent", type: "cellular",
    patterns: ["EAST TEXAS CELLULAR", "ETEX CELLULAR", "ETEX COMMUNICATIONS",
               "TX-11 ACQUISITION"]
  },
  {
    tag: "colorado_valley", big3: "independent", type: "cellular",
    patterns: ["COLORADO VALLEY TELECOM", "COLORADO VALLEY TELEPHONE"]
  },
  {
    tag: "big_bend_telephone", big3: "independent", type: "cellular",
    patterns: ["BIG BEND TELEPHONE", "BIG BEND TELECOM"]
  },
  {
    tag: "xit_telecom", big3: "independent", type: "cellular",
    patterns: ["XIT RURAL TELEPHONE", "XIT TELECOM", "XITCOM"]
  },
  {
    tag: "caprock_telephone", big3: "independent", type: "cellular",
    patterns: ["CAPROCK TELEPHONE", "CAPROCK TELECOM"]
  },
  {
    tag: "south_plains_telephone", big3: "independent", type: "cellular",
    patterns: ["SOUTH PLAINS TELEPHONE", "SOUTH PLAINS TELECOM"]
  },
  {
    tag: "taylor_telephone", big3: "independent", type: "cellular",
    patterns: ["TAYLOR TELEPHONE", "TAYLOR TELECOM"]
  },
  {
    tag: "nts_communications", big3: "independent", type: "cellular",
    patterns: ["NTS COMMUNICATIONS", "NTS TELEPHONE"]
  },
  {
    tag: "sacred_wind", big3: "independent", type: "cellular",
    patterns: ["SACRED WIND"]
  },
  {
    tag: "ntua_wireless", big3: "independent", type: "cellular",
    patterns: ["NTUA WIRELESS", "NAVAJO TRIBAL UTILITY"]
  },
  {
    tag: "leaco_telephone", big3: "independent", type: "cellular",
    patterns: ["LEACO RURAL TELEPHONE", "LEACO TELECOM"]
  },
  {
    tag: "cameron_telephone", big3: "independent", type: "cellular",
    patterns: ["CAMERON TELEPHONE", "CAMERON COMMUNICATIONS"]
  },
  {
    tag: "west_river_telecom", big3: "independent", type: "cellular",
    patterns: ["WEST RIVER TELECOM", "WEST RIVER TELEPHONE",
               "WEST RIVER COOPERATIVE"]
  },
  {
    tag: "dakota_central", big3: "independent", type: "cellular",
    patterns: ["DAKOTA CENTRAL"]
  },
  {
    tag: "viaero_wireless", big3: "independent", type: "cellular",
    patterns: ["VIAERO WIRELESS", "VIAERO"]
  },
  {
    tag: "pine_cellular", big3: "independent", type: "cellular",
    patterns: ["PINE CELLULAR", "PINE TELEPHONE"]
  },
  {
    tag: "nntc_wireless", big3: "independent", type: "cellular",
    patterns: ["NNTC WIRELESS", "NUCLA-NATURITA", "NUCLA NATURITA"]
  },
  {
    tag: "full_spectrum", big3: "independent", type: "cellular",
    patterns: ["FULL SPECTRUM"]
  },
  {
    tag: "chickasaw_telephone", big3: "independent", type: "cellular",
    patterns: ["CHICKASAW TELEPHONE", "CHICKASAW TELECOM"]
  },
  {
    tag: "northern_plains", big3: "independent", type: "cellular",
    patterns: ["NORTHERN PLAINS"]
  },
  {
    tag: "midcontinent", big3: "independent", type: "cellular",
    patterns: ["MIDCONTINENT", "MID-CONTINENT"]
  },
  {
    tag: "crossroads_wireless", big3: "independent", type: "cellular",
    patterns: ["CROSSROADS WIRELESS"]
  },
  {
    tag: "nextlink_amg", big3: "independent", type: "cellular",
    patterns: ["AMG TECHNOLOGY INVESTMENT GROUP", "NEXTLINK INTERNET", "NEXTLINK"]
  },
  {
    tag: "south_dakota_network", big3: "independent", type: "cellular",
    patterns: ["SOUTH DAKOTA NETWORK"]
  },
  {
    tag: "ctl_centurylink", big3: "independent", type: "cellular",
    patterns: ["CENTURYLINK", "CENTURYTEL", "CENTURYTEL", "LUMEN TECHNOLOGIES",
               "EMBARQ", "WINDSTREAM"]
  },
];

// ========== TOWER COMPANIES ==========
const TOWER_COMPANY_PATTERNS = [
  // --- SBA Communications (all subsidiaries) ---
  "SBA COMMUNICATIONS", "SBA TOWERS", "SBA SITE",
  "SBA 2012 TC ASSETS",
  "SBA MONARCH TOWERS",
  "SBA STRUCTURES",
  "SBA PROPERTIES",
  "SBA INFRASTRUCTURES",

  // --- Crown Castle (all subsidiaries) ---
  "CROWN CASTLE",
  "CROWN COMMUNICATION",
  "CCATT LLC",

  // --- Vertical Bridge (all subsidiaries) ---
  "VERTICAL BRIDGE",
  "VB-S1 ASSETS",
  "VB BTS",
  "VB NIMBUS",

  // --- American Tower ---
  "AMERICAN TOWER",

  // --- Other tower companies ---
  "PHOENIX TOWER",
  "UNITI TOWERS",
  "LANDMARK INFRASTRUCTURE",
  "TILLMAN INFRASTRUCTURE",
  "HARMONI TOWERS",
  "TOWER VENTURES",
  "TOWERCO",
  "TOWER PROPERTIES",
  "THE TOWERS, LLC",
  "GLOBAL SIGNAL",
  "SPECTRASITE",
  "LEGACY TOWER",
  "SKYWAY TOWERS",
  "K2 TOWERS",
  "CTI TOWERS",
  "OCTAGON TOWERS",
  "CITYSWITCH",
  "BRANCH TOWERS",
  "DIAMOND TOWERS",
  "APC TOWERS",
  "INDUSTRIAL TOWER AND WIRELESS",
  "INDUSTRIAL TOWER WEST",
  "ACME COMMERCIAL PROPERTIES",
  "HORVATH TOWERS",
  "INTERCONNECT TOWERS",
  "TOWERS OF TEXAS",
  "PINNACLE TOWERS",
  "TARPON TOWERS",
  "ATLAS TOWER",
  "ARRAY DIGITAL INFRASTRUCTURE",
  "PARALLEL INFRASTRUCTURE",
  "EIP HOLDINGS",
  "TITAN TOWERS",
  "LLOYD HOFF HOLDING",
  "REGINALD YOUNGBLOOD",
  "AFFINITI",
  "GTC UNO",
  "ALTERNATIVE ENERGY SOLUTIONS",
  "MOBILITIE",
  "REGULATORY GROUP",
  "MUNICIPAL COMMUNICATIONS",

  // --- Law firms (file FCC registrations on behalf of clients) ---
  "WILKINSON BARKER KNAUER",
  "KELLER AND HECKMAN",
  "MONA LEE & ASSOCIATES",
  "MONA LEE &AMP; ASSOCIATES",
  "FLETCHER, HEALD & HILDRETH",
  "FLETCHER, HEALD &AMP; HILDRETH",
  "HOLLAND & KNIGHT",
  "HOLLAND &AMP; KNIGHT",
  "LERMAN SENTER",
  "MINTZ, LEVIN",
  "MINTZ LEVIN",
  "BENNET & BENNET",
  "BENNET &AMP; BENNET",
  "LAW OFFICE OF DENNIS J. KELLY",
  "LAW OFFICE OF DAN J. ALPERT",
  "SMITHWICK & BELENDIUK",
  "SMITHWICK &AMP; BELENDIUK",
  "GRAHAM BROCK",
  "WILEY REIN",
  "THOMPSON HINE",
  "HEMPHILL, LLC",
  "HEMPHILL LLC",
  "TRILEAF CORPORATION",

  // --- Round 4 additions ---
  "STRATCAP WIRELESS",           // 40 - tower/infrastructure investment
  "AGILE NETWORK BUILDERS",      // 38
  "TVT III",                     // 37
  "@LINK SERVICES",              // 37
  "PI TOWER DEVELOPMENT",        // 37
  "TOWERNORTH DEVELOPMENT",      // 36
  "VB RUN",                      // 34 - Vertical Bridge subsidiary
  "STC FIVE",                    // 33
  "ENVIRONMENTAL CORPORATION OF AMERICA", // 33 - FCC environmental consulting
  "BOLDYN NETWORKS",             // 33 - private networks/DAS
  "THE TOWER COMPANY OF LOUISIANA", // 32
  "BRANCH COMMUNICATIONS",       // 30 - related to Branch Towers
  "SBA STEEL",                   // 30 - SBA subsidiary
  "ALL WEATHER INC",             // 30 - weather monitoring

  // --- Round 5 additions ---
  "WIRELESS APPLICATIONS CORPORATION", // 29
  "LOCKARD & WHITE",             // 29
  "LOCKARD &AMP; WHITE",
  "PERFORMANCE DEVELOPMENT GROUP", // 29
  "SHAINIS & PELTZMAN",          // 28
  "SHAINIS &AMP; PELTZMAN",
  "HEMPHILL SEMINARY",           // 28
  "SQF, LLC",                    // 28
  "SQF LLC",
  "GOW COMMUNICATIONS",          // 27
  "CRENSHAW COMMUNICATIONS CONSULTING", // 27
  "CROWN ATLANTIC",              // 26 - Crown Castle predecessor
  "SUBCARRIER COMMUNICATIONS",   // 51 (26+25)
  "PILLSBURY WINTHROP",          // 26 - law firm
  "NEW SIGNALS ENGINEERING",     // 26
  "LUKAS, NACE, GUTIERREZ",     // 26 - law firm
  "LUKAS NACE GUTIERREZ",
  "MICRONET COMMUNICATIONS",     // 26
  "WOMBLE BOND DICKINSON",       // 26 - law firm
  "TWO WAY COMMUNICATIONS",      // 25
  "LIBERTY TOWERS",              // 24
  "SBA GC TOWERS",               // 24 - SBA subsidiary
  "JEP TELECOM",                 // 24
  "CIG TOWERS",                  // 24
  "DOW, LOHNES & ALBERTSON",     // 23 - law firm
  "DOW, LOHNES &AMP; ALBERTSON",
  "DOW LOHNES",
];

// ========== NON-CELLULAR ==========
const NON_CELLULAR_PATTERNS = [
  "BROADCASTING", "BROADCAST", "TELEVISION", "TV STATION", "TV LICENSE",
  "RADIO STATION", "PUBLIC SAFETY", "FIRE DEPARTMENT", "FIRE DIST",
  "POLICE", "SHERIFF", "COUNTY OF", "CITY OF", "STATE OF",
  "UNITED STATES GOVERNMENT", "FEDERAL AVIATION", "FAA", "NOAA",
  "MILITARY", "NAVY", "ARMY", "AIR FORCE", "COAST GUARD",
  "NATIONAL GUARD", "DEPARTMENT OF DEFENSE",
  "ELECTRIC COOPERATIVE", "ELECTRIC POWER", "POWER COMPANY",
  "ENERGY CORP", "PIPELINE", "RAILROAD", "RAILWAY",
  "MICROWAVE", "PAGING", "MOTOROLA", "HARRIS CORPORATION",
  "ERICSSON", "NOKIA", "SAMSUNG ELECTRONICS",
  // Round 2
  "COMMONWEALTH OF",
  "KINDER MORGAN",
  "OKLAHOMA DEPARTMENT OF TRANSPORTATION",
  "LOWER COLORADO RIVER AUTHORITY",
  "WEST VIRGINIA EMERGENCY MANAGEMENT",
  "GRAY LOCAL MEDIA", "GRAY TELEVISION",
  "PUBLIC SERVICE COMPANY OF",
  "DEPARTMENT OF TRANSPORTATION",
  "EMERGENCY MANAGEMENT",
  "BUREAU OF LAND MANAGEMENT",
  "NATIONAL PARK SERVICE",
  "FOREST SERVICE",
  "BUREAU OF RECLAMATION",
  "PACIFIC GAS & ELECTRIC", "PACIFIC GAS &AMP; ELECTRIC", "PACIFIC GAS AND ELECTRIC",
  "AEP TEXAS", "AEP OHIO", "AEP APPALACHIAN",
  "AMERICAN ELECTRIC POWER",
  "ONCOR", "CENTERPOINT ENERGY", "ENTERGY",
  "XCEL ENERGY", "DOMINION ENERGY", "DUKE ENERGY",
  "SEMPRA", "SOUTHERN CALIFORNIA EDISON",
  "PNM RESOURCES", "EL PASO ELECTRIC",
  // Round 3
  "AMERICAN FAMILY ASSOCIATION",
  "NEXSTAR MEDIA",
  "REGION 8 EDUCATION SERVICE CENTER",
  "OKLAHOMA STATE REGENTS",
  "EDUCATION SERVICE CENTER",

  // --- Round 4 additions ---
  "UTAH COMMUNICATIONS AUTHORITY",  // 39 - government public safety
  "SCRRA",                          // 35 - Southern California Regional Rail Authority
  "LOS ANGELES REGIONAL INTEROPERABLE", // 34 - LA public safety comms
  "CLECO POWER",                    // 33 - Louisiana utility
  "CLEAR CHANNEL COMMUNICATIONS",   // 33 - broadcasting (now iHeartMedia)
  "CLEAR CHANNEL",
  "IHEART",
  "STERLING COMMUNICATIONS",        // 32 - broadcasting
  "OKLAHOMA GAS AND ELECTRIC",      // 31 - utility (OGE)
  "OKLAHOMA GAS & ELECTRIC",
  "ENTERCOM COMMUNICATIONS",        // 31 - broadcasting (now Audacy)
  "AUDACY",
  "SEVEN MOUNTAINS MEDIA",          // 30 - broadcasting
  "CHARTER COMMUNICATIONS",         // 29 - cable company
  "CHARTER SPECTRUM",
  "COMCAST", "SPECTRUM",

  // --- Round 5 additions ---
  "CLECO SUPPORT GROUP",            // 26 - Cleco utility subsidiary
  "EASTERN GAS TRANSMISSION",       // 26 - gas pipeline (now Equitrans)
  "TEGNA INC",                      // 23 - TV broadcasting
  "TEGNA ",
];

// ========== CLASSIFY ==========
function classifyOwner(owner) {
  // Normalize: fix HTML entities and uppercase
  const upper = owner.replace(/&amp;/g, "&").toUpperCase();

  // Check carriers in order
  for (const carrier of CARRIERS) {
    for (const pat of carrier.patterns) {
      if (upper.includes(pat.toUpperCase())) {
        return {
          type: carrier.type,
          carriers: [carrier.tag],
          big3: carrier.big3
        };
      }
    }
  }

  // Tower companies
  for (const pat of TOWER_COMPANY_PATTERNS) {
    if (upper.includes(pat.replace(/&amp;/g, "&").toUpperCase())) {
      return { type: "tower_company", carriers: ["tower_company"], big3: null };
    }
  }

  // Non-cellular
  for (const pat of NON_CELLULAR_PATTERNS) {
    if (upper.includes(pat.replace(/&amp;/g, "&").toUpperCase())) {
      return { type: "non_cellular", carriers: ["non_cellular"], big3: null };
    }
  }

  // Exact-match edge cases
  const trimmed = upper.trim();
  if (trimmed === "CTL" || trimmed === "NONE" || trimmed === "UNKNOWN") {
    if (trimmed === "CTL") {
      return { type: "cellular", carriers: ["ctl_centurylink"], big3: "independent" };
    }
    return { type: "unknown", carriers: ["unknown"], big3: null };
  }

  // Unknown
  return { type: "cellular", carriers: ["other_cellular"], big3: "unknown" };
}

// ========== PROCESS ==========
const stats = {
  total: data.length,
  att: 0, verizon: 0, tmobile: 0,
  regional_att: 0, regional_verizon: 0, regional_tmobile: 0, regional_independent: 0,
  tower_company: 0, non_cellular: 0, other_cellular: 0,
  regional: {}
};

const unknownOwners = {};

for (const tower of data) {
  // Also normalize the owner field in the data itself
  if (tower.owner) tower.owner = tower.owner.replace(/&amp;/g, "&");

  const result = classifyOwner(tower.owner);
  tower.type = result.type;
  tower.carriers = result.carriers;
  tower.big3 = result.big3 || null;

  const tag = result.carriers[0];

  if (tag === "att") stats.att++;
  else if (tag === "verizon") stats.verizon++;
  else if (tag === "tmobile") stats.tmobile++;
  else if (tag === "tower_company") stats.tower_company++;
  else if (tag === "non_cellular") stats.non_cellular++;
  else if (tag === "other_cellular") {
    stats.other_cellular++;
    const short = tower.owner.substring(0, 60).toUpperCase().trim();
    if (short !== "UNKNOWN" && short !== "NONE" && short !== "CTL") {
      unknownOwners[short] = (unknownOwners[short] || 0) + 1;
    }
  } else {
    stats.regional[tag] = stats.regional[tag] || { count: 0, big3: result.big3 };
    stats.regional[tag].count++;
    if (result.big3 === "att") stats.regional_att++;
    else if (result.big3 === "verizon") stats.regional_verizon++;
    else if (result.big3 === "tmobile") stats.regional_tmobile++;
    else stats.regional_independent++;
  }
}

// ========== SAVE ==========
fs.writeFileSync(filePath, JSON.stringify(data));

// ========== REPORT ==========
console.log("");
console.log("==========================================================");
console.log("     FCC Tower Reclassification — FINAL BUILD");
console.log("==========================================================");
console.log("");
console.log(`  Total towers:        ${stats.total.toLocaleString()}`);
console.log("");
console.log("  --- BIG 3 (Direct) ---------------------------------");
console.log(`  AT&T:                ${stats.att.toLocaleString()}`);
console.log(`  Verizon:             ${stats.verizon.toLocaleString()}`);
console.log(`  T-Mobile/Sprint:     ${stats.tmobile.toLocaleString()}`);
console.log("");
console.log("  --- REGIONAL (by Big 3 affiliation) -----------------");
console.log(`  -> Verizon-affiliated:   ${stats.regional_verizon.toLocaleString()}`);
console.log(`  -> AT&T-affiliated:      ${stats.regional_att.toLocaleString()}`);
console.log(`  -> T-Mobile-affiliated:  ${stats.regional_tmobile.toLocaleString()}`);
console.log(`  -> Independent:          ${stats.regional_independent.toLocaleString()}`);
console.log("");

const big3Groups = { verizon: [], att: [], tmobile: [], independent: [] };
for (const [name, info] of Object.entries(stats.regional)) {
  const group = info.big3 || "independent";
  big3Groups[group] = big3Groups[group] || [];
  big3Groups[group].push({ name, count: info.count });
}

for (const [group, carriers] of Object.entries(big3Groups)) {
  if (carriers.length === 0) continue;
  const label = group === "att" ? "AT&T" : group === "verizon" ? "Verizon" : group === "tmobile" ? "T-Mobile" : "Independent";
  console.log(`  ${label.toUpperCase()} AFFILIATED:`);
  carriers.sort((a, b) => b.count - a.count);
  for (const c of carriers) {
    const pretty = c.name.replace(/_/g, " ").replace(/\b\w/g, ch => ch.toUpperCase());
    console.log(`     ${pretty}: ${c.count.toLocaleString()}`);
  }
  console.log("");
}

console.log("  --- OTHER -------------------------------------------");
console.log(`  Tower Companies:     ${stats.tower_company.toLocaleString()}`);
console.log(`  Non-Cellular:        ${stats.non_cellular.toLocaleString()}`);
console.log(`  Unknown/Other Cell:  ${stats.other_cellular.toLocaleString()}`);
console.log("");

const totalATT = stats.att + stats.regional_att;
const totalVerizon = stats.verizon + stats.regional_verizon;
const totalTMobile = stats.tmobile + stats.regional_tmobile;

console.log("  === GRAND TOTALS (Big 3 + affiliates) ===============");
console.log(`  AT&T family:         ${totalATT.toLocaleString()}`);
console.log(`  Verizon family:      ${totalVerizon.toLocaleString()}`);
console.log(`  T-Mobile family:     ${totalTMobile.toLocaleString()}`);
console.log(`  Independent:         ${stats.regional_independent.toLocaleString()}`);
console.log(`  Tower Co / Non-Cell: ${(stats.tower_company + stats.non_cellular).toLocaleString()}`);
console.log(`  Unknown:             ${stats.other_cellular.toLocaleString()}`);
console.log("");
console.log("  Saved to: public/fcc_towers.json");
console.log("==========================================================");

const sorted = Object.entries(unknownOwners).sort((a, b) => b[1] - a[1]);
if (sorted.length > 0) {
  console.log("");
  console.log("TOP 30 UNCLASSIFIED OWNERS (review these):");
  console.log("-------------------------------------------");
  const topN = Math.min(30, sorted.length);
  for (let i = 0; i < topN; i++) {
    console.log(`  ${sorted[i][1].toString().padStart(4)} x  ${sorted[i][0]}`);
  }
  console.log("");
  console.log("Share this list if you want to classify more!");
}
