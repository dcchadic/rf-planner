"use client";

import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";

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

const [measureMode, setMeasureMode] = useState(false);
const measurePoints = useRef([]);
const measureMarkersRef = useRef([]);



  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const measureModeRef = useRef(false);
  useEffect(() => { measureModeRef.current = measureMode; }, [measureMode]);

  // ---------- INIT ----------
  useEffect(()=>{

    if(!containerRef.current) return;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [-102.8927,31.5943],
      zoom: 11
    });

    mapRef.current = map;

map.on("click",(e)=>{
      if(measureModeRef.current){
        handleMeasureClick(e.lngLat.lng, e.lngLat.lat);
        return;
      }
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

  const key = `${lng.toFixed(4)},${lat.toFixed(4)}`;
  if(elevationCache[key]) return elevationCache[key];

  try{
    const res = await fetch(
      `https://api.mapbox.com/v4/mapbox.mapbox-terrain-v2/tilequery/${lng},${lat}.json?layers=contour&limit=1&access_token=${mapboxgl.accessToken}`
    );

    const data = await res.json();

    const elev = (data.features?.[0]?.properties?.ele || 0) * 3.281;
    elevationCache[key] = elev;

    return elev;

  }catch{
    return 0;
  }
}


// ✅ LOS FUNCTION (separate!)
async function checkLOS(p1, p2, h1, h2){

  const elev1 = await getElevation(p1.lng, p1.lat);
  const elev2 = await getElevation(p2.lng, p2.lat);

  const tip1 = elev1 + h1;
  const tip2 = elev2 + h2;

  let maxBlock = 0;

  const steps = 10;
  for(let i = 1; i < steps; i++){
    const t = i / steps;
    const lng = p1.lng + (p2.lng - p1.lng) * t;
    const lat = p1.lat + (p2.lat - p1.lat) * t;
    const elev = await getElevation(lng, lat);
    const losAtPoint = tip1 + (tip2 - tip1) * t;

    const diff = elev - losAtPoint;
    if(diff > maxBlock) maxBlock = diff;
  }

  if(maxBlock > 0){
    return {
      clear: false,
      requiredHeight: maxBlock + 5
    };
  }

  return {
    clear: true,
    requiredHeight: 0
  };
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
  elevation: null,
  blocked: false,
  blockDetail: null,
  outOfRange: false

};
    const marker = new mapboxgl.Marker({element:el,draggable:true})
      .setLngLat([lng,lat])
      .addTo(map);

    el.addEventListener("click", (e) => {
  e.stopPropagation(); // ✅ CRITICAL FIX
  setSelectedNode(node);
setEditName(node.name);
setEditType(node.type); 
setEditHeight(node.height);
});

    marker.on("dragend",()=>{
      const p = marker.getLngLat();
      node.lng=p.lng;
      node.lat=p.lat;
      node.elevation = null;
      redraw();
    });

    el.oncontextmenu=(e)=>{
      e.preventDefault();
      marker.remove();
      
 nodesRef.current = nodesRef.current.filter(n=>n!==node);
      saveSnapshot();
      redraw();

    };

   node.marker = marker; 
    

nodesRef.current.push(node);
    if (!silent){
      saveSnapshot();
      redraw();
    }
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


  let clearGateway   = null;  let clearGatewayDist   = Infinity;
    let clearLRA       = null;  let clearLRADist       = Infinity;
    let clearSRA       = null;  let clearSRADist       = Infinity;
    let blockedGateway = null;  let blockedGatewayDist = Infinity;
    let blockedLRA     = null;  let blockedLRADist     = Infinity;
    let blockedSRA     = null;  let blockedSRADist     = Infinity;

    for (const b of nodesRef.current) {

      if (b === a) continue;

      const d = distance(a, b);
      
   

const linkRange = (b.type === "lra") ? 3 : a.range;
      if (d > linkRange) continue;

      const isGateway = b.type === "gateway";

     let hasMeshPath = false;

      if (!isGateway) {
        if (b.type !== "sra" && b.type !== "lra") continue;

        const bPath = getPath(b);
        const bReachesGateway = bPath.some(n => n.type === "gateway");
        if (bReachesGateway) {
          hasMeshPath = true;
        }
      }

      if (!isGateway && !hasMeshPath) continue;

      const los = await checkLOS(a, b, a.height, b.height);

     const isLRA = b.type === "lra";

      if      (isGateway && los.clear  && d < clearGatewayDist)          { clearGateway   = b; clearGatewayDist   = d; }
      else if (isGateway && !los.clear && d < blockedGatewayDist)        { blockedGateway = b; blockedGatewayDist = d; }
      else if (isLRA     && los.clear  && d < clearLRADist)              { clearLRA       = b; clearLRADist       = d; }
      else if (isLRA     && !los.clear && d < blockedLRADist)            { blockedLRA     = b; blockedLRADist     = d; }
      else if (!isGateway && !isLRA && los.clear  && d < clearSRADist)   { clearSRA       = b; clearSRADist       = d; }
      else if (!isGateway && !isLRA && !los.clear && d < blockedSRADist) { blockedSRA     = b; blockedSRADist     = d; }

    }

    const best = clearGateway || clearLRA || clearSRA || blockedGateway || blockedLRA || blockedSRA || null;

    if (best) {
      linksRef.current[a.name] = best;
    }
  }
}

 function getPath(start){

    const path=[start];
    let current=start;

    for(let i=0;i<10;i++){

      const next = linksRef.current[current.name];
      if(!next) break;

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

for (const n of nodesRef.current){
      n.blocked = false;
      n.blockDetail = null;
    }
    await computeLinks();

for (const n of nodesRef.current){
      if (n.type === "gateway") { n.outOfRange = false; continue; }
      const path = getPath(n);
      const reaches = path.some(p => p.type === "gateway");
      n.outOfRange = !reaches;
      if ((n.outOfRange || n.type === "single") && n.markerElement){
        n.markerElement.style.background = "black";
      } else if (n.markerElement){
        n.markerElement.style.background =
          n.type === "gateway" ? "blue" :
          n.type === "lra" ? "orange" : "green";
      }
    }
console.log("LINKS:", linksRef.current);

    const layers = map.getStyle().layers || [];

    layers.forEach(l=>{
      if(l.id.startsWith("node") || l.id.startsWith("line") || l.id.startsWith("label") || l.id.startsWith("route") || l.id === "all-nodes"){
        if(map.getLayer(l.id)) map.removeLayer(l.id);
        if(map.getSource(l.id)) map.removeSource(l.id);
      }
    });
// ✅ ALL NODE LABELS IN ONE LAYER
    const nodeFeatures = [];
    for(let k=0; k<nodesRef.current.length; k++){
      const nd = nodesRef.current[k];
      if (nd.elevation === null){
        const elevM = await getElevation(nd.lng, nd.lat);
        nd.elevation = Math.round(elevM);
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

    map.addSource("all-nodes", {
      type: "geojson",
      data: { type: "FeatureCollection", features: nodeFeatures }
    });

    map.addLayer({
      id: "all-nodes",
      type: "symbol",
      source: "all-nodes",
      layout: {
        "text-field": ["get", "text"],
        "text-size": 12,
        "text-variable-anchor": ["top", "bottom", "left", "right"],
        "text-radial-offset": 1.2,
        "text-justify": "auto",
        "text-allow-overlap": false
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "#000000",
        "text-halo-width": 1
      }
    });

    for(let i=0;i<nodesRef.current.length;i++){

      const a = nodesRef.current[i];

     if(a.type==="gateway") continue;

      const path = getPath(a);

if (!path || path.length < 2) continue;

      for(let j=0;j<path.length-1;j++){

        const p1 = path[j];
        const p2 = path[j+1];

        const los = await checkLOS(p1, p2, p1.height, p2.height);
        const d = distance(p1,p2);
const signal = calcPower(d);

if (!los.clear){
          p1.blocked = true;
          p1.blockDetail = `⛰️ +${Math.ceil(los.requiredHeight)}ft to clear → ${p2.name}`;
        }

        const lineId = `line-${i}-${j}`;

       // ✅ REMOVE OLD SOURCE FIRST (FIX)
if (map.getSource(lineId)) {
  try {
    map.removeLayer(lineId);
    map.removeSource(lineId);
  } catch {}
}

// ✅ NOW ADD NEW ONE
map.addSource(lineId,{
  type: "geojson",
  data: {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [p1.lng, p1.lat],
        [p2.lng, p2.lat]
      ]
    }
  }
});
        map.addLayer({
          id:lineId,
          type:"line",
          source:lineId,
          paint:{
           
"line-color":
!los.clear ? "red" :
signal > -70 ? "green" :
signal > -85 ? "yellow" :
signal > -100 ? "orange" :
"red",

            "line-width":3
          }
        });

       
// ✅ LABEL
const labelId = `label-${i}-${j}`;

if (map.getSource(labelId)) {
  try {
    map.removeLayer(labelId);
    map.removeSource(labelId);
  } catch {}
}

map.addSource(labelId,{
  type: "geojson",
  data: {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [
        (p1.lng + p2.lng)/2,
        (p1.lat + p2.lat)/2
      ]
    },
    properties: {
     
text: los.clear
  ? `${d.toFixed(2)} mi | ${signal.toFixed(0)} dBm`
  : `${d.toFixed(2)} mi | BLOCKED | +${Math.ceil(los.requiredHeight)} ft`

    }
  }
});

map.addLayer({
  id: labelId,
  type: "symbol",
  source: labelId,
  layout: {
    "text-field": ["get", "text"],
    "text-size": 13,
    "text-variable-anchor": ["top", "bottom", "left", "right"],
    "text-radial-offset": 1.2,
    "text-justify": "auto",
   "text-allow-overlap": false
  },
  paint: {
    "text-color": "#00ffff",
    "text-halo-color": "#000000",
    "text-halo-width": 2
  }
});

      } // ✅ closes INNER loop (j loop)

    } // ✅ closes OUTER loop (i loop)

    analyzeNetwork();

}

