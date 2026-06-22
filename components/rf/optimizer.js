// =====================================================
// RF PLANNER - OPTIMIZER (v2)
// Locked rules:
//   - Pad detection (200 ft, Option B)
//   - Gateway placement (highest direct SRA + LOS tie-break + 100 ft north)
//   - Default + max heights (G:15/25, LRA:10/20, SRA:5/5)
//   - 1.5x flagged-but-allowed rule
//   - Height escalation (Gateway first, then LRA 5 ft steps)
//   - Mesh routing + selective LRA promotion
//   - Smarter, chain-aware promotion + safety pass
// =====================================================

import {
  DEFAULT_HEIGHT_GATEWAY,
  DEFAULT_HEIGHT_LRA,
  DEFAULT_HEIGHT_SRA,
  MAX_HEIGHT_GATEWAY,
  MAX_HEIGHT_LRA,
  FLAG_MAX_HEIGHT_GATEWAY,
  FLAG_MAX_HEIGHT_LRA,
  RANGE_GATEWAY,
  RANGE_LRA,
  RANGE_SRA,
  HEIGHT_STEP,
  GATEWAY_OFFSET_NORTH_FT,
  PAD_RADIUS_FT,
  PAD_MIN_FOR_MANDATORY_LRA,
  PAD_MIN_FOR_OPTIONAL_LRA,
} from "./constants.js";

import {
  distance,
  getElevation,
  checkLOS,
} from "./geo.js";

import {
  computeLinks,
  isConnectedToGateway,
  getPath,
} from "./links.js";

// =====================================================
// HELPERS
// =====================================================

function feetToLatDegrees(ft) { return ft / 364000; }
function feetToMiles(ft) { return ft / 5280; }

function resetToSRA(node) {
  node.type = "sra";
  node.height = DEFAULT_HEIGHT_SRA;
  node.range = RANGE_SRA;
  if (node.markerElement) node.markerElement.style.background = "green";
}

function promoteToLRA(node) {
  node.type = "lra";
  node.height = DEFAULT_HEIGHT_LRA;
  node.range = RANGE_LRA;
  if (node.markerElement) node.markerElement.style.background = "orange";
}

function getDisconnected(nodes, linksMap) {
  return nodes.filter(
    n => n.type !== "gateway" && n.type !== "single" && !isConnectedToGateway(n, linksMap)
  );
}

// =====================================================
// 1. PAD DETECTION
// =====================================================
export function detectPads(nodes) {
  const padRadiusMiles = feetToMiles(PAD_RADIUS_FT);
  const visited = new Set();
  const pads = [];

  for (const n of nodes) {
    if (visited.has(n.name)) continue;
    const cluster = [n];
    visited.add(n.name);

    for (const m of nodes) {
      if (visited.has(m.name)) continue;
      if (distance(n, m) <= padRadiusMiles) {
        cluster.push(m);
        visited.add(m.name);
      }
    }

    if (cluster.length >= PAD_MIN_FOR_OPTIONAL_LRA) {
      pads.push(cluster);
    }
  }

  return pads;
}

