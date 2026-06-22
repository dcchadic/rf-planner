"use client";

import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import html2canvas from "html2canvas";
// =====================================================
// NEW RF ENGINE IMPORTS (Path A — runs alongside the old one)
// =====================================================
import { runFullOptimizer } from "./rf/optimizer.js";
import { readKmzToPlacemarks } from "./rf/kmlImporter.js";
import { computeLinks as newComputeLinks } from "./rf/links.js";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// ---------- CACHES ----------
const elevationCache = {};
const fresnelCache = {};

// =====================================================
// MAP LEGEND COMPONENT
// =====================================================
function MapLegend(){
  const [open, setOpen] = useState(true);

  const nodeStates = [
    { color: "blue",   label: "Gateway" },
    { color: "orange", label: "LRA" },
    { color: "green",  label: "SRA" },
    { color: "black",  label: "Single Modem" },
    { color: "#666",   border: "2px solid red",     label: "Disconnected (impossible)" },
    { color: "green",  border: "2px solid #ff1493", glow: true, label: "Flagged (above max height)" },
  ];

  const lineStates = [
    { color: "rgb(46,125,50)",  label: "Strong (Fresnel ≥ 80%)" },
    { color: "rgb(255,215,0)",  label: "Marginal Fresnel" },
    { color: "rgb(255,152,0)",  label: "Weak Fresnel" },
    { color: "rgb(244,67,54)",  label: "Fringe" },
    { color: "#a64ca6",         label: "Flagged-but-allowed" },
    { color: "#ff3333", dashed: true, label: "Blocked / impossible LOS" },
  ];

  return (
    <div style={{
      position: "absolute",
      bottom: 30,
      left: 10,
      zIndex: 1000,
      background: "rgba(20,20,30,0.92)",
      border: "1px solid rgba(255,255,255,0.3)",
      borderRadius: 8,
      padding: open ? "10px 14px" : "6px 10px",
      backdropFilter: "blur(4px)",
      boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
      maxWidth: 240,
      color: "#fff",
      fontSize: 12
    }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          cursor: "pointer",
          marginBottom: open ? 6 : 0,
          fontWeight: "bold"
        }}
        onClick={() => setOpen(!open)}
      >
        <span>🗺️ Map Legend</span>
        <span style={{ marginLeft: 8, fontSize: 11, color: "#aaa" }}>
          {open ? "▼" : "▶"}
        </span>
      </div>

      {open && (
        <div>
          <div style={{ fontWeight: "bold", color: "#aaa", marginTop: 4, marginBottom: 4 }}>Nodes</div>
          {nodeStates.map((s, i) => (
            <div key={"n" + i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
              <div style={{
  width: 14, height: 14, borderRadius: "50%",
  background: s.color,
  border: s.border || "1px solid rgba(255,255,255,0.3)",
  boxShadow: s.glow ? "0 0 6px #ff1493" : "none"
}}/>
              <span style={{ color: "#ddd" }}>{s.label}</span>
            </div>
          ))}

          <div style={{ fontWeight: "bold", color: "#aaa", marginTop: 8, marginBottom: 4 }}>Routes</div>
          {lineStates.map((s, i) => (
            <div key={"l" + i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
              <div style={{
                width: 22, height: 4, borderRadius: 2,
                background: s.dashed ? `repeating-linear-gradient(90deg, ${s.color} 0 6px, transparent 6px 10px)` : s.color
              }}/>
              <span style={{ color: "#ddd" }}>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
export default function Map(){

  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const nodesRef = useRef([]);
  const linksRef = useRef({});
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const [mode, setMode] = useState("sra"); // node placement mode (gateway/lra/sra/single)
   const [inputCoords,setInputCoords] = useState("");
  const [recommendations,setRecommendations] = useState([]);
  const [showOptimizePrompt, setShowOptimizePrompt] = useState(false);
  const [importedData, setImportedData] = useState([]);

  const [selectedNode,setSelectedNode] = useState(null);
  const [editName,setEditName] = useState("");
  const [editType,setEditType] = useState("");
  const [editHeight, setEditHeight] = useState(0);
  const [editModbus, setEditModbus] = useState("");
  const [nodeVersion, setNodeVersion] = useState(0);
  const [showProfile, setShowProfile] = useState(false);
  const [profileData, setProfileData] = useState(null);
  const canvasRef = useRef(null);
  const [profileFromHeight, setProfileFromHeight] = useState(0);
  const [profileToHeight, setProfileToHeight] = useState(0);
  const [profileFromType, setProfileFromType] = useState("sra");
  const [profileToType, setProfileToType] = useState("sra");
  const [measureMode, setMeasureMode] = useState(false);
  const measurePoints = useRef([]);
  const measureMarkersRef = useRef([]);
  const skipNextClick = useRef(false);
  const [showFileMenu, setShowFileMenu] = useState(false);
  // =====================================================
// PROGRESS OVERLAY STATE
// loadingState = null    → idle (hidden)
// loadingState = { title: "...", subtitle: "...", progress: 0..1 (optional) }
// =====================================================
const [loadingState, setLoadingState] = useState(null);
// =====================================================
// TEXT PROMPT MODAL (replaces native prompt() which is blocked in some browsers)
// shape: { title, defaultValue, onConfirm: (value) => void }
// =====================================================
const [textPrompt, setTextPrompt] = useState(null);
// =====================================================
// MULTI-GATEWAY LOAD PROMPT STATE
// Shown when a loaded file contains 2+ gateways and we want
// to ask the user whether to auto-split into project tabs.
// =====================================================
const [multiGatewayLoadPrompt, setMultiGatewayLoadPrompt] = useState(null);
// shape: { nodes: [...], gatewayCount: number, fileName: "..." }

  // ---------- FCC TOWER STATE ----------
  const [showFCCTowers, setShowFCCTowers] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const heatmapLoaded = useRef(false);
  const showHeatmapRef = useRef(false);
  const [fccLoading, setFccLoading] = useState(false);
  const fccLoaded = useRef(false);
  const fccPopupRef = useRef(null);

  // ---------- MULTI-PROJECT STATE ----------
  const [projects, setProjects] = useState([{ id: 1, name: "Project 1" }]);
  const [activeProjectId, setActiveProjectId] = useState(1);
  const projectDataRef = useRef({});
  const nextProjectIdRef = useRef(2);

  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { showHeatmapRef.current = showHeatmap; }, [showHeatmap]);

  const measureModeRef = useRef(false);
  useEffect(() => { measureModeRef.current = measureMode; }, [measureMode]);

  // ---------- INIT ----------
  useEffect(()=>{
    if(!containerRef.current) return;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [-102.8927,31.5943],
      zoom: 11,
      preserveDrawingBuffer: true
    });
    mapRef.current = map;
    map.on("click",(e)=>{
      if(skipNextClick.current){ skipNextClick.current = false; return; }
      if(measureModeRef.current){ handleMeasureClick(e.lngLat.lng, e.lngLat.lat); return; }
      addNode(map, e.lngLat.lng, e.lngLat.lat, modeRef.current);
    });
    return ()=> map.remove();
  },[]);

  // ---------- RF ----------
  function distance(a,b){
    return Math.sqrt((a.lng-b.lng)**2 + (a.lat-b.lat)**2)*69;
  }
  function calcPower(d){
    return 30+5+5-(20*Math.log10(d*1.6+0.01)+20*Math.log10(900)+32.44);
  }

  // ---------- TERRAIN ----------
  async function getElevation(lng, lat){
    const key = `${lng.toFixed(5)},${lat.toFixed(5)}`;
    if(elevationCache[key] !== undefined) return elevationCache[key];
    try{
      const zoom = 14;
      const tileSize = 256;
      const tileX = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
      const latRad = lat * Math.PI / 180;
      const tileY = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom));
      const pixelX = Math.floor(((lng + 180) / 360 * Math.pow(2, zoom) - tileX) * tileSize);
      const pixelY = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom) - tileY) * tileSize);
      const tileKey = `tile_${zoom}_${tileX}_${tileY}`;
      if(!elevationCache[tileKey]){
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
    }catch{ return 0; }
  }

  async function checkLOS(p1, p2, h1, h2){
    const elev1 = await getElevation(p1.lng, p1.lat);
    const elev2 = await getElevation(p2.lng, p2.lat);
    const tip1 = elev1 + h1;
    const tip2 = elev2 + h2;
    let maxBlock = 0;
    const steps = Math.max(10, Math.round((distance(p1, p2) * 5280) / 200));
    for(let i = 1; i < steps; i++){
      const t = i / steps;
      const lng = p1.lng + (p2.lng - p1.lng) * t;
      const lat = p1.lat + (p2.lat - p1.lat) * t;
      const elev = await getElevation(lng, lat);
      const losAtPoint = tip1 + (tip2 - tip1) * t;
      const diff = elev - losAtPoint;
      if(diff > maxBlock) maxBlock = diff;
    }
    if(maxBlock > 0){ return { clear: false, requiredHeight: maxBlock + 5 }; }
    return { clear: true, requiredHeight: 0 };
  }

  // ---------- ADD NODE ----------
  function addNode(map,lng,lat,type,name=null,silent=false,customHeight=null){
    const el = document.createElement("div");
    el.style.width = "18px";
    el.style.height = "18px";
    el.style.borderRadius = "50%";
    el.style.background =
      type==="gateway" ? "blue" :
      type==="lra" ? "orange" :
      type==="single" ? "black" : "green";
    const node = {
      lng, lat, type,
      markerElement: el,
      height: customHeight || (type==="gateway"?15:type==="lra"?10:5),
      range: type==="gateway"?3:type==="lra"?3:type==="single"?0:0.75,
      name: name || `${type}-${nodesRef.current.length+1}`,
      elevation: null, blocked: false, blockDetail: null, outOfRange: false,
      modbusId: type === "gateway" ? null : nodesRef.current.filter(n => n.type !== "gateway").length + 1
    };
    const marker = new mapboxgl.Marker({element:el,draggable:true})
      .setLngLat([lng,lat]).addTo(map);
    // =====================================================
// MAP NODE CLICK BEHAVIOR
// Single click → open node editor only
// Double click → open terrain profile to connected node
// =====================================================
el.addEventListener("click", (e) => {
  e.stopPropagation();
  e.preventDefault();
  skipNextClick.current = true;

  // Stop Mapbox from also handling this click
  if (e.nativeEvent) e.nativeEvent.stopImmediatePropagation?.();

  setSelectedNode(node);
  setEditName(node.name);
  setEditType(node.type);
  setEditHeight(node.height);
  setEditModbus(node.modbusId || "");
});

el.addEventListener("dblclick", (e) => {
  e.stopPropagation();
  skipNextClick.current = true;

  // Only open the terrain profile — do NOT open the editor
  if (node.type !== "gateway" && node.type !== "single" && linksRef.current[node.name]) {
    try { generateProfile(node); } catch (err) { console.log("Profile error:", err); }
  } else {
    // No link target — show an empty profile so user sees something useful
    setProfileData({
      from: node,
      to: node,
      points: [{ dist: 0, elev: 0, lng: node.lng, lat: node.lat }],
      totalDist: 0,
      isMeasure: false
    });
    setProfileFromHeight(node.height);
    setProfileToHeight(node.height);
    setProfileFromType(node.type);
    setProfileToType(node.type);
    setShowProfile(true);
  }
});
    marker.on("dragend",()=>{
      const p = marker.getLngLat();
      node.lng=p.lng; node.lat=p.lat; node.elevation = null; redraw();
    });
    el.oncontextmenu=(e)=>{
      e.preventDefault();
      saveSnapshot();
      marker.remove();
      nodesRef.current = nodesRef.current.filter(n=>n!==node);
      redraw();
    };
    if(customHeight && !node.modbusId && type !== "gateway"){ node.modbusId = nodesRef.current.filter(n => n.type !== "gateway").length + 1; }
   node.marker = marker;
    if (!silent){ saveSnapshot(); }
    nodesRef.current.push(node);
    if (!silent){ redraw(); }
  }

  // ---------- ROUTING ----------
  async function calcFresnelPct(p1, p2){
    const d = distance(p1, p2);
    const totalDistM = d * 1609.34;
    const wl = 0.333;
    if(totalDistM <= 0) return 100;
    const elev1 = await getElevation(p1.lng, p1.lat);
    const elev2 = await getElevation(p2.lng, p2.lat);
    const tip1 = elev1 + p1.height;
    const tip2 = elev2 + p2.height;
    let worstPct = 100;
    const steps = 20;
    for(let s = 1; s < steps; s++){
      const t = s / steps;
      const d1m = t * totalDistM;
      const d2m = totalDistM - d1m;
      const fR = (d1m > 0 && d2m > 0) ? Math.sqrt(wl * d1m * d2m / totalDistM) * 3.281 : 0;
      if(fR <= 0) continue;
      const lng = p1.lng + (p2.lng - p1.lng) * t;
      const lat = p1.lat + (p2.lat - p1.lat) * t;
      const ev = await getElevation(lng, lat);
      const losE = tip1 + (tip2 - tip1) * t;
      const cl = losE - ev;
      const pct = (cl / fR) * 100;
      if(pct < worstPct) worstPct = pct;
    }
    return worstPct;
  }

  async function computeLinks(){
    linksRef.current = {};
    const sortedNodes = [...nodesRef.current].sort((x,y)=>{
      const order = {gateway:0, lra:1, sra:2};
      return order[x.type] - order[y.type];
    });
    for (const a of sortedNodes) {
      if (a.type === "gateway") continue;
      if (a.type === "single") continue;
      let clearGateway=null,clearGatewayDist=Infinity;
      let clearLRA=null,clearLRADist=Infinity;
      let clearSRA=null,clearSRADist=Infinity;
      let blockedGateway=null,blockedGatewayDist=Infinity;
      let blockedLRA=null,blockedLRADist=Infinity;
      let blockedSRA=null,blockedSRADist=Infinity;
      for (const b of nodesRef.current) {
        if (b === a) continue;
        const d = distance(a, b);
        const linkRange = (b.type === "lra") ? 3 : a.range;
        if (d > linkRange) continue;
        const isGateway = b.type === "gateway";
        let hasMeshPath = false;
        if (!isGateway) {
          if (b.type !== "sra" && b.type !== "lra") continue;
          if (a.type === "lra" && b.type === "lra") { hasMeshPath = true; }
          else { const bPath = getPath(b); if(bPath.some(n => n.type === "gateway")) hasMeshPath = true; }
        }
        if (!isGateway && !hasMeshPath) continue;
        const los = await checkLOS(a, b, a.height, b.height);
        const isLRA = b.type === "lra";
        if(isGateway && los.clear && d<clearGatewayDist){clearGateway=b;clearGatewayDist=d;}
        else if(isGateway && !los.clear && d<blockedGatewayDist){blockedGateway=b;blockedGatewayDist=d;}
        else if(isLRA && los.clear && d<clearLRADist){clearLRA=b;clearLRADist=d;}
        else if(isLRA && !los.clear && d<blockedLRADist){blockedLRA=b;blockedLRADist=d;}
        else if(!isGateway && !isLRA && los.clear && d<clearSRADist){clearSRA=b;clearSRADist=d;}
        else if(!isGateway && !isLRA && !los.clear && d<blockedSRADist){blockedSRA=b;blockedSRADist=d;}
      }
      const best = clearGateway||clearLRA||clearSRA||blockedGateway||blockedLRA||blockedSRA||null;
      if (best) linksRef.current[a.name] = best;
    }
    // SECOND PASS - fix blocked links
    for (const a of sortedNodes) {
      if (a.type === "gateway") continue;
      if (a.type === "single") continue;
      const currentLink = linksRef.current[a.name];
      if (currentLink) { const currentLOS = await checkLOS(a, currentLink, a.height, currentLink.height); if (currentLOS.clear) continue; }
      let bestAlt=null,bestAltDist=Infinity;
      for (const b of nodesRef.current) {
        if (b === a) continue;
        if (currentLink && b === currentLink) continue;
        const d = distance(a, b);
        const linkRange = (b.type === "lra") ? 3 : a.range;
        if (d > linkRange) continue;
        const isGateway = b.type === "gateway";
        if (!isGateway) {
          if (b.type !== "sra" && b.type !== "lra") continue;
          const bPath = getPath(b);
          if (!bPath.some(n => n.type === "gateway")) continue;
        }
        const los = await checkLOS(a, b, a.height, b.height);
        if (!los.clear) continue;
        if (d < bestAltDist) { bestAltDist = d; bestAlt = b; }
      }
      if (bestAlt) linksRef.current[a.name] = bestAlt;
    }
  }

  function getPath(start){
    const path=[start]; let current=start;
    const visited = new Set([start.name]);
    for(let i=0;i<20;i++){
      const next = linksRef.current[current.name];
      if(!next) break;
      if(visited.has(next.name)) break;
      visited.add(next.name);
      path.push(next);
      if(next.type==="gateway") break;
      current = next;
    }
    return path;
  }

// ---------- DRAW (v2 — visual polish for new optimizer) ----------
async function draw(){
  const map = mapRef.current;
  if(!map) return;

  // Reset link/visual states
  for (const n of nodesRef.current){
    n.blocked = false;
    n.blockDetail = null;
    n.fresnelWarn = false;
    n.fresnelDetail = null;
    n.fresnelTarget = null;
    n.flagged = false;
  }

  await computeLinks();

  // Mark connectivity
  for (const n of nodesRef.current){
    if (n.type === "gateway" || n.type === "single") {
      n.outOfRange = false;
      continue;
    }
    const path = getPath(n);
    n.outOfRange = !path.some(p => p.type === "gateway");
  }

  // Clear old layers
  const layers = map.getStyle().layers || [];
  layers.forEach(l => {
    if (
      l.id.startsWith("node") ||
      l.id.startsWith("line") ||
      l.id.startsWith("label") ||
      l.id.startsWith("route") ||
      l.id === "all-nodes"
    ) {
      if (map.getLayer(l.id)) map.removeLayer(l.id);
      if (map.getSource(l.id)) map.removeSource(l.id);
    }
  });

  // Node text labels
  const nodeFeatures = [];
  for (let k = 0; k < nodesRef.current.length; k++) {
    const nd = nodesRef.current[k];
    if (nd.elevation === null) {
      nd.elevation = Math.round(await getElevation(nd.lng, nd.lat));
    }
    nodeFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [nd.lng, nd.lat] },
      properties: {
        text: nd.type === "single"
          ? `${nd.name}\nElev ${nd.elevation || '...'}ft`
          : `${nd.name}\n${nd.height}ft AGL | Elev ${nd.elevation || '...'}ft`
      }
    });
  }
  if (map.getLayer("all-nodes")) map.removeLayer("all-nodes");