// ✅ TERRAIN PROFILE GENERATOR
  async function generateProfile(node, forceTarget){
    const target = forceTarget || linksRef.current[node.name];
    if(!target){
      alert("This node has no connection to profile.");
      return;
    }

   const samples = Math.max(10, Math.round((distance(node, target) * 5280) / 100));
    const points = [];
    const totalDist = distance(node, target);

    for(let i = 0; i <= samples; i++){
      const t = i / samples;
      const lng = node.lng + (target.lng - node.lng) * t;
      const lat = node.lat + (target.lat - node.lat) * t;
      const elev = await getElevation(lng, lat);
      const d = totalDist * t;
      points.push({ dist: d, elev, lng, lat });
    }

    setProfileData({
      from: node,
      to: target,
      points,
      totalDist
    });
    setProfileFromHeight(node.height);
    setProfileToHeight(target.height);
    setShowProfile(true);
  }
// ✅ DRAW TERRAIN PROFILE ON CANVAS
  useEffect(() => {
    if(!showProfile || !profileData || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;

    const points = profileData.points;
    const padElev = 30;
    const minElev = Math.min(...points.map(p => p.elev)) - padElev;
    const maxElev = Math.max(...points.map(p => p.elev)) + padElev + profileData.from.height + profileData.to.height;
    const maxDist = profileData.totalDist;

    const left = 65;
    const right = 25;
    const top = 35;
    const bottom = 45;
    const plotW = W - left - right;
    const plotH = H - top - bottom;

    // Background
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, W, H);

    // Elevation grid lines every 20ft
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 0.5;
    ctx.fillStyle = "#888";
    ctx.font = "11px Arial";
    ctx.textAlign = "right";

    const elevStep = 20;
    const startElev = Math.floor(minElev / elevStep) * elevStep;

    for(let e = startElev; e <= maxElev; e += elevStep){
      const y = top + plotH - ((e - minElev) / (maxElev - minElev)) * plotH;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + plotW, y);
      ctx.stroke();
      ctx.fillText(`${Math.round(e)}ft`, left - 5, y + 4);
    }

   // Helper: get x,y for a point
    function ptX(i){ return left + (points[i].dist / maxDist) * plotW; }
    function ptY(i){ return top + plotH - ((points[i].elev - minElev) / (maxElev - minElev)) * plotH; }

    // Terrain fill (smooth)
    ctx.beginPath();
    ctx.moveTo(left, top + plotH);
    ctx.lineTo(ptX(0), ptY(0));
    for(let i = 0; i < points.length - 1; i++){
      const cx = (ptX(i) + ptX(i+1)) / 2;
      const cy = (ptY(i) + ptY(i+1)) / 2;
      ctx.quadraticCurveTo(ptX(i), ptY(i), cx, cy);
    }
    ctx.lineTo(ptX(points.length-1), ptY(points.length-1));
    ctx.lineTo(left + plotW, top + plotH);
    ctx.closePath();

    // Gradient fill
    const terrainGrad = ctx.createLinearGradient(0, top, 0, top + plotH);
    terrainGrad.addColorStop(0, "rgba(139, 119, 81, 0.7)");
    terrainGrad.addColorStop(0.4, "rgba(107, 142, 35, 0.6)");
    terrainGrad.addColorStop(1, "rgba(34, 85, 34, 0.8)");
    ctx.fillStyle = terrainGrad;
    ctx.fill();

    // Terrain line (smooth)
    ctx.beginPath();
    ctx.moveTo(ptX(0), ptY(0));
    for(let i = 0; i < points.length - 1; i++){
      const cx = (ptX(i) + ptX(i+1)) / 2;
      const cy = (ptY(i) + ptY(i+1)) / 2;
      ctx.quadraticCurveTo(ptX(i), ptY(i), cx, cy);
    }
    ctx.lineTo(ptX(points.length-1), ptY(points.length-1));
    ctx.strokeStyle = "#8B7751";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Antenna heights
    
const fromElev = points[0].elev + profileFromHeight;
    const toElev = points[points.length - 1].elev + profileToHeight;

    const fromGroundY = top + plotH - ((points[0].elev - minElev) / (maxElev - minElev)) * plotH;
    const toGroundY = top + plotH - ((points[points.length-1].elev - minElev) / (maxElev - minElev)) * plotH;
    const fromTipY = top + plotH - ((fromElev - minElev) / (maxElev - minElev)) * plotH;
    const toTipY = top + plotH - ((toElev - minElev) / (maxElev - minElev)) * plotH;

    // From antenna pole
    ctx.beginPath();
    ctx.moveTo(left, fromGroundY);
    ctx.lineTo(left, fromTipY);
    ctx.strokeStyle = "#00bcd4";
    ctx.lineWidth = 3;
    ctx.stroke();

    // To antenna pole
    ctx.beginPath();
    ctx.moveTo(left + plotW, toGroundY);
    ctx.lineTo(left + plotW, toTipY);
    ctx.strokeStyle = "#00bcd4";
    ctx.lineWidth = 3;
    ctx.stroke();

    // LOS line (dashed)
    ctx.beginPath();
    ctx.moveTo(left, fromTipY);
    ctx.lineTo(left + plotW, toTipY);
    ctx.strokeStyle = "#ff5555";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Check if terrain crosses LOS
    let blocked = false;
    for(let i = 0; i < points.length; i++){
      const t = i / (points.length - 1);
      const losAtPoint = fromElev + (toElev - fromElev) * t;
      if(points[i].elev > losAtPoint){
        blocked = true;
        const x = left + (points[i].dist / maxDist) * plotW;
        const y = top + plotH - ((points[i].elev - minElev) / (maxElev - minElev)) * plotH;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = "red";
        ctx.fill();
      }
    }

   // Node name labels
    ctx.fillStyle = "#00bcd4";
    ctx.font = "bold 12px Arial";
    ctx.textAlign = "left";
    ctx.fillText(`${profileData.from.name} (${profileData.from.type.toUpperCase()}) ${profileFromHeight}ft`, left + 5, top + 15);
    ctx.textAlign = "right";
    ctx.fillText(`${profileData.to.name} (${profileData.to.type.toUpperCase()}) ${profileToHeight}ft`, left + plotW - 5, top + 15);

    // Distance labels on X axis
    ctx.fillStyle = "#888";
    ctx.font = "11px Arial";
    for(let i = 0; i <= 5; i++){
      const d = (maxDist / 5) * i;
      const x = left + (d / maxDist) * plotW;
      ctx.fillText(`${d.toFixed(2)}mi`, x, top + plotH + 20);
    }

    // Title
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 14px Arial";
    ctx.textAlign = "center";
    const signal = calcPower(maxDist);
    const statusText = blocked ? "⛰️ LOS BLOCKED" : `✅ LOS Clear | ${signal.toFixed(0)} dBm`;
    ctx.fillText(`${profileData.totalDist.toFixed(2)} mi | ${statusText}`, W / 2, H - 5);

    // Recommended height
    if(blocked){
      let maxBlock = 0;
      for(let i = 0; i < points.length; i++){
        const t = i / (points.length - 1);
        const losAtPoint = fromElev + (toElev - fromElev) * t;
        const diff = points[i].elev - losAtPoint;
        if(diff > maxBlock) maxBlock = diff;
      }
      const recHeight = Math.ceil(maxBlock + 5);
      ctx.fillStyle = "#ff5555";
      ctx.font = "bold 16px Arial";
      ctx.textAlign = "center";
      ctx.fillText(`⚠️ Increase height by ~${recHeight}ft to clear obstruction`, W / 2, top + 30);
    } else {
      ctx.fillStyle = "#4CAF50";
      ctx.font = "bold 16px Arial";
      ctx.textAlign = "center";
      ctx.fillText(`✅ Clear LOS — no height change needed`, W / 2, top + 30);
    }

   }, [showProfile, profileData, profileFromHeight, profileToHeight]);

