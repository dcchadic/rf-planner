// =====================================================
// RF PLANNER - LINK / ROUTING LOGIC
// Handles which nodes can reach which, route scoring,
// and finding a path back to the gateway.
// =====================================================

import {
  RANGE_GATEWAY,
  RANGE_LRA,
  RANGE_SRA,
  SCORE_WEIGHT_LOS,
  SCORE_WEIGHT_DISTANCE,
  SCORE_WEIGHT_FRESNEL,
  FRESNEL_WARN_PCT,
} from "./constants.js";

import {
  distance,
  checkLOS,
  calcFresnelPct,
} from "./geo.js";

// =====================================================
// 1. GET MAX RANGE FOR A NODE TYPE
// =====================================================
export function getRangeForType(type) {
  if (type === "gateway") return RANGE_GATEWAY;
  if (type === "lra")     return RANGE_LRA;
  if (type === "sra")     return RANGE_SRA;
  return 0; // single = no mesh range
}

// =====================================================
// 2. SCORE A POTENTIAL LINK
// Returns a number: HIGHER = BETTER link.
// Inputs:
//   d           - distance in miles
//   losClear    - true/false
//   fresnelPct  - 0..100
// =====================================================
export function scoreLink(d, losClear, fresnelPct) {
  let score = 0;

  // LOS is most important
  if (losClear) score += SCORE_WEIGHT_LOS;

  // Closer = better.  
  // We invert distance so smaller distance = higher score.
  score += SCORE_WEIGHT_DISTANCE * (1 / (d + 0.01));

  // Fresnel adds bonus when it's above the warning threshold.
  if (fresnelPct >= FRESNEL_WARN_PCT) {
    score += SCORE_WEIGHT_FRESNEL;
  }

  return score;
}

// =====================================================
// 3. FIND BEST NEXT HOP TOWARD GATEWAY
// For a given node "a", find the best neighbor "b" to talk to.
// Returns: { node, score, los, distance, fresnelPct } or null
// =====================================================
export async function findBestHop(a, allNodes, linksMap) {
  let best = null;

  const aRange = getRangeForType(a.type);

  for (const b of allNodes) {
    if (b === a) continue;
    if (b.type === "single") continue;

    const d = distance(a, b);

    // Determine the max range allowed for THIS link.
    // If b is a gateway or LRA, the relay range is what matters.
    const linkRange = (b.type === "lra" || b.type === "gateway") ? RANGE_LRA : aRange;

    if (d > linkRange) continue;

    // We only count b as a valid "next hop" if it eventually reaches a gateway.
    if (b.type !== "gateway") {
      if (b.type !== "sra" && b.type !== "lra") continue;
      const bPath = getPath(b, linksMap);
      if (!bPath.some((n) => n.type === "gateway")) continue;
    }

    const los = await checkLOS(a, b, a.height, b.height);
    const fresnel = los.clear ? await calcFresnelPct(a, b) : 0;

    const score = scoreLink(d, los.clear, fresnel);

    if (!best || score > best.score) {
      best = {
        node: b,
        score,
        los,
        distance: d,
        fresnelPct: fresnel,
      };
    }
  }

  return best;
}

// =====================================================
// 4. BUILD A PATH FROM A NODE TO THE GATEWAY
// Follows the current link map until we reach a gateway
// or run out of hops.
// =====================================================
export function getPath(start, linksMap) {
  const path = [start];
  const visited = new Set([start.name]);
  let current = start;

  for (let i = 0; i < 50; i++) {
    const next = linksMap[current.name];
    if (!next) break;
    if (visited.has(next.name)) break;
    visited.add(next.name);
    path.push(next);
    if (next.type === "gateway") break;
    current = next;
  }

  return path;
}

// =====================================================
// 5. IS NODE CONNECTED TO A GATEWAY?
// =====================================================
export function isConnectedToGateway(node, linksMap) {
  const path = getPath(node, linksMap);
  return path.some((n) => n.type === "gateway");
}

// =====================================================
// 6. COMPUTE LINKS (build linksMap from all nodes)
// Walks every node, finds the best next hop, and stores
// the result in linksMap. Multi-pass so chained nodes
// can find paths via earlier connections.
// =====================================================
export async function computeLinks(allNodes) {
  const linksMap = {};

  // Sort gateways first, then LRAs, then SRAs so chained paths build up.
  const sorted = [...allNodes].sort((x, y) => {
    const order = { gateway: 0, lra: 1, sra: 2, single: 3 };
    return order[x.type] - order[y.type];
  });

  // Do 2 passes so secondary nodes can connect through newly-linked LRAs.
  for (let pass = 0; pass < 2; pass++) {
    for (const a of sorted) {
      if (a.type === "gateway" || a.type === "single") continue;
      const best = await findBestHop(a, allNodes, linksMap);
      if (best) {
        linksMap[a.name] = best.node;
      }
    }
  }

  return linksMap;
}