if (map.getSource("all-nodes")) map.removeSource("all-nodes");
map.addSource("all-nodes", { type: "geojson", data: { type: "FeatureCollection", features: nodeFeatures } });
  map.addLayer({
    id: "all-nodes", type: "symbol", source: "all-nodes",
    layout: {
      "text-field": ["get", "text"],
      "text-size": 13,
      "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"],
      "text-variable-anchor": ["top","bottom","left","right"],
      "text-radial-offset": 1.2,
      "text-justify": "auto",
      "text-allow-overlap": false
    },
    paint: { "text-color": "#00ffff", "text-halo-color": "#000000", "text-halo-width": 2 }
  });

  // Helper to detect flagged height usage
  function isFlaggedHeight(n) {
    if (!n) return false;
    if (n.type === "gateway" && n.height > 25) return true;
    if (n.type === "lra" && n.height > 20) return true;
    if (n.type === "sra" && n.height > 5) return true;
    return false;
  }

  // Draw links
  const drawnLinks = new Set();
  for (let i = 0; i < nodesRef.current.length; i++) {
    const a = nodesRef.current[i];
    if (a.type === "gateway" || a.type === "single") continue;

    const path = getPath(a);
    if (!path || path.length < 2) continue;

    for (let j = 0; j < path.length - 1; j++) {
      const p1 = path[j];
      const p2 = path[j + 1];
      const linkKey = [p1.name, p2.name].sort().join("→");
      if (drawnLinks.has(linkKey)) continue;
      drawnLinks.add(linkKey);

      const los = await checkLOS(p1, p2, p1.height, p2.height);
      const d = distance(p1, p2);
      const signal = calcPower(d);
      const flaggedByHeight = isFlaggedHeight(p1) || isFlaggedHeight(p2);

      if (!los.clear) {
        p1.blocked = true;
        p1.blockDetail = `⛰️ +${Math.ceil(los.requiredHeight)}ft to clear → ${p2.name}`;
      }
      if (flaggedByHeight) {
        p1.flagged = true;
      }

      const lineId = `line-${i}-${j}`;
      map.addSource(lineId, {
        type: "geojson",
        data: { type: "Feature", geometry: { type: "LineString", coordinates: [[p1.lng, p1.lat],[p2.lng, p2.lat]] } }
      });

      // Fresnel %
      let fresnelPct = 100;
      if (los.clear) {
        const totalDistM2 = d * 1609.34;
        const wl = 0.333;
        if (totalDistM2 > 0) {
          const elev1 = await getElevation(p1.lng, p1.lat);
          const elev2 = await getElevation(p2.lng, p2.lat);
          const tip1f = elev1 + p1.height;
          const tip2f = elev2 + p2.height;
          const checkSteps = 20;
          for (let s = 1; s < checkSteps; s++) {
            const t2 = s / checkSteps;
            const d1m = t2 * totalDistM2;
            const d2m = totalDistM2 - d1m;
            const fR = (d1m > 0 && d2m > 0)
              ? Math.sqrt(wl * d1m * d2m / totalDistM2) * 3.281
              : 0;
            if (fR <= 0) continue;
            const lng2 = p1.lng + (p2.lng - p1.lng) * t2;
            const lat2 = p1.lat + (p2.lat - p1.lat) * t2;
            const ev = await getElevation(lng2, lat2);
            const losE = tip1f + (tip2f - tip1f) * t2;
            const cl = losE - ev;
            const pct2 = (cl / fR) * 100;
            if (pct2 < fresnelPct) fresnelPct = pct2;
          }
        }
      }

      // Determine line color
      let lineColor = "red";
      let lineDash = null;

      if (los.clear) {
        if (flaggedByHeight) {
          lineColor = "#a64ca6"; // purple = flagged-but-allowed
        } else {
          const fp = Math.max(0, Math.min(100, fresnelPct));
          const stops = [
            { pct:0,   r:244,g:67, b:54  },
            { pct:20,  r:255,g:152,b:0   },
            { pct:40,  r:255,g:215,b:0   },
            { pct:60,  r:139,g:195,b:74  },
            { pct:80,  r:76, g:175,b:80  },
            { pct:100, r:46, g:125,b:50  }
          ];
          let lower = stops[0], upper = stops[stops.length - 1];
          for (let s = 0; s < stops.length - 1; s++) {
            if (fp >= stops[s].pct && fp <= stops[s + 1].pct) {
              lower = stops[s]; upper = stops[s + 1]; break;
            }
          }
          const range = upper.pct - lower.pct || 1;
          const t = (fp - lower.pct) / range;
          const r = Math.round(lower.r + (upper.r - lower.r) * t);
          const g = Math.round(lower.g + (upper.g - lower.g) * t);
          const b = Math.round(lower.b + (upper.b - lower.b) * t);
          lineColor = `rgb(${r},${g},${b})`;
        }
      } else {
        // Blocked → dashed red
        lineColor = "#ff3333";
        lineDash = [4, 3];
      }

      const fresnelLoss = (los.clear && fresnelPct < 60) ? (60 - Math.max(0, fresnelPct)) / 10 : 0;

      const paint = { "line-color": lineColor, "line-width": 3 };
      if (lineDash) paint["line-dasharray"] = lineDash;
      map.addLayer({ id: lineId, type: "line", source: lineId, paint });

      if (los.clear && fresnelPct < 60) {
        p1.fresnelWarn = true;
        p1.fresnelDetail = `⚠️ Fresnel ${Math.max(0,fresnelPct).toFixed(0)}% clearance → ${p2.name}`;
        p1.fresnelTarget = p2;
      }

      // Click + hover
      const clickP1 = p1, clickP2 = p2;
      map.on("click", lineId, (e) => {
        e.preventDefault();
        e.originalEvent.stopPropagation();
        skipNextClick.current = true;
        generateProfile(clickP1, clickP2);
      });
      map.on("mouseenter", lineId, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", lineId, () => { map.getCanvas().style.cursor = ""; });

      // Label
      const labelId = `label-${i}-${j}`;
      let labelText;
      if (!los.clear) {
        labelText = `${d.toFixed(2)} mi | BLOCKED | +${Math.ceil(los.requiredHeight)} ft`;
      } else if (flaggedByHeight) {
        labelText = `${d.toFixed(2)} mi | FLAGGED | ${(signal - fresnelLoss).toFixed(0)} dBm`;
      } else {
        labelText = `${d.toFixed(2)} mi | ${(signal - fresnelLoss).toFixed(0)} dBm${fresnelLoss > 0 ? ` (F: -${fresnelLoss.toFixed(0)})` : ""}`;
      }

      map.addSource(labelId, {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "Point", coordinates: [(p1.lng + p2.lng) / 2, (p1.lat + p2.lat) / 2] },
          properties: { text: labelText }
        }
      });
      map.addLayer({
        id: labelId, type: "symbol", source: labelId,
        layout: {
          "text-field": ["get", "text"],
          "text-size": 13,
          "text-variable-anchor": ["top","bottom","left","right"],
          "text-radial-offset": 1.2,
          "text-justify": "auto",
          "text-allow-overlap": false
        },
        paint: { "text-color": "#00ffff", "text-halo-color": "#000000", "text-halo-width": 2 }
      });
    }
  }

  // Marker visual states
  for (const n of nodesRef.current) {
  if (!n.markerElement) continue;

  // Base color by type
  let baseColor =
    n.type === "gateway" ? "blue" :
    n.type === "lra"     ? "orange" :
    n.type === "single"  ? "black" :
                           "green";

  // Reset border + shadow every redraw
  n.markerElement.style.border = "none";
  n.markerElement.style.boxShadow = "none";

  if (n.type === "single") {
    n.markerElement.style.background = "black";
  } else if (n.outOfRange) {
    // Disconnected — impossible
    n.markerElement.style.background = "#666";
    n.markerElement.style.border = "2px solid red";
  } else if (n.flagged) {
    // Flagged-but-allowed → device color + pink outline + glow
    n.markerElement.style.background = baseColor;
    n.markerElement.style.border = "2px solid #ff1493";
    n.markerElement.style.boxShadow = "0 0 6px #ff1493";
  } else {
    // Normal connected node
    n.markerElement.style.background = baseColor;
  }
}

  if (showHeatmapRef.current) updateHeatmapData();
  analyzeNetwork();
  setNodeVersion(v => v + 1);
}

  // TERRAIN PROFILE GENERATOR
  async function generateProfile(node, forceTarget){
    let target = forceTarget || linksRef.current[node.name];
    if(!target){ alert("This node has no connection to profile."); return; }
    let leftNode = node, rightNode = target;
    if(node.lng > target.lng){ leftNode = target; rightNode = node; }
    else if(node.lng === target.lng && node.lat < target.lat){ leftNode = target; rightNode = node; }
    node = leftNode; target = rightNode;
    const samples = Math.max(10, Math.round((distance(node, target) * 5280) / 100));
    const points = [];
    const totalDist = distance(node, target);
    for(let i = 0; i <= samples; i++){
      const t = i / samples;
      const lng = node.lng + (target.lng - node.lng) * t;
      const lat = node.lat + (target.lat - node.lat) * t;
      const elev = await getElevation(lng, lat);
      points.push({ dist: totalDist * t, elev, lng, lat });
    }
    setProfileData({ from: node, to: target, points, totalDist, isMeasure: false });
    setProfileFromHeight(node.height); setProfileToHeight(target.height);
    setProfileFromType(node.type); setProfileToType(target.type);
    setShowProfile(true);
  }

  // DRAW TERRAIN PROFILE ON CANVAS
  useEffect(() => {
    if(!showProfile || !profileData || !canvasRef.current) return;
    if(!profileData.points || profileData.points.length < 2 || profileData.totalDist <= 0){
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#1a1a2e"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#00bcd4"; ctx.font = "bold 16px Arial"; ctx.textAlign = "center";
      ctx.fillText(`${profileData.from.name} (${profileData.from.type.toUpperCase()})`, canvas.width/2, canvas.height/2 - 10);
      ctx.fillStyle = "#888"; ctx.font = "12px Arial";
      ctx.fillText("No link connection \u2014 edit node below", canvas.width/2, canvas.height/2 + 15);
      return;
    }
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const points = profileData.points;
    const padElev = 30;
    const minElev = Math.min(...points.map(p => p.elev)) - padElev;
    const maxElev = Math.max(...points.map(p => p.elev)) + padElev + profileData.from.height + profileData.to.height;
    const maxDist = profileData.totalDist;
    const left = 65, right = 25, top = 85, bottom = 40;
    const plotW = W - left - right, plotH = H - top - bottom;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#1a1a2e"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#333"; ctx.lineWidth = 0.5; ctx.fillStyle = "#888"; ctx.font = "11px Arial"; ctx.textAlign = "right";
    const elevStep = 20;
    const startElev = Math.floor(minElev / elevStep) * elevStep;
    for(let e = startElev; e <= maxElev; e += elevStep){
      const y = top + plotH - ((e - minElev) / (maxElev - minElev)) * plotH;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + plotW, y); ctx.stroke();
      ctx.fillText(`${Math.round(e)}ft`, left - 5, y + 4);
    }
    function ptX(i){ return left + (points[i].dist / maxDist) * plotW; }
    function ptY(i){ return top + plotH - ((points[i].elev - minElev) / (maxElev - minElev)) * plotH; }
    ctx.beginPath(); ctx.moveTo(left, top + plotH); ctx.lineTo(ptX(0), ptY(0));
    for(let i = 0; i < points.length - 1; i++){ const cx=(ptX(i)+ptX(i+1))/2,cy=(ptY(i)+ptY(i+1))/2; ctx.quadraticCurveTo(ptX(i),ptY(i),cx,cy); }
    ctx.lineTo(ptX(points.length-1), ptY(points.length-1)); ctx.lineTo(left + plotW, top + plotH); ctx.closePath();
    const terrainGrad = ctx.createLinearGradient(0, top, 0, top + plotH);
    terrainGrad.addColorStop(0, "rgba(139, 119, 81, 0.7)"); terrainGrad.addColorStop(0.4, "rgba(107, 142, 35, 0.6)"); terrainGrad.addColorStop(1, "rgba(34, 85, 34, 0.8)");
    ctx.fillStyle = terrainGrad; ctx.fill();
    ctx.beginPath(); ctx.moveTo(ptX(0), ptY(0));
    for(let i = 0; i < points.length - 1; i++){ const cx=(ptX(i)+ptX(i+1))/2,cy=(ptY(i)+ptY(i+1))/2; ctx.quadraticCurveTo(ptX(i),ptY(i),cx,cy); }
    ctx.lineTo(ptX(points.length-1), ptY(points.length-1)); ctx.strokeStyle = "#8B7751"; ctx.lineWidth = 2; ctx.stroke();
    const fromElev = points[0].elev + profileFromHeight;
    const toElev = points[points.length - 1].elev + profileToHeight;
    const fromGroundY = top + plotH - ((points[0].elev - minElev) / (maxElev - minElev)) * plotH;
    const toGroundY = top + plotH - ((points[points.length-1].elev - minElev) / (maxElev - minElev)) * plotH;
    const fromTipY = top + plotH - ((fromElev - minElev) / (maxElev - minElev)) * plotH;
    const toTipY = top + plotH - ((toElev - minElev) / (maxElev - minElev)) * plotH;
    ctx.beginPath(); ctx.moveTo(left, fromGroundY); ctx.lineTo(left, fromTipY); ctx.strokeStyle = "#00bcd4"; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(left + plotW, toGroundY); ctx.lineTo(left + plotW, toTipY); ctx.strokeStyle = "#00bcd4"; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(left, fromTipY); ctx.lineTo(left + plotW, toTipY); ctx.strokeStyle = "#ff5555"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);

    // --- FRESNEL ZONE ---
    const wavelengthM = 0.333;
    const totalDistM = profileData.totalDist * 1609.34;
    if(totalDistM > 0){
      ctx.beginPath();
      for(let i = 0; i < points.length; i++){
        const t = i / (points.length - 1);
        const d1m = t * totalDistM;
        const d2m = totalDistM - d1m;
        const fresnelR = (d1m > 0 && d2m > 0) ? Math.sqrt(wavelengthM * d1m * d2m / totalDistM) * 3.281 : 0;
        const losElev = fromElev + (toElev - fromElev) * t;
        const upperElev = losElev + fresnelR;
        const x = left + (points[i].dist / maxDist) * plotW;
        const y = top + plotH - ((upperElev - minElev) / (maxElev - minElev)) * plotH;
        if(i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      for(let i = points.length - 1; i >= 0; i--){
        const t = i / (points.length - 1);
        const d1m = t * totalDistM;
        const d2m = totalDistM - d1m;
        const fresnelR = (d1m > 0 && d2m > 0) ? Math.sqrt(wavelengthM * d1m * d2m / totalDistM) * 3.281 : 0;
        const losElev = fromElev + (toElev - fromElev) * t;
        const lowerElev = losElev - fresnelR;
        const x = left + (points[i].dist / maxDist) * plotW;
        const y = top + plotH - ((lowerElev - minElev) / (maxElev - minElev)) * plotH;
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(255, 165, 0, 0.15)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 165, 0, 0.4)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Fresnel clearance check
    let fresnelClear = true;
    let worstFresnelPct = 100;
    if(totalDistM > 0){
      for(let i = 1; i < points.length - 1; i++){
        const t = i / (points.length - 1);
        const d1m = t * totalDistM;
        const d2m = totalDistM - d1m;
        const fresnelR = Math.sqrt(wavelengthM * d1m * d2m / totalDistM) * 3.281;
        if(fresnelR <= 0) continue;
        const losElev2 = fromElev + (toElev - fromElev) * t;
        const clearance = losElev2 - points[i].elev;
        const pct = (clearance / fresnelR) * 100;
        if(pct < worstFresnelPct) worstFresnelPct = pct;
        if(clearance < fresnelR * 0.6) fresnelClear = false;
      }
    }
    let blocked = false;
    for(let i = 0; i < points.length; i++){
      const t = i / (points.length - 1);
      const losAtPoint = fromElev + (toElev - fromElev) * t;
      if(points[i].elev > losAtPoint){
        blocked = true;
        const x = left + (points[i].dist / maxDist) * plotW;
        const y = top + plotH - ((points[i].elev - minElev) / (maxElev - minElev)) * plotH;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = "red"; ctx.fill();
      }
    }
    ctx.fillStyle = "#00bcd4"; ctx.font = "bold 12px Arial";
    ctx.textAlign = "left"; ctx.fillText(`${profileData.from.name} (${profileFromType.toUpperCase()}) ${profileFromHeight}ft`, left + 5, top + 15);
    ctx.textAlign = "right"; ctx.fillText(`${profileData.to.name} (${profileToType.toUpperCase()}) ${profileToHeight}ft`, left + plotW - 5, top + 15);
    ctx.fillStyle = "#00bcd4"; ctx.font = "bold 12px Arial"; ctx.textAlign = "center";
    for(let i = 0; i <= 5; i++){
      const d = (maxDist / 5) * i;
      const x = left + (d / maxDist) * plotW;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(x - 22, top + plotH + 8, 44, 16);
      ctx.fillStyle = "#00bcd4"; ctx.font = "bold 12px Arial"; ctx.textAlign = "center";
      ctx.fillText(`${d.toFixed(2)}mi`, x, top + plotH + 21);
    }
    const signal = calcPower(maxDist);
    const profileFresnelLoss = (!blocked && worstFresnelPct < 60) ? (60 - Math.max(0, worstFresnelPct)) / 10 : 0;
    const adjSignal = signal - profileFresnelLoss;
    const statusText = blocked ? "\u26F0\uFE0F LOS BLOCKED" : `\u2705 LOS Clear | ${adjSignal.toFixed(0)} dBm${profileFresnelLoss > 0 ? ` (Fresnel: -${profileFresnelLoss.toFixed(1)} dB)` : ""}`;
    ctx.fillText(`${profileData.totalDist.toFixed(2)} mi | ${statusText}`, W / 2, H - 5);
    if(blocked){
      if(profileData.isMeasure){
        let minLeftH = profileFromHeight;
        for(let testH = 0; testH <= 200; testH++){ let clear=true; const t1=points[0].elev+testH,t2=points[points.length-1].elev+profileToHeight;
          for(let i=1;i<points.length-1;i++){const t=i/(points.length-1);if(points[i].elev>t1+(t2-t1)*t){clear=false;break;}} if(clear){minLeftH=testH;break;} }
        let minRightH = profileToHeight;
        for(let testH = 0; testH <= 200; testH++){ let clear=true; const t1=points[0].elev+profileFromHeight,t2=points[points.length-1].elev+testH;
          for(let i=1;i<points.length-1;i++){const t=i/(points.length-1);if(points[i].elev>t1+(t2-t1)*t){clear=false;break;}} if(clear){minRightH=testH;break;} }
        ctx.fillStyle="#ff5555";ctx.font="bold 14px Arial";ctx.textAlign="center";ctx.fillText(`\u26A0\uFE0F LOS BLOCKED`,W/2,top+55);
        ctx.fillStyle="#ffaa00";ctx.font="bold 12px Arial";
        ctx.textAlign="left";ctx.fillText(`\u2B06\uFE0F Needs ${minLeftH}ft to clear`,left+5,top+70);
        ctx.textAlign="right";ctx.fillText(`\u2B06\uFE0F Needs ${minRightH}ft to clear`,left+plotW-5,top+70);
      } else {
        let maxBlock2=0; for(let i=0;i<points.length;i++){const t=i/(points.length-1);const diff=points[i].elev-(fromElev+(toElev-fromElev)*t);if(diff>maxBlock2)maxBlock2=diff;}
        ctx.fillStyle="#ff5555";ctx.font="bold 16px Arial";ctx.textAlign="center";
        ctx.fillText(`\u26A0\uFE0F Increase height by ~${Math.ceil(maxBlock2+5)}ft to clear obstruction`,W/2,top+65);
      }
    } else {
      ctx.fillStyle="#4CAF50";ctx.font="bold 16px Arial";ctx.textAlign="center";
      ctx.fillText(`\u2705 Clear LOS \u2014 no height change needed`,W/2,top+30);
      if(fresnelClear){
        ctx.fillStyle="#4CAF50";ctx.font="bold 12px Arial";ctx.textAlign="center";
        ctx.fillText(`\uD83D\uDFE2 Fresnel Zone: ${Math.max(0,worstFresnelPct).toFixed(0)}% clearance \u2014 Reliable link`,W/2,top+48);
      } else {
        ctx.fillStyle="#ffaa00";ctx.font="bold 12px Arial";ctx.textAlign="center";
        ctx.fillText(`\u26A0\uFE0F Fresnel Zone: ${Math.max(0,worstFresnelPct).toFixed(0)}% clearance \u2014 Increase height for reliable link`,W/2,top+48);
      }
    }
    // --- FRESNEL REFERENCE CHART ---
    const chartTop = 12;
    const chartLeft = left;
    const barH = 10;
    const barW = plotW;
    const gradStops = [
      { pct: 0, r: 244, g: 67, b: 54 },
      { pct: 20, r: 255, g: 152, b: 0 },
      { pct: 40, r: 255, g: 215, b: 0 },
      { pct: 60, r: 139, g: 195, b: 74 },
      { pct: 80, r: 76, g: 175, b: 80 },
      { pct: 100, r: 46, g: 125, b: 50 }
    ];
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(chartLeft - 5, chartTop - 14, barW + 10, 55);
    ctx.fillStyle = "#aaa"; ctx.font = "bold 10px Arial"; ctx.textAlign = "left";
    ctx.fillText("FRESNEL CLEARANCE", chartLeft, chartTop - 4);
    const barGrad = ctx.createLinearGradient(chartLeft + barW, chartTop, chartLeft, chartTop);
    gradStops.forEach(s => {
      barGrad.addColorStop(s.pct / 100, `rgb(${s.r},${s.g},${s.b})`);
    });
    ctx.fillStyle = barGrad;
    ctx.fillRect(chartLeft, chartTop, barW, barH);
    const labels = [
      { pct: 10, text: "Unreliable" },
      { pct: 30, text: "Poor" },
      { pct: 50, text: "Marginal" },
      { pct: 70, text: "Good" },
      { pct: 90, text: "Excellent" }
    ];
    labels.forEach(lb => {
      const x = chartLeft + ((100 - lb.pct) / 100) * barW;
      ctx.fillStyle = "#ccc"; ctx.font = "9px Arial"; ctx.textAlign = "center";
      ctx.fillText(lb.text, x, chartTop + barH + 10);
    });
    [0, 20, 40, 60, 80, 100].forEach(p => {
      const x = chartLeft + ((100 - p) / 100) * barW;
      ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, chartTop); ctx.lineTo(x, chartTop + barH); ctx.stroke();
      ctx.fillStyle = "#888"; ctx.font = "8px Arial"; ctx.textAlign = "center";
      ctx.fillText(`${p}%`, x, chartTop + barH + 20);
    });
    if(totalDistM > 0 && !blocked){
      const markerX = chartLeft + ((100 - Math.max(0, Math.min(100, worstFresnelPct))) / 100) * barW;
      ctx.beginPath();
      ctx.moveTo(markerX, chartTop - 2);
      ctx.lineTo(markerX - 5, chartTop - 10);
      ctx.lineTo(markerX + 5, chartTop - 10);
      ctx.closePath();
      ctx.fillStyle = "#00ffff"; ctx.fill();
      ctx.fillStyle = "#00ffff"; ctx.font = "bold 10px Arial"; ctx.textAlign = "center";
      ctx.fillText(`\u25BC ${Math.max(0, worstFresnelPct).toFixed(0)}%`, markerX, chartTop - 12);
    }
  }, [showProfile, profileData, profileFromHeight, profileToHeight, profileFromType, profileToType]);

  function saveSnapshot(){
    const snap = nodesRef.current.map(n => ({ name:n.name,type:n.type,lat:n.lat,lng:n.lng,height:n.height,range:n.range }));
    undoStack.current.push(JSON.stringify(snap)); redoStack.current = [];
    if(undoStack.current.length > 50) undoStack.current.shift();
  }
  
