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
  async function getElevation(lng,lat){

    const key = `${lng.toFixed(4)},${lat.toFixed(4)}`;
    if(elevationCache[key]) return elevationCache[key];

    try{
      const res = await fetch(
       `https://api.mapbox.com/v4/mapbox.mapbox-terrain-v2/tilequery/${lng},${lat}.json?layers=contour&limit=1&access_token=${mapboxgl.accessToken}`
      );
      const data = await res.json();

      const elev = data.features?.[0]?.properties?.ele || 0;
      elevationCache[key] = elev;

      return elev;

    }catch{
      return 0;
    }
  }

 
  // ---------- ADD NODE ----------
  function addNode(map,lng,lat,type,name=null){

    const node={
      lng,lat,type,
      height: type==="gateway"?15:type==="lra"?10:5,
      range: type==="gateway"?5:type==="lra"?3:0.75,
      name: name || `${type}-${nodesRef.current.length+1}`
    };

    const el=document.createElement("div");
    el.style.width="14px";
    el.style.height="14px";
    el.style.borderRadius="50%";
    el.style.background=
      type==="gateway"?"blue":
      type==="lra"?"orange":"green";

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
      redraw();
    });

    el.oncontextmenu=(e)=>{
      e.preventDefault();
      marker.remove();
      nodesRef.current = nodesRef.current.filter(n=>n!==node);
      redraw();
    };

    nodesRef.current.push(node);
    redraw();
  }

  // ---------- ROUTING ----------
 async function computeLinks(){

  linksRef.current = {};

 // ✅ process in order: gateway → LRA → SRA
const sortedNodes = [...nodesRef.current].sort((x,y)=>{
  const order = {gateway:0, lra:1, sra:2};
  return order[x.type] - order[y.type];
});


for (const a of sortedNodes) {

  if (a.type === "gateway") continue;

  let best = null;

  // ✅ 1. Direct connection to gateway
  for (const b of nodesRef.current) {
    if (b.type !== "gateway") continue;

    const d = distance(a, b);
    if (d <= a.range) {
      best = b;
      break;
    }
  }

  // ✅ 2. Connect to SRA or LRA that already has a path
  if (!best) {
    for (const b of nodesRef.current) {

      if (b === a) continue;
      if (b.type !== "sra" && b.type !== "lra") continue;

      const d = distance(a, b);
      if (d > a.range) continue;

      const next = linksRef.current[b.name];

      // ✅ if b connects to gateway OR another valid node
      if (next && (next.type === "gateway" || next.type === "lra" || linksRef.current[next.name])) {
        best = b;
        break;
      }
    }
  }

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

      map.addSource(nodeId,{
        type:"geojson",
        data:{
          type:"Feature",
          geometry:{type:"Point",coordinates:[a.lng,a.lat]},
          properties:{text:`${a.name}\n${a.height}ft`}
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

        const f = { clear: 100 };
        const d = distance(p1,p2);
const signal = calcPower(d);

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
     text: `${d.toFixed(2)} mi | ${signal.toFixed(0)} dBm`
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

  function redraw(){ draw(); }

 
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

    for(const b of nodesRef.current){

      if(a === b) continue;

      const d = distance(a,b);
      if(d > a.range) continue;

      const f = { clear: 100 };
      const signal = calcPower(d);

      // ✅ Track worst Fresnel
      if(f.clear < worstClear){
        worstClear = f.clear;
      }

      // ✅ Track best signal
      if(signal > bestSignal){
        bestSignal = signal;
      }
    }

    const terrainBlocked = worstClear < 40;

    // ✅ Height calculation (your existing logic)
    const neededBoost = Math.ceil((60 - worstClear) * 0.5);
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

    // ✅ SIGNAL CONDITION
    const weakSignal = bestSignal < -90;

    // ✅ FINAL RECOMMENDATION LOGIC
    if(terrainBlocked || weakSignal){

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

function autoOptimizeNetwork(){

  if(!importedData.length) return;

  nodesRef.current = [];
  const map = mapRef.current;

  const recs = [];

  // ✅ Primary gateway
  const gateway = importedData[0];

  addNode(map, gateway.Longitude, gateway.Latitude, "gateway", gateway.Name);

  let count = 0;
  const placedNodes = [];

 for(let i = 1; i < importedData.length; i++){

  if(count >= 25) break;

 const r = importedData[i];

let type = "sra";


// Check if this node can connect to ANY node that reaches a gateway

let hasPathToGateway = false;

for (const existing of nodesRef.current) {
  
const d = distance(
  { lng: r.Longitude, lat: r.Latitude },
  { lng: existing.lng, lat: existing.lat }
);


  if (d > .75) continue;

// ✅ valid if connects to gateway OR chain

const reachesGateway =
  existing.type === "gateway" ||
  existing.type === "lra";


  if (reachesGateway) {
    hasPathToGateway = true;
    break;
  }
}

// ✅ If no valid path → promote to LRA
if (!hasPathToGateway) {
  for(const g of nodesRef.current){

    if(g.type !== "gateway") continue;

    const dToGateway = distance(
      { lng: r.Longitude, lat: r.Latitude },
      { lng: g.lng, lat: g.lat }
    );

    if(dToGateway <= 10){
      type = "lra";
      break;
    }
  }
}

  placedNodes.push(r);

  addNode(map, r.Longitude, r.Latitude, type, r.Name);

  count++;
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
let needsGateway = false;

for (const node of nodesRef.current) {

  if (node.type === "gateway") continue;

  const path = getPath(node);
  const reachesGateway = path.some(n => n.type === "gateway");

  if (!reachesGateway) {
    needsGateway = true;
    break;
  }
}

// ✅ ONLY add new gateway if something truly cannot connect
if (needsGateway) {

  let candidate = null;

  for (const node of nodesRef.current) {

    if (node.type === "gateway") continue;

    const path = getPath(node);
    const reachesGateway = path.some(n => n.type === "gateway");

    if (!reachesGateway) {
      candidate = node;
      break;
    }
  }

  // ✅ OUTSIDE the loop (this is important)
  if (candidate) {
    addNode(
      map,
      candidate.lng,
      candidate.lat,
      "gateway",
      "GATEWAY-2"
    );

    recs.push({
      text: `📡 Secondary Gateway added (needed for connectivity)`
    });
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
    }}>
      No
    </button>
  </div>
)}

    {/* ✅ SIDEBAR */}
    <div style={{width:300,padding:12}}>

      {/* ✅ Mode buttons */}
      <button onClick={()=>setMode("gateway")}>Gateway</button>
      <button onClick={()=>setMode("lra")}>LRA</button>
      <button onClick={()=>setMode("sra")}>SRA</button>

           <hr/>

      {/* ✅ Import text */}
      <textarea
        value={inputCoords}
        onChange={e=>setInputCoords(e.target.value)}
        placeholder="Name,Lat,Lng"
        style={{width:"100%",height:80}}
      />

    {/* <button onClick={importText}>Import</button> */}
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

              // ✅ update height + range
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

              redraw();
            }}
            style={{width:"100%", marginBottom:6}}
          >
            Save Changes
          </button>

        </div>
      )}

      <hr/>

      {/* ✅ Save network */}
      {/* <button onClick={saveNetwork}>Save</button> */}

      <hr/>

      {/* ✅ ✅ RECOMMENDATIONS */}
      {recommendations.map((r,i)=>(
        <div key={i} style={{marginBottom:6}}>
          {r.text}
        </div>
      ))}

    </div>

    {/* ✅ MAP */}
    <div ref={containerRef} style={{flex:1}}/>

  </div>
);
}