function saveSnapshot(){
    const snap = nodesRef.current.map(n => ({
      name: n.name, type: n.type,
      lat: n.lat, lng: n.lng,
      height: n.height, range: n.range
    }));
    undoStack.current.push(JSON.stringify(snap));
    redoStack.current = [];
    if(undoStack.current.length > 50) undoStack.current.shift();
  }
function undo(){
    if(undoStack.current.length === 0) return;
    const currentSnap = nodesRef.current.map(n => ({
      name: n.name, type: n.type,
      lat: n.lat, lng: n.lng,
      height: n.height, range: n.range
    }));
    redoStack.current.push(JSON.stringify(currentSnap));

    const prev = JSON.parse(undoStack.current.pop());
    const map = mapRef.current;

    nodesRef.current.forEach(n => { if(n.marker) n.marker.remove(); });
    nodesRef.current = [];

    prev.forEach(n => {
      addNode(map, n.lng, n.lat, n.type, n.name, true, n.height);
    });
    redraw();
  }

  function redo(){
    if(redoStack.current.length === 0) return;
    const currentSnap = nodesRef.current.map(n => ({
      name: n.name, type: n.type,
      lat: n.lat, lng: n.lng,
      height: n.height, range: n.range
    }));
    undoStack.current.push(JSON.stringify(currentSnap));

    const next = JSON.parse(redoStack.current.pop());
    const map = mapRef.current;

    nodesRef.current.forEach(n => { if(n.marker) n.marker.remove(); });
    nodesRef.current = [];

    next.forEach(n => {
      addNode(map, n.lng, n.lat, n.type, n.name, true, n.height);
    });
    redraw();
  }