async function restoreModeSnapshot(mode) {
  const snap = modeSnapshots.current[mode];
  if (!snap || snap.length === 0) return false;

  const map = mapRef.current;
  // Remove existing markers
  nodesRef.current.forEach(n => { if (n.marker) n.marker.remove(); });
  nodesRef.current = [];

  // Rebuild nodes from snapshot
  for (const n of snap) {
    addNode(map, n.lng, n.lat, n.type, n.name, true, n.height);
    const created = nodesRef.current[nodesRef.current.length - 1];
    if (n.modbusId) created.modbusId = n.modbusId;
    created.flagged    = !!n.flagged;
    created.outOfRange = !!n.outOfRange;
  }

  redraw();
  return true;
}
  function undo(){
    if(undoStack.current.length===0) return;
    const cs=nodesRef.current.map(n=>({name:n.name,type:n.type,lat:n.lat,lng:n.lng,height:n.height,range:n.range}));
    redoStack.current.push(JSON.stringify(cs));
    const prev=JSON.parse(undoStack.current.pop()); const map=mapRef.current;
    nodesRef.current.forEach(n=>{if(n.marker)n.marker.remove();}); nodesRef.current=[];
    prev.forEach(n=>{addNode(map,n.lng,n.lat,n.type,n.name,true,n.height);}); redraw();
  }
  function redo(){
    if(redoStack.current.length===0) return;
    const cs=nodesRef.current.map(n=>({name:n.name,type:n.type,lat:n.lat,lng:n.lng,height:n.height,range:n.range}));
    undoStack.current.push(JSON.stringify(cs));
    const next=JSON.parse(redoStack.current.pop()); const map=mapRef.current;
    nodesRef.current.forEach(n=>{if(n.marker)n.marker.remove();}); nodesRef.current=[];
    next.forEach(n=>{addNode(map,n.lng,n.lat,n.type,n.name,true,n.height);}); redraw();
  }
  function handleMeasureClick(lng,lat){
    const map=mapRef.current;
    const el=document.createElement("div"); el.style.width="10px"; el.style.height="10px"; el.style.borderRadius="50%"; el.style.background="red"; el.style.border="2px solid white";
    const marker=new mapboxgl.Marker({element:el}).setLngLat([lng,lat]).addTo(map);
    measureMarkersRef.current.push(marker); measurePoints.current.push({lng,lat});
    if(measurePoints.current.length===2){
      const p1=measurePoints.current[0],p2=measurePoints.current[1]; const d=distance(p1,p2);
      if(map.getLayer("measure-line"))map.removeLayer("measure-line"); if(map.getSource("measure-line"))map.removeSource("measure-line");
      map.addSource("measure-line",{type:"geojson",data:{type:"Feature",geometry:{type:"LineString",coordinates:[[p1.lng,p1.lat],[p2.lng,p2.lat]]}}});
      map.addLayer({id:"measure-line",type:"line",source:"measure-line",paint:{"line-color":"#ff00ff","line-width":3,"line-dasharray":[4,3]}});
      if(map.getLayer("measure-label"))map.removeLayer("measure-label"); if(map.getSource("measure-label"))map.removeSource("measure-label");
      map.addSource("measure-label",{type:"geojson",data:{type:"Feature",geometry:{type:"Point",coordinates:[(p1.lng+p2.lng)/2,(p1.lat+p2.lat)/2]},properties:{text:`\uD83D\uDCCF ${d.toFixed(2)} mi (${(d*5280).toFixed(0)} ft)`}}});
      map.addLayer({id:"measure-label",type:"symbol",source:"measure-label",layout:{"text-field":["get","text"],"text-size":16,"text-offset":[0,-1.5],"text-anchor":"bottom","text-allow-overlap":true},paint:{"text-color":"#ff00ff","text-halo-color":"#000000","text-halo-width":2}});
      // Point A label
      if(map.getLayer("measure-label-a"))map.removeLayer("measure-label-a"); if(map.getSource("measure-label-a"))map.removeSource("measure-label-a");
      map.addSource("measure-label-a",{type:"geojson",data:{type:"Feature",geometry:{type:"Point",coordinates:[p1.lng,p1.lat]},properties:{text:"Point A"}}});
      map.addLayer({id:"measure-label-a",type:"symbol",source:"measure-label-a",layout:{"text-field":["get","text"],"text-size":14,"text-font":["DIN Pro Bold","Arial Unicode MS Bold"],"text-offset":[0,-1.2],"text-anchor":"bottom","text-allow-overlap":true},paint:{"text-color":"#ff00ff","text-halo-color":"#000000","text-halo-width":2}});
      // Point B label
      if(map.getLayer("measure-label-b"))map.removeLayer("measure-label-b"); if(map.getSource("measure-label-b"))map.removeSource("measure-label-b");
      map.addSource("measure-label-b",{type:"geojson",data:{type:"Feature",geometry:{type:"Point",coordinates:[p2.lng,p2.lat]},properties:{text:"Point B"}}});
      map.addLayer({id:"measure-label-b",type:"symbol",source:"measure-label-b",layout:{"text-field":["get","text"],"text-size":14,"text-font":["DIN Pro Bold","Arial Unicode MS Bold"],"text-offset":[0,-1.2],"text-anchor":"bottom","text-allow-overlap":true},paint:{"text-color":"#ff00ff","text-halo-color":"#000000","text-halo-width":2}});
    }
  }
  function clearMeasure(){
    const map=mapRef.current; measurePoints.current=[]; measureMarkersRef.current.forEach(m=>m.remove()); measureMarkersRef.current=[];
    if(map){
      if(map.getLayer("measure-line"))map.removeLayer("measure-line"); if(map.getSource("measure-line"))map.removeSource("measure-line");
      if(map.getLayer("measure-label"))map.removeLayer("measure-label"); if(map.getSource("measure-label"))map.removeSource("measure-label");
      if(map.getLayer("measure-label-a"))map.removeLayer("measure-label-a"); if(map.getSource("measure-label-a"))map.removeSource("measure-label-a");
      if(map.getLayer("measure-label-b"))map.removeLayer("measure-label-b"); if(map.getSource("measure-label-b"))map.removeSource("measure-label-b");
    }
  }
  async function generateMeasureProfile(p1,p2){
    let leftPt=p1,rightPt=p2;
    if(p1.lng>p2.lng){leftPt=p2;rightPt=p1;}else if(p1.lng===p2.lng&&p1.lat<p2.lat){leftPt=p2;rightPt=p1;}
    const totalDist=distance(leftPt,rightPt); const samples=Math.max(10,Math.round((totalDist*5280)/100)); const points=[];
    for(let i=0;i<=samples;i++){const t=i/samples;const lng=leftPt.lng+(rightPt.lng-leftPt.lng)*t;const lat=leftPt.lat+(rightPt.lat-leftPt.lat)*t;const elev=await getElevation(lng,lat);points.push({dist:totalDist*t,elev,lng,lat});}
    const fakeFrom={name:"Point A",type:"sra",height:5,range:0.75,lng:leftPt.lng,lat:leftPt.lat,markerElement:null};
    const fakeTo={name:"Point B",type:"sra",height:5,range:0.75,lng:rightPt.lng,lat:rightPt.lat,markerElement:null};
    setProfileData({from:fakeFrom,to:fakeTo,points,totalDist,isMeasure:true});
    setProfileFromHeight(5);setProfileToHeight(5);setProfileFromType("sra");setProfileToType("sra");setShowProfile(true);
  }
    
  
  function redraw(){ setNodeVersion(v=>v+1); draw(); }

  // ========== FCC TOWER OVERLAY ==========
  function createTriangleImage(size, fillColors, outlineColor) {
    const canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext("2d");
    const topX = size/2, topY = 2, botLeftX = 3, botLeftY = size-2, botRightX = size-3, botRightY = size-2;
    if (Array.isArray(fillColors) && fillColors.length > 1) {
      ctx.save(); ctx.beginPath(); ctx.moveTo(topX,topY); ctx.lineTo(botRightX,botRightY); ctx.lineTo(botLeftX,botLeftY); ctx.closePath(); ctx.clip();
      const stripeW = size / fillColors.length;
      fillColors.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(i * stripeW, 0, stripeW, size); });
      ctx.restore();
    } else {
      const fill = Array.isArray(fillColors) ? fillColors[0] : fillColors;
      ctx.beginPath(); ctx.moveTo(topX,topY); ctx.lineTo(botRightX,botRightY); ctx.lineTo(botLeftX,botLeftY); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
    }
    if (outlineColor) {
      ctx.beginPath(); ctx.moveTo(topX,topY); ctx.lineTo(botRightX,botRightY); ctx.lineTo(botLeftX,botLeftY); ctx.closePath();
      ctx.strokeStyle = outlineColor; ctx.lineWidth = 2; ctx.stroke();
    }
    return { width: size, height: size, data: ctx.getImageData(0, 0, size, size).data };
  }

  async function loadFCCData() {
    const map = mapRef.current;
    if (!map) return;
    try {
      const res = await fetch("/fcc_towers.json");
      const data = await res.json();
      const sz = 28;
      map.addImage("fcc-tri-att", createTriangleImage(sz, "#0057B8", null));
      map.addImage("fcc-tri-verizon", createTriangleImage(sz, "#FF0000", null));
      map.addImage("fcc-tri-tmobile", createTriangleImage(sz, "#E20074", null));
      map.addImage("fcc-tri-independent", createTriangleImage(sz, "#FFD700", null));
      map.addImage("fcc-tri-black", createTriangleImage(sz, "#000000", "#333333"));

      const geojson = {
        type: "FeatureCollection",
        features: data.map(t => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [t.lng, t.lat] },
          properties: {
            height: t.height || 0,
            towerType: t.type || "unknown",
            carriers: t.carrier || "unknown",
            carrierCount: 1,
            owner: t.owner || "Unknown",
            fccId: t.fccId || "",
            big3: t.big3 || "none",
            carrierTag: t.carrier || "unknown"
          }
        }))
      };
      map.addSource("fcc-towers", { type: "geojson", data: geojson, cluster: true, clusterMaxZoom: 13, clusterRadius: 50 });
      map.addLayer({ id: "fcc-clusters", type: "circle", source: "fcc-towers", filter: ["has", "point_count"],
        paint: { "circle-color": ["step",["get","point_count"],"#51bbd6",25,"#f1f075",100,"#f28cb1"],
          "circle-radius": ["step",["get","point_count"],14,25,18,100,22],
          "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" }
      });
      map.addLayer({ id: "fcc-cluster-count", type: "symbol", source: "fcc-towers", filter: ["has", "point_count"],
        layout: { "text-field": "{point_count_abbreviated}", "text-size": 11, "text-allow-overlap": true },
        paint: { "text-color": "#000000" }
      });
      map.addLayer({ id: "fcc-towers-unclustered", type: "symbol", source: "fcc-towers", filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": [
            "case",
            ["==", ["get", "carrierTag"], "att"], "fcc-tri-att",
            ["==", ["get", "carrierTag"], "verizon"], "fcc-tri-verizon",
            ["==", ["get", "carrierTag"], "tmobile"], "fcc-tri-tmobile",
            ["==", ["get", "towerType"], "non_cellular"], "fcc-tri-black",
            ["==", ["get", "towerType"], "tower_company"], "fcc-tri-black",
            ["==", ["get", "towerType"], "unknown"], "fcc-tri-black",
            ["==", ["get", "carrierTag"], "other_cellular"], "fcc-tri-black",
            ["==", ["get", "carrierTag"], "unknown"], "fcc-tri-black",
            ["==", ["get", "big3"], "att"], "fcc-tri-att",
            ["==", ["get", "big3"], "verizon"], "fcc-tri-verizon",
            ["==", ["get", "big3"], "tmobile"], "fcc-tri-tmobile",
            ["==", ["get", "big3"], "independent"], "fcc-tri-independent",
            "fcc-tri-black"
          ],
          "icon-size": 0.9, "icon-allow-overlap": true, "icon-anchor": "bottom"
        }
      });
      map.addLayer({ id: "fcc-towers-labels", type: "symbol", source: "fcc-towers",
        filter: ["!", ["has", "point_count"]], minzoom: 11,
        layout: { "text-field": ["concat", ["to-string", ["get", "height"]], "ft"],
          "text-size": 13, "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"],
          "text-offset": [0, 0.5], "text-anchor": "top", "text-allow-overlap": false },
        paint: { "text-color": "#00ffff", "text-halo-color": "#000000", "text-halo-width": 2 }
      });
      map.on("click", "fcc-clusters", (e) => {
        e.originalEvent.stopPropagation(); skipNextClick.current = true;
        const features = map.queryRenderedFeatures(e.point, { layers: ["fcc-clusters"] });
        const clusterId = features[0].properties.cluster_id;
        map.getSource("fcc-towers").getClusterExpansionZoom(clusterId, (err, zoom) => { if (err) return; map.easeTo({ center: features[0].geometry.coordinates, zoom }); });
      });
      map.on("click", "fcc-towers-unclustered", (e) => {
        e.originalEvent.stopPropagation(); skipNextClick.current = true;
        const props = e.features[0].properties;
        const coords = e.features[0].geometry.coordinates.slice();
        const big3Val = props.big3, carrierTag = props.carrierTag;
        let affiliationLabel = "";
        if (carrierTag==="att"||carrierTag==="verizon"||carrierTag==="tmobile") {
          affiliationLabel = carrierTag==="att"?"AT&T":carrierTag==="verizon"?"Verizon":"T-Mobile";
        } else if (big3Val==="att") { affiliationLabel = "AT&T (via " + props.carriers + ")"; }
        else if (big3Val==="verizon") { affiliationLabel = "Verizon (via " + props.carriers + ")"; }
        else if (big3Val==="tmobile") { affiliationLabel = "T-Mobile (via " + props.carriers + ")"; }
        else if (big3Val==="independent") { affiliationLabel = "Independent: " + props.carriers; }
        else if (props.towerType==="tower_company") { affiliationLabel = "Tower Company"; }
        else if (props.towerType==="non_cellular") { affiliationLabel = "Non-Cellular"; }
        else { affiliationLabel = props.carriers; }
        const dotColor = carrierTag==="att"?"#0057B8":carrierTag==="verizon"?"#FF0000":carrierTag==="tmobile"?"#E20074":
          big3Val==="att"?"#0057B8":big3Val==="verizon"?"#FF0000":big3Val==="tmobile"?"#E20074":big3Val==="independent"?"#FFD700":"#666";
        if (fccPopupRef.current) fccPopupRef.current.remove();
        fccPopupRef.current = new mapboxgl.Popup({ offset: 15 }).setLngLat(coords).setHTML(
          `<div style="font-size:12px;max-width:280px"><strong>\uD83D\uDDFC ${props.height}ft</strong><br><b>Network:</b> <span style="color:${dotColor};font-weight:bold">\u2B24 ${affiliationLabel}</span><br><b>Owner:</b> ${props.owner}<br><b>Type:</b> ${props.towerType}<br><b>FCC ID:</b> ${props.fccId}</div>`
        ).addTo(map);
      });
      map.on("mouseenter","fcc-clusters",()=>{map.getCanvas().style.cursor="pointer";});
      map.on("mouseleave","fcc-clusters",()=>{map.getCanvas().style.cursor="";});
      map.on("mouseenter","fcc-towers-unclustered",()=>{map.getCanvas().style.cursor="pointer";});
      map.on("mouseleave","fcc-towers-unclustered",()=>{map.getCanvas().style.cursor="";});
      fccLoaded.current = true;
    } catch (err) {
      console.error("Failed to load FCC tower data:", err);
      alert("Failed to load FCC tower data. Check that fcc_towers.json is in the public folder.");
      setFccLoading(false);
    }
  }

  async function updateHeatmapData(){
    const map = mapRef.current; if(!map) return;
    const features = [];
    const connected = nodesRef.current.filter(n => n.type !== "single" && !n.outOfRange);
    for(const n of connected){
      const rangeMi = (n.type === "gateway" || n.type === "lra") ? 3 : 0.75;
      const dirs = (n.type === "gateway" || n.type === "lra") ? 16 : 8;
      const steps = 5;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [n.lng, n.lat] },
        properties: { weight: n.type === "gateway" ? 1.0 : n.type === "lra" ? 0.8 : 0.5 }
      });
      for(let dir = 0; dir < dirs; dir++){
        const angle = (dir / dirs) * 2 * Math.PI;
        for(let s = 1; s <= steps; s++){
          const dist = (s / steps) * rangeMi;
          const dlat = (dist / 69) * Math.cos(angle);
          const dlng = (dist / (69 * Math.cos(n.lat * Math.PI / 180))) * Math.sin(angle);
          const sLat = n.lat + dlat;
          const sLng = n.lng + dlng;
          const elev1 = await getElevation(n.lng, n.lat);
          const elev2 = await getElevation(sLng, sLat);
          const tip1 = elev1 + n.height;
          const tip2 = elev2 + 5;
          const midLng = (n.lng + sLng) / 2;
          const midLat = (n.lat + sLat) / 2;
          const midElev = await getElevation(midLng, midLat);
          const midLOS = (tip1 + tip2) / 2;
          if(midElev > midLOS) break;
          const w = (1 - (s / steps)) * (n.type === "gateway" ? 0.8 : n.type === "lra" ? 0.6 : 0.4);
          features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [sLng, sLat] },
            properties: { weight: Math.max(0.05, w) }
          });
        }
      }
    }
    const data = { type: "FeatureCollection", features };
    if(map.getSource("signal-heatmap")){
      map.getSource("signal-heatmap").setData(data);
    }
  }

  async function toggleHeatmap(){
    const map = mapRef.current; if(!map) return;
    if(!showHeatmap){
      if(!heatmapLoaded.current){
        const features = [{type:"Feature",geometry:{type:"Point",coordinates:[0,0]},properties:{weight:0}}];
        map.addSource("signal-heatmap", {
          type: "geojson",
          data: { type: "FeatureCollection", features }
        });
        map.addLayer({
          id: "signal-heatmap-layer",
          type: "heatmap",
          source: "signal-heatmap",
          paint: {
            "heatmap-weight": ["get", "weight"],
            "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 15, 2],
            "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 8, 20, 10, 40, 12, 80, 14, 140, 16, 220],
            "heatmap-color": [
              "interpolate", ["linear"], ["heatmap-density"],
              0, "rgba(0,0,0,0)",
              0.1, "rgba(255,0,0,0.3)",
              0.3, "rgba(255,128,0,0.4)",
              0.5, "rgba(255,255,0,0.45)",
              0.7, "rgba(0,255,255,0.5)",
              0.9, "rgba(0,200,0,0.6)",
              1.0, "rgba(0,128,0,0.7)"
            ],
            "heatmap-opacity": 0.6
          }
        }, "all-nodes");
        heatmapLoaded.current = true;
      } else {
        if(map.getLayer("signal-heatmap-layer")) map.setLayoutProperty("signal-heatmap-layer", "visibility", "visible");
      }
      await updateHeatmapData();
      setShowHeatmap(true);
    } else {
      if(map.getLayer("signal-heatmap-layer")) map.setLayoutProperty("signal-heatmap-layer", "visibility", "none");
      setShowHeatmap(false);
    }
  }

  async function toggleFCCTowers() {
    const map = mapRef.current; if (!map) return;
    if (!showFCCTowers) {
      if (!fccLoaded.current) { setFccLoading(true); await loadFCCData(); setFccLoading(false); }
      else { ["fcc-clusters","fcc-cluster-count","fcc-towers-unclustered","fcc-towers-labels"].forEach(id => { if(map.getLayer(id)) map.setLayoutProperty(id,"visibility","visible"); }); }
      setShowFCCTowers(true);
    } else {
      ["fcc-clusters","fcc-cluster-count","fcc-towers-unclustered","fcc-towers-labels"].forEach(id => { if(map.getLayer(id)) map.setLayoutProperty(id,"visibility","none"); });
      if (fccPopupRef.current) fccPopupRef.current.remove();
      setShowFCCTowers(false);
    }
  }

  // SAVE NETWORK - uses project name as default
 function saveNetwork(){
  const currentProject = projects.find(p => p.id === activeProjectId);
  setTextPrompt({
    title: "Name this network",
    defaultValue: currentProject?.name || "rf-network",
    onConfirm: (fileName) => {
      if (!fileName) return;
      const saveData = {
        nodes: nodesRef.current.map(n => ({
          name: n.name, type: n.type, lat: n.lat, lng: n.lng,
          height: n.height, range: n.range, modbusId: n.modbusId || null
        })),
        fccTowersVisible: showFCCTowers
      };
      const blob = new Blob([JSON.stringify(saveData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName + ".json";
      a.click();
      URL.revokeObjectURL(url);
    }
  });
}
  // =====================================================
// INSTALL REPORT - PDF VERSION (Step C2)
// Installer-ready PDF report.
// Includes map snapshot, BOM, recommendations, routes.
// =====================================================
async function exportInstallReportPDF(){
  if (!nodesRef.current.length) {
    alert("Add some nodes first, then export the PDF report.");
    return;
  }

  // Load jsPDF + autoTable plugin
  const jsPDFModule = await import("jspdf");
const jsPDF = jsPDFModule.jsPDF;
const autoTableModule = await import("jspdf-autotable");
const autoTable = autoTableModule.default;

  const currentProject = projects.find(p => p.id === activeProjectId);
  const projectName = currentProject?.name || "rf-network";
  // ---------- Helper: strip emojis (jsPDF Helvetica doesn't support them) ----------
// ---------- Helper: PDF-safe text (replace emojis with labels) ----------
function stripEmojis(text) {
  if (!text) return "";
  let t = String(text);

  // Replace meaningful emojis with text tags so messages stay readable
  const replacements = [
    { re: /⚠️|⚠/g,  with: "[WARN] " },
    { re: /⛰️|⛰/g,  with: "[TERRAIN] " },
    { re: /📡/g,    with: "[SIGNAL] " },
    { re: /🔗/g,    with: "[LINK] " },
    { re: /⬆️|⬆/g,  with: "[PROMOTE] " },
    { re: /🟪/g,    with: "[FLAGGED] " },
    { re: /⚫/g,    with: "[SINGLE] " },
    { re: /✅/g,    with: "[OK] " },
    { re: /🟢/g,    with: "[HEALTHY] " },
    { re: /🔵/g,    with: "[GATEWAY] " },
    { re: /🟠/g,    with: "[LRA] " },
    { re: /🟢/g,    with: "[SRA] " },
    { re: /🧠/g,    with: "" },
    { re: /📄/g,    with: "" },
    { re: /🧾/g,    with: "" },
    { re: /📊/g,    with: "" },
    { re: /📁/g,    with: "" },
    { re: /💾/g,    with: "" },
    { re: /📂/g,    with: "" },
    { re: /📦/g,    with: "" },
    { re: /📍/g,    with: "" },
    { re: /📏/g,    with: "" },
    { re: /🛰️|🛰/g, with: "[NETWORK] " },
    { re: /🗺️|🗺/g, with: "" },
  ];

  for (const r of replacements) {
    t = t.replace(r.re, r.with);
  }

  // Strip any remaining emojis (broad ranges)
  t = t
    .replace(/[\u{1F600}-\u{1F64F}]/gu, "")
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, "")
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, "")
    .replace(/[\u{1F700}-\u{1F77F}]/gu, "")
    .replace(/[\u{1F780}-\u{1F7FF}]/gu, "")
    .replace(/[\u{1F800}-\u{1F8FF}]/gu, "")
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, "")
    .replace(/[\u{1FA00}-\u{1FA6F}]/gu, "")
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, "")
    .replace(/[\u{2600}-\u{26FF}]/gu, "")
    .replace(/[\u{2700}-\u{27BF}]/gu, "")
    .replace(/[\u{2300}-\u{23FF}]/gu, "")
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "")
    .replace(/[\u{FE00}-\u{FE0F}]/gu, "")
    .replace(/[\u{200D}]/gu, "")
    // Replace non-Latin special arrows with a safe arrow
    .replace(/→/g, "->");

  return t.replace(/\s+/g, " ").trim();
}

  // ---------- Helpers (matched to Excel report) ----------
  function poleHeightFor(n) {
    if (n.type === "single") return 0;
    if (n.type === "gateway") return Math.max(15, n.height);
    if (n.type === "lra")     return Math.max(10, n.height);
    if (n.type === "sra")     return Math.max(5,  n.height);
    return n.height || 0;
  }
  function poleSticksFor(n) {
    if (n.type !== "gateway" && n.type !== "lra") return 0;
    const h = poleHeightFor(n);
    if (h <= 0) return 0;
    return Math.ceil(h / 10);
  }
  function poleMaterialFor(n) {
    if (n.type === "gateway") return '3/4" Rigid Conduit';
    if (n.type === "lra")     return '1.25" EMT';
    return "";
  }
  function statusFor(n) {
    if (n.type === "single") return "Single Modem";
    if (n.outOfRange) return "DISCONNECTED";
    if (n.flagged)    return "FLAGGED";
    if (n.blocked)    return "BLOCKED";
    return "OK";
  }

  // ---------- Counts ----------
  const gateways = nodesRef.current.filter(n => n.type === "gateway").length;
  const lras     = nodesRef.current.filter(n => n.type === "lra").length;
  const sras     = nodesRef.current.filter(n => n.type === "sra").length;
  const singles  = nodesRef.current.filter(n => n.type === "single").length;
  const flagged  = nodesRef.current.filter(n => n.flagged && n.type !== "single").length;
  const disco    = nodesRef.current.filter(n => n.outOfRange && n.type !== "single").length;

  let healthText = "Healthy";
  if (disco > 0)        healthText = "Has Disconnects";
  else if (flagged > 0) healthText = "Has Flagged Routes";

  // ---------- Create PDF ----------
  const pdf = new jsPDF("p", "pt", "letter");
  const pageWidth  = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();

  // ---- Header band ----
  pdf.setFillColor(13, 13, 26);
  pdf.rect(0, 0, pageWidth, 60, "F");
  pdf.setTextColor(0, 188, 212);
  pdf.setFontSize(20);
  pdf.setFont("helvetica", "bold");
  pdf.text("RF Planner — Install Report", 40, 38);

  pdf.setTextColor(180, 180, 180);
  pdf.setFontSize(10);
  pdf.setFont("helvetica", "normal");
  pdf.text(`Project: ${projectName}`, pageWidth - 40, 25, { align: "right" });
  pdf.text(`Generated: ${new Date().toLocaleString()}`, pageWidth - 40, 40, { align: "right" });

  // ---- Summary ----
  pdf.setTextColor(0, 0, 0);
  pdf.setFontSize(14);
  pdf.setFont("helvetica", "bold");
  pdf.text("Project Summary", 40, 90);

  autoTable(pdf, {
    startY: 100,
    head: [["Item", "Value"]],
    body: [
      ["Project Name", projectName],
      ["Date Generated", new Date().toLocaleString()],
      ["Total Nodes", String(nodesRef.current.length)],
      ["Gateways", String(gateways)],
      ["LRAs", String(lras)],
      ["SRAs", String(sras)],
      ["Single Modems", String(singles)],
      ["Flagged Nodes", String(flagged)],
      ["Disconnected Nodes", String(disco)],
      ["Network Health", healthText]
    ],
    theme: "striped",
    headStyles: { fillColor: [13, 13, 26], textColor: [0, 188, 212] },
    margin: { left: 40, right: 40 }
  });

  // ---- Map snapshot ----
  try {
    const screenshotCanvas = await html2canvas(containerRef.current, {
      useCORS: true, allowTaint: true, backgroundColor: null
    });
    const imgData = screenshotCanvas.toDataURL("image/png");
    const imgWidth  = pageWidth - 80;
    const imgHeight = (screenshotCanvas.height / screenshotCanvas.width) * imgWidth;

    let y = pdf.lastAutoTable.finalY + 25;
    if (y + imgHeight > pageHeight - 50) { pdf.addPage(); y = 40; }

    pdf.setFontSize(14);
    pdf.setFont("helvetica", "bold");
    pdf.text("Network Map", 40, y);
    pdf.addImage(imgData, "PNG", 40, y + 8, imgWidth, imgHeight);
  } catch (err) {
    console.log("Map snapshot failed:", err);
  }

  // ---- Site Install Sheet ----
  pdf.addPage();
  pdf.setFontSize(14);
  pdf.setFont("helvetica", "bold");
  pdf.text("Site Install Sheet", 40, 40);

  const siteBody = [];
  for (const n of nodesRef.current) {
    const target = linksRef.current[n.name] || null;
    const dist = target ? distance(n, target).toFixed(2) : "";
    siteBody.push([
      n.name,
      n.type.toUpperCase(),
      String(n.height),
      String(poleHeightFor(n)),
      String(poleSticksFor(n)),
      poleMaterialFor(n),
      target ? target.name : "—",
      dist,
      statusFor(n)
    ]);
  }

 autoTable(pdf, {
  startY: 55,
  head: [["Site", "Type", "Ant ft", "Pole ft", "Sticks", "Material", "To", "Dist mi", "Status"]],
  body: siteBody,
  theme: "striped",
  headStyles: { fillColor: [13, 13, 26], textColor: [0, 188, 212] },
  styles: {
    fontSize: 7,
    cellPadding: 3,
    overflow: "linebreak"
  },
  columnStyles: {
    0: { cellWidth: 110 },  // Site name — wider
    6: { cellWidth: 90 }    // "Connected To"
  },
  margin: { left: 30, right: 30 }
});

  // ---- BOM ----
  let gwSticks = 0, lraSticks = 0;
  for (const n of nodesRef.current) {
    if (n.type === "gateway") gwSticks  += poleSticksFor(n);
    if (n.type === "lra")     lraSticks += poleSticksFor(n);
  }

  pdf.addPage();
  pdf.setFontSize(14);
  pdf.setFont("helvetica", "bold");
  pdf.text("Bill of Materials", 40, 40);

  autoTable(pdf, {
    startY: 55,
    head: [["Item", "Qty", "Notes"]],
    body: [
      ["Gateways",                                String(gateways),  ""],
      ["LRA Radios",                              String(lras),      ""],
      ["SRA Radios",                              String(sras),      "Enclosure mounted"],
      ["Single Modems",                           String(singles),   "Modem only"],
      ['3/4" Rigid Conduit – 10ft sticks (GW)',   String(gwSticks),       "Rounded UP"],
      ['3/4" Rigid Conduit – Total Feet',         String(gwSticks * 10),  ""],
      ['1.25" EMT – 10ft sticks (LRA)',           String(lraSticks),      "Rounded UP"],
      ['1.25" EMT – Total Feet',                  String(lraSticks * 10), ""],
      ["TOTAL Pole Sticks",                       String(gwSticks + lraSticks),      "Combined"],
      ["TOTAL Pole Feet",                         String((gwSticks + lraSticks)*10), ""]
    ],
    theme: "striped",
    headStyles: { fillColor: [13, 13, 26], textColor: [0, 188, 212] },
    margin: { left: 40, right: 40 }
  });

  // ---- Recommendations ----
  pdf.addPage();
  pdf.setFontSize(14);
  pdf.setFont("helvetica", "bold");
  pdf.text("Recommendations", 40, 40);

  // Build cleaned rows safely
