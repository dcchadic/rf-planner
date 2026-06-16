"use client";

import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import html2canvas from "html2canvas";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// ---------- CACHES ----------
const elevationCache = {};
const fresnelCache = {};

export default function Map(){

  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const nodesRef = useRef([]);
  const linksRef = useRef({});
  const undoStack = useRef([]);
  const redoStack = useRef([]);

  const [mode,setMode] = useState("sra");
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
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      skipNextClick.current = true;
      setSelectedNode(node);
      setEditName(node.name);
      setEditType(node.type);
      setEditHeight(node.height);
      setEditModbus(node.modbusId || "");
    });
    el.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      skipNextClick.current = true;
      setSelectedNode(node);
      setEditName(node.name);
      setEditType(node.type);
      setEditHeight(node.height);
      setEditModbus(node.modbusId || "");
      if(node.type !== "gateway" && node.type !== "single" && linksRef.current[node.name]){
        try{ generateProfile(node); }catch(err){ console.log("Profile error:", err); }
      } else {
        setProfileData({ from: node, to: node, points: [{dist:0,elev:0,lng:node.lng,lat:node.lat}], totalDist: 0, isMeasure: false });
        setProfileFromHeight(node.height); setProfileToHeight(node.height);
        setProfileFromType(node.type); setProfileToType(node.type);
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

  // ---------- DRAW ----------
  async function draw(){
    const map = mapRef.current;
    if(!map) return;
    for (const n of nodesRef.current){ n.blocked = false; n.blockDetail = null; n.fresnelWarn = false; n.fresnelDetail = null; n.fresnelTarget = null; }
    await computeLinks();
    for (const n of nodesRef.current){
      if (n.type === "gateway") { n.outOfRange = false; continue; }
      if (n.type === "single") { n.outOfRange = false; continue; }
      const path = getPath(n);
      n.outOfRange = !path.some(p => p.type === "gateway");
    }
    console.log("LINKS:", linksRef.current);
    const layers = map.getStyle().layers || [];
    layers.forEach(l=>{
      if(l.id.startsWith("node") || l.id.startsWith("line") || l.id.startsWith("label") || l.id.startsWith("route") || l.id === "all-nodes"){
        if(map.getLayer(l.id)) map.removeLayer(l.id);
        if(map.getSource(l.id)) map.removeSource(l.id);
      }
    });
    const nodeFeatures = [];
    for(let k=0; k<nodesRef.current.length; k++){
      const nd = nodesRef.current[k];
      if (nd.elevation === null){ nd.elevation = Math.round(await getElevation(nd.lng, nd.lat)); }
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
    map.addSource("all-nodes", { type: "geojson", data: { type: "FeatureCollection", features: nodeFeatures } });
    map.addLayer({
      id: "all-nodes", type: "symbol", source: "all-nodes",
      layout: { "text-field": ["get", "text"], "text-size": 13, "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"],
        "text-variable-anchor": ["top","bottom","left","right"],
        "text-radial-offset": 1.2, "text-justify": "auto", "text-allow-overlap": false },
      paint: { "text-color": "#00ffff", "text-halo-color": "#000000", "text-halo-width": 2 }
    });
    const drawnLinks = new Set();
    for(let i=0;i<nodesRef.current.length;i++){
      const a = nodesRef.current[i];
      if(a.type==="gateway") continue;
      if(a.type==="single") continue;
      const path = getPath(a);
      if (!path || path.length < 2) continue;
      for(let j=0;j<path.length-1;j++){
        const p1 = path[j]; const p2 = path[j+1];
        const linkKey = [p1.name, p2.name].sort().join("\u2192");
        if(drawnLinks.has(linkKey)) continue;
        drawnLinks.add(linkKey);
        const los = await checkLOS(p1, p2, p1.height, p2.height);
        const d = distance(p1,p2);
        const signal = calcPower(d);
        if (!los.clear){
          p1.blocked = true;
          p1.blockDetail = `\u26F0\uFE0F +${Math.ceil(los.requiredHeight)}ft to clear \u2192 ${p2.name}`;
        }
        const lineId = `line-${i}-${j}`;
        if (map.getSource(lineId)) { try { map.removeLayer(lineId); map.removeSource(lineId); } catch {} }
        map.addSource(lineId,{ type:"geojson", data:{ type:"Feature", geometry:{ type:"LineString", coordinates:[[p1.lng,p1.lat],[p2.lng,p2.lat]] } } });
        let fresnelPct = 100;
        if(los.clear){
          const totalDistM2 = d * 1609.34;
          const wl = 0.333;
          if(totalDistM2 > 0){
            const elev1 = await getElevation(p1.lng, p1.lat);
            const elev2 = await getElevation(p2.lng, p2.lat);
            const tip1f = elev1 + p1.height;
            const tip2f = elev2 + p2.height;
            const checkSteps = 20;
            for(let s = 1; s < checkSteps; s++){
              const t2 = s / checkSteps;
              const d1m = t2 * totalDistM2;
              const d2m = totalDistM2 - d1m;
              const fR = (d1m > 0 && d2m > 0) ? Math.sqrt(wl * d1m * d2m / totalDistM2) * 3.281 : 0;
              if(fR <= 0) continue;
              const lng2 = p1.lng + (p2.lng - p1.lng) * t2;
              const lat2 = p1.lat + (p2.lat - p1.lat) * t2;
              const ev = await getElevation(lng2, lat2);
              const losE = tip1f + (tip2f - tip1f) * t2;
              const cl = losE - ev;
              const pct2 = (cl / fR) * 100;
              if(pct2 < fresnelPct) fresnelPct = pct2;
            }
          }
        }
        let lineColor = "red";
        if(los.clear){
          const fp = Math.max(0, Math.min(100, fresnelPct));
          const stops = [
            { pct: 0, r: 244, g: 67, b: 54 },
            { pct: 20, r: 255, g: 152, b: 0 },
            { pct: 40, r: 255, g: 215, b: 0 },
            { pct: 60, r: 139, g: 195, b: 74 },
            { pct: 80, r: 76, g: 175, b: 80 },
            { pct: 100, r: 46, g: 125, b: 50 }
          ];
          let lower = stops[0], upper = stops[stops.length - 1];
          for(let s = 0; s < stops.length - 1; s++){
            if(fp >= stops[s].pct && fp <= stops[s + 1].pct){ lower = stops[s]; upper = stops[s + 1]; break; }
          }
          const range = upper.pct - lower.pct || 1;
          const t = (fp - lower.pct) / range;
          const r = Math.round(lower.r + (upper.r - lower.r) * t);
          const g = Math.round(lower.g + (upper.g - lower.g) * t);
          const b = Math.round(lower.b + (upper.b - lower.b) * t);
          lineColor = `rgb(${r},${g},${b})`;
        }
        const fresnelLoss = (los.clear && fresnelPct < 60) ? (60 - Math.max(0, fresnelPct)) / 10 : 0;
        map.addLayer({ id:lineId, type:"line", source:lineId, paint:{
          "line-color": lineColor,
          "line-width":3 }
        });

        if(los.clear && fresnelPct < 60){
          p1.fresnelWarn = true;
          p1.fresnelDetail = `\u26A0\uFE0F Fresnel ${Math.max(0,fresnelPct).toFixed(0)}% clearance \u2192 ${p2.name} \u2014 increase height`;
          p1.fresnelTarget = p2;
        }

        const clickP1=p1,clickP2=p2;
        map.on("click", lineId, (e) => { e.preventDefault(); e.originalEvent.stopPropagation(); skipNextClick.current=true; generateProfile(clickP1, clickP2); });
        map.on("mouseenter", lineId, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", lineId, () => { map.getCanvas().style.cursor = ""; });
        const labelId = `label-${i}-${j}`;
        if (map.getSource(labelId)) { try { map.removeLayer(labelId); map.removeSource(labelId); } catch {} }
        map.addSource(labelId,{ type:"geojson", data:{ type:"Feature",
          geometry:{ type:"Point", coordinates:[(p1.lng+p2.lng)/2,(p1.lat+p2.lat)/2] },
          properties:{ text: los.clear ? `${d.toFixed(2)} mi | ${(signal - fresnelLoss).toFixed(0)} dBm${fresnelLoss > 0 ? ` (F: -${fresnelLoss.toFixed(0)})` : ""}` : `${d.toFixed(2)} mi | BLOCKED | +${Math.ceil(los.requiredHeight)} ft` } } });
        map.addLayer({ id:labelId, type:"symbol", source:labelId,
          layout:{ "text-field":["get","text"], "text-size":13,
            "text-variable-anchor":["top","bottom","left","right"],
            "text-radial-offset":1.2, "text-justify":"auto", "text-allow-overlap":false },
          paint:{ "text-color":"#00ffff", "text-halo-color":"#000000", "text-halo-width":2 }
        });
      }
    }
    for (const n of nodesRef.current){
      if (!n.markerElement) continue;
      if (n.type === "single"){ n.markerElement.style.background = "black"; }
      else if (n.outOfRange){ n.markerElement.style.background = "#666"; n.markerElement.style.border = "2px solid red"; }
      else { n.markerElement.style.background = n.type==="gateway"?"blue":n.type==="lra"?"orange":"green"; n.markerElement.style.border = "none"; }
    }
    if(showHeatmapRef.current) updateHeatmapData();
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
  async function optimizeHeights(){
    for(const node of nodesRef.current){
      if(node.type==="gateway"||node.type==="lra"){
        const maxH=30; const minH=node.type==="gateway"?15:10; let neededHeight=minH;
        for(const other of nodesRef.current){
          if(other===node)continue; if(other.type==="single")continue;
          const d=distance(node,other); const linkRange=(node.type==="lra"||node.type==="gateway")?3:0.75; if(d>linkRange)continue;
          const link=linksRef.current[other.name]; const isConnected=(link===node)||(linksRef.current[node.name]===other); if(!isConnected)continue;
          for(let testH=minH;testH<=maxH;testH+=5){const los=await checkLOS(node,other,testH,other.height);if(los.clear){if(testH>neededHeight)neededHeight=testH;break;}if(testH===maxH)neededHeight=maxH;}
        }
        node.height=neededHeight;
      }
    }
  }
  async function rescueDisconnected(){
    for(let attempt=0;attempt<5;attempt++){
      let disconnected=[];
      for(const node of nodesRef.current){if(node.type==="gateway")continue;if(node.type==="single")continue;const path=getPath(node);if(!path.some(n=>n.type==="gateway"))disconnected.push(node);}
      if(disconnected.length===0){for(const node of nodesRef.current){if(node.type!=="sra")continue;const link=linksRef.current[node.name];if(!link)continue;const los=await checkLOS(node,link,node.height,link.height);if(!los.clear)disconnected.push(node);}}
      if(disconnected.length===0)return;
      let rescued=false;
      for(const disc of disconnected){
        let bestBridge=null,bestBridgeH=999,bestDiscH=999;
        for(const bridge of nodesRef.current){
          if(bridge===disc)continue;if(bridge.type==="single")continue;if(bridge.type==="gateway")continue;
          const dToDisc=distance(bridge,disc);if(dToDisc>3)continue;
          let bridgeConnected=false;const bridgePath=getPath(bridge);if(bridgePath.some(n=>n.type==="gateway"))bridgeConnected=true;
          if(!bridgeConnected){for(const g of nodesRef.current){if(g.type!=="gateway"&&g.type!=="lra")continue;const gPath=getPath(g);if(g.type!=="gateway"&&!gPath.some(n=>n.type==="gateway"))continue;if(distance(bridge,g)<=3){bridgeConnected=true;break;}}}
          if(!bridgeConnected)continue;
          for(let bh=10;bh<=30;bh+=5){for(let dh=5;dh<=30;dh+=5){const los=await checkLOS(bridge,disc,bh,dh);if(los.clear){if(bh+dh<bestBridgeH+bestDiscH){bestBridgeH=bh;bestDiscH=dh;bestBridge=bridge;}break;}}}
        }
        if(bestBridge){
          if(bestBridge.type==="sra"){bestBridge.type="lra";bestBridge.range=3;if(bestBridge.markerElement)bestBridge.markerElement.style.background="orange";}
          bestBridge.height=Math.max(bestBridge.height,bestBridgeH);
          if(bestDiscH>5||distance(bestBridge,disc)>0.75){disc.type="lra";disc.range=3;disc.height=Math.max(disc.height,bestDiscH);if(disc.markerElement)disc.markerElement.style.background="orange";}
          await computeLinks();rescued=true;break;
        }
      }
      if(!rescued)break;
    }
  }

  async function optimizeFresnel(){
    let changed = false;
    for(const a of nodesRef.current){
      if(a.type === "gateway" || a.type === "single") continue;
      const currentLink = linksRef.current[a.name];
      if(!currentLink) continue;
      const currentLOS = await checkLOS(a, currentLink, a.height, currentLink.height);
      if(!currentLOS.clear) continue;
      const currentFresnel = await calcFresnelPct(a, currentLink);
      if(currentFresnel >= 60) continue;
      let bestAlt = null;
      let bestAltFresnel = currentFresnel;
      let bestAltNeedsLRA = false;
      let bestAltCanSRA = false;
      for(const b of nodesRef.current){
        if(b === a || b === currentLink) continue;
        if(b.type === "single") continue;
        const d = distance(a, b);
        let reachable = false;
        let needsLRA = false;
        if(b.type === "gateway" && d <= 3) reachable = true;
        else if(b.type === "lra" && d <= 3) reachable = true;
        else if(d <= a.range) reachable = true;
        else if(d <= 3 && a.type === "sra"){
          needsLRA = true;
          reachable = true;
        }
        if(!reachable) continue;
        const isGateway = b.type === "gateway";
        if(!isGateway){
          const bPath = getPath(b);
          if(!bPath.some(n => n.type === "gateway")) continue;
        }
        const los = await checkLOS(a, b, needsLRA ? 10 : a.height, b.height);
        if(!los.clear) continue;
        const tempA = {...a, height: needsLRA ? 10 : a.height};
        const fpct = await calcFresnelPct(tempA, b);
        if(fpct > bestAltFresnel){
          bestAltFresnel = fpct;
          bestAlt = b;
          bestAltNeedsLRA = needsLRA;
          bestAltCanSRA = (d <= 0.75 && a.type === "lra" && !needsLRA);
        }
      }
      if(bestAlt && bestAltFresnel > currentFresnel){
        linksRef.current[a.name] = bestAlt;
        changed = true;
        if(bestAltNeedsLRA && a.type === "sra"){
          a.type = "lra";
          a.height = 10;
          a.range = 3;
          if(a.markerElement) a.markerElement.style.background = "orange";
        }
        if(bestAltCanSRA && a.type === "lra" && !a._wasUpgraded){
          a.type = "sra";
          a.height = 5;
          a.range = 0.75;
          if(a.markerElement) a.markerElement.style.background = "green";
        }
      }
    }
    return changed;
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
    const fileName = prompt("Name this network:", currentProject?.name || "rf-network");
    if(!fileName) return;
    const saveData = {
      nodes: nodesRef.current.map(n => ({ name:n.name,type:n.type,lat:n.lat,lng:n.lng,height:n.height,range:n.range,modbusId:n.modbusId||null })),
      fccTowersVisible: showFCCTowers
    };
    const blob = new Blob([JSON.stringify(saveData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = fileName + ".json"; a.click(); URL.revokeObjectURL(url);
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
    const folderName=prompt("Name this export:",currentProject?.name || "rf-network"); if(!folderName)return;
    const zip=new JSZip(); const folder=zip.folder(folderName);
    const nodeRows=nodesRef.current.map(n=>({"Name":n.name,"Type":n.type.toUpperCase(),"Latitude":n.lat,"Longitude":n.lng,"Antenna Height (ft)":n.height,"Recommended Height (ft)":n.recommendedHeight||n.height,"Ground Elevation (ft)":n.elevation||"N/A","Range (mi)":n.range,"Status":n.outOfRange?"SINGLE MODEM":n.blocked?"BLOCKED":"OK"}));
    const connectionRows=[];
    for(const a of nodesRef.current){if(a.type==="gateway")continue;const target=linksRef.current[a.name];if(target){const d=distance(a,target);const signal=calcPower(d);connectionRows.push({"From":a.name,"To":target.name,"Distance (mi)":Number(d.toFixed(2)),"Signal (dBm)":Number(signal.toFixed(0)),"LOS":a.blocked?"BLOCKED":"CLEAR"});}else{connectionRows.push({"From":a.name,"To":"NONE","Distance (mi)":"N/A","Signal (dBm)":"N/A","LOS":"NO CONNECTION"});}}
    const summaryRows=[{"Item":"Total Nodes","Value":nodesRef.current.length},{"Item":"Gateways","Value":nodesRef.current.filter(n=>n.type==="gateway").length},{"Item":"LRAs","Value":nodesRef.current.filter(n=>n.type==="lra").length},{"Item":"SRAs","Value":nodesRef.current.filter(n=>n.type==="sra").length},{"Item":"Single Modems","Value":nodesRef.current.filter(n=>n.type==="single"||n.outOfRange).length}];
    const recRows=recommendations.map(r=>({"Recommendation":r.text}));
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(nodeRows),"Nodes");XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(connectionRows),"Connections");XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(summaryRows),"Summary");XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(recRows),"Recommendations");
    const excelBuffer=XLSX.write(wb,{bookType:"xlsx",type:"array"}); folder.file(folderName+"-report.xlsx",excelBuffer);
    const networkData={nodes:nodesRef.current.map(n=>({name:n.name,type:n.type,lat:n.lat,lng:n.lng,height:n.height,range:n.range})),fccTowersVisible:showFCCTowers};
    folder.file(folderName+"-network.json",JSON.stringify(networkData,null,2));
    const mapContainer=containerRef.current;
    const screenshotCanvas=await html2canvas(mapContainer,{useCORS:true,allowTaint:true,backgroundColor:null});
    const dataURL=screenshotCanvas.toDataURL("image/png"); const imgData=dataURL.split(",")[1];
    folder.file(folderName+"-map.png",imgData,{base64:true});
    const url=window.location.href; folder.file("Open RF Planner.url","[InternetShortcut]\nURL="+url+"\n");
    const content=await zip.generateAsync({type:"blob"});
    const blobUrl=URL.createObjectURL(content); const a=document.createElement("a"); a.href=blobUrl; a.download=folderName+".zip"; a.click(); URL.revokeObjectURL(blobUrl);
  }
  function loadNetwork(e){
    const file = e.target.files[0];
    if(!file) return;
    e.target.value = "";
    const reader=new FileReader();
    reader.onload=(evt)=>{
      const raw=JSON.parse(evt.target.result); const map=mapRef.current;
      let nodeData; let fccVisible=false;
      if(Array.isArray(raw)){nodeData=raw;}else{nodeData=raw.nodes||[];fccVisible=raw.fccTowersVisible||false;}
      nodesRef.current.forEach(n=>{if(n.marker)n.marker.remove();}); nodesRef.current=[];
      nodeData.forEach(n=>{addNode(map,n.lng,n.lat,n.type,n.name,false,n.height); if(n.modbusId) nodesRef.current[nodesRef.current.length-1].modbusId = n.modbusId;});
      if(fccVisible&&!showFCCTowers){toggleFCCTowers();}else if(!fccVisible&&showFCCTowers){toggleFCCTowers();}
      // Update project tab name to match file
      const fileName = file.name.replace(/\.json$/, "");
      setProjects(prev => prev.map(p => p.id === activeProjectId ? { ...p, name: fileName } : p));
      let avgLat=0,avgLng=0; for(const n of nodeData){avgLat+=n.lat;avgLng+=n.lng;} avgLat/=nodeData.length;avgLng/=nodeData.length;
      map.flyTo({center:[avgLng,avgLat],zoom:13});
    };
    reader.readAsText(file);
  }
  async function analyzeNetwork(){
    const recs=[];
    const seenRecs = new Set();
    for(const a of nodesRef.current){
      if(a.type==="gateway")continue;if(a.type==="single")continue;
      const path=getPath(a);if(!path.some(n=>n.type==="gateway"))continue;
      for(let p=0;p<path.length-1;p++){const p1=path[p],p2=path[p+1];
        const recKey = [p1.name, p2.name].sort().join("\u2192");
        if(p1.blocked && !seenRecs.has("block-"+recKey)){seenRecs.add("block-"+recKey);recs.push({text:`\u26F0\uFE0F ${p1.name.toUpperCase()} \u2192 ${p2.name.toUpperCase()}: Blocked LOS \u2014 adjust height`,node:p1,target:p2});}
        else if(p1.fresnelWarn && p1.fresnelTarget){const fKey=[p1.name,p1.fresnelTarget.name].sort().join("\u2192");if(!seenRecs.has("fresnel-"+fKey)){seenRecs.add("fresnel-"+fKey);recs.push({text:`\u26A0\uFE0F ${p1.name.toUpperCase()} \u2192 ${p1.fresnelTarget.name.toUpperCase()}: Fresnel ${p1.fresnelDetail.match(/\d+/)?.[0] || '?'}% \u2014 increase height for reliable link`,node:p1,target:p1.fresnelTarget});}}}
    }
    for(const a of nodesRef.current){
      if(a.type==="gateway")continue;if(a.type==="single")continue;
      const path=getPath(a);if(path.some(n=>n.type==="gateway"))continue;

      // Find nearest gateway and nearest connected LRA
      let nearestGW=null, nearestGWDist=Infinity;
      let nearestLRA=null, nearestLRADist=Infinity;
      for(const b of nodesRef.current){
        if(b===a) continue;
        const d=distance(a,b);
        if(b.type==="gateway" && d<nearestGWDist){ nearestGW=b; nearestGWDist=d; }
        if(b.type==="lra" && d<nearestLRADist){
          const bPath=getPath(b);
          if(bPath.some(n=>n.type==="gateway")){ nearestLRA=b; nearestLRADist=d; }
        }
      }

      const nearestTarget = (nearestGWDist <= nearestLRADist) ? nearestGW : nearestLRA;
      const nearestDist = (nearestGWDist <= nearestLRADist) ? nearestGWDist : nearestLRADist;
      const nearestLabel = nearestTarget ? nearestTarget.name.toUpperCase() : "any gateway/LRA";
      const maxReach = (a.type==="lra") ? 3 : 0.75;

      // CASE 1: Nothing within max possible range (3mi for LRA reach)
      if(!nearestTarget || nearestDist > 3){
        recs.push({text:`📡 ${a.name.toUpperCase()}: Out of range — nearest gateway/LRA is ${nearestDist===Infinity?"unknown":nearestDist.toFixed(2)+" mi"} away (max 3 mi)`,node:a});
        continue;
      }

      // CASE 2: Within 3mi but beyond current type range — needs upgrade
      if(nearestDist > maxReach && a.type==="sra"){
        const los = await checkLOS(a, nearestTarget, 10, nearestTarget.height);
        if(!los.clear){
          const neededH = Math.ceil(los.requiredHeight + a.height);
          if(neededH > 30){
            recs.push({text:`⛰️ ${a.name.toUpperCase()}: Terrain blocks LOS to ${nearestLabel} (${nearestDist.toFixed(2)} mi) — needs ${neededH}ft but max LRA height is 30ft`,node:a,target:nearestTarget});
          } else {
            recs.push({text:`⛰️ ${a.name.toUpperCase()}: Upgrade to LRA + set height to ~${neededH}ft to clear terrain to ${nearestLabel} (${nearestDist.toFixed(2)} mi)`,node:a,target:nearestTarget});
          }
        } else {
          recs.push({text:`⬆️ ${a.name.toUpperCase()}: Out of SRA range (0.75 mi) — upgrade to LRA to reach ${nearestLabel} (${nearestDist.toFixed(2)} mi)`,node:a,target:nearestTarget});
        }
        continue;
      }

      // CASE 3: Within range — check LOS
      const los = await checkLOS(a, nearestTarget, a.height, nearestTarget.height);
      if(!los.clear){
        const neededH = Math.ceil(los.requiredHeight + a.height);
        const maxH = a.type==="sra" ? 5 : a.type==="lra" ? 30 : 30;
        if(neededH > maxH){
          if(a.type==="sra"){
            // Check if LRA height could fix it
            const losLRA = await checkLOS(a, nearestTarget, 30, nearestTarget.height);
            if(losLRA.clear){
              recs.push({text:`⬆️ ${a.name.toUpperCase()}: Terrain blocks LOS at SRA max 5ft — upgrade to LRA (~${Math.ceil(los.requiredHeight+5)}ft) to clear to ${nearestLabel}`,node:a,target:nearestTarget});
            } else {
              recs.push({text:`⛰️ ${a.name.toUpperCase()}: Terrain blocks LOS to ${nearestLabel} — needs ${neededH}ft, exceeds max LRA height (30ft)`,node:a,target:nearestTarget});
            }
          } else {
            recs.push({text:`⛰️ ${a.name.toUpperCase()}: Terrain blocks LOS to ${nearestLabel} — needs ${neededH}ft but max ${a.type.toUpperCase()} height is ${maxH}ft`,node:a,target:nearestTarget});
          }
        } else {
          recs.push({text:`⛰️ ${a.name.toUpperCase()}: Terrain blocks LOS to ${nearestLabel} — increase height to ~${neededH}ft to clear`,node:a,target:nearestTarget});
        }
        continue;
      }

      // CASE 4: LOS clear but still disconnected (mesh routing issue)
      const signal = calcPower(nearestDist);
      if(signal < -95){
        recs.push({text:`📡 ${a.name.toUpperCase()}: Weak signal to ${nearestLabel} (${signal.toFixed(0)} dBm at ${nearestDist.toFixed(2)} mi) — consider adding relay node`,node:a,target:nearestTarget});
      } else {
        recs.push({text:`🔗 ${a.name.toUpperCase()}: LOS clear to ${nearestLabel} but no mesh path to gateway — check intermediate node connections`,node:a,target:nearestTarget});
      }
    }
    if(recs.length===0){setRecommendations([{text:`\u2705 All nodes connected \u2014 no action needed`}]);}else{setRecommendations(recs);}
  }
  function importText(){
    if(!inputCoords.trim())return;
    const lines=inputCoords.trim().split("\n");
    for(const line of lines){const parts=line.split(",");if(parts.length<3)continue;const name=parts[0].trim();const lat=parseFloat(parts[1].trim());const lng=parseFloat(parts[2].trim());if(isNaN(lat)||isNaN(lng))continue;addNode(mapRef.current,lng,lat,modeRef.current,name);}
    const first=inputCoords.trim().split("\n")[0].split(",");const lat=parseFloat(first[1]);const lng=parseFloat(first[2]);
    if(!isNaN(lat)&&!isNaN(lng)){mapRef.current.flyTo({center:[lng,lat],zoom:13});}
    setInputCoords("");
  }
  function uploadExcel(e){
    const file = e.target.files[0];
    if(!file) return;
    e.target.value = "";
    const reader=new FileReader();
    reader.onload=(evt)=>{const wb=XLSX.read(new Uint8Array(evt.target.result));const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);setImportedData(rows);setShowOptimizePrompt(true);};
    reader.readAsArrayBuffer(file);
  }

  async function optimizeExisting(){
    if(!nodesRef.current.length)return; const map=mapRef.current; const recs=[];
    try{
      let hasGateway=nodesRef.current.some(n=>n.type==="gateway");
      if(!hasGateway){
        let bestNode=nodesRef.current[0],bestCount=-1;
        for(const n of nodesRef.current){let count=0;for(const other of nodesRef.current){if(other===n)continue;if(distance(n,other)<=3)count++;}if(count>bestCount){bestCount=count;bestNode=n;}}
        addNode(map,bestNode.lng,bestNode.lat+(60/364000),"gateway","GATEWAY-1",true);
        recs.push({text:`\uD83D\uDCE1 GATEWAY-1 placed 60ft north of ${bestNode.name.toUpperCase()}`});
      }
      for(const node of nodesRef.current){if(node.type==="gateway")continue;node.type="sra";node.height=5;node.range=0.75;if(node.markerElement)node.markerElement.style.background="green";}
      await computeLinks();
      for(let pass=0;pass<10;pass++){
        let disconnected=[];
        for(const node of nodesRef.current){if(node.type==="gateway")continue;const path=getPath(node);if(!path.some(n=>n.type==="gateway"))disconnected.push(node);}
        if(disconnected.length===0)break;
        let bestCandidate=null,bestScore=-1;
        for(const node of disconnected){
          let inRange=false;for(const g of nodesRef.current){if(g.type!=="gateway"&&g.type!=="lra")continue;if(distance(node,g)<=3){inRange=true;break;}}if(!inRange)continue;
          let score=0;for(const other of disconnected){if(other===node)continue;const dd=distance(node,other);if(dd<=0.75)score+=2;else if(dd<=3)score+=1;}
          if(score===0){for(const other of nodesRef.current){if(other===node)continue;if(other.type==="gateway"||other.type==="single")continue;const dd=distance(node,other);if(dd>3)continue;const op=getPath(other);if(!op.some(n=>n.type==="gateway")&&dd<=3)score+=1;}}
          if(score>bestScore){bestScore=score;bestCandidate=node;}
        }
        if(!bestCandidate)break;
        bestCandidate.type="lra";bestCandidate.height=10;bestCandidate.range=3;bestCandidate._wasUpgraded=true;if(bestCandidate.markerElement)bestCandidate.markerElement.style.background="orange";
        recs.push({text:`\u2B06\uFE0F ${bestCandidate.name.toUpperCase()} upgraded to LRA (needed for connectivity)`});
        await computeLinks();
      }
      await computeLinks();await optimizeHeights();await computeLinks();
      try{await rescueDisconnected();await computeLinks();}catch(e){console.log("Rescue pass error:",e);}
      for(const node of nodesRef.current){
        if(node.type!=="sra")continue;const link=linksRef.current[node.name];if(!link)continue;const los=await checkLOS(node,link,node.height,link.height);if(los.clear)continue;
        for(const bridge of nodesRef.current){
          if(bridge===node)continue;if(bridge.type!=="sra")continue;const dBridge=distance(bridge,node);if(dBridge>3)continue;
          const bridgePath=getPath(bridge);if(!bridgePath.some(n=>n.type==="gateway"))continue;
          for(let bh=10;bh<=30;bh+=5){for(let nh=5;nh<=30;nh+=5){const testLos=await checkLOS(bridge,node,bh,nh);if(testLos.clear){bridge.type="lra";bridge.height=bh;bridge.range=3;if(bridge.markerElement)bridge.markerElement.style.background="orange";if(nh>5){node.type="lra";node.height=nh;node.range=3;if(node.markerElement)node.markerElement.style.background="orange";}await computeLinks();break;}}if(bridge.type==="lra")break;}if(bridge.type==="lra")break;
        }
      }
      await computeLinks();
      try{ await optimizeFresnel(); await computeLinks(); }catch(e){ console.log("Fresnel optimize error:",e); }
      for(const node of nodesRef.current){
        if(node.type==="gateway"||node.type==="single") continue;
        const path=getPath(node);
        if(!path.some(n=>n.type==="gateway")){
          if(node.type==="lra" && node._wasUpgraded){
            node.type="single"; node.range=0; node.outOfRange=false;
            if(node.markerElement){node.markerElement.style.background="black";node.markerElement.style.border="none";}
            recs.push({text:`\u26AB ${node.name.toUpperCase()}: No gateway path \u2014 set as Single Modem`});
          } else {
            recs.push({text:`\u26A0\uFE0F ${node.name.toUpperCase()}: Cannot reach gateway \u2014 consider repositioning or adding LRA`});
          }
        }
      }
    }catch(e){console.log("Optimize error:",e);}
    draw();setRecommendations(prev=>[...prev,...recs]);
  }

  async function autoOptimizeNetwork(){
    if(!importedData.length)return; nodesRef.current=[]; const map=mapRef.current; const recs=[];
    try{
      let gateway=importedData[0],bestCount=-1;
      for(const r of importedData){let count=0;for(const other of importedData){if(other===r)continue;if(distance({lng:r.Longitude,lat:r.Latitude},{lng:other.Longitude,lat:other.Latitude})<=3)count++;}if(count>bestCount){bestCount=count;gateway=r;}}
      map.flyTo({center:[gateway.Longitude,gateway.Latitude],zoom:13});
      addNode(map,gateway.Longitude,gateway.Latitude+(60/364000),"gateway","GATEWAY-1",true);
      for(let i=0;i<importedData.length;i++){const r=importedData[i];addNode(map,r.Longitude,r.Latitude,"sra",r.Name,true);}
      await computeLinks();
      for(let pass=0;pass<10;pass++){
        let disconnected=[];
        for(const node of nodesRef.current){if(node.type==="gateway"||node.type==="single")continue;const path=getPath(node);if(!path.some(n=>n.type==="gateway"))disconnected.push(node);}
        if(disconnected.length===0){for(const node of nodesRef.current){if(node.type!=="sra")continue;const link=linksRef.current[node.name];if(!link){disconnected.push(node);continue;}const los=await checkLOS(node,link,node.height,link.height);if(!los.clear)disconnected.push(node);}}
        if(disconnected.length===0)break;
        let bestCandidate=null,bestScore=-1;
        for(const node of disconnected){
          let inRange=false;for(const g of nodesRef.current){if(g.type!=="gateway"&&g.type!=="lra")continue;if(distance(node,g)<=3){inRange=true;break;}}if(!inRange)continue;
          let score=0;for(const other of disconnected){if(other===node)continue;const dd=distance(node,other);if(dd<=0.75)score+=2;else if(dd<=3)score+=1;}
          if(score===0){for(const other of nodesRef.current){if(other===node||other.type==="gateway"||other.type==="single")continue;const dd=distance(node,other);if(dd>3)continue;const op=getPath(other);if(!op.some(n=>n.type==="gateway")&&dd<=3)score+=1;}}
          if(score>bestScore){bestScore=score;bestCandidate=node;}
        }
        if(!bestCandidate)break;
        bestCandidate.type="lra";bestCandidate.range=3;bestCandidate.height=10;bestCandidate._wasUpgraded=true;if(bestCandidate.markerElement)bestCandidate.markerElement.style.background="orange";
        await computeLinks();
      }
      await optimizeHeights();await computeLinks();
      try{await rescueDisconnected();await computeLinks();}catch(e){console.log("Rescue pass error:",e);await computeLinks();}
      for(const node of nodesRef.current){
        if(node.type!=="sra")continue;const link=linksRef.current[node.name];if(!link)continue;const los=await checkLOS(node,link,node.height,link.height);if(los.clear)continue;
        for(const bridge of nodesRef.current){
          if(bridge===node||bridge.type!=="sra")continue;const dBridge=distance(bridge,node);if(dBridge>3)continue;
          const bridgePath=getPath(bridge);if(!bridgePath.some(n=>n.type==="gateway"))continue;
          for(let bh=10;bh<=30;bh+=5){for(let nh=5;nh<=30;nh+=5){const testLos=await checkLOS(bridge,node,bh,nh);if(testLos.clear){bridge.type="lra";bridge.height=bh;bridge.range=3;if(bridge.markerElement)bridge.markerElement.style.background="orange";if(nh>5){node.type="lra";node.height=nh;node.range=3;if(node.markerElement)node.markerElement.style.background="orange";}await computeLinks();break;}}if(bridge.type==="lra")break;}if(bridge.type==="lra")break;
        }
      }
      await computeLinks();
      try{ await optimizeFresnel(); await computeLinks(); }catch(e){ console.log("Fresnel optimize error:",e); }
      for(const node of nodesRef.current){
        if(node.type==="gateway"||node.type==="single") continue;
        const path=getPath(node);
        if(!path.some(n=>n.type==="gateway")){
          if(node.type==="lra" && node._wasUpgraded){
            node.type="single"; node.range=0; node.outOfRange=false;
            if(node.markerElement){node.markerElement.style.background="black";node.markerElement.style.border="none";}
          }
        }
      }
    }catch(e){console.log("Auto-optimize error:",e);}
    draw();setRecommendations(prev=>[...prev,...recs]);setShowOptimizePrompt(false);setNodeVersion(v=>v+1);
  }

  // ========== MULTI-PROJECT FUNCTIONS ==========
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
    if(newId === activeProjectId) return;
    // Save current project
    projectDataRef.current[activeProjectId] = serializeProject();
    // Load new project
    const newData = projectDataRef.current[newId] || null;
    loadProjectToMap(newData);
    setActiveProjectId(newId);
  }

  function addProject(){
    const id = nextProjectIdRef.current++;
    const name = prompt("Project name:", `Project ${id}`);
    if(!name || !name.trim()) return;
    // Save current project first
    projectDataRef.current[activeProjectId] = serializeProject();
    // Create new empty project
    setProjects(prev => [...prev, { id, name: name.trim() }]);
    projectDataRef.current[id] = null;
    loadProjectToMap(null);
    setActiveProjectId(id);
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
    const newName = prompt("Rename project:", current?.name || "");
    if(!newName || !newName.trim()) return;
    setProjects(prev => prev.map(p => p.id === id ? { ...p, name: newName.trim() } : p));
  }