function handleMeasureClick(lng, lat){
    const map = mapRef.current;

    // Add a small red dot at click point
    const el = document.createElement("div");
    el.style.width = "10px";
    el.style.height = "10px";
    el.style.borderRadius = "50%";
    el.style.background = "red";
    el.style.border = "2px solid white";

    const marker = new mapboxgl.Marker({element: el})
      .setLngLat([lng, lat])
      .addTo(map);

    measureMarkersRef.current.push(marker);
    measurePoints.current.push({lng, lat});

    if(measurePoints.current.length === 2){
      const p1 = measurePoints.current[0];
      const p2 = measurePoints.current[1];
      const d = distance(p1, p2);

      // Draw line
      if(map.getLayer("measure-line")) map.removeLayer("measure-line");
      if(map.getSource("measure-line")) map.removeSource("measure-line");

      map.addSource("measure-line", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [[p1.lng, p1.lat], [p2.lng, p2.lat]]
          }
        }
      });

      map.addLayer({
        id: "measure-line",
        type: "line",
        source: "measure-line",
        paint: {
          "line-color": "#ff00ff",
          "line-width": 3,
          "line-dasharray": [4, 3]
        }
      });

      // Distance label
      if(map.getLayer("measure-label")) map.removeLayer("measure-label");
      if(map.getSource("measure-label")) map.removeSource("measure-label");

      map.addSource("measure-label", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [(p1.lng + p2.lng)/2, (p1.lat + p2.lat)/2]
          },
          properties: {
            text: `📏 ${d.toFixed(2)} mi (${(d * 5280).toFixed(0)} ft)`
          }
        }
      });

      map.addLayer({
        id: "measure-label",
        type: "symbol",
        source: "measure-label",
        layout: {
          "text-field": ["get", "text"],
          "text-size": 16,
          "text-offset": [0, -1.5],
          "text-anchor": "bottom",
          "text-allow-overlap": true
        },
        paint: {
          "text-color": "#ff00ff",
          "text-halo-color": "#000000",
          "text-halo-width": 2
        }
      });
    }
  }

  function clearMeasure(){
    const map = mapRef.current;

    measurePoints.current = [];

    measureMarkersRef.current.forEach(m => m.remove());
    measureMarkersRef.current = [];

    if(map.getLayer("measure-line")) map.removeLayer("measure-line");
    if(map.getSource("measure-line")) map.removeSource("measure-line");
    if(map.getLayer("measure-label")) map.removeLayer("measure-label");
    if(map.getSource("measure-label")) map.removeSource("measure-label");
  }
function redraw(){
    setNodeVersion(v => v + 1);
    draw();
  }

// ✅ SAVE NETWORK — downloads a file to your computer
  function saveNetwork(){
    const fileName = prompt("Name this network:", "rf-network");
    if(!fileName) return;

    const data = nodesRef.current.map(n => ({
      name: n.name,
      type: n.type,
      lat: n.lat,
      lng: n.lng,
      height: n.height,
      range: n.range
    }));

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }

function exportExcel(){
    // Sheet 1: Node Details
    const nodeRows = nodesRef.current.map(n => ({
      "Name": n.name,
      "Type": n.type.toUpperCase(),
      "Latitude": n.lat,
      "Longitude": n.lng,
      "Antenna Height (ft)": n.height,
      "Recommended Height (ft)": n.recommendedHeight || n.height,
      "Ground Elevation (ft)": n.elevation || "N/A",
      "Range (mi)": n.range,
        "Status": n.outOfRange ? "SINGLE MODEM" : n.blocked ? "BLOCKED" : "OK"
    }));

    // Sheet 2: Connections
    const connectionRows = [];
    for(const a of nodesRef.current){
      if(a.type === "gateway") continue;
      const target = linksRef.current[a.name];
      if(target){
        const d = distance(a, target);
        const signal = calcPower(d);
        connectionRows.push({
          "From": a.name,
          "To": target.name,
          "Distance (mi)": Number(d.toFixed(2)),
          "Signal (dBm)": Number(signal.toFixed(0)),
          "LOS": a.blocked ? "BLOCKED" : "CLEAR"
        });
      } else {
        connectionRows.push({
          "From": a.name,
          "To": "NONE",
          "Distance (mi)": "N/A",
          "Signal (dBm)": "N/A",
          "LOS": "NO CONNECTION"
        });
      }
    }

    // Sheet 3: Summary
    const summaryRows = [
      { "Item": "Total Nodes", "Value": nodesRef.current.length },
      { "Item": "Gateways", "Value": nodesRef.current.filter(n => n.type === "gateway").length },
      { "Item": "LRAs", "Value": nodesRef.current.filter(n => n.type === "lra").length },
      { "Item": "SRAs", "Value": nodesRef.current.filter(n => n.type === "sra").length }
    ];

    // Sheet 4: Recommendations
    const recRows = recommendations.map(r => ({
      "Recommendation": r.text
    }));

    // Build workbook
    const wb = XLSX.utils.book_new();

    const ws1 = XLSX.utils.json_to_sheet(nodeRows);
    XLSX.utils.book_append_sheet(wb, ws1, "Nodes");

    const ws2 = XLSX.utils.json_to_sheet(connectionRows);
    XLSX.utils.book_append_sheet(wb, ws2, "Connections");

    const ws3 = XLSX.utils.json_to_sheet(summaryRows);
    XLSX.utils.book_append_sheet(wb, ws3, "Summary");

    const ws4 = XLSX.utils.json_to_sheet(recRows);
    XLSX.utils.book_append_sheet(wb, ws4, "Recommendations");

    // Download
    XLSX.writeFile(wb, "rf-network-report.xlsx");
  }
    
  // ✅ LOAD NETWORK — opens a saved file
  function loadNetwork(e){
    const reader = new FileReader();

    reader.onload = (evt) => {
      const data = JSON.parse(evt.target.result);
      const map = mapRef.current;

      // clear old nodes
      nodesRef.current.forEach(n => {
        if(n.marker) n.marker.remove();
      });
      nodesRef.current = [];

      // place each saved node
      data.forEach(n => {
        addNode(map, n.lng, n.lat, n.type, n.name, false, n.height);
      });

      // center map on loaded network
      let avgLat = 0;
      let avgLng = 0;
      for(const n of data){
        avgLat += n.lat;
        avgLng += n.lng;
      }
      avgLat /= data.length;
      avgLng /= data.length;
      map.flyTo({ center: [avgLng, avgLat], zoom: 13 });
    };

    reader.readAsText(e.target.files[0]);
  }


 