const recBody = [];
if (Array.isArray(recommendations) && recommendations.length > 0) {
  for (const r of recommendations) {
    const cleaned = stripEmojis(r?.text || "");
    if (cleaned && cleaned.length > 0) {
      recBody.push([cleaned]);
    } else if (r?.text) {
      recBody.push([String(r.text).replace(/[^\x20-\x7E]/g, "")]);
    }
  }
}
if (recBody.length === 0) {
  recBody.push(["All nodes connected — no action needed"]);
}

console.log("PDF Recommendations rows:", recBody);

autoTable(pdf, {
  startY: 55,
  head: [["Recommendation"]],
  body: recBody,
  theme: "grid",
  headStyles: {
    fillColor: [13, 13, 26],
    textColor: [0, 188, 212],
    fontStyle: "bold"
  },
  bodyStyles: {
    textColor: [20, 20, 20],
    fontSize: 9,
    cellPadding: 5,
    overflow: "linebreak",
    valign: "top"
  },
  alternateRowStyles: { fillColor: [245, 245, 245] },
  margin: { left: 40, right: 40 },
  tableWidth: "auto"
});

  // ---- Routes ----
  pdf.addPage();
  pdf.setFontSize(14);
  pdf.setFont("helvetica", "bold");
  pdf.text("Route Details", 40, 40);

  const routeBody = [];
  for (const n of nodesRef.current) {
    if (n.type === "gateway" || n.type === "single") continue;
    const target = linksRef.current[n.name];
    if (!target) {
      routeBody.push([n.name, "NONE", "", "", "NO CONNECTION"]);
      continue;
    }
    const d = distance(n, target);
    const signal = calcPower(d);
    let los = "CLEAR";
    if (n.outOfRange) los = "DISCONNECTED";
    else if (n.flagged) los = "FLAGGED";
    else if (n.blocked) los = "BLOCKED";
    routeBody.push([n.name, target.name, d.toFixed(2), signal.toFixed(0), los]);
  }

  autoTable(pdf, {
    startY: 55,
    head: [["From", "To", "Distance mi", "Signal dBm", "LOS"]],
    body: routeBody,
    theme: "striped",
    headStyles: { fillColor: [13, 13, 26], textColor: [0, 188, 212] },
    margin: { left: 40, right: 40 }
  });

  // ---- Footer on each page ----
  const totalPages = pdf.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    pdf.setPage(i);
    pdf.setFontSize(8);
    pdf.setTextColor(150, 150, 150);
    pdf.text(`RF Planner Install Report — ${projectName}`, 40, pageHeight - 20);
    pdf.text(`Page ${i} of ${totalPages}`, pageWidth - 40, pageHeight - 20, { align: "right" });
  }

  pdf.save(`${projectName}-install-report.pdf`);
}
  // =====================================================
