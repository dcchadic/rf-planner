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

  const [selectedNode,setSelectedNode] = useState(null);
  const [editName,setEditName] = useState("");
const [editType,setEditType] = useState("");
const [useFresnel, setUseFresnel] = useState(true);

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

  // ---------- FRESNEL ----------
  async function getFresnel(a,b){

    const key = `${a.lng}-${a.lat}-${b.lng}-${b.lat}`;
    if(fresnelCache[key]) return fresnelCache[key];

    const elevA = await getElevation(a.lng,a.lat);
    const elevB = await getElevation(b.lng,b.lat);

    const hA = elevA*3.28 + a.height;
    const hB = elevB*3.28 + b.height;

    const total = distance(a,b)*5280;

    let worst = 0;

    for(let i=1;i<6;i++){

      const t=i/15;

      const lng = a.lng+(b.lng-a.lng)*t;
      const lat = a.lat+(b.lat-a.lat)*t;

      const terrain = (await getElevation(lng,lat))*3.28;
      const los = hA+(hB-hA)*t;

      const d1=total*t;
      const d2=total*(1-t);

      const fresnel = 17.32*Math.sqrt((d1*d2)/(0.9*total));

      const clear = los-terrain;
      const blocked = Math.max(0,fresnel-clear);
      const pct = (blocked/fresnel)*100;

      if(pct>worst) worst=pct;
    }

    const result = { blocked: worst, clear: 100-worst };
    fresnelCache[key] = result;

    return result;
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

  for(const a of nodesRef.current){

    if(a.type === "gateway") continue;

    let best = null;
    let bestScore = -999;

    for(const b of nodesRef.current){

      if(a === b) continue;

      const d = distance(a,b);
      if(d > a.range) continue;

      const p = calcPower(d);
      const f = await getFresnel(a,b);

      // ✅ Allow ALL links, but penalize bad ones
      let penalty = 0;

      if(f.clear < 40){
        penalty = -80; // discourage but don't block
      }

      // ✅ Small extra penalty for very weak
      if(f.clear < 20){
        penalty -= 50;
      }

      let boost = 0;

      if(a.type === "sra" && b.type === "gateway") boost = 50;
      if(a.type === "sra" && b.type === "lra") boost = 25;
      if(a.type === "lra" && b.type === "gateway") boost = 40;

      const score = p + (f.clear * 1.2) + boost + penalty;

      if(score > bestScore){
        best = b;
        bestScore = score;
      }
    }

    // ✅ ALWAYS assign if something found
    if(best){
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

        const f = await getFresnel(p1,p2);
        const d = distance(p1,p2);

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
              f.clear<20?"purple":
              f.clear<40?"red":
              f.clear>80?"green":
              f.clear>60?"yellow":"orange",
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
      text: `${d.toFixed(2)} mi`
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

    for(const b of nodesRef.current){

      if(a === b) continue;

      const d = distance(a,b);
      if(d > a.range) continue;

      const f = await getFresnel(a,b);

      if(f.clear < worstClear){
        worstClear = f.clear;
      }
    }

    const terrainBlocked = worstClear < 40;

    const neededBoost = Math.ceil((60 - worstClear) * 0.5);
    let targetHeight = a.height + neededBoost;

    let maxHeight =
      a.type === "sra" ? 5 :
      a.type === "lra" ? 20 :
      a.type === "gateway" ? 30 : 999;

    let capped = false;

    if(targetHeight > maxHeight){
      targetHeight = maxHeight;
      capped = true;
    }

    if(terrainBlocked){

      if(capped){
        if(a.type === "sra"){
          recs.push({
            text: `⬆️ ${a.name.toUpperCase()}: Upgrade to LRA`
          });
        } else {
          recs.push({
            text: `⚠️ ${a.name.toUpperCase()}: Reposition`
          });
        }
      } else {
        recs.push({
          text: `🔧 ${a.name.toUpperCase()}: Set height to ~${targetHeight} ft`
        });
      }

    } else {

      if(a.type === "sra"){
        recs.push({
          text: `⬆️ ${a.name.toUpperCase()}: Upgrade to LRA`
        });
      } else {
        recs.push({
          text: `⚠️ ${a.name.toUpperCase()}: Reposition`
        });
      }
    }

  } // ✅ closes for(a loop)

  // ✅ FINAL OUTPUT
  if (recs.length === 0) {
    setRecommendations([
      { text: "✅ All nodes connected — no action needed" }
    ]);
  } else {
    setRecommendations(recs);
  }

} // ✅ closes analyzeNetwork()

  // ---------- IMPORT / EXPORT ----------
  function importText(){
    inputCoords.split("\n").forEach(l=>{
      const [name,lat,lng]=l.split(",");
      if(!lat||!lng) return;
      addNode(mapRef.current,parseFloat(lng),parseFloat(lat),"sra",name);
    });
  }

  function uploadExcel(e){

    const reader=new FileReader();

    reader.onload=(evt)=>{
      const wb=XLSX.read(new Uint8Array(evt.target.result));

      XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]])
        .forEach(r=>{
          addNode(mapRef.current,r.Longitude,r.Latitude,"sra",r.Name);
        });
    };

    reader.readAsArrayBuffer(e.target.files[0]);
  }

  function saveNetwork(){

    const data = nodesRef.current;

    const blob = new Blob([JSON.stringify(data,null,2)]);
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href=url;
    a.download="rf-network.json";
    a.click();
  }

  // ---------- UI ----------
 
return (
  <div style={{display:"flex",height:"100vh"}}>

    {/* ✅ SIDEBAR */}
    <div style={{width:300,padding:12}}>

      {/* ✅ Mode buttons */}
      <button onClick={()=>setMode("gateway")}>Gateway</button>
      <button onClick={()=>setMode("lra")}>LRA</button>
      <button onClick={()=>setMode("sra")}>SRA</button>

      {/* ✅ Fresnel toggle */}
      <button onClick={() => setUseFresnel(!useFresnel)}>
        Fresnel: {useFresnel ? "ON" : "OFF"}
      </button>

      <hr/>

      {/* ✅ Import text */}
      <textarea
        value={inputCoords}
        onChange={e=>setInputCoords(e.target.value)}
        placeholder="Name,Lat,Lng"
        style={{width:"100%",height:80}}
      />

      <button onClick={importText}>Import</button>
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
      <button onClick={saveNetwork}>Save</button>

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