// ---------- ANALYSIS ----------

async function analyzeNetwork(){

  const recs = [];

  // ✅ Check CONNECTED nodes for blocked LOS on their actual path
  for(const a of nodesRef.current){
    if(a.type === "gateway") continue;
    if(a.type === "single") continue;

    const path = getPath(a);
    const reachesGateway = path.some(n => n.type === "gateway");
    if(!reachesGateway) continue;

    for(let p = 0; p < path.length - 1; p++){
      const p1 = path[p];
      const p2 = path[p + 1];
     if(p1.blocked){
        recs.push({
          text: `⛰️ ${p1.name.toUpperCase()} → ${p2.name.toUpperCase()}: Blocked LOS — adjust height`,
          node: p1,
          target: p2
        });
      }
    }
  }

  // ✅ Check DISCONNECTED nodes
  for(const a of nodesRef.current){

   if(a.type === "gateway") continue;
    if(a.type === "single") continue;

    const path = getPath(a);
    const reachesGateway = path.some(n => n.type === "gateway");

    if(reachesGateway) continue;

    let worstClear = 100;
    let bestSignal = -999;
 let maxNeededHeight = 0; 

    for(const b of nodesRef.current){

      if(a === b) continue;

      const d = distance(a,b);

       
const linkRange = (b.type === "lra") ? 3 : a.range;
      if (d > linkRange) continue;



      const los = await checkLOS(a, b, a.height, b.height);

if(!los.clear && (a.type === "lra" || a.type === "gateway")){
 recs.push({
    text: `📡 ${a.name.toUpperCase()}: Increase height by ~${Math.ceil(los.requiredHeight)} ft (terrain)`,
    node: a
  });
}

      const signal = calcPower(d);

      // ✅ Track worst Fresnel
     
if(!los.clear){
        worstClear = 0;
        if(los.requiredHeight > maxNeededHeight){
          maxNeededHeight = los.requiredHeight;
        }
      }


      // ✅ Track best signal
      if(signal > bestSignal){
        bestSignal = signal;
      }
    }

    const terrainBlocked = worstClear === 0;

    // ✅ Height calculation (your existing logic)
     const neededBoost = terrainBlocked ? Math.ceil(maxNeededHeight) : 0;
    let targetHeight = a.height + neededBoost;

    // ✅ UPDATED MAX RULES (your requirement)
    let maxHeight =
      a.type === "sra" ? 5 :
      a.type === "lra" ? 30 :
      a.type === "gateway" ? 30 : 999;

    let capped = false;

    if(targetHeight > maxHeight){
      targetHeight = maxHeight;
      capped = true;
    }

a.recommendedHeight = targetHeight;

 // ✅ SIGNAL CONDITION
    const weakSignal = bestSignal < -90;

    // ✅ FINAL RECOMMENDATION LOGIC

   // No node in range at all — skip (already shown as Single Modem on map)
    if(bestSignal === -999){

    } else if(terrainBlocked || weakSignal){

      if(!capped){
      recs.push({
          text: `📡 ${a.name.toUpperCase()}: Set antenna height to ~${targetHeight} ft (${bestSignal.toFixed(0)} dBm)`,
          node: a
        });
      } else {
        if(a.type === "sra"){
          recs.push({
            text: `⬆️ ${a.name.toUpperCase()}: Max height reached (5 ft). Upgrade to LRA (${bestSignal.toFixed(0)} dBm)`
          });
        } else {
          recs.push({
            text: `📡 ${a.name.toUpperCase()}: Set antenna height to max ${targetHeight} ft (${bestSignal.toFixed(0)} dBm)`,
            node: a
          });
        }
      }

    } else {
      recs.push({
        text: `✅ ${a.name.toUpperCase()}: Good link (${bestSignal.toFixed(0)} dBm)`
      });
    }

  }

  // ✅ FINAL OUTPUT
  if (recs.length === 0) {
    setRecommendations([
      { text: "✅ All nodes connected — no action needed" }
    ]);
 
 } else {
    setRecommendations(recs);
  }

} 

function importText(){
    if(!inputCoords.trim()) return;

    const lines = inputCoords.trim().split("\n");

    for(const line of lines){
      const parts = line.split(",");
      if(parts.length < 3) continue;

      const name = parts[0].trim();
      const lat = parseFloat(parts[1].trim());
      const lng = parseFloat(parts[2].trim());

      if(isNaN(lat) || isNaN(lng)) continue;

      addNode(mapRef.current, lng, lat, modeRef.current, name);
    }

    // center map on first coordinate
    const first = inputCoords.trim().split("\n")[0].split(",");
    const lat = parseFloat(first[1]);
    const lng = parseFloat(first[2]);
    if(!isNaN(lat) && !isNaN(lng)){
      mapRef.current.flyTo({ center: [lng, lat], zoom: 13 });
    }

    setInputCoords("");
  }

function uploadExcel(e){


  const reader = new FileReader();

  reader.onload = (evt) => {

    const wb = XLSX.read(new Uint8Array(evt.target.result));

    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

    // ✅ store data for optimization
    setImportedData(rows);

    // ✅ show prompt
    setShowOptimizePrompt(true);
  };

  reader.readAsArrayBuffer(e.target.files[0]);
}