// INSTALL REPORT (Step C1)
// Full installer-ready Excel report aligned with new optimizer.
// Does NOT replace exportExcel() or exportBundle().
// =====================================================
async function exportInstallReport(){
  if (!nodesRef.current.length) {
    alert("Add some nodes first, then export the install report.");
    return;
  }

  const currentProject = projects.find(p => p.id === activeProjectId);
  const projectName = currentProject?.name || "rf-network";

  // ---------- Helper: pole height recommendation ----------
function poleHeightFor(n) {
  if (n.type === "single") return 0;
  if (n.type === "gateway") return Math.max(15, n.height);
  if (n.type === "lra")     return Math.max(10, n.height);
  if (n.type === "sra")     return Math.max(5,  n.height);
  return n.height || 0;
}

// ---------- Helper: pole sticks (10 ft each, round UP) ----------
// All poles are physically purchased in 10 ft sticks.
function poleSticksFor(n) {
  // Only Gateway and LRA use poles
  if (n.type !== "gateway" && n.type !== "lra") return 0;
  const h = poleHeightFor(n);
  if (h <= 0) return 0;
  return Math.ceil(h / 10);
}

// ---------- Helper: pole material ----------
function poleMaterialFor(n) {
  if (n.type === "gateway") return '3/4" Rigid Conduit';
  if (n.type === "lra")     return '1.25" EMT';
  return ""; // SRA = enclosure mount, Single = modem only
}

// ---------- Helper: antenna recommendation ----------
function antennaFor(n) {
  if (n.type === "single") return "Modem only";
  if (n.type === "gateway") return "Omni (Gateway)";
  if (n.type === "lra")     return "Omni (LRA)";
  if (n.type === "sra")     return "Omni (SRA, enclosure mount)";
  return "Omni";
}

// ---------- Helper: status string ----------
function statusFor(n) {
  if (n.type === "single") return "Single Modem";
  if (n.outOfRange) return "DISCONNECTED";
  if (n.flagged)    return "FLAGGED (above max)";
  if (n.blocked)    return "BLOCKED LOS";
  return "OK";
}

// ---------- Tab 1: Project Summary ----------
const gateways = nodesRef.current.filter(n => n.type === "gateway").length;
const lras     = nodesRef.current.filter(n => n.type === "lra").length;
const sras     = nodesRef.current.filter(n => n.type === "sra").length;
const singles  = nodesRef.current.filter(n => n.type === "single").length;
const flagged  = nodesRef.current.filter(n => n.flagged && n.type !== "single").length;
const disco    = nodesRef.current.filter(n => n.outOfRange && n.type !== "single").length;

let healthText = "🟢 Healthy";
if (disco > 0)        healthText = "⚠️ Has Disconnects";
else if (flagged > 0) healthText = "🟪 Has Flagged Routes";

const summaryRows = [
  { Item: "Project Name",       Value: projectName },
  { Item: "Date Generated",     Value: new Date().toLocaleString() },
  { Item: "Total Nodes",        Value: nodesRef.current.length },
  { Item: "Gateways",           Value: gateways },
  { Item: "LRAs",               Value: lras },
  { Item: "SRAs",               Value: sras },
  { Item: "Single Modems",      Value: singles },
  { Item: "Flagged Nodes",      Value: flagged },
  { Item: "Disconnected Nodes", Value: disco },
  { Item: "Network Health",     Value: healthText }
];

// ---------- Tab 2: Site-by-Site Install Sheet ----------
const siteRows = [];
for (const n of nodesRef.current) {
  const target = linksRef.current[n.name] || null;
  let dist = "";
  let los = "";
  if (target) {
    dist = Number(distance(n, target).toFixed(2));
    const losCheck = await checkLOS(n, target, n.height, target.height);
    if (n.outOfRange) los = "DISCONNECTED";
    else if (n.flagged) los = "FLAGGED (1.5× rule)";
    else if (!losCheck.clear) los = "BLOCKED";
    else los = "CLEAR";
  }

  siteRows.push({
    "Site Name":               n.name,
    "Type":                    n.type.toUpperCase(),
    "Latitude":                n.lat,
    "Longitude":               n.lng,
    "Antenna Height ft":       n.height,
    "Pole Height ft":          poleHeightFor(n),
    "Pole Sticks (10ft each)": poleSticksFor(n),
    "Pole Material":           poleMaterialFor(n),
        "Connected To":            target ? target.name : "—",
    "Distance mi":             dist,
    "LOS":                     los,
    "Modbus ID":               n.modbusId || "",
    "Status":                  statusFor(n)
  });
}

// ---------- Tab 3: BOM (per-material pole breakdown) ----------
let gwSticks  = 0;
let lraSticks = 0;
for (const n of nodesRef.current) {
  if (n.type === "gateway") gwSticks  += poleSticksFor(n);
  if (n.type === "lra")     lraSticks += poleSticksFor(n);
}

const bomRows = [
  { Item: "Gateways",        Qty: gateways,             Notes: "" },
  { Item: "LRA Radios",      Qty: lras,                 Notes: "" },
  { Item: "SRA Radios",      Qty: sras,                 Notes: "Enclosure mounted, no pole" },
  { Item: "Single Modems",   Qty: singles,              Notes: "Modem only, no pole" },
 
  // Pole materials
  { Item: '3/4" Rigid Conduit – 10ft sticks (Gateway)', Qty: gwSticks,        Notes: "Rounded UP to next stick" },
  { Item: '3/4" Rigid Conduit – Total Feet',            Qty: gwSticks * 10,   Notes: "" },
  { Item: '1.25" EMT – 10ft sticks (LRA)',              Qty: lraSticks,       Notes: "Rounded UP to next stick" },
  { Item: '1.25" EMT – Total Feet',                     Qty: lraSticks * 10,  Notes: "" },

  { Item: "TOTAL Pole Sticks",  Qty: gwSticks + lraSticks,           Notes: "All materials combined" },
  { Item: "TOTAL Pole Feet",    Qty: (gwSticks + lraSticks) * 10,    Notes: "Raw material in feet" }
];

  // ---------- Tab 4: Recommendations ----------
  const recRows = recommendations.map(r => ({ Recommendation: r.text }));

  // ---------- Tab 5: Route Details ----------
  const routeRows = [];
  for (const n of nodesRef.current) {
    if (n.type === "gateway" || n.type === "single") continue;
    const target = linksRef.current[n.name];
    if (!target) {
      routeRows.push({
        "From":         n.name,
        "To":           "NONE",
        "Distance mi":  "",
        "Signal dBm":   "",
        "LOS":          "NO CONNECTION"
      });
      continue;
    }
    const d = distance(n, target);
    const signal = calcPower(d);
    const losCheck = await checkLOS(n, target, n.height, target.height);
    let los = "CLEAR";
    if (n.outOfRange) los = "DISCONNECTED";
    else if (n.flagged) los = "FLAGGED";
    else if (!losCheck.clear) los = "BLOCKED";

    routeRows.push({
      "From":          n.name,
      "To":            target.name,
      "Distance mi":   Number(d.toFixed(2)),
      "Signal dBm":    Number(signal.toFixed(0)),
      "LOS":           los
    });
  }

  // ---------- Build workbook ----------
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "Summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(siteRows),     "Site Install");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bomRows),      "BOM");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(recRows),      "Recommendations");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(routeRows),    "Routes");

  XLSX.writeFile(wb, `${projectName}-install-report.xlsx`);
}
  function exportExcel(){
    const nodeRows = nodesRef.current.map(n => ({
      "Name":n.name,"Type":n.type.toUpperCase(),"Latitude":n.lat,"Longitude":n.lng,
      "Antenna Height (ft)":n.height,"Recommended Height (ft)":n.recommendedHeight||n.height,
      "Ground Elevation (ft)":n.elevation||"N/A","Range (mi)":n.range,
      "Status":n.outOfRange?"SINGLE MODEM":n.blocked?"BLOCKED":"OK"
    }));
    const connectionRows=[];
    for(const a of nodesRef.current){
      if(a.type==="gateway")continue;
      const target=linksRef.current[a.name];
      if(target){const d=distance(a,target);const signal=calcPower(d);connectionRows.push({"From":a.name,"To":target.name,"Distance (mi)":Number(d.toFixed(2)),"Signal (dBm)":Number(signal.toFixed(0)),"LOS":a.blocked?"BLOCKED":"CLEAR"});}
      else{connectionRows.push({"From":a.name,"To":"NONE","Distance (mi)":"N/A","Signal (dBm)":"N/A","LOS":"NO CONNECTION"});}
    }
    const summaryRows=[{"Item":"Total Nodes","Value":nodesRef.current.length},{"Item":"Gateways","Value":nodesRef.current.filter(n=>n.type==="gateway").length},{"Item":"LRAs","Value":nodesRef.current.filter(n=>n.type==="lra").length},{"Item":"SRAs","Value":nodesRef.current.filter(n=>n.type==="sra").length}];
    const recRows=recommendations.map(r=>({"Recommendation":r.text}));
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(nodeRows),"Nodes");
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(connectionRows),"Connections");
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(summaryRows),"Summary");
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(recRows),"Recommendations");
    XLSX.writeFile(wb,"rf-network-report.xlsx");
  }

  async function exportBundle(){
  const currentProject = projects.find(p => p.id === activeProjectId);
  setTextPrompt({
    title: "Name this export",
    defaultValue: currentProject?.name || "rf-network",
    onConfirm: async (folderName) => {
      if (!folderName) return;
      const zip = new JSZip();
      const folder = zip.folder(folderName);
      const nodeRows = nodesRef.current.map(n => ({
        "Name": n.name, "Type": n.type.toUpperCase(), "Latitude": n.lat, "Longitude": n.lng,
        "Antenna Height (ft)": n.height, "Recommended Height (ft)": n.recommendedHeight || n.height,
        "Ground Elevation (ft)": n.elevation || "N/A", "Range (mi)": n.range,
        "Status": n.outOfRange ? "SINGLE MODEM" : n.blocked ? "BLOCKED" : "OK"
      }));
      const connectionRows = [];
      for (const a of nodesRef.current) {
        if (a.type === "gateway") continue;
        const target = linksRef.current[a.name];
        if (target) {
          const d = distance(a, target); const signal = calcPower(d);
          connectionRows.push({ "From": a.name, "To": target.name, "Distance (mi)": Number(d.toFixed(2)), "Signal (dBm)": Number(signal.toFixed(0)), "LOS": a.blocked ? "BLOCKED" : "CLEAR" });
        } else {
          connectionRows.push({ "From": a.name, "To": "NONE", "Distance (mi)": "N/A", "Signal (dBm)": "N/A", "LOS": "NO CONNECTION" });
        }
      }
      const summaryRows = [
        { "Item": "Total Nodes", "Value": nodesRef.current.length },
        { "Item": "Gateways", "Value": nodesRef.current.filter(n => n.type === "gateway").length },
        { "Item": "LRAs", "Value": nodesRef.current.filter(n => n.type === "lra").length },
        { "Item": "SRAs", "Value": nodesRef.current.filter(n => n.type === "sra").length },
        { "Item": "Single Modems", "Value": nodesRef.current.filter(n => n.type === "single" || n.outOfRange).length }
      ];
      const recRows = recommendations.map(r => ({ "Recommendation": r.text }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(nodeRows), "Nodes");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(connectionRows), "Connections");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "Summary");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(recRows), "Recommendations");
      const excelBuffer = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      folder.file(folderName + "-report.xlsx", excelBuffer);
      const networkData = { nodes: nodesRef.current.map(n => ({ name: n.name, type: n.type, lat: n.lat, lng: n.lng, height: n.height, range: n.range })), fccTowersVisible: showFCCTowers };
      folder.file(folderName + "-network.json", JSON.stringify(networkData, null, 2));
      const mapContainer = containerRef.current;
      const screenshotCanvas = await html2canvas(mapContainer, { useCORS: true, allowTaint: true, backgroundColor: null });
      const dataURL = screenshotCanvas.toDataURL("image/png");
      const imgData = dataURL.split(",")[1];
      folder.file(folderName + "-map.png", imgData, { base64: true });
      const url = window.location.href;
      folder.file("Open RF Planner.url", "[InternetShortcut]\nURL=" + url + "\n");
      const content = await zip.generateAsync({ type: "blob" });
      const blobUrl = URL.createObjectURL(content);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = folderName + ".zip";
      a.click();
      URL.revokeObjectURL(blobUrl);
    }
  });
}
  function loadNetwork(e){
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const raw = JSON.parse(evt.target.result);

      let nodeData;
      let fccVisible = false;
      if (Array.isArray(raw)) {
        nodeData = raw;
      } else {
        nodeData = raw.nodes || [];
        fccVisible = raw.fccTowersVisible || false;
      }

      // Count gateways in the saved file
      const gatewayCount = nodeData.filter(n => n.type === "gateway").length;
      const fileName = file.name.replace(/\.json$/, "");

      // If multi-gateway, ask the user how to handle it
      if (gatewayCount >= 2) {
        setMultiGatewayLoadPrompt({
          nodes: nodeData,
          gatewayCount,
          fileName,
          fccVisible
        });
        return;
      }

      // Otherwise, fall through to the standard single-project load
      loadAsSingleProject(nodeData, fccVisible, fileName);
    } catch (err) {
      console.error("Load network error:", err);
      alert("Failed to load network file.\n\n" + (err?.message || "Unknown error"));
    }
  };
  reader.readAsText(file);
}
// =====================================================
// MULTI-GATEWAY SPLIT HELPERS (Phase 2)
// =====================================================

// Pure distance calc (mirrors the in-app one but works on raw node data)
function rawDistance(a, b) {
  return Math.sqrt((a.lng - b.lng) ** 2 + (a.lat - b.lat) ** 2) * 69;
}

// Build a quick {name: node} index from a raw node list
function indexByName(nodeData) {
  const idx = {};
  for (const n of nodeData) idx[n.name] = n;
  return idx;
}

// =====================================================
// MULTI-GATEWAY ASSIGNMENT (chain-aware)
// Walks the full mesh tree back to a gateway, not just 1 hop.
// Matches how real LRA→LRA→Gateway routing works.
// =====================================================
function computeRawGatewayAssignment(nodeData) {
  const RANGE_LRA = 3;
  const RANGE_SRA = 0.75;

  // ----- 1. Build parent links (nearest valid neighbor that helps reach a gateway) -----
  // Step A: sort by priority — gateways first, then LRAs, then SRAs
  const sorted = [...nodeData].sort((x, y) => {
    const order = { gateway: 0, lra: 1, sra: 2, single: 3 };
    return order[x.type] - order[y.type];
  });

  const links = {}; // name -> parent name

  // First pass: connect every non-gateway, non-single node to its nearest valid neighbor
  for (const a of sorted) {
    if (a.type === "gateway" || a.type === "single") continue;

    let bestParent = null;
    let bestDist = Infinity;

    for (const b of nodeData) {
      if (b === a) continue;
      if (b.type === "single") continue;

      const d = rawDistance(a, b);
      // If we're an SRA, our range is short; if we're an LRA, our range is long
      const myRange = (a.type === "lra") ? RANGE_LRA : RANGE_SRA;
      // The link's effective range is also constrained by the other side
      const partnerRange = (b.type === "lra" || b.type === "gateway") ? RANGE_LRA : RANGE_SRA;
      const linkRange = Math.min(myRange, partnerRange);

      if (d > linkRange) continue;

      if (d < bestDist) {
        bestDist = d;
        bestParent = b.name;
      }
    }

    if (bestParent) links[a.name] = bestParent;
  }

  // ----- 2. Walk parent chain to find each node's gateway -----
  const nodeIdx = {};
  for (const n of nodeData) nodeIdx[n.name] = n;

  function findGatewayFor(startName) {
    const visited = new Set();
    let current = startName;
    for (let i = 0; i < 100; i++) {
      if (visited.has(current)) return null;
      visited.add(current);

      const node = nodeIdx[current];
      if (!node) return null;
      if (node.type === "gateway") return node;

      const next = links[current];
      if (!next) return null;
      current = next;
    }
    return null;
  }

  // ----- 3. Build the final assignment -----
  const assignment = {}; // nodeName -> gatewayName  (null if disconnected/single)
  for (const n of nodeData) {
    if (n.type === "gateway") {
      assignment[n.name] = n.name;
    } else if (n.type === "single") {
      assignment[n.name] = null;
    } else {
      const gw = findGatewayFor(n.name);
      assignment[n.name] = gw ? gw.name : null;
    }
  }

  return assignment;
}

