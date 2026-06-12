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


  const [mode,setMode] = useState("sra");
  const [inputCoords,setInputCoords] = useState("");
  const [recommendations,setRecommendations] = useState([]);
const [showOptimizePrompt, setShowOptimizePrompt] = useState(false);
const [importedData, setImportedData] = useState([]);

  const [selectedNode,setSelectedNode] = useState(null);
  const [editName,setEditName] = useState("");
const [editType,setEditType] = useState("");
const [nodeVersion, setNodeVersion] = useState(0);

  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

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

  const midLng = (p1.lng + p2.lng)/2;
  const midLat = (p1.lat + p2.lat)/2;

  const elevMid = await getElevation(midLng, midLat);

  const losLine = ((elev1 + h1) + (elev2 + h2)) / 2;

  if (elevMid > losLine) {
    return {
      clear:false,
      requiredHeight: elevMid - losLine + 5
    };
  }

  return {
    clear:true,
    requiredHeight:0
  };
}
 
  // ---------- ADD NODE ----------
  function addNode(map,lng,lat,type,name=null,silent=false){

    
   const el = document.createElement("div");
el.style.width = "14px";
el.style.height = "14px";
el.style.borderRadius = "50%";
el.style.background =
  type==="gateway" ? "blue" :
  type==="lra" ? "orange" : "green";

const node = {
  lng, lat, type,
  markerElement: el,
  height: type==="gateway"?15:type==="lra"?10:5,
  range: type==="gateway"?5:type==="lra"?3:0.75,
  name: name || `${type}-${nodesRef.current.length+1}`,
  elevation: null,
  blocked: false,
  blockDetail: null
};
    const marker = new mapboxgl.Marker({element:el,draggable:true})
      .setLngLat([lng,lat])
      .addTo(map);

    el.addEventListener("click", (e) => {
  e.stopPropagation(); // ✅ CRITICAL FIX
  setSelectedNode(node);
setEditName(node.name);
setEditType(node.type);   // ✅ NEW
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
      redraw();
    };

   node.marker = marker; 
    
nodesRef.current.push(node);
    if (!silent) redraw();
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

   let clearGateway   = null;  let clearGatewayDist   = Infinity;
      let clearMesh      = null;  let clearMeshDist      = Infinity;
      let blockedGateway = null;  let blockedGatewayDist = Infinity;
      let blockedMesh    = null;  let blockedMeshDist    = Infinity;

    for (const b of nodesRef.current) {

      if (b === a) continue;

      const d = distance(a, b);
      
   
 const linkRange = (b.type === "lra") ? b.range : a.range;
    if (d > linkRange) continue;


      const isGateway = b.type === "gateway";

      let hasMeshPath = false;

      if (!isGateway) {
        if (b.type !== "sra" && b.type !== "lra") continue;

        const next = linksRef.current[b.name];
        if (next && (next.type === "gateway" || next.type === "lra" || linksRef.current[next.name])) {
          hasMeshPath = true;
        }
      }

      if (!isGateway && !hasMeshPath) continue;

      const los = await checkLOS(a, b, a.height, b.height);

     if      (isGateway  && los.clear  && d < clearGatewayDist)   { clearGateway   = b; clearGatewayDist   = d; }
        else if (isGateway  && !los.clear && d < blockedGatewayDist) { blockedGateway = b; blockedGatewayDist = d; }
        else if (!isGateway && los.clear  && d < clearMeshDist)      { clearMesh      = b; clearMeshDist      = d; }
        else if (!isGateway && !los.clear && d < blockedMeshDist)    { blockedMesh    = b; blockedMeshDist    = d; }

    }

    const best = clearGateway || clearMesh || blockedGateway || blockedMesh || null;

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

console.log("LINKS:", linksRef.current);

    const layers = map.getStyle().layers || [];

    layers.forEach(l=>{
      if(l.id.startsWith("node") || l.id.startsWith("line") || l.id.startsWith("label") || l.id.startsWith("route")){
        if(map.getLayer(l.id)) map.removeLayer(l.id);
        if(map.getSource(l.id)) map.removeSource(l.id);
      }
    });

    for(let i=0;i<nodesRef.current.length;i++){

      const a = nodesRef.current[i];

      const nodeId = "node"+i;

 if (a.elevation === null){
        const elevM = await getElevation(a.lng, a.lat);
        a.elevation = Math.round(elevM);
      }


      map.addSource(nodeId,{
        type:"geojson",
        data:{
          type:"Feature",
          geometry:{type:"Point",coordinates:[a.lng,a.lat]},
       properties:{text:`${a.name}\n${a.height}ft AGL | Elev ${a.elevation || '...'}ft`}
        }
      });

     map.addLayer({
  id: nodeId,
  type: "symbol",
  source: nodeId,
  layout: {
    "text-field": ["get", "text"],
    "text-size": 12
  },
  paint: {
    "text-color": "#ffffff",
    "text-halo-color": "#000000",
    "text-halo-width": 1
  }
});

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
    "text-size": 14,
    "text-offset": [0, 1.5],
    "text-anchor": "top",
    "text-allow-overlap": true
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
        addNode(map, n.lng, n.lat, n.type, n.name);
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

  for(const a of nodesRef.current){

    if(a.type === "gateway") continue;

    const path = getPath(a);
    const reachesGateway = path.some(n => n.type === "gateway");

    if(reachesGateway) continue;

    let worstClear = 100;
    let bestSignal = -999;
 let maxNeededHeight = 0; 

    for(const b of nodesRef.current){

      if(a === b) continue;

      const d = distance(a,b);
          const linkRange = (b.type === "lra") ? b.range : a.range;
      if (d > linkRange) continue;


      const los = await checkLOS(a, b, a.height, b.height);

if(!los.clear && (a.type === "lra" || a.type === "gateway")){
  recs.push({
    text: `📡 ${a.name.toUpperCase()}: Increase height by ~${Math.ceil(los.requiredHeight)} ft (terrain)`
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

    // No node in range at all
    if(bestSignal === -999){
      recs.push({
        text: `📶 ${a.name.toUpperCase()}: Out of range — recommend Single Modem`
      });

    } else if(terrainBlocked || weakSignal){

      if(!capped){
        recs.push({
          text: `📡 ${a.name.toUpperCase()}: Set antenna height to ~${targetHeight} ft (${bestSignal.toFixed(0)} dBm)`
        });
      } else {
        if(a.type === "sra"){
          recs.push({
            text: `⬆️ ${a.name.toUpperCase()}: Max height reached (5 ft). Upgrade to LRA (${bestSignal.toFixed(0)} dBm)`
          });
        } else {
          recs.push({
            text: `📡 ${a.name.toUpperCase()}: Set antenna height to max ${targetHeight} ft (${bestSignal.toFixed(0)} dBm)`
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

    let avgLat = 0;
    let avgLng = 0;

    for(const n of nodesRef.current){
      avgLat += n.lat;
      avgLng += n.lng;
    }

    avgLat /= nodesRef.current.length;
    avgLng /= nodesRef.current.length;

    let bestNode = nodesRef.current[0];
    let bestDist = Infinity;

    for(const n of nodesRef.current){
      const d = distance(n, { lng: avgLng, lat: avgLat });
      if(d < bestDist){
        bestDist = d;
        bestNode = n;
      }
    }

    bestNode.type = "gateway";
    bestNode.height = 15;
    bestNode.range = 5;
    if(bestNode.markerElement){
      bestNode.markerElement.style.background = "blue";
    }

    recs.push({
      text: `📡 ${bestNode.name.toUpperCase()} assigned as Gateway (network center)`
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

 // ✅ Single Modem check
  for(const node of nodesRef.current){

    if(node.type === "gateway") continue;

    let canConnect = false;

    for(const b of nodesRef.current){
      if(b === node) continue;

      const d = distance(node, b);

      if(d < 1.5){
        canConnect = true;
        break;
      }
    }

    if(!canConnect){
      recs.push({
        text: `📶 ${node.name.toUpperCase()}: Add Single Modem`
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
  // ✅ FIND CENTER POINT
let avgLat = 0;
let avgLng = 0;

for (const r of importedData) {
  avgLat += r.Latitude;
  avgLng += r.Longitude;
}

avgLat /= importedData.length;
avgLng /= importedData.length;

map.flyTo({ center: [avgLng, avgLat], zoom: 13 });

// ✅ FIND NODE CLOSEST TO CENTER → BEST GATEWAY
let gateway = importedData[0];
let bestDist = Infinity;

for (const r of importedData) {
  const d = distance(
    { lng: avgLng, lat: avgLat },
    { lng: r.Longitude, lat: r.Latitude }
  );

  if (d < bestDist) {
    bestDist = d;
    gateway = r;
  }
}

// ✅ PLACE GATEWAY
addNode(map, gateway.Longitude, gateway.Latitude, "gateway", gateway.Name, true);
 const placedNodes = [];

 for (let i = 0; i < importedData.length; i++) {

  const r = importedData[i];

  if (r === gateway) continue;

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

  // ✅ SINGLE MODEM CHECK
  placedNodes.forEach(node => {

    let canConnect = false;

    for(const b of nodesRef.current){

      const d = distance(
        { lng: node.Longitude, lat: node.Latitude },
        { lng: b.lng, lat: b.lat }
      );

      if(d < 1.5){
        canConnect = true;
        break;
      }
    }

    if(!canConnect){
      recs.push({
        text: `📶 ${node.Name.toUpperCase()}: Add Single Modem`
      });
    }

  });

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
if (disconnectedCount <= 6 && disconnectedCount > 0) {
  for (const node of nodesRef.current) {
    if (node.type === "gateway") continue;
    const path = getPath(node);
    const reachesGateway = path.some(n => n.type === "gateway");
    if (!reachesGateway) {
      recs.push({
        text: `📶 ${node.name.toUpperCase()}: Cannot reach gateway — recommend Single Modem`
      });
    }
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
  <button onClick={()=>setMode("gateway")}>Gateway</button>
  <button onClick={()=>setMode("lra")}>LRA</button>
  <button onClick={()=>setMode("sra")}>SRA</button>
  <button onClick={optimizeExisting} style={{marginTop:6, width:"100%", background:"#4CAF50", color:"white", padding:"6px", border:"none", cursor:"pointer"}}>
    ⚡ Auto-Optimize
  </button>
</div>

<div style={{
  flex:1,
  overflowY:"auto",
  padding:12
}}>

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
            onChange={e => setEditType(e.target.value)}
            style={{width:"100%", marginBottom:6}}
          >
            <option value="gateway">Gateway</option>
            <option value="lra">LRA</option>
            <option value="sra">SRA</option>
          </select>

          {/* ✅ Save */}
          <button
           onClick={()=>{
  if(!selectedNode) return;

  selectedNode.name = editName;
  selectedNode.type = editType;

  if(editType === "gateway"){
    selectedNode.height = 15;
    selectedNode.range = 5;
  } 
  else if(editType === "lra"){
    selectedNode.height = 10;
    selectedNode.range = 3;
  } 
  else {
    selectedNode.height = 5;
    selectedNode.range = 0.75;
  }

  // ✅ update marker color
  selectedNode.markerElement.style.background =
    editType === "gateway" ? "blue" :
    editType === "lra" ? "orange" : "green";

  redraw();
}}


            style={{width:"100%", marginBottom:6}}
          >
            Save Changes
          </button>

        </div>
      )}

      <hr/>

     {/* ✅ Save & Load network */}
      <button onClick={saveNetwork} style={{width:"100%", marginBottom:6}}>
        💾 Save Network
      </button>

      <label style={{
        display:"block",
        width:"100%",
        marginBottom:6,
        padding:"4px 8px",
        background:"#eee",
        textAlign:"center",
        cursor:"pointer",
        border:"1px solid #ccc"
      }}>
        📂 Load Network
        <input type="file" accept=".json" onChange={loadNetwork} style={{display:"none"}}/>
      </label>

      <hr/>

<hr/>

<div>
  <div style={{fontWeight:"bold", marginBottom:6}}>Nodes</div>

 
{nodesRef.current.map((n, i) => (
    <div key={i} style={{marginBottom:4}}>
      
<span style={{
  color:
    n.type==="gateway" ? "blue" :
    n.type==="lra" ? "orange" : "green"
}}>
  {n.name} ({n.type.toUpperCase()}) {n.recommendedHeight || n.height} ft
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
        <div key={i} style={{marginBottom:6}}>
          {r.text}
        </div>
      ))}

    </div>
  </div>          {/* ✅ ADD THIS LINE — closes the sidebar */}

    {/* MAP */}
    <div ref={containerRef} style={{flex:1}}/>

  </div>
);
}
