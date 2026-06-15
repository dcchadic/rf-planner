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
    el.style.width = "14px";
    el.style.height = "14px";
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
      elevation: null, blocked: false, blockDetail: null, outOfRange: false
    };
    const marker = new mapboxgl.Marker({element:el,draggable:true})
      .setLngLat([lng,lat]).addTo(map);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      setSelectedNode(node);
      setEditName(node.name);
      setEditType(node.type);
      setEditHeight(node.height);
    });
    marker.on("dragend",()=>{
      const p = marker.getLngLat();
      node.lng=p.lng; node.lat=p.lat; node.elevation = null; redraw();
    });
    el.oncontextmenu=(e)=>{
      e.preventDefault(); marker.remove();
      nodesRef.current = nodesRef.current.filter(n=>n!==node);
      saveSnapshot(); redraw();
    };
    node.marker = marker;
    nodesRef.current.push(node);
    if (!silent){ saveSnapshot(); redraw(); }
  }

  // ---------- ROUTING ----------
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
    // SECOND PASS
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
    for (const n of nodesRef.current){ n.blocked = false; n.blockDetail = null; }
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
      layout: { "text-field": ["get", "text"], "text-size": 12,
        "text-variable-anchor": ["top","bottom","left","right"],
        "text-radial-offset": 1.2, "text-justify": "auto", "text-allow-overlap": false },
      paint: { "text-color": "#ffffff", "text-halo-color": "#000000", "text-halo-width": 1 }
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
        const linkKey = [p1.name, p2.name].sort().join("→");
        if(drawnLinks.has(linkKey)) continue;
        drawnLinks.add(linkKey);
        const los = await checkLOS(p1, p2, p1.height, p2.height);
        const d = distance(p1,p2);
        const signal = calcPower(d);
        if (!los.clear){
          p1.blocked = true;
          p1.blockDetail = `⛰️ +${Math.ceil(los.requiredHeight)}ft to clear → ${p2.name}`;
        }
        const lineId = `line-${i}-${j}`;
        if (map.getSource(lineId)) { try { map.removeLayer(lineId); map.removeSource(lineId); } catch {} }
        map.addSource(lineId,{ type:"geojson", data:{ type:"Feature", geometry:{ type:"LineString", coordinates:[[p1.lng,p1.lat],[p2.lng,p2.lat]] } } });
        map.addLayer({ id:lineId, type:"line", source:lineId, paint:{
          "line-color": !los.clear?"red": signal>-70?"green": signal>-85?"yellow": signal>-100?"orange":"red",
          "line-width":3 }
        });
        const clickP1=p1,clickP2=p2;
        map.on("click", lineId, (e) => { e.preventDefault(); e.originalEvent.stopPropagation(); skipNextClick.current=true; generateProfile(clickP1, clickP2); });
        map.on("mouseenter", lineId, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", lineId, () => { map.getCanvas().style.cursor = ""; });
        const labelId = `label-${i}-${j}`;
        if (map.getSource(labelId)) { try { map.removeLayer(labelId); map.removeSource(labelId); } catch {} }
        map.addSource(labelId,{ type:"geojson", data:{ type:"Feature",
          geometry:{ type:"Point", coordinates:[(p1.lng+p2.lng)/2,(p1.lat+p2.lat)/2] },
          properties:{ text: los.clear ? `${d.toFixed(2)} mi | ${signal.toFixed(0)} dBm` : `${d.toFixed(2)} mi | BLOCKED | +${Math.ceil(los.requiredHeight)} ft` } } });
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
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const points = profileData.points;
    const padElev = 30;
    const minElev = Math.min(...points.map(p => p.elev)) - padElev;
    const maxElev = Math.max(...points.map(p => p.elev)) + padElev + profileData.from.height + profileData.to.height;
    const maxDist = profileData.totalDist;
    const left = 65, right = 25, top = 35, bottom = 45;
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
    const wavelengthM = 0.333; // 900 MHz
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
    ctx.fillStyle = "#888"; ctx.font = "11px Arial";
    for(let i = 0; i <= 5; i++){ const d = (maxDist / 5) * i; const x = left + (d / maxDist) * plotW; ctx.fillText(`${d.toFixed(2)}mi`, x, top + plotH + 20); }
    ctx.fillStyle = "#ffffff"; ctx.font = "bold 14px Arial"; ctx.textAlign = "center";
    const signal = calcPower(maxDist);
    const statusText = blocked ? "\u26F0\uFE0F LOS BLOCKED" : `\u2705 LOS Clear | ${signal.toFixed(0)} dBm`;
    ctx.fillText(`${profileData.totalDist.toFixed(2)} mi | ${statusText}`, W / 2, H - 5);
    if(blocked){
      if(profileData.isMeasure){
        let minLeftH = profileFromHeight;
        for(let testH = 0; testH <= 200; testH++){ let clear=true; const t1=points[0].elev+testH,t2=points[points.length-1].elev+profileToHeight;
          for(let i=1;i<points.length-1;i++){const t=i/(points.length-1);if(points[i].elev>t1+(t2-t1)*t){clear=false;break;}} if(clear){minLeftH=testH;break;} }
        let minRightH = profileToHeight;
        for(let testH = 0; testH <= 200; testH++){ let clear=true; const t1=points[0].elev+profileFromHeight,t2=points[points.length-1].elev+testH;
          for(let i=1;i<points.length-1;i++){const t=i/(points.length-1);if(points[i].elev>t1+(t2-t1)*t){clear=false;break;}} if(clear){minRightH=testH;break;} }
        ctx.fillStyle="#ff5555";ctx.font="bold 14px Arial";ctx.textAlign="center";ctx.fillText(`\u26A0\uFE0F LOS BLOCKED`,W/2,top+14);
        ctx.fillStyle="#ffaa00";ctx.font="bold 12px Arial";
        ctx.textAlign="left";ctx.fillText(`\u2B06\uFE0F Needs ${minLeftH}ft to clear`,left+5,top+30);
        ctx.textAlign="right";ctx.fillText(`\u2B06\uFE0F Needs ${minRightH}ft to clear`,left+plotW-5,top+30);
      } else {
        let maxBlock2=0; for(let i=0;i<points.length;i++){const t=i/(points.length-1);const diff=points[i].elev-(fromElev+(toElev-fromElev)*t);if(diff>maxBlock2)maxBlock2=diff;}
        ctx.fillStyle="#ff5555";ctx.font="bold 16px Arial";ctx.textAlign="center";
        ctx.fillText(`\u26A0\uFE0F Increase height by ~${Math.ceil(maxBlock2+5)}ft to clear obstruction`,W/2,top+30);
      }
    } else {
      ctx.fillStyle="#4CAF50";ctx.font="bold 16px Arial";ctx.textAlign="center";
      ctx.fillText(`✅ Clear LOS — no height change needed`,W/2,top+30);
      // Fresnel recommendation
      if(fresnelClear){
        ctx.fillStyle="#4CAF50";ctx.font="bold 12px Arial";ctx.textAlign="center";
        ctx.fillText(`🟢 Fresnel Zone: ${Math.max(0,worstFresnelPct).toFixed(0)}% clearance — Reliable link`,W/2,top+48);
      } else {
        ctx.fillStyle="#ffaa00";ctx.font="bold 12px Arial";ctx.textAlign="center";
        ctx.fillText(`⚠️ Fresnel Zone: ${Math.max(0,worstFresnelPct).toFixed(0)}% clearance — Increase height for reliable link`,W/2,top+48);
      }
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
    }
  }
  function clearMeasure(){
    const map=mapRef.current; measurePoints.current=[]; measureMarkersRef.current.forEach(m=>m.remove()); measureMarkersRef.current=[];
    if(map.getLayer("measure-line"))map.removeLayer("measure-line"); if(map.getSource("measure-line"))map.removeSource("measure-line");
    if(map.getLayer("measure-label"))map.removeLayer("measure-label"); if(map.getSource("measure-label"))map.removeSource("measure-label");
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
      // Carrier-colored triangles
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
      // Individual tower symbols — carrier-colored
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
      // Height labels — bigger, bold, cyan with black halo
      map.addLayer({ id: "fcc-towers-labels", type: "symbol", source: "fcc-towers",
        filter: ["!", ["has", "point_count"]], minzoom: 11,
        layout: { "text-field": ["concat", ["to-string", ["get", "height"]], "ft"],
          "text-size": 13, "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"],
          "text-offset": [0, 0.5], "text-anchor": "top", "text-allow-overlap": false },
        paint: { "text-color": "#00ffff", "text-halo-color": "#000000", "text-halo-width": 2 }
      });
      // Click cluster to zoom
      map.on("click", "fcc-clusters", (e) => {
        e.originalEvent.stopPropagation(); skipNextClick.current = true;
        const features = map.queryRenderedFeatures(e.point, { layers: ["fcc-clusters"] });
        const clusterId = features[0].properties.cluster_id;
        map.getSource("fcc-towers").getClusterExpansionZoom(clusterId, (err, zoom) => { if (err) return; map.easeTo({ center: features[0].geometry.coordinates, zoom }); });
      });
      // Click tower for popup with carrier affiliation
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
function updateHeatmapData(){
    const map = mapRef.current; if(!map) return;
    const features = nodesRef.current
      .filter(n => n.type !== "single" && !n.outOfRange)
      .map(n => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [n.lng, n.lat] },
        properties: {
          weight: n.type === "gateway" ? 1.0 : n.type === "lra" ? 0.7 : 0.4,
          range: n.type === "gateway" ? 3 : n.type === "lra" ? 3 : 0.75
        }
      }));
    const data = { type: "FeatureCollection", features };
    if(map.getSource("signal-heatmap")){
      map.getSource("signal-heatmap").setData(data);
    }
  }

  function toggleHeatmap(){
    const map = mapRef.current; if(!map) return;
    if(!showHeatmap){
      if(!heatmapLoaded.current){
        const features = nodesRef.current
          .filter(n => n.type !== "single" && !n.outOfRange)
          .map(n => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [n.lng, n.lat] },
            properties: {
              weight: n.type === "gateway" ? 1.0 : n.type === "lra" ? 0.7 : 0.4,
              range: n.type === "gateway" ? 3 : n.type === "lra" ? 3 : 0.75
            }
          }));
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
            "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 8, 15, 11, 40, 14, 80, 16, 120],
            "heatmap-color": [
              "interpolate", ["linear"], ["heatmap-density"],
              0, "rgba(0,0,0,0)",
              0.1, "rgba(0,0,255,0.2)",
              0.3, "rgba(0,255,255,0.35)",
              0.5, "rgba(0,255,0,0.4)",
              0.7, "rgba(255,255,0,0.5)",
              0.9, "rgba(255,128,0,0.6)",
              1.0, "rgba(255,0,0,0.7)"
            ],
            "heatmap-opacity": 0.6
          }
        }, "all-nodes");
        heatmapLoaded.current = true;
      } else {
        updateHeatmapData();
        if(map.getLayer("signal-heatmap-layer")) map.setLayoutProperty("signal-heatmap-layer", "visibility", "visible");
      }
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

  // SAVE NETWORK
  function saveNetwork(){
    const fileName = prompt("Name this network:", "rf-network");
    if(!fileName) return;
    const saveData = {
      nodes: nodesRef.current.map(n => ({ name:n.name,type:n.type,lat:n.lat,lng:n.lng,height:n.height,range:n.range })),
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
    const folderName=prompt("Name this export:","rf-network"); if(!folderName)return;
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
    const reader=new FileReader();
    reader.onload=(evt)=>{
      const raw=JSON.parse(evt.target.result); const map=mapRef.current;
      let nodeData; let fccVisible=false;
      if(Array.isArray(raw)){nodeData=raw;}else{nodeData=raw.nodes||[];fccVisible=raw.fccTowersVisible||false;}
      nodesRef.current.forEach(n=>{if(n.marker)n.marker.remove();}); nodesRef.current=[];
      nodeData.forEach(n=>{addNode(map,n.lng,n.lat,n.type,n.name,false,n.height);});
      if(fccVisible&&!showFCCTowers){toggleFCCTowers();}else if(!fccVisible&&showFCCTowers){toggleFCCTowers();}
      let avgLat=0,avgLng=0; for(const n of nodeData){avgLat+=n.lat;avgLng+=n.lng;} avgLat/=nodeData.length;avgLng/=nodeData.length;
      map.flyTo({center:[avgLng,avgLat],zoom:13});
    };
    reader.readAsText(e.target.files[0]);
  }
  async function analyzeNetwork(){
    const recs=[];
    for(const a of nodesRef.current){
      if(a.type==="gateway")continue;if(a.type==="single")continue;
      const path=getPath(a);if(!path.some(n=>n.type==="gateway"))continue;
      for(let p=0;p<path.length-1;p++){const p1=path[p],p2=path[p+1];
        if(p1.blocked){recs.push({text:`\u26F0\uFE0F ${p1.name.toUpperCase()} \u2192 ${p2.name.toUpperCase()}: Blocked LOS \u2014 adjust height`,node:p1,target:p2});}}
    }
    for(const a of nodesRef.current){
      if(a.type==="gateway")continue;if(a.type==="single")continue;
      const path=getPath(a);if(path.some(n=>n.type==="gateway"))continue;
      let worstClear=100,bestSignal=-999,maxNeededHeight=0;
      for(const b of nodesRef.current){
        if(a===b)continue;const d=distance(a,b);const linkRange=(b.type==="lra")?3:a.range;if(d>linkRange)continue;
        const los=await checkLOS(a,b,a.height,b.height);const signal=calcPower(d);
        if(!los.clear){worstClear=0;if(los.requiredHeight>maxNeededHeight)maxNeededHeight=los.requiredHeight;}
        if(signal>bestSignal)bestSignal=signal;
      }
      const terrainBlocked=worstClear===0;
      const neededBoost=terrainBlocked?Math.ceil(maxNeededHeight):0;
      let targetHeight=a.height+neededBoost;
      let maxHeight=a.type==="sra"?5:a.type==="lra"?30:a.type==="gateway"?30:999;
      let capped=false;
      if(targetHeight>maxHeight){targetHeight=maxHeight;capped=true;}
      a.recommendedHeight=targetHeight;
      const weakSignal=bestSignal<-90;
      if(bestSignal===-999){}
      else if(terrainBlocked||weakSignal){
        if(!capped){recs.push({text:`\uD83D\uDCE1 ${a.name.toUpperCase()}: Set antenna height to ~${targetHeight} ft (${bestSignal.toFixed(0)} dBm)`,node:a});}
        else{if(a.type==="sra"){recs.push({text:`\u2B06\uFE0F ${a.name.toUpperCase()}: Max height reached (5 ft). Upgrade to LRA (${bestSignal.toFixed(0)} dBm)`});}
        else{recs.push({text:`\uD83D\uDCE1 ${a.name.toUpperCase()}: Set antenna height to max ${targetHeight} ft (${bestSignal.toFixed(0)} dBm)`,node:a});}}
      } else {recs.push({text:`\u2705 ${a.name.toUpperCase()}: Good link (${bestSignal.toFixed(0)} dBm)`});}
    }
    if(recs.length===0){setRecommendations([{text:"\u2705 All nodes connected \u2014 no action needed"}]);}else{setRecommendations(recs);}
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
    const reader=new FileReader();
    reader.onload=(evt)=>{const wb=XLSX.read(new Uint8Array(evt.target.result));const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);setImportedData(rows);setShowOptimizePrompt(true);};
    reader.readAsArrayBuffer(e.target.files[0]);
  }

  async function optimizeExisting(){
    const map=mapRef.current; if(!nodesRef.current.length)return; const recs=[];
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
        bestCandidate.type="lra";bestCandidate.height=10;bestCandidate.range=3;if(bestCandidate.markerElement)bestCandidate.markerElement.style.background="orange";
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
      for(const node of nodesRef.current){
        if(node.type==="gateway"||node.type==="single") continue;
        const path=getPath(node);
        if(!path.some(n=>n.type==="gateway")){
          node.type="single"; node.range=0; node.outOfRange=false;
          if(node.markerElement){node.markerElement.style.background="black";node.markerElement.style.border="none";}
          recs.push({text:`⚫ ${node.name.toUpperCase()}: No gateway path — set as Single Modem`});
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
        bestCandidate.type="lra";bestCandidate.range=3;bestCandidate.height=10;if(bestCandidate.markerElement)bestCandidate.markerElement.style.background="orange";
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
      for(const node of nodesRef.current){
        if(node.type==="gateway"||node.type==="single") continue;
        const path=getPath(node);
        if(!path.some(n=>n.type==="gateway")){
          node.type="single"; node.range=0; node.outOfRange=false;
          if(node.markerElement){node.markerElement.style.background="black";node.markerElement.style.border="none";}
        }
      }
    }catch(e){console.log("Auto-optimize error:",e);}
    draw();setRecommendations(prev=>[...prev,...recs]);setShowOptimizePrompt(false);setNodeVersion(v=>v+1);
  }

return (<div style={{display:"flex",height:"100vh"}}>
{showOptimizePrompt && (<div style={{position:"absolute",top:"30%",left:"35%",background:"#fff",padding:20,border:"2px solid black",zIndex:1000}}>
  <div style={{marginBottom:10,fontWeight:"bold"}}>Do you want to Auto-Optimize this network?</div>
  <button onClick={autoOptimizeNetwork} style={{marginRight:10}}>Yes</button>
  <button onClick={()=>{setShowOptimizePrompt(false);importedData.forEach(r=>{addNode(mapRef.current,r.Longitude,r.Latitude,"sra",r.Name);});
    let avgLat=0,avgLng=0;for(const r of importedData){avgLat+=r.Latitude;avgLng+=r.Longitude;}avgLat/=importedData.length;avgLng/=importedData.length;mapRef.current.flyTo({center:[avgLng,avgLat],zoom:13});}}>No</button>
</div>)}
<div style={{width:300,display:"flex",flexDirection:"column",height:"100%",borderRight:"1px solid #ccc"}}>
  <div style={{padding:12}}>
    <div style={{display:"flex",gap:4}}>
      <button onClick={()=>setMode("gateway")} style={{flex:1,padding:"6px",border:"none",cursor:"pointer",color:"white",background:mode==="gateway"?"#0000cc":"blue",fontWeight:"bold",fontSize:11}}>🔵 Gateway</button>
      <button onClick={()=>setMode("lra")} style={{flex:1,padding:"6px",border:"none",cursor:"pointer",color:"white",background:mode==="lra"?"#cc7a00":"orange",fontWeight:"bold",fontSize:11}}>🟠 LRA</button>
      <button onClick={()=>setMode("sra")} style={{flex:1,padding:"6px",border:"none",cursor:"pointer",color:"white",background:mode==="sra"?"#2e7d32":"green",fontWeight:"bold",fontSize:11}}>🟢 SRA</button>
      <button onClick={()=>setMode("single")} style={{flex:1,padding:"6px",border:"none",cursor:"pointer",color:"white",background:mode==="single"?"#333":"black",fontWeight:"bold",fontSize:11}}>⚫ Single</button>
    </div>
    <button onClick={optimizeExisting} style={{marginTop:6,width:"100%",background:"#4CAF50",color:"white",padding:"6px",border:"none",cursor:"pointer"}}>⚡ Auto-Optimize</button>
    <button onClick={()=>{nodesRef.current.forEach(n=>{if(n.marker)n.marker.remove();});nodesRef.current=[];linksRef.current={};setRecommendations([]);setSelectedNode(null);redraw();}} style={{marginTop:6,width:"100%",background:"#f44336",color:"white",padding:"6px",border:"none",cursor:"pointer"}}>🗑️ Clear All</button>
  </div>
  <div style={{flex:1,overflowY:"auto",padding:12}}>
    <div style={{position:"relative"}}>
      <button onClick={()=>setShowFileMenu(!showFileMenu)} style={{width:"100%",marginBottom:6,background:"#555",color:"white",border:"none",padding:"6px",cursor:"pointer",fontSize:14}}>📁 File {showFileMenu?"▲":"▼"}</button>
      {showFileMenu && (<div style={{background:"#333",border:"1px solid #555",borderRadius:4,marginBottom:6,overflow:"hidden"}}>
        <button onClick={()=>{saveNetwork();setShowFileMenu(false);}} style={{width:"100%",padding:"8px 12px",background:"transparent",color:"white",border:"none",borderBottom:"1px solid #444",cursor:"pointer",textAlign:"left",fontSize:13}}>💾 Save Network</button>
        <label style={{display:"block",width:"100%",padding:"8px 12px",color:"white",borderBottom:"1px solid #444",cursor:"pointer",fontSize:13,boxSizing:"border-box"}}>📂 Load Network<input type="file" accept=".json" onChange={(e)=>{loadNetwork(e);setShowFileMenu(false);}} style={{display:"none"}}/></label>
        <button onClick={()=>{exportExcel();setShowFileMenu(false);}} style={{width:"100%",padding:"8px 12px",background:"transparent",color:"#FF9800",border:"none",borderBottom:"1px solid #444",cursor:"pointer",textAlign:"left",fontSize:13}}>📊 Export to Excel</button>
        <button onClick={()=>{exportBundle();setShowFileMenu(false);}} style={{width:"100%",padding:"8px 12px",background:"transparent",color:"#CE93D8",border:"none",cursor:"pointer",textAlign:"left",fontSize:13}}>📦 Export All (Zip)</button>
      </div>)}
    </div>
    <div style={{display:"flex",gap:4,marginTop:6}}>
      <button onClick={undo} style={{flex:1,background:"#666",color:"white",padding:"6px",border:"none",cursor:"pointer"}}>↩️ Undo</button>
      <button onClick={redo} style={{flex:1,background:"#666",color:"white",padding:"6px",border:"none",cursor:"pointer"}}>↪️ Redo</button>
    </div>
    <div style={{display:"flex",gap:4,marginTop:6}}>
      <button onClick={()=>{clearMeasure();setMeasureMode(!measureMode);}} style={{flex:1,background:measureMode?"#ff00ff":"#666",color:"white",padding:"6px",border:"none",cursor:"pointer"}}>{measureMode?"📏 Measuring...":"📏 Measure"}</button>
      <button onClick={()=>{clearMeasure();setMeasureMode(false);}} style={{flex:1,background:"#666",color:"white",padding:"6px",border:"none",cursor:"pointer"}}>✕ Clear</button>
      <button onClick={()=>{if(measurePoints.current.length===2){generateMeasureProfile(measurePoints.current[0],measurePoints.current[1]);}}} style={{flex:1,background:"#8B7355",color:"white",padding:"6px",border:"none",cursor:"pointer"}}>📊 Profile</button>
    </div>
    <hr/>
    <textarea value={inputCoords} onChange={e=>setInputCoords(e.target.value)} placeholder="Name,Lat,Lng" style={{width:"100%",height:80}}/>
    <button onClick={importText} style={{width:"100%",marginBottom:6,background:"#4CAF50",color:"white",border:"none",padding:"6px",cursor:"pointer",fontSize:14}}>📍 Import Coordinates</button>
    <label style={{display:"block",width:"100%",marginBottom:6,padding:"6px",background:"#2196F3",color:"white",textAlign:"center",cursor:"pointer",border:"none",fontSize:14,boxSizing:"border-box"}}>📂 Upload Excel<input type="file" accept=".xlsx,.xls" onChange={uploadExcel} style={{display:"none"}}/></label>
    <hr/>
    {selectedNode && (<div style={{marginTop:10}}>
      <div style={{marginBottom:6,fontWeight:"bold",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",background:"#444",color:"white",padding:"6px 10px",borderRadius:4}} onClick={()=>setSelectedNode(selectedNode._collapsed?{...selectedNode,_collapsed:false}:{...selectedNode,_collapsed:true})}>
        <span>✏️ Edit: {selectedNode.name}</span><span>{selectedNode._collapsed?"▼":"▲"}</span>
      </div>
      {!selectedNode._collapsed && (<div>
        <input value={editName} onChange={e=>setEditName(e.target.value)} placeholder="Node Name" style={{width:"100%",marginBottom:6}}/>
        <select value={editType} onChange={e=>{const newType=e.target.value;setEditType(newType);if(newType==="gateway")setEditHeight(15);else if(newType==="lra")setEditHeight(10);else setEditHeight(5);}} style={{width:"100%",marginBottom:6}}>
          <option value="gateway">Gateway</option><option value="lra">LRA</option><option value="sra">SRA</option><option value="single">Single Modem</option>
        </select>
        <div style={{marginBottom:6}}><label style={{fontSize:12}}>Antenna Height (ft):</label><input type="number" value={editHeight} onChange={e=>setEditHeight(Number(e.target.value))} style={{width:"100%"}}/></div>
        <button onClick={()=>{if(!selectedNode)return;selectedNode.name=editName;selectedNode.type=editType;selectedNode.outOfRange=false;
          if(editType==="gateway"){selectedNode.height=editHeight;selectedNode.range=3;}
          else if(editType==="lra"){selectedNode.height=editHeight;selectedNode.range=3;}
          else if(editType==="single"){selectedNode.height=editHeight;selectedNode.range=0;}
          else{selectedNode.height=editHeight;selectedNode.range=0.75;}
          selectedNode.markerElement.style.background=editType==="gateway"?"blue":editType==="lra"?"orange":editType==="single"?"black":"green";
          saveSnapshot();setNodeVersion(v=>v+1);redraw();}} style={{width:"100%",marginBottom:6,background:"#4CAF50",color:"white",border:"none",padding:"6px",cursor:"pointer",fontSize:14}}>💾 Save Changes</button>
        <button onClick={()=>{if(selectedNode)generateProfile(selectedNode);}} style={{width:"100%",marginBottom:6,background:"#8B7355",color:"white",border:"none",padding:"6px",cursor:"pointer"}}>📊 Terrain Profile</button>
      </div>)}
    </div>)}
    <hr/>
    <div>
      <div style={{fontWeight:"bold",marginBottom:6}}>Nodes ({nodesRef.current.length})</div>
      <div style={{fontSize:11,color:"#888",marginBottom:2}}>🔵 {nodesRef.current.filter(n=>n.type==="gateway").length} Gateway{" | "}🟠 {nodesRef.current.filter(n=>n.type==="lra").length} LRA{" | "}🟢 {nodesRef.current.filter(n=>n.type==="sra").length} SRA</div>
      <div style={{fontSize:11,color:"#888",marginBottom:6}}>⚫ {nodesRef.current.filter(n=>n.type==="single").length} Single Modem
        {nodesRef.current.filter(n=>n.outOfRange&&n.type!=="single").length>0&&(<span style={{color:"red"}}>{" | "}⚠️ {nodesRef.current.filter(n=>n.outOfRange&&n.type!=="single").length} Disconnected</span>)}
      </div>
      {nodesRef.current.map((n,i)=>(<div key={i} style={{marginBottom:4}}>
        <span style={{color:n.outOfRange||n.type==="single"?"black":n.type==="gateway"?"blue":n.type==="lra"?"orange":"green",cursor:"pointer",textDecoration:"underline"}}
          onClick={()=>{mapRef.current.flyTo({center:[n.lng,n.lat],zoom:15});setSelectedNode(n);setEditName(n.name);setEditType(n.type);setEditHeight(n.height);}}>
          {n.name} ({n.type.toUpperCase()}) {n.type!=="single"?`${n.recommendedHeight||n.height} ft`:""}
        </span>
        {n.elevation!==null&&(<span style={{color:"#888",fontSize:11}}>{" "}| Elev: {n.elevation}ft</span>)}
        {n.blocked&&n.blockDetail&&(<div style={{color:"red",fontSize:11,marginLeft:10}}>{n.blockDetail}</div>)}
      </div>))}
    </div>
    <hr/>
    {recommendations.map((r,i)=>(<div key={i} style={{marginBottom:6,cursor:r.node?"pointer":"default",textDecoration:r.node?"underline":"none",color:r.node?"#2196F3":"inherit"}}
      onClick={()=>{if(r.node)generateProfile(r.node,r.target||null);}}>{r.text}{r.node&&" 📊"}</div>))}
  </div>
</div>
{showProfile&&profileData&&(<div style={{position:"absolute",top:"10%",left:"15%",width:"70%",background:"#1a1a2e",border:"2px solid #00bcd4",borderRadius:8,zIndex:2000,padding:10}}>
  <div style={{display:"flex",justifyContent:"flex-end",marginBottom:4}}>
    <button onClick={()=>setShowProfile(false)} style={{background:"red",color:"white",border:"none",borderRadius:"50%",width:28,height:28,cursor:"pointer",fontWeight:"bold",fontSize:14}}>✕</button>
  </div>
  <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
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
  <canvas ref={canvasRef} width={800} height={350} style={{width:"100%",height:"auto"}}/>
</div>)}
<div style={{flex:1,position:"relative"}}>
  <div ref={containerRef} style={{width:"100%",height:"100%"}}/>
  <button onClick={toggleHeatmap} style={{position:"absolute",top:10,right:170,zIndex:1000,padding:"8px 14px",
    background:showHeatmap?"#4CAF50":"rgba(50,50,50,0.85)",
    color:showHeatmap?"#fff":"#fff",
    border:showHeatmap?"2px solid #388E3C":"2px solid rgba(255,255,255,0.3)",
    borderRadius:6,cursor:"pointer",fontWeight:"bold",fontSize:13,
    backdropFilter:"blur(4px)",boxShadow:"0 2px 8px rgba(0,0,0,0.4)"}}>
    {showHeatmap?"📡 Heatmap ✅":"📡 Heatmap"}
  </button>
  <button onClick={toggleFCCTowers} style={{position:"absolute",top:10,right:10,zIndex:1000,padding:"8px 14px",
    background:showFCCTowers?"#FFD700":"rgba(50,50,50,0.85)",
    color:showFCCTowers?"#000":"#fff",
    border:showFCCTowers?"2px solid #DAA520":"2px solid rgba(255,255,255,0.3)",
    borderRadius:6,cursor:"pointer",fontWeight:"bold",fontSize:13,
    backdropFilter:"blur(4px)",boxShadow:"0 2px 8px rgba(0,0,0,0.4)"}}>
    {fccLoading?"⏳ Loading...":showFCCTowers?"🗼 FCC Towers ✅":"🗼 FCC Towers"}
  </button>
</div>
</div>);
}