// Find the closest non-gateway node to a given gateway → used for tab name
function nearestWellName(gateway, nodeData) {
  let best = null;
  let bestDist = Infinity;
  for (const n of nodeData) {
    if (n.type === "gateway") continue;
    const d = rawDistance(gateway, n);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  return best ? best.name : gateway.name;
}

// Apply a raw nodeData list to the live map (replaces current network)
// Apply a raw nodeData list to the live map (replaces current network)
// If `focusNode` is provided, zoom in on that node instead of centering on the whole group.
function applyNodeDataToMap(nodeData, focusNode = null) {
  const map = mapRef.current;
  if (!map) return;

  nodesRef.current.forEach(n => { if (n.marker) n.marker.remove(); });
  nodesRef.current = [];

  for (const n of nodeData) {
    addNode(map, n.lng, n.lat, n.type, n.name, true, n.height);
    const created = nodesRef.current[nodesRef.current.length - 1];
    if (n.modbusId) created.modbusId = n.modbusId;
  }

  if (focusNode) {
    // Zoom to the gateway for this tab
    map.flyTo({ center: [focusNode.lng, focusNode.lat], zoom: 13 });
  } else if (nodeData.length > 0) {
    // Default: center on average position (used for the Overall tab)
    let avgLat = 0, avgLng = 0;
    for (const n of nodeData) { avgLat += n.lat; avgLng += n.lng; }
    avgLat /= nodeData.length;
    avgLng /= nodeData.length;
    map.flyTo({ center: [avgLng, avgLat], zoom: 12 });
  }

  redraw();
}
// Existing single-project load (refactored out so multi-gateway can reuse it)
function loadAsSingleProject(nodeData, fccVisible, fileName) {
  const map = mapRef.current;

  nodesRef.current.forEach(n => { if (n.marker) n.marker.remove(); });
  nodesRef.current = [];

  nodeData.forEach(n => {
    addNode(map, n.lng, n.lat, n.type, n.name, true, n.height);
    if (n.modbusId) nodesRef.current[nodesRef.current.length - 1].modbusId = n.modbusId;
  });

  if (fccVisible && !showFCCTowers) { toggleFCCTowers(); }
  else if (!fccVisible && showFCCTowers) { toggleFCCTowers(); }

  // Update active project tab name to match file
  setProjects(prev => prev.map(p => p.id === activeProjectId ? { ...p, name: fileName } : p));

  // Center map
  let avgLat = 0, avgLng = 0;
  for (const n of nodeData) { avgLat += n.lat; avgLng += n.lng; }
  avgLat /= nodeData.length;
  avgLng /= nodeData.length;
  map.flyTo({ center: [avgLng, avgLat], zoom: 13 });

  redraw();
}
  // =====================================================
// NETWORK ANALYSIS (v2 — aligned with new optimizer rules)
//
// New rule-aware recommendations:
// - Pad logic awareness
// - 100 ft north gateway logic
// - New max heights:  G=25, LRA=20, SRA=5
// - 1.5x flagged-but-allowed rule
// - Promotion suggestion (SRA → LRA)
// - Single Modem recommendation
// - Clear, action-oriented messages
// =====================================================
async function analyzeNetwork(){
  const recs = [];
  const seen = new Set();

  // Rule constants (kept in sync with rf/constants.js)
  const MAX_G   = 25;
  const MAX_LRA = 20;
  const MAX_SRA = 5;
  const FLAG_G   = MAX_G   * 1.5;
  const FLAG_LRA = MAX_LRA * 1.5;

  // Helper to push only unique recs
  function pushRec(key, text, node = null, target = null) {
    if (seen.has(key)) return;
    seen.add(key);
    recs.push({ text, node, target });
  }

  // --------------------------------------
  // PASS 1: review existing connected links
  // --------------------------------------
  for (const a of nodesRef.current){
    if (a.type === "gateway" || a.type === "single") continue;
    const path = getPath(a);
    if (!path.some(n => n.type === "gateway")) continue;

    for (let p = 0; p < path.length - 1; p++){
      const p1 = path[p], p2 = path[p + 1];
      const key = [p1.name, p2.name].sort().join("→");

      // Blocked LOS
      if (p1.blocked) {
        pushRec(
          `block-${key}`,
          `⛰️ ${p1.name.toUpperCase()} → ${p2.name.toUpperCase()}: Blocked LOS — adjust height`,
          p1, p2
        );
      }
      // Fresnel warning
      else if (p1.fresnelWarn && p1.fresnelTarget) {
        const pct = p1.fresnelDetail?.match(/\d+/)?.[0] || "?";
        pushRec(
          `fresnel-${[p1.name, p1.fresnelTarget.name].sort().join("→")}`,
          `⚠️ ${p1.name.toUpperCase()} → ${p1.fresnelTarget.name.toUpperCase()}: Fresnel ${pct}% — increase height for reliable link`,
          p1, p1.fresnelTarget
        );
      }

      // Flagged-but-allowed (above max but within 1.5x)
      if (
        (p1.type === "gateway" && p1.height > MAX_G && p1.height <= FLAG_G) ||
        (p1.type === "lra"     && p1.height > MAX_LRA && p1.height <= FLAG_LRA) ||
        (p2.type === "gateway" && p2.height > MAX_G && p2.height <= FLAG_G) ||
        (p2.type === "lra"     && p2.height > MAX_LRA && p2.height <= FLAG_LRA)
      ) {
        pushRec(
          `flag-${key}`,
          `🟪 ${p1.name.toUpperCase()} → ${p2.name.toUpperCase()}: Connected using FLAGGED height (above normal max, within 1.5×)`,
          p1, p2
        );
      }
    }
  }

  // --------------------------------------
  // PASS 2: review DISCONNECTED nodes
  // --------------------------------------
  for (const a of nodesRef.current){
    if (a.type === "gateway" || a.type === "single") continue;
    const path = getPath(a);
    if (path.some(n => n.type === "gateway")) continue;

    // Find nearest gateway + nearest connected LRA
    let nearestGW = null, nearestGWDist = Infinity;
    let nearestLRA = null, nearestLRADist = Infinity;

    for (const b of nodesRef.current){
      if (b === a) continue;
      const d = distance(a, b);

      if (b.type === "gateway" && d < nearestGWDist) {
        nearestGW = b; nearestGWDist = d;
      }
      if (b.type === "lra" && d < nearestLRADist) {
        const bPath = getPath(b);
        if (bPath.some(n => n.type === "gateway")) {
          nearestLRA = b; nearestLRADist = d;
        }
      }
    }

    const useGW =
      nearestGW &&
      (!nearestLRA || nearestGWDist <= nearestLRADist);

    const target = useGW ? nearestGW : nearestLRA;
    const targetDist = useGW ? nearestGWDist : nearestLRADist;
    const targetLabel = target ? target.name.toUpperCase() : "any gateway/LRA";

    // CASE 1: nothing within possible mesh range (3 mi)
    if (!target || targetDist > 3) {
      pushRec(
        `gone-${a.name}`,
        `📡 ${a.name.toUpperCase()}: Out of range — nearest mesh anchor is ${
          targetDist === Infinity ? "unknown" : targetDist.toFixed(2) + " mi"
        } away (max 3 mi) → recommend ⚫ Single Modem`,
        a
      );
      continue;
    }

    // CASE 2: within 3 mi but beyond SRA range → suggest promotion
    if (a.type === "sra" && targetDist > 0.75) {
      const los = await checkLOS(a, target, 10, target.height);
      if (!los.clear) {
        const needed = Math.ceil(los.requiredHeight + a.height);
        if (needed > FLAG_LRA) {
          pushRec(
            `lostall-${a.name}`,
            `⛰️ ${a.name.toUpperCase()}: Terrain blocks LOS to ${targetLabel} (${targetDist.toFixed(2)} mi) — needs ${needed}ft but max flagged LRA height is ${FLAG_LRA}ft → ⚫ Single Modem`,
            a, target
          );
        } else if (needed > MAX_LRA) {
          pushRec(
            `flag-rescue-${a.name}`,
            `🟪 ${a.name.toUpperCase()}: Promote to LRA at FLAGGED height ~${needed}ft to reach ${targetLabel}`,
            a, target
          );
        } else {
          pushRec(
            `promote-${a.name}`,
            `⬆️ ${a.name.toUpperCase()}: Promote to LRA (~${needed}ft) to reach ${targetLabel} (${targetDist.toFixed(2)} mi)`,
            a, target
          );
        }
      } else {
        pushRec(
          `extend-${a.name}`,
          `⬆️ ${a.name.toUpperCase()}: Out of SRA range (0.75 mi) — promote to LRA to reach ${targetLabel} (${targetDist.toFixed(2)} mi)`,
          a, target
        );
      }
      continue;
    }

    // CASE 3: within range — check LOS at current height
    const los = await checkLOS(a, target, a.height, target.height);
    if (!los.clear) {
      const needed = Math.ceil(los.requiredHeight + a.height);
      const maxH = a.type === "sra" ? MAX_SRA : a.type === "lra" ? MAX_LRA : MAX_G;
      const flagH = a.type === "lra" ? FLAG_LRA : a.type === "gateway" ? FLAG_G : MAX_SRA;

      if (needed > flagH) {
        pushRec(
          `losdead-${a.name}`,
          `⛰️ ${a.name.toUpperCase()}: Terrain blocks LOS to ${targetLabel} — needs ${needed}ft, exceeds max FLAGGED ${a.type.toUpperCase()} height (${flagH}ft) → ⚫ Single Modem`,
          a, target
        );
      } else if (needed > maxH) {
        pushRec(
          `losflag-${a.name}`,
          `🟪 ${a.name.toUpperCase()}: Raise ${a.type.toUpperCase()} to FLAGGED ~${needed}ft to clear LOS to ${targetLabel}`,
          a, target
        );
      } else {
        pushRec(
          `losfix-${a.name}`,
          `⛰️ ${a.name.toUpperCase()}: Increase height to ~${needed}ft to clear LOS to ${targetLabel}`,
          a, target
        );
      }
      continue;
    }

    // CASE 4: LOS clear but mesh routing didn't pick it
    const signal = calcPower(targetDist);
    if (signal < -95) {
      pushRec(
        `weak-${a.name}`,
        `📡 ${a.name.toUpperCase()}: Weak signal to ${targetLabel} (${signal.toFixed(0)} dBm at ${targetDist.toFixed(2)} mi) — consider adding relay node`,
        a, target
      );
    } else {
      pushRec(
        `mesh-${a.name}`,
        `🔗 ${a.name.toUpperCase()}: LOS clear to ${targetLabel} but no mesh path to gateway — check intermediate node connections`,
        a, target
      );
    }
  }

  // --------------------------------------
  // FINAL OUTPUT
  // --------------------------------------
  if (recs.length === 0) {
    setRecommendations([{ text: "✅ All nodes connected — no action needed" }]);
  } else {
    setRecommendations(recs);
  }
}
  function importText(){
    if(!inputCoords.trim())return;
    const lines=inputCoords.trim().split("\n");
    for(const line of lines){const parts=line.split(",");if(parts.length<3)continue;const name=parts[0].trim();const lat=parseFloat(parts[1].trim());const lng=parseFloat(parts[2].trim());if(isNaN(lat)||isNaN(lng))continue;addNode(mapRef.current,lng,lat,modeRef.current,name);}
    const first=inputCoords.trim().split("\n")[0].split(",");const lat=parseFloat(first[1]);const lng=parseFloat(first[2]);
    if(!isNaN(lat)&&!isNaN(lng)){mapRef.current.flyTo({center:[lng,lat],zoom:13});}
    setInputCoords("");
  }
  // =====================================================
// KMZ UPLOAD (Phase 1)
// Parses a KMZ file → loads placemarks → opens optimize prompt
// =====================================================
async function uploadKmz(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";

  try {
    const placemarks = await readKmzToPlacemarks(file);

    if (!placemarks.length) {
      alert("No point placemarks found in this KMZ.");
      return;
    }

    // Convert KMZ placemarks into the same row shape Excel uses,
    // so the existing Auto-Optimize prompt can handle them seamlessly.
    const rows = placemarks.map(p => ({
      Name: p.name,
      Latitude: p.lat,
      Longitude: p.lng
    }));

    setImportedData(rows);
    setShowOptimizePrompt(true);
  } catch (err) {
    console.error("KMZ import error:", err);
    alert("Failed to import KMZ.\n\n" + (err?.message || "Unknown error"));
  }
}
  function uploadExcel(e){
    const file = e.target.files[0];
    if(!file) return;
    e.target.value = "";
    const reader=new FileReader();
    reader.onload=(evt)=>{const wb=XLSX.read(new Uint8Array(evt.target.result));const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);setImportedData(rows);setShowOptimizePrompt(true);};
    reader.readAsArrayBuffer(file);
  }
// =====================================================
// AUTO-OPTIMIZE (locked-rule engine)
// =====================================================
async function newAutoOptimize() {
  if (!nodesRef.current.length) {
    alert("Add some nodes first, then run Auto-Optimize.");
    return;
  }

  try {
    await runFullOptimizer({
  nodes: nodesRef.current,
  addNodeFn: addNode,
  mapRef: mapRef.current,
  onProgress: (msg) => {
    setLoadingState({
      title: "Running Auto-Optimize…",
      subtitle: msg
    });
  }
});

    redraw();

    setRecommendations(prev => [
      ...prev,
      { text: "⚡ Auto-Optimize complete — locked rules applied." }
    ]);
  } catch (err) {
    console.error("Auto-Optimize error:", err);
    alert("Auto-Optimize failed. Check console for details.");
  }
}  // ========== MULTI-PROJECT FUNCTIONS ==========
  function serializeProject(){
    const map = mapRef.current;
    return {
      nodes: nodesRef.current.map(n => ({
        name:n.name, type:n.type, lat:n.lat, lng:n.lng,
        height:n.height, range:n.range, modbusId:n.modbusId||null
      })),
      undoStack: [...undoStack.current],
      redoStack: [...redoStack.current],
      mapCenter: map ? [map.getCenter().lng, map.getCenter().lat] : null,
      mapZoom: map ? map.getZoom() : null
    };
  }

  function loadProjectToMap(data){
    const map = mapRef.current;
    if(!map) return;
    // Remove all node markers
    nodesRef.current.forEach(n => { if(n.marker) n.marker.remove(); });
    nodesRef.current = [];
    linksRef.current = {};
    // Clear measure tool
    clearMeasure();
    setMeasureMode(false);
    // Clear UI state
    setSelectedNode(null);
    setShowProfile(false);
    setRecommendations([]);
    // Clear drawn layers
    const layers = map.getStyle().layers || [];
    layers.forEach(l => {
      if(l.id.startsWith("line") || l.id.startsWith("label") || l.id.startsWith("route") || l.id === "all-nodes"){
        if(map.getLayer(l.id)) map.removeLayer(l.id);
        if(map.getSource(l.id)) map.removeSource(l.id);
      }
    });
    // Clear heatmap data if visible
    if(showHeatmapRef.current && map.getSource("signal-heatmap")){
      map.getSource("signal-heatmap").setData({ type: "FeatureCollection", features: [] });
    }
    if(data && data.nodes && data.nodes.length > 0){
      data.nodes.forEach(n => {
        addNode(map, n.lng, n.lat, n.type, n.name, true, n.height);
        const added = nodesRef.current[nodesRef.current.length - 1];
        if(n.modbusId) added.modbusId = n.modbusId;
      });
      undoStack.current = data.undoStack || [];
      redoStack.current = data.redoStack || [];
      if(data.mapCenter && data.mapZoom){
        map.jumpTo({ center: data.mapCenter, zoom: data.mapZoom });
      }
      redraw();
    } else {
      undoStack.current = [];
      redoStack.current = [];
      setNodeVersion(v => v + 1);
    }
  }

  function switchProject(newId){
  if (newId === activeProjectId) return;

  // Save current project state
  projectDataRef.current[activeProjectId] = serializeProject();

  // Load new project's data
  const newData = projectDataRef.current[newId] || null;

  if (newData && newData.nodes && newData.nodes.length > 0) {
    // If this tab has a gatewayName tied to it, zoom in on that gateway
    let focusNode = null;
    if (newData.gatewayName) {
      focusNode = newData.nodes.find(n => n.name === newData.gatewayName);
    }
    applyNodeDataToMap(newData.nodes, focusNode);
  } else {
    // Empty / unsaved tab — clear the map
    loadProjectToMap(null);
  }

  setActiveProjectId(newId);
}

  function addProject(){
  const id = nextProjectIdRef.current++;
  setTextPrompt({
    title: "New project name",
    defaultValue: `Project ${id}`,
    onConfirm: (name) => {
      if (!name) return;
      projectDataRef.current[activeProjectId] = serializeProject();
      setProjects(prev => [...prev, { id, name }]);
      projectDataRef.current[id] = null;
      loadProjectToMap(null);
      setActiveProjectId(id);
    }
  });
}

  function deleteProject(id){
    if(projects.length <= 1) return;
    if(!confirm(`Delete "${projects.find(p => p.id === id)?.name}"?`)) return;
    const remaining = projects.filter(p => p.id !== id);
    delete projectDataRef.current[id];
    setProjects(remaining);
    if(id === activeProjectId){
      const newActive = remaining[0].id;
      const newData = projectDataRef.current[newActive] || null;
      loadProjectToMap(newData);
      setActiveProjectId(newActive);
    }
  }

 function renameProject(id){
  const current = projects.find(p => p.id === id);
  setTextPrompt({
    title: "Rename project",
    defaultValue: current?.name || "",
    onConfirm: (newName) => {
      if (!newName) return;
      setProjects(prev => prev.map(p => p.id === id ? { ...p, name: newName } : p));
    }
  });
}