// =====================================================
// 2. SELECT PAD LRA
// =====================================================
export async function selectPadLRA(pad) {
  let best = null;
  let bestScore = -Infinity;

  let avgLng = 0, avgLat = 0;
  for (const p of pad) { avgLng += p.lng; avgLat += p.lat; }
  avgLng /= pad.length;
  avgLat /= pad.length;
  const center = { lng: avgLng, lat: avgLat };

  for (const p of pad) {
    const elev = await getElevation(p.lng, p.lat);
    const distToCenter = distance(p, center);
    const score = elev * 1.0 - distToCenter * 100;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

// =====================================================
// 3. APPLY PAD RULE
// =====================================================
export async function applyPadRule(nodes) {
  const pads = detectPads(nodes);
  const padLRAs = [];

  // Don't add an LRA on a pad if there's already an LRA close by
  const PAD_LRA_MIN_SEPARATION_MI = 1.0;

  for (const pad of pads) {
    if (pad.length >= PAD_MIN_FOR_MANDATORY_LRA) {
      const chosen = await selectPadLRA(pad);
      if (!chosen) continue;

      const tooClose = nodes.some(n =>
        n.type === "lra" && n !== chosen && distance(n, chosen) < PAD_LRA_MIN_SEPARATION_MI
      );
      if (tooClose) continue;

      promoteToLRA(chosen);
      padLRAs.push(chosen);
    }
  }
  return padLRAs;
}

// =====================================================
// 4. GATEWAY PLACEMENT
// Highest direct SRA reach + elevation tie-break.
// Place 100 ft NORTH of chosen anchor node.
// =====================================================
export async function placeGateway(nodes, addNodeFn, mapRef) {
  let best = null;
  let bestCount = -1;
  let bestElev = -Infinity;

  for (const n of nodes) {
    let count = 0;
    for (const m of nodes) {
      if (m === n) continue;
      if (distance(n, m) <= RANGE_SRA) count++;
    }
    const elev = await getElevation(n.lng, n.lat);
    if (count > bestCount || (count === bestCount && elev > bestElev)) {
      best = n;
      bestCount = count;
      bestElev = elev;
    }
  }

  if (!best) return null;

  const offsetLat = feetToLatDegrees(GATEWAY_OFFSET_NORTH_FT);
  const gwLng = best.lng;
  const gwLat = best.lat + offsetLat;

  addNodeFn(mapRef, gwLng, gwLat, "gateway", "GATEWAY-1", true, DEFAULT_HEIGHT_GATEWAY);
  return { gatewayAnchor: best, gwLng, gwLat };
}

// =====================================================
// 5. HEIGHT RECOVERY (Gateway first, then LRA)
// 1.5x rule:
//   - Within max → normal
//   - Within flag max (1.5x) → connect + flag
//   - Beyond → impossible
// =====================================================
export async function tryHeightRecovery(nodeA, nodeB) {
  // GATEWAY recovery first
  if (nodeA.type === "gateway" || nodeB.type === "gateway") {
    const gw = nodeA.type === "gateway" ? nodeA : nodeB;
    const other = gw === nodeA ? nodeB : nodeA;

    for (let h = gw.height; h <= MAX_HEIGHT_GATEWAY; h += HEIGHT_STEP) {
      const los = await checkLOS(gw, other, h, other.height);
      if (los.clear) { gw.height = h; return { status: "connected", flagged: false }; }
    }
    for (let h = MAX_HEIGHT_GATEWAY + HEIGHT_STEP; h <= FLAG_MAX_HEIGHT_GATEWAY; h += HEIGHT_STEP) {
      const los = await checkLOS(gw, other, h, other.height);
      if (los.clear) { gw.height = h; return { status: "connected", flagged: true }; }
    }
  }

  // LRA recovery
  if (nodeA.type === "lra" || nodeB.type === "lra") {
    const lra = nodeA.type === "lra" ? nodeA : nodeB;
    const other = lra === nodeA ? nodeB : nodeA;

    for (let h = lra.height; h <= MAX_HEIGHT_LRA; h += HEIGHT_STEP) {
      const los = await checkLOS(lra, other, h, other.height);
      if (los.clear) { lra.height = h; return { status: "connected", flagged: false }; }
    }
    for (let h = MAX_HEIGHT_LRA + HEIGHT_STEP; h <= FLAG_MAX_HEIGHT_LRA; h += HEIGHT_STEP) {
      const los = await checkLOS(lra, other, h, other.height);
      if (los.clear) { lra.height = h; return { status: "connected", flagged: true }; }
    }
  }

  return { status: "impossible", flagged: false };
}

// =====================================================
// 6. SMART PROMOTION PASS (chain-aware, repeated)
// Promotes SRA → LRA only when it actually helps.
// Repeats until no more useful promotions exist.
// =====================================================
export async function runSmartPromotionPass(nodes) {
  const MIN_HELP_TO_PROMOTE = 3;

  for (let attempt = 0; attempt < 30; attempt++) {
    const linksMap = await computeLinks(nodes);
    const disconnected = getDisconnected(nodes, linksMap);
    if (disconnected.length === 0) return;

    let bestCandidate = null;
    let bestScore = 0;

    for (const cand of nodes) {
      if (cand.type !== "sra") continue;

      let direct = 0;
      for (const d of disconnected) {
        if (cand === d) continue;
        if (distance(cand, d) <= RANGE_LRA) direct++;
      }

      let chainBonus = 0;
      if (direct > 0) {
        for (const conn of nodes) {
          if (conn === cand) continue;
          if (!isConnectedToGateway(conn, linksMap)) continue;
          if (distance(cand, conn) <= RANGE_LRA) { chainBonus = 1; break; }
        }
      }

      const score = direct + chainBonus;
      if (score > bestScore) { bestScore = score; bestCandidate = cand; }
    }

    if (!bestCandidate || bestScore < MIN_HELP_TO_PROMOTE) return;
    promoteToLRA(bestCandidate);
  }
}

// =====================================================
// 7. HEIGHT ESCALATION PASS
// For any link that exists but is currently blocked,
// raise heights per locked escalation rule.
// =====================================================
export async function runHeightEscalationPass(nodes) {
  const linksMap = await computeLinks(nodes);
  for (const n of nodes) {
    if (n.type === "gateway" || n.type === "single") continue;
    const target = linksMap[n.name];
    if (!target) continue;

    const los = await checkLOS(n, target, n.height, target.height);
    if (los.clear) continue;

    await tryHeightRecovery(n, target);
  }
}

// =====================================================
// 8. FINAL SAFETY PASS
// For any node still disconnected, try one more promotion
// + height escalation rescue.
// =====================================================
export async function runFinalSafetyPass(nodes) {
  const linksMap = await computeLinks(nodes);
  const stillDisconnected = getDisconnected(nodes, linksMap);
  if (stillDisconnected.length === 0) return;

  for (const d of stillDisconnected) {
    // Try promoting nearest SRA neighbor that's connected to gateway
    let nearest = null;
    let nearestDist = Infinity;
    for (const cand of nodes) {
      if (cand === d) continue;
      if (cand.type !== "sra") continue;
      if (!isConnectedToGateway(cand, linksMap)) continue;
      const dist = distance(cand, d);
      if (dist <= RANGE_LRA && dist < nearestDist) {
        nearest = cand;
        nearestDist = dist;
      }
    }

    if (nearest) {
      promoteToLRA(nearest);
      await tryHeightRecovery(nearest, d);
    } else {
      // Try elevating an existing LRA to reach d
      for (const lra of nodes) {
        if (lra.type !== "lra") continue;
        if (distance(lra, d) > RANGE_LRA) continue;
        await tryHeightRecovery(lra, d);
      }
    }
  }
}

// =====================================================
// 9. MARK DISCONNECTED NODES
// =====================================================
export function markDisconnected(nodes, linksMap) {
  for (const n of nodes) {
    if (n.type === "gateway" || n.type === "single") continue;
    n.outOfRange = !isConnectedToGateway(n, linksMap);
  }
}
// =====================================================
// MULTI-GATEWAY HELPERS
// =====================================================

// Constants for multi-gateway logic
const MULTI_GW_CLUSTER_RADIUS_MI = 3;   // grouping radius for disconnected nodes
const MULTI_GW_MIN_CLUSTER_SIZE  = 6;   // need at least 6 nodes to justify a new gateway
const MULTI_GW_MAX_NODES_PER_GW  = 25;  // each gateway serves at most 25 nodes

// ----- Get all disconnected non-gateway nodes -----
function getDisconnectedNodes(nodes, linksMap) {
  return nodes.filter(
    n => n.type !== "gateway" && n.type !== "single" && !isConnectedToGateway(n, linksMap)
  );
}

// ----- Group disconnected nodes into clusters by proximity -----
function clusterDisconnectedNodes(disconnected) {
  const clusters = [];
  const visited = new Set();

  for (const n of disconnected) {
    if (visited.has(n.name)) continue;

    const cluster = [n];
    visited.add(n.name);

    // expand outward — anything within 3 mi of ANY current cluster member joins it
    let added = true;
    while (added) {
      added = false;
      for (const m of disconnected) {
        if (visited.has(m.name)) continue;
        for (const c of cluster) {
          if (distance(c, m) <= MULTI_GW_CLUSTER_RADIUS_MI) {
            cluster.push(m);
            visited.add(m.name);
            added = true;
            break;
          }
        }
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

// ----- Pick the best node in a cluster to anchor a new gateway -----
async function selectGatewayAnchorInCluster(cluster) {
  let best = null;
  let bestCount = -1;
  let bestElev = -Infinity;

  for (const n of cluster) {
    let count = 0;
    for (const m of cluster) {
      if (m === n) continue;
      if (distance(n, m) <= RANGE_SRA) count++;
    }
    const elev = await getElevation(n.lng, n.lat);
    if (count > bestCount || (count === bestCount && elev > bestElev)) {
      best = n;
      bestCount = count;
      bestElev = elev;
    }
  }

  return best;
}

// ----- Place a new gateway 100 ft north of the chosen anchor -----

// ----- Place a new gateway 100 ft north of the chosen anchor -----
// allNodes = the full nodes array (used to ensure unique gateway names)
async function placeGatewayInCluster(cluster, addNodeFn, mapRef, allNodes) {
  const anchor = await selectGatewayAnchorInCluster(cluster);
  if (!anchor) return null;

  const offsetLat = GATEWAY_OFFSET_NORTH_FT / 364000;
  const gwLng = anchor.lng;
  const gwLat = anchor.lat + offsetLat;

  // Unique gateway name with collision protection
  const taken = new Set();
  if (Array.isArray(allNodes)) {
    for (const n of allNodes) {
      if (n && n.type === "gateway") taken.add(n.name);
    }
  }
  let i = 1;
  let gwName;
  while (true) {
    gwName = `GATEWAY-${i}`;
    if (!taken.has(gwName)) break;
    i++;
  }

  addNodeFn(mapRef, gwLng, gwLat, "gateway", gwName, true, DEFAULT_HEIGHT_GATEWAY);

  return { anchor, gwLng, gwLat, name: gwName };
}


// ----- Count how many nodes route through each gateway -----
function countNodesPerGateway(nodes, linksMap) {
  const counts = {};
  for (const n of nodes) {
    if (n.type === "gateway") {
      counts[n.name] = 0;
    }
  }

  for (const n of nodes) {
    if (n.type === "gateway" || n.type === "single") continue;
    const path = getPath(n, linksMap);
    const gw = path.find(p => p.type === "gateway");
    if (gw && counts[gw.name] !== undefined) {
      counts[gw.name] += 1;
    }
  }

  return counts;
}

// =====================================================
// MULTI-GATEWAY EXPANSION PASS
// Adds extra gateways for big fields based on locked rules:
//   - cluster radius = 3 mi
//   - cluster minimum = 6 nodes
//   - no cap on gateway count
// =====================================================
async function runMultiGatewayPass({ nodes, addNodeFn, mapRef, onProgress }) {
  const report = (msg) => { if (typeof onProgress === "function") onProgress(msg); };

  const MIN_DISCONNECTED_FOR_NEW_GW = 10;
  const MIN_GW_SEPARATION_MI = 2.0;

  for (let pass = 0; pass < 10; pass++) {
    report(`Multi-gateway pass ${pass + 1}…`);

    const linksMap = await computeLinks(nodes);
    const disconnected = getDisconnectedNodes(nodes, linksMap);
    if (disconnected.length === 0) return;

    const clusters = clusterDisconnectedNodes(disconnected);
    const qualifying = clusters.filter(c => c.length >= MIN_DISCONNECTED_FOR_NEW_GW);
    if (qualifying.length === 0) return;

    qualifying.sort((a, b) => b.length - a.length);

    let placedAny = false;
    for (const cluster of qualifying) {
      const anchor = await selectGatewayAnchorInCluster(cluster);
      if (!anchor) continue;

      const tooClose = nodes.some(n =>
        n.type === "gateway" && distance(n, anchor) < MIN_GW_SEPARATION_MI
      );
      if (tooClose) continue;

      const result = await placeGatewayInCluster(cluster, addNodeFn, mapRef, nodes);
      if (result) placedAny = true;
    }

    if (placedAny) {
      await runSmartPromotionPass(nodes);
    } else {
      return;
    }
  }
}
// =====================================================
// 25-NODE GATEWAY CAP PASS
// If any gateway serves more than MULTI_GW_MAX_NODES_PER_GW,
// add a new gateway inside the overflowing sub-cluster.
// =====================================================
async function runGatewayCapPass({ nodes, addNodeFn, mapRef, onProgress }) {
  const report = (msg) => { if (typeof onProgress === "function") onProgress(msg); };

  const HARD_CAP = MULTI_GW_MAX_NODES_PER_GW; // 25
  const MIN_GW_SEPARATION_MI = 2.0;

  for (let attempt = 0; attempt < 10; attempt++) {
    report(`Cap enforcement pass ${attempt + 1}…`);

    const linksMap = await computeLinks(nodes);
    const counts = countNodesPerGateway(nodes, linksMap);

    let worstGw = null;
    let worstCount = 0;
    for (const gwName of Object.keys(counts)) {
      if (counts[gwName] > worstCount) {
        worstCount = counts[gwName];
        worstGw = gwName;
      }
    }

    if (!worstGw || worstCount <= HARD_CAP) return;

    // Collect overloaded nodes
    const overloadedNodes = [];
    for (const n of nodes) {
      if (n.type === "gateway" || n.type === "single") continue;
      const path = getPath(n, linksMap);
      const gw = path.find(p => p.type === "gateway");
      if (gw && gw.name === worstGw) overloadedNodes.push(n);
    }

    if (overloadedNodes.length < HARD_CAP) return;

    const gwNode = nodes.find(n => n.name === worstGw);
    if (!gwNode) return;

    // Take the half farthest from the overloaded gateway — those are the ones
    // that would benefit most from a new gateway
    const sortedByDist = [...overloadedNodes].sort((a, b) =>
      distance(b, gwNode) - distance(a, gwNode)
    );
    const candidateCluster = sortedByDist.slice(0, Math.ceil(overloadedNodes.length / 2));
    if (candidateCluster.length < MULTI_GW_MIN_CLUSTER_SIZE) return;

    const anchor = await selectGatewayAnchorInCluster(candidateCluster);
    if (!anchor) return;

    // Must be far enough from any existing gateway, otherwise abort (prevents cascade)
    const tooClose = nodes.some(n =>
      n.type === "gateway" && distance(n, anchor) < MIN_GW_SEPARATION_MI
    );
    if (tooClose) return;

    const placed = await placeGatewayInCluster(candidateCluster, addNodeFn, mapRef, nodes);
    if (!placed) return;

    // NOTE: intentionally NOT re-running promotion here.
    // The next loop iteration's computeLinks() will rebalance naturally.
    // This is what stops the cascade.
  }
}
// =====================================================
// 10. MAIN OPTIMIZER ENTRY POINT  (multi-gateway aware + progress)
// =====================================================
export async function runFullOptimizer({ nodes, addNodeFn, mapRef, onProgress }) {
  const report = (msg) => { if (typeof onProgress === "function") onProgress(msg); };

  report("Resetting nodes…");

  // 1. Reset all non-gateway nodes to SRA defaults
  for (const n of nodes) {
    if (n.type !== "gateway") resetToSRA(n);
  }

  // 2. Place first gateway if missing
  const hasGateway = nodes.some(n => n.type === "gateway");
  if (!hasGateway) {
    report("Placing first gateway…");
    await placeGateway(nodes, addNodeFn, mapRef);
  }

  // 3. Apply pad rule
  report("Detecting pads…");
  await applyPadRule(nodes);

  // 4. Smart promotion pass
  report("Promoting LRAs (smart pass)…");
  await runSmartPromotionPass(nodes);

  // 5. Height escalation pass
  report("Raising heights to clear LOS…");
  await runHeightEscalationPass(nodes);

  // 6. Multi-gateway expansion pass
  report("Adding gateways for big clusters…");
  await runMultiGatewayPass({ nodes, addNodeFn, mapRef, onProgress });

  // 7. 25-node cap pass
  report("Enforcing 25-node per-gateway cap…");
  await runGatewayCapPass({ nodes, addNodeFn, mapRef, onProgress });

  // 8. Final safety pass
  report("Final safety pass…");
  await runFinalSafetyPass(nodes);

  // 9. Final link map + disconnect marking
  report("Finalizing network…");
  const linksMap = await computeLinks(nodes);
  markDisconnected(nodes, linksMap);

  report("Optimization complete");
  return linksMap;
}
// =====================================================
// VISION-AWARE OPTIMIZER ENTRY POINT
// Same engine, but accepts a runtime "mode" to relax rules.
// - mode = "build"   → locked rules (default behavior)
// - mode = "vision"  → no constraints (theoretical layout)
// =====================================================
// =====================================================
// MODE-AWARE OPTIMIZER ENTRY POINT
// Build Mode → locked rules
// Vision Mode → same engine, but ignore height limits + 1.5× rule
// =====================================================
export async function runOptimizerWithMode({
  nodes,
  addNodeFn,
  mapRef,
  mode = "build",
}) {
  // Build Mode is just the existing locked-rule pipeline
  if (mode === "build") {
    return await runFullOptimizer({ nodes, addNodeFn, mapRef });
  }

  // ----------- VISION MODE -----------
  // Goal: Same optimizer behavior as Build Mode, but ignore height limits.
  // We temporarily allow much taller heights so the optimizer can find
  // connections it would otherwise refuse to build.

  const VISION_MAX_HEIGHT = 200; // ft — effectively "no limit"

  // 1. Reset all non-gateway nodes to SRA defaults
  for (const n of nodes) {
    if (n.type !== "gateway") {
      n.type = "sra";
      n.height = 5;
      n.range = 0.75;
      if (n.markerElement) n.markerElement.style.background = "green";
    }
  }

  // 2. Place gateway if missing
  const hasGateway = nodes.some(n => n.type === "gateway");
  if (!hasGateway) {
    await placeGateway(nodes, addNodeFn, mapRef);
  }

  // 3. Pad rule — same as Build Mode
  await applyPadRule(nodes);

  // 4. Promotion logic — same as Build Mode
  //    The existing logic picks LRAs based on connectivity.
  await runFullOptimizer({ nodes, addNodeFn, mapRef });

  // 5. Vision Mode rescue:
  //    For any node that ended up disconnected after Build logic,
  //    raise heights aggressively up to VISION_MAX_HEIGHT to recover LOS.
  for (const n of nodes) {
    if (n.type === "gateway" || n.type === "single") continue;
    if (!n.outOfRange) continue;

    // Try raising heights up to 200ft to recover any connectable link
    if (n.type === "lra") {
      n.height = VISION_MAX_HEIGHT;
    } else if (n.type === "sra") {
      // promote it temporarily for vision
      n.type = "lra";
      n.range = 3;
      n.height = VISION_MAX_HEIGHT;
      if (n.markerElement) n.markerElement.style.background = "orange";
    }
  }

  // 6. Recompute final link map
  const linksMap = await computeLinks(nodes);

  // 7. Vision Mode hides "disconnected" flags — assume everything is connectable
  for (const n of nodes) {
    if (n.type === "gateway" || n.type === "single") continue;
    n.outOfRange = false;
  }

  return linksMap;
}