return (<div style={{display:"flex",height:"100vh"}}>
{showOptimizePrompt && (<div style={{position:"absolute",top:"30%",left:"35%",background:"#fff",padding:20,border:"2px solid black",zIndex:1000}}>
  <div style={{marginBottom:10,fontWeight:"bold"}}>Do you want to Auto-Optimize this network?</div>
  <button onClick={autoOptimizeNetwork} style={{marginRight:10}}>Yes</button>
  <button onClick={()=>{setShowOptimizePrompt(false);importedData.forEach(r=>{addNode(mapRef.current,r.Longitude,r.Latitude,"sra",r.Name);});
    let avgLat=0,avgLng=0;for(const r of importedData){avgLat+=r.Latitude;avgLng+=r.Longitude;}avgLat/=importedData.length;avgLng/=importedData.length;mapRef.current.flyTo({center:[avgLng,avgLat],zoom:13});}}>No</button>
</div>)}
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
    <div style={{display:"flex",gap:4}}>
      <button onClick={()=>setMode("gateway")} style={{flex:1,padding:"6px",border:"1px solid #fff",cursor:"pointer",color:"white",background:mode==="gateway"?"#0000cc":"blue",fontWeight:"bold",fontSize:11}}>{"\uD83D\uDD35"} Gateway</button>
      <button onClick={()=>setMode("lra")} style={{flex:1,padding:"6px",border:"1px solid #fff",cursor:"pointer",color:"white",background:mode==="lra"?"#cc7a00":"orange",fontWeight:"bold",fontSize:11}}>{"\uD83D\uDFE0"} LRA</button>
      <button onClick={()=>setMode("sra")} style={{flex:1,padding:"6px",border:"1px solid #fff",cursor:"pointer",color:"white",background:mode==="sra"?"#2e7d32":"green",fontWeight:"bold",fontSize:11}}>{"\uD83D\uDFE2"} SRA</button>
      <button onClick={()=>setMode("single")} style={{flex:1,padding:"6px",border:"1px solid #fff",cursor:"pointer",color:"white",background:mode==="single"?"#333":"black",fontWeight:"bold",fontSize:11}}>{"\u26AB"} Single</button>
    </div>
    <button onClick={optimizeExisting} style={{marginTop:6,width:"100%",background:"#4CAF50",color:"white",padding:"6px",border:"1px solid #fff",cursor:"pointer"}}>{"\u26A1"} Auto-Optimize</button>
    <button onClick={()=>{nodesRef.current.forEach(n=>{if(n.marker)n.marker.remove();});nodesRef.current=[];linksRef.current={};setRecommendations([]);setSelectedNode(null);redraw();}} style={{marginTop:6,width:"100%",background:"#f44336",color:"white",padding:"6px",border:"1px solid #fff",cursor:"pointer"}}>{"\uD83D\uDDD1\uFE0F"} Clear All</button>
  </div>
  <div style={{flex:1,overflowY:"auto",padding:12}}>
    <div style={{position:"relative"}}>
      <button onClick={()=>setShowFileMenu(!showFileMenu)} style={{width:"100%",marginBottom:6,background:"#555",color:"white",border:"none",padding:"6px",cursor:"pointer",fontSize:14}}>{"\uD83D\uDCC1"} File {showFileMenu?"\u25B2":"\u25BC"}</button>
      {showFileMenu && (<div style={{background:"#333",border:"1px solid #555",borderRadius:4,marginBottom:6,overflow:"hidden"}}>
        <button onClick={()=>{saveNetwork();setShowFileMenu(false);}} style={{width:"100%",padding:"8px 12px",background:"transparent",color:"white",border:"none",borderBottom:"1px solid #444",cursor:"pointer",textAlign:"left",fontSize:13}}>{"\uD83D\uDCBE"} Save Network</button>
        <label style={{display:"block",width:"100%",padding:"8px 12px",color:"white",borderBottom:"1px solid #444",cursor:"pointer",fontSize:13,boxSizing:"border-box"}}>{"\uD83D\uDCC2"} Load Network<input type="file" accept=".json" onChange={(e)=>{loadNetwork(e);setShowFileMenu(false);}} style={{display:"none"}}/></label>
        <button onClick={()=>{exportExcel();setShowFileMenu(false);}} style={{width:"100%",padding:"8px 12px",background:"transparent",color:"#FF9800",border:"none",borderBottom:"1px solid #444",cursor:"pointer",textAlign:"left",fontSize:13}}>{"\uD83D\uDCCA"} Export to Excel</button>
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
    <hr/>
    <hr/>
    <div>
      <div style={{fontWeight:"bold",marginBottom:6,color:"#fff"}}>Nodes ({nodesRef.current.length})</div>
      <div style={{fontSize:11,color:"#aaa",marginBottom:2}}>{"\uD83D\uDD35"} {nodesRef.current.filter(n=>n.type==="gateway").length} Gateway{" | "}{"\uD83D\uDFE0"} {nodesRef.current.filter(n=>n.type==="lra").length} LRA{" | "}{"\uD83D\uDFE2"} {nodesRef.current.filter(n=>n.type==="sra").length} SRA</div>
      <div style={{fontSize:11,color:"#aaa",marginBottom:6}}>{"\u26AB"} {nodesRef.current.filter(n=>n.type==="single").length} Single Modem
        {nodesRef.current.filter(n=>n.outOfRange&&n.type!=="single").length>0&&(<span style={{color:"red"}}>{" | "}{"\u26A0\uFE0F"} {nodesRef.current.filter(n=>n.outOfRange&&n.type!=="single").length} Disconnected</span>)}
      </div>
      {nodesRef.current.map((n,i)=>(<div key={i} style={{marginBottom:4}}>
        <span style={{color:n.outOfRange||n.type==="single"?"#999":n.type==="gateway"?"blue":n.type==="lra"?"orange":"green",cursor:"pointer",textDecoration:"underline"}}
         onClick={()=>{
  mapRef.current.flyTo({center:[n.lng,n.lat],zoom:15});
  setSelectedNode(n);setEditName(n.name);setEditType(n.type);setEditHeight(n.height);setEditModbus(n.modbusId||"");
  if(n.type !== "gateway" && n.type !== "single" && linksRef.current[n.name]){
    try{ generateProfile(n); }catch(err){ console.log("Profile error:", err); }
  } else {
    setProfileData({ from: n, to: n, points: [{dist:0,elev:0,lng:n.lng,lat:n.lat}], totalDist: 0, isMeasure: false });
    setProfileFromHeight(n.height); setProfileToHeight(n.height);
    setProfileFromType(n.type); setProfileToType(n.type);
    setShowProfile(true);
  }
}}>
          {n.name} ({n.type.toUpperCase()}) {n.type!=="single"?`${n.recommendedHeight||n.height} ft`:""}{n.modbusId ? ` [M:${n.modbusId}]` : ""}
        </span>
        {n.elevation!==null&&(<span style={{color:"#aaa",fontSize:11}}>{" "}| Elev: {n.elevation}ft</span>)}
        {n.blocked&&n.blockDetail&&(<div style={{color:"red",fontSize:11,marginLeft:10}}>{n.blockDetail}</div>)}
      </div>))}
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