return (<div style={{display:"flex",height:"100vh"}}>
{/* ===== MULTI-GATEWAY LOAD PROMPT ===== */}
{multiGatewayLoadPrompt && (
  <div style={{
    position: "fixed",
    top: 0, left: 0,
    width: "100vw", height: "100vh",
    background: "rgba(10,10,20,0.78)",
    backdropFilter: "blur(2px)",
    zIndex: 6000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  }}>
    <div style={{
      background: "linear-gradient(135deg,#1a1a2e,#0d0d1a)",
      border: "1px solid rgba(0,188,212,0.4)",
      borderRadius: 10,
      padding: "22px 28px",
      minWidth: 360,
      maxWidth: 460,
      color: "#fff",
      boxShadow: "0 8px 24px rgba(0,0,0,0.6)"
    }}>
      <div style={{
        fontWeight: "bold",
        fontSize: 16,
        color: "#00bcd4",
        marginBottom: 6
      }}>
        🗂️ Multi-Gateway Project Detected
      </div>

      <div style={{ color: "#bbb", fontSize: 13, marginBottom: 14, lineHeight: 1.4 }}>
        <strong>{multiGatewayLoadPrompt.fileName}</strong> contains <strong>{multiGatewayLoadPrompt.gatewayCount} gateways</strong>.
        <br/>
        Would you like to split it into project tabs?
        <br/><br/>
        <span style={{ color: "#888", fontSize: 12 }}>
          • <strong>Yes</strong> → creates an <em>Overall</em> tab + one tab per gateway (installer view)<br/>
          • <strong>No</strong> → loads as a single project like before
        </span>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={async () => {
  const { nodes, fccVisible, fileName } = multiGatewayLoadPrompt;
  setMultiGatewayLoadPrompt(null);

  setLoadingState({
    title: "Splitting project…",
    subtitle: "Loading network and computing routes"
  });

  // -----------------------------------------------
  // STEP 1: Load all nodes onto the live map first
  // -----------------------------------------------
  applyNodeDataToMap(nodes);
  await new Promise(res => setTimeout(res, 50));

  // -----------------------------------------------
  // STEP 2: Run the REAL routing engine
  // -----------------------------------------------
  setLoadingState({
    title: "Splitting project…",
    subtitle: "Mapping nodes to gateways"
  });
  await computeLinks();

  const liveNodes = nodesRef.current;
  const gateways = liveNodes.filter(n => n.type === "gateway");

  // -----------------------------------------------
  // STEP 3: Determine each node's true gateway
  // - non-gateway nodes: use real getPath()
  // - gateway nodes: belong to themselves only (prevents gateway-to-gateway nesting)
  // - disconnected/single nodes: nearest gateway by distance
  // -----------------------------------------------
  function nearestGatewayByDistance(node, gws) {
    let best = null;
    let bestDist = Infinity;
    for (const gw of gws) {
      const d = distance(node, gw);
      if (d < bestDist) { bestDist = d; best = gw; }
    }
    return best;
  }

  const assignment = {}; // nodeName -> gatewayName

  for (const n of liveNodes) {
    if (n.type === "gateway") {
      // Gateways belong to themselves only
      assignment[n.name] = n.name;
      continue;
    }

    if (n.type === "single") {
      // Single modems → nearest gateway by distance
      const gw = nearestGatewayByDistance(n, gateways);
      assignment[n.name] = gw ? gw.name : null;
      continue;
    }

    // Normal node — try real mesh path first
    const path = getPath(n);
    const gw = path.find(p => p.type === "gateway");
    if (gw) {
      assignment[n.name] = gw.name;
    } else {
      // Disconnected → assign to nearest gateway by distance
      const fallback = nearestGatewayByDistance(n, gateways);
      assignment[n.name] = fallback ? fallback.name : null;
    }
  }

  // -----------------------------------------------
  // STEP 4: Build per-gateway subsets (with gateway count per gateway)
  // -----------------------------------------------
  function snapshotNode(n) {
    return {
      name: n.name,
      type: n.type,
      lat: n.lat,
      lng: n.lng,
      height: n.height,
      range: n.range,
      modbusId: n.modbusId || null
    };
  }

  const overallSnapshot = liveNodes.map(snapshotNode);

  const subsetByGateway = {};
  for (const gw of gateways) subsetByGateway[gw.name] = [];

  for (const n of liveNodes) {
    const owner = assignment[n.name];
    if (!owner) continue;
    if (subsetByGateway[owner]) {
      subsetByGateway[owner].push(snapshotNode(n));
    }
  }

  // -----------------------------------------------
  // STEP 5: Apply 20-tab cap → keep biggest gateways
  // -----------------------------------------------
  const TAB_LIMIT = 20;
  let gatewaysForTabs = gateways;

  if (gateways.length > TAB_LIMIT) {
    const proceed = confirm(
      `This file has ${gateways.length} gateways.\n\n` +
      `Load only the first ${TAB_LIMIT} as tabs (by node count)?\n\n` +
      `OK = Yes, cap at ${TAB_LIMIT} tabs\n` +
      `Cancel = Load as a single project instead`
    );

    if (!proceed) {
      loadAsSingleProject(nodes, fccVisible, fileName);
      setLoadingState(null);
      return;
    }

    gatewaysForTabs = [...gateways].sort((a, b) =>
      (subsetByGateway[b.name]?.length || 0) -
      (subsetByGateway[a.name]?.length || 0)
    ).slice(0, TAB_LIMIT);
  }

  // -----------------------------------------------
  // STEP 6: Build the tabs
  // -----------------------------------------------
  const newProjects = [];
  const newProjectData = {};

  // Overall tab
  const overallId = nextProjectIdRef.current++;
  newProjects.push({ id: overallId, name: `${fileName} — Overall` });
  newProjectData[overallId] = {
    nodes: overallSnapshot,
    undoStack: [],
    redoStack: [],
    mapCenter: null,
    mapZoom: null,
    isOverall: true
  };

  // One tab per qualifying gateway, named after nearest well
  for (const gw of gatewaysForTabs) {
    const tabId = nextProjectIdRef.current++;
    const tabName = `${gw.name} — ${nearestWellName(gw, nodes)}`;
    newProjects.push({ id: tabId, name: tabName });
    newProjectData[tabId] = {
      nodes: subsetByGateway[gw.name],
      undoStack: [],
      redoStack: [],
      mapCenter: null,
      mapZoom: null,
      isOverall: false,
      gatewayName: gw.name
    };
  }

  // -----------------------------------------------
  // STEP 7: Activate the new tab set
  // -----------------------------------------------
  projectDataRef.current[activeProjectId] = serializeProject();

  setProjects(newProjects);
  for (const id of Object.keys(newProjectData)) {
    projectDataRef.current[id] = newProjectData[id];
  }

  setActiveProjectId(overallId);
  applyNodeDataToMap(overallSnapshot);

  if (fccVisible && !showFCCTowers) toggleFCCTowers();
  else if (!fccVisible && showFCCTowers) toggleFCCTowers();

  setLoadingState(null);
}}
        >
          ✅ Yes, split into tabs
        </button>

        <button
          onClick={() => {
            const { nodes, fccVisible, fileName } = multiGatewayLoadPrompt;
            setMultiGatewayLoadPrompt(null);
            loadAsSingleProject(nodes, fccVisible, fileName);
          }}
          style={{
            flex: 1,
            padding: "8px 12px",
            background: "#555",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 13
          }}
        >
          ➡️ No, load as one project
        </button>
      </div>
    </div>
  </div>
)}
{/* ===== TEXT PROMPT MODAL ===== */}
{textPrompt && (
  <div style={{
    position: "fixed",
    top: 0, left: 0,
    width: "100vw", height: "100vh",
    background: "rgba(10,10,20,0.78)",
    backdropFilter: "blur(2px)",
    zIndex: 7000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  }}>
    <div style={{
      background: "linear-gradient(135deg,#1a1a2e,#0d0d1a)",
      border: "1px solid rgba(0,188,212,0.4)",
      borderRadius: 10,
      padding: "22px 28px",
      minWidth: 340,
      color: "#fff",
      boxShadow: "0 8px 24px rgba(0,0,0,0.6)"
    }}>
      <div style={{ fontWeight: "bold", fontSize: 16, color: "#00bcd4", marginBottom: 10 }}>
        {textPrompt.title || "Enter value"}
      </div>

      <input
        autoFocus
        defaultValue={textPrompt.defaultValue || ""}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = e.currentTarget.value.trim();
            const cb = textPrompt.onConfirm;
            setTextPrompt(null);
            if (cb) cb(v);
          } else if (e.key === "Escape") {
            setTextPrompt(null);
          }
        }}
        id="__text_prompt_input"
        style={{
          width: "100%",
          padding: "8px 10px",
          background: "#222",
          color: "#fff",
          border: "1px solid #555",
          borderRadius: 4,
          fontSize: 14,
          boxSizing: "border-box",
          marginBottom: 12
        }}
      />

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => {
            const el = document.getElementById("__text_prompt_input");
            const v = el ? el.value.trim() : "";
            const cb = textPrompt.onConfirm;
            setTextPrompt(null);
            if (cb) cb(v);
          }}
          style={{
            flex: 1,
            padding: "8px 12px",
            background: "#4caf50",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            fontWeight: "bold",
            fontSize: 13
          }}
        >
          ✅ OK
        </button>
        <button
          onClick={() => setTextPrompt(null)}
          style={{
            flex: 1,
            padding: "8px 12px",
            background: "#555",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 13
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  </div>
)}
{/* ===== PROGRESS OVERLAY (spinner only) ===== */}
{loadingState && (
  <div style={{
    position: "fixed",
    top: 0,
    left: 0,
    width: "100vw",
    height: "100vh",
    background: "rgba(10,10,20,0.78)",
    backdropFilter: "blur(2px)",
    zIndex: 5000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "auto"
  }}>
    <div style={{
      background: "linear-gradient(135deg, #1a1a2e, #0d0d1a)",
      border: "1px solid rgba(0,188,212,0.3)",
      borderRadius: 10,
      padding: "22px 28px",
      minWidth: 320,
      maxWidth: 420,
      textAlign: "center",
      color: "#fff",
      boxShadow: "0 8px 24px rgba(0,0,0,0.6)"
    }}>
      <div style={{
        width: 42,
        height: 42,
        margin: "4px auto 14px",
        border: "4px solid rgba(0,188,212,0.18)",
        borderTop: "4px solid #00bcd4",
        borderRadius: "50%",
        animation: "spin 0.9s linear infinite"
      }}/>

      <div style={{
        fontWeight: "bold",
        fontSize: 16,
        color: "#00bcd4",
        marginBottom: 4
      }}>
        {loadingState.title || "Working…"}
      </div>

      {loadingState.subtitle && (
        <div style={{color: "#bbb", fontSize: 12, marginTop: 4}}>
          {loadingState.subtitle}
        </div>
      )}
    </div>

    <style>{`
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `}</style>
  </div>
)}
{showOptimizePrompt && (
  <div style={{position:"absolute",top:"30%",left:"35%",background:"#fff",padding:20,border:"2px solid black",zIndex:1000}}>
    <div style={{marginBottom:10,fontWeight:"bold"}}>Do you want to Auto-Optimize this network?</div>
    <button
      onClick={async () => {
        if (!importedData.length) { setShowOptimizePrompt(false); return; }

        // Reset map state and load uploaded coords as SRAs first
        nodesRef.current.forEach(n => { if (n.marker) n.marker.remove(); });
        nodesRef.current = [];

        for (const r of importedData) {
          addNode(mapRef.current, r.Longitude, r.Latitude, "sra", r.Name, true);
        }

        // Run the NEW optimizer
        await runFullOptimizer({
          nodes: nodesRef.current,
          addNodeFn: addNode,
          mapRef: mapRef.current,
        });

        // Center map
        let avgLat = 0, avgLng = 0;
        for (const r of importedData) { avgLat += r.Latitude; avgLng += r.Longitude; }
        avgLat /= importedData.length;
        avgLng /= importedData.length;
        mapRef.current.flyTo({ center: [avgLng, avgLat], zoom: 13 });

        redraw();
        setShowOptimizePrompt(false);
      }}
      style={{marginRight:10}}
    >
      Yes
    </button>
    <button
      onClick={() => {
        setShowOptimizePrompt(false);
        importedData.forEach(r => {
         addNode(mapRef.current, r.Longitude, r.Latitude, "sra", r.Name, true);
        });
        let avgLat = 0, avgLng = 0;
        for (const r of importedData) { avgLat += r.Latitude; avgLng += r.Longitude; }
        avgLat /= importedData.length;
        avgLng /= importedData.length;
        mapRef.current.flyTo({ center: [avgLng, avgLat], zoom: 13 });
        redraw();
      }}
    >
      No
    </button>
  </div>
)}
<div style={{width:300,display:"flex",flexDirection:"column",height:"100%",borderRight:"1px solid #333",background:"#1a1a2e"}}>
  {/* ========== PROJECT TABS ========== */}
  <div style={{display:"flex",alignItems:"center",borderBottom:"2px solid #333",background:"#0d0d1a",padding:"0",overflowX:"auto",flexShrink:0,minHeight:36}}>
    {projects.map(p => (
      <div key={p.id}
        onClick={() => switchProject(p.id)}
        onDoubleClick={(e) => { e.stopPropagation(); renameProject(p.id); }}
        title={"Click to switch • Double-click to rename"}
        style={{
          display:"flex",alignItems:"center",gap:4,
          padding:"8px 12px",
          background: p.id === activeProjectId ? "#1a1a2e" : "transparent",
          color: p.id === activeProjectId ? "#00bcd4" : "#aaa",
          borderBottom: p.id === activeProjectId ? "2px solid #00bcd4" : "2px solid transparent",
          cursor:"pointer",fontSize:12,fontWeight:"bold",
          whiteSpace:"nowrap",userSelect:"none",
          transition:"all 0.15s"
        }}>
        <span>{p.name}</span>
        {projects.length > 1 && (
          <span
            onClick={(e) => { e.stopPropagation(); deleteProject(p.id); }}
            style={{color: p.id === activeProjectId ? "#00bcd4" : "#999",cursor:"pointer",fontSize:14,marginLeft:2,lineHeight:"1"}}
            onMouseEnter={e => e.target.style.color = "red"}
            onMouseLeave={e => e.target.style.color = p.id === activeProjectId ? "#00bcd4" : "#999"}
          >{"\u00D7"}</span>
        )}
      </div>
    ))}
    <button onClick={addProject} title="New Project" style={{
      padding:"4px 10px",background:"transparent",color:"#999",
      border:"none",cursor:"pointer",fontSize:18,fontWeight:"bold",flexShrink:0
    }}
    onMouseEnter={e => e.target.style.color = "#00bcd4"}
    onMouseLeave={e => e.target.style.color = "#999"}
    >+</button>
  </div>
  {/* ========== SIDEBAR CONTENT ========== */}
  <div style={{padding:12}}>
  {/* ===== SIDEBAR STATUS HEADER ===== */}
<div style={{
  marginBottom: 10,
  padding: "8px 10px",
  borderRadius: 6,
  background: "linear-gradient(135deg, #0d0d1a, #1a1a2e)",
  border: "1px solid rgba(255,255,255,0.08)",
  boxShadow: "0 1px 3px rgba(0,0,0,0.4)"
}}>
  {/* App / project title */}
  <div style={{
    display:"flex",
    justifyContent:"space-between",
    alignItems:"center",
    marginBottom: 6
  }}>
    <div style={{ fontWeight: "bold", color:"#00bcd4", fontSize: 13 }}>
      📡 RF Planner
    </div>
    <div style={{ color:"#888", fontSize: 11 }}>
      {projects.find(p => p.id === activeProjectId)?.name || "Project"}
    </div>
  </div>

  {/* Health badge */}
  {(() => {
    const totalNodes      = nodesRef.current.length;
    const flaggedCount    = nodesRef.current.filter(n => n.flagged && n.type !== "single").length;
    const disconnected    = nodesRef.current.filter(n => n.outOfRange && n.type !== "single").length;

    let badgeColor = "#4caf50";   // green
    let badgeText  = "🟢 Healthy";
    if (disconnected > 0) {
      badgeColor = "#f44336";
      badgeText  = "⚠️ Disconnected";
    } else if (flaggedCount > 0) {
      badgeColor = "#ff1493";
      badgeText  = "🟪 Flagged";
    }

    return (
      <div style={{
        display:"flex",
        justifyContent:"space-between",
        alignItems:"center"
      }}>
        <div style={{
          background: badgeColor,
          color: "#fff",
          fontWeight: "bold",
          fontSize: 11,
          padding: "2px 8px",
          borderRadius: 999
        }}>
          {badgeText}
        </div>

        <div style={{ color:"#aaa", fontSize: 11 }}>
          {totalNodes} nodes
          {flaggedCount > 0 && (
            <span style={{color:"#ff1493", marginLeft:6}}>
              | 🟪 {flaggedCount}
            </span>
          )}
          {disconnected > 0 && (
            <span style={{color:"red", marginLeft:6}}>
              | ⚠️ {disconnected}
            </span>
          )}
        </div>
      </div>
    );
  })()}
</div>
    <div style={{display:"flex",gap:4}}>
      <button onClick={()=>setMode("gateway")} style={{flex:1,padding:"6px",border:"1px solid #fff",cursor:"pointer",color:"white",background:mode==="gateway"?"#0000cc":"blue",fontWeight:"bold",fontSize:11}}>{"\uD83D\uDD35"} Gateway</button>
      <button onClick={()=>setMode("lra")} style={{flex:1,padding:"6px",border:"1px solid #fff",cursor:"pointer",color:"white",background:mode==="lra"?"#cc7a00":"orange",fontWeight:"bold",fontSize:11}}>{"\uD83D\uDFE0"} LRA</button>
      <button onClick={()=>setMode("sra")} style={{flex:1,padding:"6px",border:"1px solid #fff",cursor:"pointer",color:"white",background:mode==="sra"?"#2e7d32":"green",fontWeight:"bold",fontSize:11}}>{"\uD83D\uDFE2"} SRA</button>
      <button onClick={()=>setMode("single")} style={{flex:1,padding:"6px",border:"1px solid #fff",cursor:"pointer",color:"white",background:mode==="single"?"#333":"black",fontWeight:"bold",fontSize:11}}>{"\u26AB"} Single</button>
    </div>
<button
  onClick={newAutoOptimize}
  style={{
    marginTop: 6,
    width: "100%",
    background: "#4CAF50",
    color: "white",
    padding: "6px",
    border: "1px solid #fff",
    cursor: "pointer",
    fontWeight: "bold"
  }}
>
  ⚡ Auto-Optimize
</button>
    <button onClick={()=>{nodesRef.current.forEach(n=>{if(n.marker)n.marker.remove();});nodesRef.current=[];linksRef.current={};setRecommendations([]);setSelectedNode(null);redraw();}} style={{marginTop:6,width:"100%",background:"#f44336",color:"white",padding:"6px",border:"1px solid #fff",cursor:"pointer"}}>{"\uD83D\uDDD1\uFE0F"} Clear All</button>
  </div>
  <div style={{flex:1,overflowY:"auto",padding:12}}>
    <div style={{position:"relative"}}>
      <button onClick={()=>setShowFileMenu(!showFileMenu)} style={{width:"100%",marginBottom:6,background:"#555",color:"white",border:"none",padding:"6px",cursor:"pointer",fontSize:14}}>{"\uD83D\uDCC1"} File {showFileMenu?"\u25B2":"\u25BC"}</button>
      {showFileMenu && (<div style={{background:"#333",border:"1px solid #555",borderRadius:4,marginBottom:6,overflow:"hidden"}}>
        <button onClick={()=>{saveNetwork();setShowFileMenu(false);}} style={{width:"100%",padding:"8px 12px",background:"transparent",color:"white",border:"none",borderBottom:"1px solid #444",cursor:"pointer",textAlign:"left",fontSize:13}}>{"\uD83D\uDCBE"} Save Network</button>
        <label style={{display:"block",width:"100%",padding:"8px 12px",color:"white",borderBottom:"1px solid #444",cursor:"pointer",fontSize:13,boxSizing:"border-box"}}>{"\uD83D\uDCC2"} Load Network<input type="file" accept=".json" onChange={(e)=>{loadNetwork(e);setShowFileMenu(false);}} style={{display:"none"}}/></label>
        <button onClick={()=>{exportExcel();setShowFileMenu(false);}} style={{width:"100%",padding:"8px 12px",background:"transparent",color:"#FF9800",border:"none",borderBottom:"1px solid #444",cursor:"pointer",textAlign:"left",fontSize:13}}>{"\uD83D\uDCCA"} Export to Excel</button>
        <button
  onClick={() => { exportInstallReport(); setShowFileMenu(false); }}
  style={{
    width: "100%",
    padding: "8px 12px",
    background: "transparent",
    color: "#4caf50",
    border: "none",
    borderBottom: "1px solid #444",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 13,
    fontWeight: "bold"
  }}
>
  📄 Export Install Report (NEW)
</button>
<button
  onClick={() => { exportInstallReportPDF(); setShowFileMenu(false); }}
  style={{
    width: "100%",
    padding: "8px 12px",
    background: "transparent",
    color: "#ff5252",
    border: "none",
    borderBottom: "1px solid #444",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 13,
    fontWeight: "bold"
  }}
>
  🧾 Export Install Report (PDF)
</button>
        <button onClick={()=>{exportBundle();setShowFileMenu(false);}} style={{width:"100%",padding:"8px 12px",background:"transparent",color:"#CE93D8",border:"none",cursor:"pointer",textAlign:"left",fontSize:13}}>{"\uD83D\uDCE6"} Export All (Zip)</button>
      </div>)}
    </div>
    <div style={{display:"flex",gap:4,marginTop:6}}>
      <button onClick={undo} style={{flex:1,background:"#666",color:"white",padding:"6px",border:"none",cursor:"pointer"}}>{"\u21A9\uFE0F"} Undo</button>
      <button onClick={redo} style={{flex:1,background:"#666",color:"white",padding:"6px",border:"none",cursor:"pointer"}}>{"\u21AA\uFE0F"} Redo</button>
    </div>
    <div style={{display:"flex",gap:4,marginTop:6}}>
      <button onClick={()=>{clearMeasure();setMeasureMode(!measureMode);}} style={{flex:1,background:measureMode?"#ff00ff":"#666",color:"white",padding:"6px",border:"none",cursor:"pointer"}}>{measureMode?"\uD83D\uDCCF Measuring...":"\uD83D\uDCCF Measure"}</button>
      <button onClick={()=>{clearMeasure();setMeasureMode(false);}} style={{flex:1,background:"#666",color:"white",padding:"6px",border:"none",cursor:"pointer"}}>{"\u2715"} Clear</button>
      <button onClick={()=>{if(measurePoints.current.length===2){generateMeasureProfile(measurePoints.current[0],measurePoints.current[1]);}}} style={{flex:1,background:"#8B7355",color:"white",padding:"6px",border:"none",cursor:"pointer"}}>{"\uD83D\uDCCA"} Profile</button>
    </div>
    <hr/>
    <textarea value={inputCoords} onChange={e=>setInputCoords(e.target.value)} placeholder="Name,Lat,Lng" style={{width:"100%",height:80}}/>
    <button onClick={importText} style={{width:"100%",marginBottom:6,background:"#4CAF50",color:"white",border:"none",padding:"6px",cursor:"pointer",fontSize:14}}>{"\uD83D\uDCCD"} Import Coordinates</button>
    <label style={{display:"block",width:"100%",marginBottom:6,padding:"6px",background:"#2196F3",color:"white",textAlign:"center",cursor:"pointer",border:"none",fontSize:14,boxSizing:"border-box"}}>{"\uD83D\uDCC2"} Upload Excel<input type="file" accept=".xlsx,.xls" onChange={uploadExcel} style={{display:"none"}}/></label>
    <label style={{display:"block",width:"100%",marginBottom:6,padding:"6px",background:"#8e44ad",color:"white",textAlign:"center",cursor:"pointer",border:"none",fontSize:14,boxSizing:"border-box"}}>📍 Upload KMZ<input type="file" accept=".kmz" onChange={uploadKmz} style={{display:"none"}}/></label>
    <hr/>
    <hr/>
    {/* ===== NODE LIST (v2 — aligned with new optimizer) ===== */}