async function optimizeExisting(){

  const map = mapRef.current;
  if(!nodesRef.current.length) return;

  const recs = [];

  // ✅ Check if there's already a gateway
  let hasGateway = nodesRef.current.some(n => n.type === "gateway");

  // ✅ If no gateway, find the best one (closest to center)
 if(!hasGateway){

    let bestNode = nodesRef.current[0];
    let bestCount = -1;

    for(const n of nodesRef.current){
      let count = 0;
      for(const other of nodesRef.current){
        if(other === n) continue;
        if(distance(n, other) <= 3) count++;
      }
      if(count > bestCount){
        bestCount = count;
        bestNode = n;
      }
    }

    const gwLat = bestNode.lat + (60 / 364000);
    const gwLng = bestNode.lng;
    addNode(map, gwLng, gwLat, "gateway", "GATEWAY-1", true);

    recs.push({
      text: `📡 GATEWAY-1 placed 60ft north of ${bestNode.name.toUpperCase()}`
    });
  }

  // ✅ Reset all non-gateway nodes to SRA first
  for(const node of nodesRef.current){
    if(node.type === "gateway") continue;

    node.type = "sra";
    node.height = 5;
    node.range = 0.75;
    if(node.markerElement){
      node.markerElement.style.background = "green";
    }
  }

  // ✅ Build initial connections
  await computeLinks();

 // ✅ Upgrade ONE node at a time to minimize LRA usage
  for(let pass = 0; pass < 10; pass++){

    let upgraded = false;

    // find disconnected nodes
    let disconnected = [];
    for(const node of nodesRef.current){
      if(node.type === "gateway") continue;
      const path = getPath(node);
      const reachesGateway = path.some(n => n.type === "gateway");
      if(!reachesGateway) disconnected.push(node);
    }

    if(disconnected.length === 0) break;

    // find the best node to upgrade (most disconnected neighbors)
    let bestCandidate = null;
    let bestScore = -1;

    for(const node of disconnected){

      // must be within LRA range of gateway or existing LRA
      let inRange = false;
      for(const g of nodesRef.current){
        if(g.type !== "gateway" && g.type !== "lra") continue;
        if(distance(node, g) <= 3){
          inRange = true;
          break;
        }
      }

      if(!inRange) continue;

      // score = how many disconnected nodes are within SRA range
      let score = 0;
      for(const other of disconnected){
        if(other === node) continue;
        if(distance(node, other) <= 0.75) score++;
      }

      if(score > bestScore){
        bestScore = score;
        bestCandidate = node;
      }
    }

    if(!bestCandidate) break;

    bestCandidate.type = "lra";
    bestCandidate.height = 10;
    bestCandidate.range = 3;
    if(bestCandidate.markerElement){
      bestCandidate.markerElement.style.background = "orange";
    }

    recs.push({
      text: `⬆️ ${bestCandidate.name.toUpperCase()} upgraded to LRA (needed for connectivity)`
    });

    // rebuild and check again
    await computeLinks();
  }

  // ✅ Rebuild after upgrades
  await computeLinks();

  // ✅ Check if anything still can't connect
  for(const node of nodesRef.current){

    if(node.type === "gateway") continue;

    const path = getPath(node);
    const reachesGateway = path.some(n => n.type === "gateway");

    if(!reachesGateway){
      recs.push({
        text: `⚠️ ${node.name.toUpperCase()}: Cannot reach gateway — consider repositioning`
      });
    }
  }

       // ✅ Redraw and show results
  draw();
  setRecommendations(prev => [...prev, ...recs]);
}

async function autoOptimizeNetwork(){

  if(!importedData.length) return;

  nodesRef.current = [];
  const map = mapRef.current;

  const recs = [];

  // ✅ Primary gateway
 // ✅ FIND NODE WITH MOST NEIGHBORS → BEST GATEWAY
let gateway = importedData[0];
let bestCount = -1;

for (const r of importedData) {
  let count = 0;
  for (const other of importedData) {
    if (other === r) continue;
    const d = distance(
      { lng: r.Longitude, lat: r.Latitude },
      { lng: other.Longitude, lat: other.Latitude }
    );
    if (d <= 3) count++;
  }
  if (count > bestCount) {
    bestCount = count;
    gateway = r;
  }
}

// ✅ Center map on gateway
map.flyTo({ center: [gateway.Longitude, gateway.Latitude], zoom: 13 });
// ✅ PLACE GATEWAY 60ft north of best node
const gwLat = gateway.Latitude + (60 / 364000);
const gwLng = gateway.Longitude;
addNode(map, gwLng, gwLat, "gateway", "GATEWAY-1", true);

 const placedNodes = [];

 for (let i = 0; i < importedData.length; i++) {

  const r = importedData[i];

  placedNodes.push(r);

  addNode(map, r.Longitude, r.Latitude, "sra", r.Name, true);
}

// ✅ Build initial connections
await computeLinks();
// ✅ Upgrade ONE node at a time to minimize LRA usage
for(let pass = 0; pass < 10; pass++){

  let upgraded = false;

  let disconnected = [];
  for(const node of nodesRef.current){
    if(node.type === "gateway") continue;
    const path = getPath(node);
    const reachesGateway = path.some(n => n.type === "gateway");
    if(!reachesGateway) disconnected.push(node);
  }

  if(disconnected.length === 0) break;

  let bestCandidate = null;
  let bestScore = -1;

  for(const node of disconnected){

    let inRange = false;
   for(const g of nodesRef.current){
        if(g.type !== "gateway" && g.type !== "lra") continue;
        if(distance(node, g) <= 3){
          inRange = true;
          break;
        }
      }

    if(!inRange) continue;

    let score = 0;
    for(const other of disconnected){
      if(other === node) continue;
      if(distance(node, other) <= 0.75) score++;
    }

    if(score > bestScore){
      bestScore = score;
      bestCandidate = node;
    }
  }

  if(!bestCandidate) break;

  bestCandidate.type = "lra";
  bestCandidate.range = 3;
  bestCandidate.height = 10;
  if(bestCandidate.markerElement){
    bestCandidate.markerElement.style.background = "orange";
  }

  await computeLinks();
}

  // ✅ IMPROVED GATEWAY LOGIC (ONLY ADD IF NEEDED)
let disconnectedCount = 0;

for (const node of nodesRef.current) {

  if (node.type === "gateway") continue;

  const path = getPath(node);
  const reachesGateway = path.some(n => n.type === "gateway");

  if (!reachesGateway) {
    disconnectedCount++;
  }
}

if (disconnectedCount > 6) {
  let candidate = null;
  for (const node of nodesRef.current) {
    if (node.type === "gateway") continue;
    const path = getPath(node);
    if (!path.some(n => n.type === "gateway")){ candidate = node; break; }
  }
  if (candidate) {
    addNode(map, candidate.lng, candidate.lat, "gateway", "GATEWAY-2", true);
    recs.push({ text: `📡 Secondary Gateway added (needed for connectivity)` });
  }
}

// ✅ ✅ NOW FINISH THE FUNCTION
draw();

setRecommendations(prev => [...prev, ...recs]);
setShowOptimizePrompt(false);

} // ✅ closes autoOptimizeNetwork