<div>
  {/* Header */}
  <div style={{fontWeight:"bold",marginBottom:6,color:"#fff",fontSize:13}}>
    Nodes ({nodesRef.current.length})
  </div>

  {/* Counts row 1 */}
  <div style={{fontSize:11,color:"#aaa",marginBottom:2}}>
    🔵 {nodesRef.current.filter(n=>n.type==="gateway").length} Gateway
    {" | "}
    🟠 {nodesRef.current.filter(n=>n.type==="lra").length} LRA
    {" | "}
    🟢 {nodesRef.current.filter(n=>n.type==="sra").length} SRA
  </div>

  {/* Counts row 2 — single, flagged, disconnected */}
  <div style={{fontSize:11,color:"#aaa",marginBottom:6}}>
    ⚫ {nodesRef.current.filter(n=>n.type==="single").length} Single

    {nodesRef.current.filter(n=>n.flagged && n.type!=="single").length>0 && (
      <span style={{color:"#ff1493", marginLeft:6}}>
        | 🟪 {nodesRef.current.filter(n=>n.flagged && n.type!=="single").length} Flagged
      </span>
    )}

    {nodesRef.current.filter(n=>n.outOfRange && n.type!=="single").length>0 && (
      <span style={{color:"red", marginLeft:6}}>
        | ⚠️ {nodesRef.current.filter(n=>n.outOfRange && n.type!=="single").length} Disconnected
      </span>
    )}
  </div>

  {/* Node list */}
  {nodesRef.current.map((n,i)=> {
    let color;
    if (n.outOfRange) color = "#888";
    else if (n.type === "gateway") color = "#3a8dff";
    else if (n.type === "lra")     color = "#ff9500";
    else if (n.type === "sra")     color = "#4caf50";
    else if (n.type === "single")  color = "#999";
    else color = "#ccc";

    return (
      <div key={i} style={{
        marginBottom:4,
        paddingBottom:4,
        borderBottom:"1px dashed rgba(255,255,255,0.07)"
      }}>
        <span
          style={{
            color,
            cursor:"pointer",
            textDecoration:"underline",
            fontWeight: n.flagged || n.outOfRange ? "bold" : "normal"
          }}
          onClick={()=>{
            mapRef.current.flyTo({center:[n.lng,n.lat],zoom:15});
            setSelectedNode(n);
            setEditName(n.name);
            setEditType(n.type);
            setEditHeight(n.height);
            setEditModbus(n.modbusId || "");
            if(n.type !== "gateway" && n.type !== "single" && linksRef.current[n.name]){
              try { generateProfile(n); } catch(err){ console.log("Profile error:", err); }
            } else {
              setProfileData({
                from: n, to: n,
                points: [{ dist:0, elev:0, lng:n.lng, lat:n.lat }],
                totalDist: 0, isMeasure: false
              });
              setProfileFromHeight(n.height);
              setProfileToHeight(n.height);
              setProfileFromType(n.type);
              setProfileToType(n.type);
              setShowProfile(true);
            }
          }}
        >
          {n.name} ({n.type.toUpperCase()})
          {n.type !== "single" ? ` ${n.height} ft` : ""}
          {n.modbusId ? ` [M:${n.modbusId}]` : ""}
        </span>

        <div style={{marginLeft:10, marginTop:2, fontSize:11}}>
          {n.elevation !== null && (
            <span style={{color:"#aaa"}}>Elev: {n.elevation} ft</span>
          )}

          {n.flagged && !n.outOfRange && (
            <span style={{color:"#ff1493", marginLeft:8, fontWeight:"bold"}}>
              🟪 FLAGGED
            </span>
          )}

          {n.outOfRange && (
            <span style={{color:"red", marginLeft:8, fontWeight:"bold"}}>
              ⚠️ DISCONNECTED
            </span>
          )}

          {n.blocked && n.blockDetail && !n.outOfRange && (
            <div style={{color:"#ff6b6b", fontSize:11, marginTop:2}}>
              {n.blockDetail}
            </div>
          )}
        </div>
      </div>
    );
  })}
</div>
    <hr/>
    {recommendations.map((r,i)=>(<div key={i} style={{marginBottom:6,cursor:r.node?"pointer":"default",textDecoration:r.node?"underline":"none",color:r.node?"#2196F3":"inherit"}}
      onClick={()=>{if(r.node)generateProfile(r.node,r.target||null);}}>{r.text}{r.node&&" \uD83D\uDCCA"}</div>))}
  </div>
</div>

   {showProfile&&profileData&&(<div style={{position:"absolute",top:"2%",left:"10%",width:"80%",maxHeight:"96vh",background:"#1a1a2e",border:"2px solid #00bcd4",borderRadius:8,zIndex:2000,padding:8,overflow:"auto"}}>
 <div style={{display:"flex",justifyContent:"flex-end",marginBottom:2}}>
    <button onClick={()=>setShowProfile(false)} style={{background:"red",color:"white",border:"none",borderRadius:"50%",width:28,height:28,cursor:"pointer",fontWeight:"bold",fontSize:14}}>{"\u2715"}</button>
  </div>
  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
    <div style={{display:"flex",alignItems:"center",gap:4}}>
      <span style={{color:"#00bcd4",fontSize:11}}>{profileData.from.name}:</span>
      <select value={profileFromType} onChange={e=>{const t=e.target.value;setProfileFromType(t);if(t==="gateway")setProfileFromHeight(15);else if(t==="lra")setProfileFromHeight(10);else if(t==="single")setProfileFromHeight(0);else setProfileFromHeight(5);}} style={{background:"#333",color:"white",border:"1px solid #00bcd4",borderRadius:4,padding:2,fontSize:11}}>
        <option value="gateway">Gateway</option><option value="lra">LRA</option><option value="sra">SRA</option><option value="single">Single</option>
      </select>
      <input type="number" value={profileFromHeight} onChange={e=>setProfileFromHeight(Number(e.target.value))} style={{width:45,background:"#333",color:"white",border:"1px solid #00bcd4",borderRadius:4,padding:2,fontSize:11}}/>
      <span style={{color:"#888",fontSize:10}}>ft</span>
      <button onClick={()=>{profileData.from.type=profileFromType;profileData.from.outOfRange=false;profileData.from.height=profileFromHeight;profileData.from.range=profileFromType==="single"?0:profileFromType==="sra"?0.75:3;if(profileData.from.markerElement){profileData.from.markerElement.style.background=profileFromType==="gateway"?"blue":profileFromType==="lra"?"orange":profileFromType==="single"?"black":"green";}redraw();}} style={{background:"#4CAF50",color:"white",border:"none",borderRadius:4,padding:"2px 6px",cursor:"pointer",fontSize:10}}>Apply</button>
    </div>
    <div style={{display:"flex",alignItems:"center",gap:4}}>
      <span style={{color:"#00bcd4",fontSize:11}}>{profileData.to.name}:</span>
      <select value={profileToType} onChange={e=>{const t=e.target.value;setProfileToType(t);if(t==="gateway")setProfileToHeight(15);else if(t==="lra")setProfileToHeight(10);else if(t==="single")setProfileToHeight(0);else setProfileToHeight(5);}} style={{background:"#333",color:"white",border:"1px solid #00bcd4",borderRadius:4,padding:2,fontSize:11}}>
        <option value="gateway">Gateway</option><option value="lra">LRA</option><option value="sra">SRA</option><option value="single">Single</option>
      </select>
      <input type="number" value={profileToHeight} onChange={e=>setProfileToHeight(Number(e.target.value))} style={{width:45,background:"#333",color:"white",border:"1px solid #00bcd4",borderRadius:4,padding:2,fontSize:11}}/>
      <span style={{color:"#888",fontSize:10}}>ft</span>
      <button onClick={()=>{profileData.to.type=profileToType;profileData.to.outOfRange=false;profileData.to.height=profileToHeight;profileData.to.range=profileToType==="single"?0:profileToType==="sra"?0.75:3;if(profileData.to.markerElement){profileData.to.markerElement.style.background=profileToType==="gateway"?"blue":profileToType==="lra"?"orange":profileToType==="single"?"black":"green";}redraw();}} style={{background:"#4CAF50",color:"white",border:"none",borderRadius:4,padding:"2px 6px",cursor:"pointer",fontSize:10}}>Apply</button>
    </div>
  </div>
<canvas ref={canvasRef} width={800} height={380} style={{width:"100%",height:"auto"}}/>
 {selectedNode && (
    <div style={{display:"flex",gap:8,marginTop:8,padding:"8px 4px",borderTop:"1px solid #333",alignItems:"center",flexWrap:"wrap"}}>
      <div style={{display:"flex",alignItems:"center",gap:4}}>
        <label style={{color:"#888",fontSize:11}}>Name:</label>
        <input value={editName} onChange={e=>setEditName(e.target.value)} style={{width:160,padding:3,background:"#333",color:"white",border:"1px solid #555",borderRadius:4,fontSize:11}}/>
      </div>
      {editType !== "gateway" && (
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          <label style={{color:"#888",fontSize:11}}>Modbus:</label>
          <input type="number" value={editModbus} onChange={e=>setEditModbus(Number(e.target.value))} style={{width:50,padding:3,background:"#333",color:"white",border:"1px solid #555",borderRadius:4,fontSize:11}}/>
        </div>
      )}
      <button onClick={()=>{
        if(!selectedNode) return;
        selectedNode.name=editName;selectedNode.modbusId=selectedNode.type==="gateway"?null:(editModbus||null);
        saveSnapshot();setNodeVersion(v=>v+1);redraw();
      }} style={{padding:"4px 12px",background:"#4CAF50",color:"white",border:"none",borderRadius:4,cursor:"pointer",fontWeight:"bold",fontSize:11}}>
        {"\uD83D\uDCBE"} Save
      </button>
    </div>
  )}
</div>)}
<div style={{flex:1,position:"relative"}}>
  <div ref={containerRef} style={{width:"100%",height:"100%"}}/>
  {/* ===== Inline Node Editor (single-click popup) ===== */}
{selectedNode && !showProfile && (
  <div style={{
    position: "absolute",
    top: 60,
    right: 10,
    zIndex: 1200,
    width: 260,
    background: "linear-gradient(135deg,#1a1a2e,#0d0d1a)",
    border: "1px solid rgba(0,188,212,0.4)",
    borderRadius: 8,
    boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
    color: "#fff",
    padding: 12
  }}>
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 8
    }}>
      <div style={{ color: "#00bcd4", fontWeight: "bold", fontSize: 13 }}>
        🛠️ Edit Node
      </div>
      <button
        onClick={() => setSelectedNode(null)}
        style={{
          background: "transparent",
          color: "#bbb",
          border: "none",
          cursor: "pointer",
          fontSize: 14
        }}
      >
        ✕
      </button>
    </div>

    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div>
        <label style={{ color: "#888", fontSize: 11 }}>Name</label>
        <input
          value={editName}
          onChange={e => setEditName(e.target.value)}
          style={{
            width: "100%",
            padding: 4,
            background: "#333",
            color: "#fff",
            border: "1px solid #555",
            borderRadius: 4,
            fontSize: 12,
            boxSizing: "border-box"
          }}
        />
      </div>

      <div>
        <label style={{ color: "#888", fontSize: 11 }}>Type</label>
        <select
          value={editType}
          onChange={e => setEditType(e.target.value)}
          style={{
            width: "100%",
            padding: 4,
            background: "#333",
            color: "#fff",
            border: "1px solid #555",
            borderRadius: 4,
            fontSize: 12,
            boxSizing: "border-box"
          }}
        >
          <option value="gateway">Gateway</option>
          <option value="lra">LRA</option>
          <option value="sra">SRA</option>
          <option value="single">Single Modem</option>
        </select>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={{ color: "#888", fontSize: 11 }}>Height (ft)</label>
          <input
            type="number"
            value={editHeight}
            onChange={e => setEditHeight(Number(e.target.value))}
            style={{
              width: "100%",
              padding: 4,
              background: "#333",
              color: "#fff",
              border: "1px solid #555",
              borderRadius: 4,
              fontSize: 12,
              boxSizing: "border-box"
            }}
          />
        </div>

        {editType !== "gateway" && (
          <div style={{ flex: 1 }}>
            <label style={{ color: "#888", fontSize: 11 }}>Modbus</label>
            <input
              type="number"
              value={editModbus}
              onChange={e => setEditModbus(Number(e.target.value))}
              style={{
                width: "100%",
                padding: 4,
                background: "#333",
                color: "#fff",
                border: "1px solid #555",
                borderRadius: 4,
                fontSize: 12,
                boxSizing: "border-box"
              }}
            />
          </div>
        )}
      </div>

      <button
        onClick={() => {
          if (!selectedNode) return;
          selectedNode.name = editName;
          selectedNode.type = editType;
          selectedNode.height = editHeight;
          selectedNode.range =
            editType === "gateway" ? 3 :
            editType === "lra" ? 3 :
            editType === "single" ? 0 : 0.75;
          selectedNode.modbusId = editType === "gateway" ? null : (editModbus || null);

          // Update visible color immediately
          if (selectedNode.markerElement) {
            selectedNode.markerElement.style.background =
              editType === "gateway" ? "blue" :
              editType === "lra" ? "orange" :
              editType === "single" ? "black" : "green";
          }

          saveSnapshot();
          setNodeVersion(v => v + 1);
          redraw();
        }}
        style={{
          marginTop: 4,
          padding: "6px 10px",
          background: "#4CAF50",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          cursor: "pointer",
          fontWeight: "bold",
          fontSize: 12
        }}
      >
        💾 Save Changes
      </button>
    </div>
  </div>
)}
  {/* ===== Map Legend (new) ===== */}
<MapLegend />
  {showHeatmap && (
    <div style={{position:"absolute",bottom:30,right:10,zIndex:1000,background:"rgba(20,20,30,0.9)",
      border:"1px solid rgba(255,255,255,0.3)",borderRadius:8,padding:"10px 14px",
      backdropFilter:"blur(4px)",boxShadow:"0 2px 8px rgba(0,0,0,0.5)"}}>
      <div style={{color:"#fff",fontWeight:"bold",fontSize:12,marginBottom:6}}>{"\uD83D\uDCE1"} Signal Coverage</div>
      {[
        {color:"#008000",label:"Strong (Gateway)"},
        {color:"#00c800",label:"Good"},
        {color:"#00ffff",label:"Moderate"},
        {color:"#ffff00",label:"Fair"},
        {color:"#ff8000",label:"Weak"},
        {color:"#ff0000",label:"Fringe"}
      ].map((item,i) => (
        <div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
          <div style={{width:16,height:10,borderRadius:2,background:item.color,opacity:0.8}}/>
          <span style={{color:"#ccc",fontSize:11}}>{item.label}</span>
        </div>
      ))}
    </div>
  )}
  <button onClick={toggleHeatmap} style={{position:"absolute",top:10,right:170,zIndex:1000,padding:"8px 14px",
    background:showHeatmap?"#4CAF50":"rgba(50,50,50,0.85)",
    color:showHeatmap?"#fff":"#fff",
    border:showHeatmap?"2px solid #388E3C":"2px solid rgba(255,255,255,0.3)",
    borderRadius:6,cursor:"pointer",fontWeight:"bold",fontSize:13,
    backdropFilter:"blur(4px)",boxShadow:"0 2px 8px rgba(0,0,0,0.4)"}}>
    {showHeatmap?"\uD83D\uDCE1 Heatmap \u2705":"\uD83D\uDCE1 Heatmap"}
  </button>
  <button onClick={toggleFCCTowers} style={{position:"absolute",top:10,right:10,zIndex:1000,padding:"8px 14px",
    background:showFCCTowers?"#FFD700":"rgba(50,50,50,0.85)",
    color:showFCCTowers?"#000":"#fff",
    border:showFCCTowers?"2px solid #DAA520":"2px solid rgba(255,255,255,0.3)",
    borderRadius:6,cursor:"pointer",fontWeight:"bold",fontSize:13,
    backdropFilter:"blur(4px)",boxShadow:"0 2px 8px rgba(0,0,0,0.4)"}}>
    {fccLoading?"\u23F3 Loading...":showFCCTowers?"\uD83D\uDDFC FCC Towers \u2705":"\uD83D\uDDFC FCC Towers"}
  </button>
</div>
</div>);
}