return (  <div style={{display:"flex",height:"100vh"}}>

{showOptimizePrompt && (
  <div style={{
    position:"absolute",
    top:"30%",
    left:"35%",
    background:"#fff",
    padding:20,
    border:"2px solid black",
    zIndex:1000
  }}>
    <div style={{marginBottom:10,fontWeight:"bold"}}>
      Do you want to Auto-Optimize this network?
    </div>

    <button onClick={autoOptimizeNetwork} style={{marginRight:10}}>
      Yes
    </button>

    <button onClick={()=>{
      setShowOptimizePrompt(false);

      importedData.forEach(r=>{
        addNode(mapRef.current, r.Longitude, r.Latitude, "sra", r.Name);
      });

      // ✅ Center map on uploaded coordinates
      let avgLat = 0;
      let avgLng = 0;
      for(const r of importedData){
        avgLat += r.Latitude;
        avgLng += r.Longitude;
      }
      avgLat /= importedData.length;
      avgLng /= importedData.length;
      mapRef.current.flyTo({ center: [avgLng, avgLat], zoom: 13 });
    }}>
      No
    </button>
  </div>
)}

    {/* ✅ SIDEBAR */}
   <div style={{
  width:300,
  display:"flex",
  flexDirection:"column",
  height:"100%",
  borderRight:"1px solid #ccc"
}}>

      {/* ✅ Mode buttons */}
  
<div style={{padding:12}}>
 <div style={{display:"flex", gap:4}}>
    <button
      onClick={()=>setMode("gateway")}
      style={{
        flex:1, padding:"6px", border:"none", cursor:"pointer", color:"white",
        background: mode === "gateway" ? "#0000cc" : "blue", fontWeight:"bold", fontSize:11
      }}
    >🔵 Gateway</button>
    <button
      onClick={()=>setMode("lra")}
      style={{
        flex:1, padding:"6px", border:"none", cursor:"pointer", color:"white",
        background: mode === "lra" ? "#cc7a00" : "orange", fontWeight:"bold", fontSize:11
      }}
    >🟠 LRA</button>
    <button
      onClick={()=>setMode("sra")}
      style={{
        flex:1, padding:"6px", border:"none", cursor:"pointer", color:"white",
        background: mode === "sra" ? "#2e7d32" : "green", fontWeight:"bold", fontSize:11
      }}
    >🟢 SRA</button>
    <button
      onClick={()=>setMode("single")}
      style={{
        flex:1, padding:"6px", border:"none", cursor:"pointer", color:"white",
        background: mode === "single" ? "#333" : "black", fontWeight:"bold", fontSize:11
      }}
    >⚫ Single</button>
  </div>
  <button onClick={optimizeExisting} style={{marginTop:6, width:"100%", background:"#4CAF50", color:"white", padding:"6px", border:"none", cursor:"pointer"}}>
    ⚡ Auto-Optimize
  </button><button onClick={() => {
    nodesRef.current.forEach(n => { if(n.marker) n.marker.remove(); });
    nodesRef.current = [];
    linksRef.current = {};
    setRecommendations([]);
    setSelectedNode(null);
    redraw();
  }} style={{marginTop:6, width:"100%", background:"#f44336", color:"white", padding:"6px", border:"none", cursor:"pointer"}}>
    🗑️ Clear All
  </button>
</div>

<div style={{
  flex:1,
  overflowY:"auto",
  padding:12
}}>

<div style={{display:"flex", gap:4, marginTop:6}}>
    <button onClick={undo} style={{flex:1, background:"#666", color:"white", padding:"6px", border:"none", cursor:"pointer"}}>
      ↩️ Undo
    </button>
    <button onClick={redo} style={{flex:1, background:"#666", color:"white", padding:"6px", border:"none", cursor:"pointer"}}>
      ↪️ Redo
    </button>
  </div>
<div style={{display:"flex", gap:4, marginTop:6}}>
    <button
      onClick={() => {
        clearMeasure();
        setMeasureMode(!measureMode);
      }}
      style={{
        flex:1,
        background: measureMode ? "#ff00ff" : "#666",
        color:"white",
        padding:"6px",
        border:"none",
        cursor:"pointer"
      }}
    >
      {measureMode ? "📏 Measuring..." : "📏 Measure"}
    </button>
    <button
      onClick={() => {
        clearMeasure();
        setMeasureMode(false);
      }}
      style={{flex:1, background:"#666", color:"white", padding:"6px", border:"none", cursor:"pointer"}}
    >
      ✕ Clear
    </button>
  </div>
           <hr/>

      {/* ✅ Import text */}
      <textarea
        value={inputCoords}
        onChange={e=>setInputCoords(e.target.value)}
        placeholder="Name,Lat,Lng"
        style={{width:"100%",height:80}}
      />

    <button onClick={importText} style={{width:"100%", marginBottom:6}}>📍 Import Coordinates</button>
      <input type="file" onChange={uploadExcel}/>

      <hr/>

      {/* ✅ ✅ NODE EDIT PANEL */}
      {selectedNode && (
        <div style={{marginTop:10}}>

          <div style={{marginBottom:6,fontWeight:"bold"}}>Edit Node</div>

          {/* ✅ Name */}
          <input
            value={editName}
            onChange={e => setEditName(e.target.value)}
            placeholder="Node Name"
            style={{width:"100%", marginBottom:6}}
          />

          {/* ✅ Type */}
          <select
            value={editType}
            onChange={e => {
              const newType = e.target.value;
              setEditType(newType);
              if(newType === "gateway") setEditHeight(15);
              else if(newType === "lra") setEditHeight(10);
              else setEditHeight(5);
            }}
            style={{width:"100%", marginBottom:6}}
          >
            <option value="gateway">Gateway</option>
            <option value="lra">LRA</option>
            <option value="sra">SRA</option>
            <option value="single">Single Modem</option>
          </select>

<div style={{marginBottom:6}}>
            <label style={{fontSize:12}}>Antenna Height (ft):</label>
            <input
              type="number"
              value={editHeight}
              onChange={e => setEditHeight(Number(e.target.value))}
              style={{width:"100%"}}
            />
          </div>


          {/* ✅ Save */}
          <button
           onClick={()=>{
  if(!selectedNode) return;

  selectedNode.name = editName;
  selectedNode.type = editType;

 if(editType === "gateway"){
    selectedNode.height = editHeight;
    selectedNode.range = 3;
  } 
  else if(editType === "lra"){
    selectedNode.height = editHeight;
    selectedNode.range = 3;
  } 
 else if(editType === "single"){
    selectedNode.height = editHeight;
    selectedNode.range = 0;
  }
  else {
    selectedNode.height = editHeight;
    selectedNode.range = 0.75;
  }

  // ✅ update marker color
 selectedNode.markerElement.style.background =
    editType === "gateway" ? "blue" :
    editType === "lra" ? "orange" :
    editType === "single" ? "black" : "green";

saveSnapshot();
  setNodeVersion(v => v + 1);
  redraw();
}}



            style={{width:"100%", marginBottom:6}}
          >
            Save Changes
          </button>

<button
            onClick={() => { if(selectedNode) generateProfile(selectedNode); }}
            style={{width:"100%", marginBottom:6, background:"#2196F3", color:"white", border:"none", padding:"6px", cursor:"pointer"}}
          >
            📊 Terrain Profile
          </button>

        </div>
      )}

      <hr/>

     {/* ✅ Save & Load network */}
      <button onClick={saveNetwork} style={{width:"100%", marginBottom:6}}>
        💾 Save Network
      </button>
<button onClick={exportExcel} style={{width:"100%", marginBottom:6, background:"#FF9800", color:"white", border:"none", padding:"6px", cursor:"pointer"}}>
        📊 Export to Excel
      </button>

     <label style={{
        display:"block",
        width:"100%",
        marginBottom:6,
        padding:"6px",
        background:"#2196F3",
        color:"white",
        textAlign:"center",
        cursor:"pointer",
        border:"none",
        borderRadius:0,
        fontSize:14,
        boxSizing:"border-box"
      }}>
        📂 Load Network
        <input type="file" accept=".json" onChange={loadNetwork} style={{display:"none"}}/>
      </label>

      <hr/>

<hr/>

<div>
  <div style={{fontWeight:"bold", marginBottom:6}}>
    Nodes ({nodesRef.current.length})
  </div>
<div style={{fontSize:11, color:"#888", marginBottom:2}}>
    🔵 {nodesRef.current.filter(n => n.type === "gateway").length} Gateway
    {" | "}🟠 {nodesRef.current.filter(n => n.type === "lra").length} LRA
    {" | "}🟢 {nodesRef.current.filter(n => n.type === "sra").length} SRA
  </div>
  <div style={{fontSize:11, color:"#888", marginBottom:6}}>
    ⚫ {nodesRef.current.filter(n => n.type === "single" || n.outOfRange).length} Single Modem
  </div>
 
{nodesRef.current.map((n, i) => (
    <div key={i} style={{marginBottom:4}}>
      
<span style={{
  color:
    n.outOfRange || n.type==="single" ? "black" :
    n.type==="gateway" ? "blue" :
    n.type==="lra" ? "orange" : "green",
  cursor: "pointer",
  textDecoration: "underline"
}}
  
onClick={() => {
    mapRef.current.flyTo({ center: [n.lng, n.lat], zoom: 15 });
    setSelectedNode(n);
    setEditName(n.name);
    setEditType(n.type);
setEditHeight(n.height);
  }}

>
  {n.name} ({n.type.toUpperCase()}) {n.type !== "single" ? `${n.recommendedHeight || n.height} ft` : ""}
</span>
{n.elevation !== null && (
  <span style={{color:"#888", fontSize:11}}>
    {" "}| Elev: {n.elevation}ft
  </span>
)}

{n.blocked && n.blockDetail && (
  <div style={{color:"red", fontSize:11, marginLeft:10}}>
    {n.blockDetail}
  </div>
)}

    </div>
  ))}
</div>

<hr/>

      {/* ✅ ✅ RECOMMENDATIONS */}
     {recommendations.map((r,i)=>(
        <div key={i} style={{
          marginBottom:6,
          cursor: r.node ? "pointer" : "default",
          textDecoration: r.node ? "underline" : "none",
          color: r.node ? "#2196F3" : "inherit"
        }}
          onClick={() => {
            if(r.node) generateProfile(r.node, r.target || null);
          }}
        >
          {r.text}
          {r.node && " 📊"}
        </div>
      ))}

    </div>
  </div>          {/* ✅ ADD THIS LINE — closes the sidebar */}
{/* ✅ TERRAIN PROFILE POPUP */}
      {showProfile && profileData && (
        <div style={{
          position:"absolute",
          top:"10%",
          left:"15%",
          width:"70%",
          background:"#1a1a2e",
          border:"2px solid #00bcd4",
          borderRadius:8,
          zIndex:2000,
          padding:10
        }}>
         <div style={{display:"flex", justifyContent:"flex-end", marginBottom:4}}>
            <button
              onClick={() => setShowProfile(false)}
              style={{
                background:"red",
                color:"white",
                border:"none",
                borderRadius:"50%",
                width:28,
                height:28,
                cursor:"pointer",
                fontWeight:"bold",
                fontSize:14
              }}
            >✕</button>
          </div>

          <div style={{display:"flex", justifyContent:"space-between", marginBottom:8}}>
            <div>
              <label style={{color:"#00bcd4", fontSize:12, marginRight:4}}>
                {profileData.from.name} Height (ft):
              </label>
              <input
                type="number"
                value={profileFromHeight}
                onChange={e => {
                  const h = Number(e.target.value);
                  setProfileFromHeight(h);
                }}
                style={{width:60, background:"#333", color:"white", border:"1px solid #00bcd4", borderRadius:4, padding:2}}
              />
              <button
                onClick={() => {
                  profileData.from.height = profileFromHeight;
                  redraw();
                }}
                style={{marginLeft:4, background:"#4CAF50", color:"white", border:"none", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:11}}
              >Apply</button>
            </div>
            <div>
              <label style={{color:"#00bcd4", fontSize:12, marginRight:4}}>
                {profileData.to.name} Height (ft):
              </label>
              <input
                type="number"
                value={profileToHeight}
                onChange={e => {
                  const h = Number(e.target.value);
                  setProfileToHeight(h);
                }}
                style={{width:60, background:"#333", color:"white", border:"1px solid #00bcd4", borderRadius:4, padding:2}}
              />
              <button
                onClick={() => {
                  profileData.to.height = profileToHeight;
                  redraw();
                }}
                style={{marginLeft:4, background:"#4CAF50", color:"white", border:"none", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:11}}
              >Apply</button>
            </div>
          </div>

          <canvas
            ref={canvasRef}
            width={800}
            height={350}
            style={{width:"100%", height:"auto"}}
          />
        </div>
      )}
    {/* MAP */}
    <div ref={containerRef} style={{flex:1}}/>

  </div>
);
}
