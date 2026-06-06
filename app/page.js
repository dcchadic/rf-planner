
"use client";

import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useRef, useState } from "react";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

export default function Page() {

console.log("NEW CODE RUNNING ✅"); // ✅ ADD THIS HERE

  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const nodesRef = useRef([]);

  const [mode, setMode] = useState("sra");
const modeRef = useRef(mode);
 
useEffect(() => {
  if (mapRef.current) {
    mapRef.current.currentMode = mode;
  }
}, [mode]);

useEffect(() => {

    if (!containerRef.current) return;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [-97.3964, 27.8006],
      zoom: 10
    });

    mapRef.current = map;
map.currentMode = mode;
   
map.on("click", (e) => {
  const currentMode = map.currentMode || "sra";
  addNode(e.lngLat.lng, e.lngLat.lat, currentMode);
});


    return () => map.remove();

  }, []);

  function addNode(lng, lat, type) {

    const node = {
      lng,
      lat,
      type,
      name: `${type}-${nodesRef.current.length + 1}`
    };

   
const el = document.createElement("div");

// ✅ MAKE IT BIGGER (so we KNOW it's working)
el.style.width = "20px";
el.style.height = "20px";
el.style.borderRadius = "50%";
el.style.border = "2px solid black";
el.style.cursor = "pointer";

// ✅ FORCE COLOR (very obvious)
if (type === "gateway") {
  el.style.background = "blue";
} else if (type === "lra") {
  el.style.background = "orange";
} else {
  el.style.background = "green";
}

// ✅ DEBUG label inside marker
el.innerHTML = type[0].toUpperCase();

const marker = new mapboxgl.Marker({
  element: el,
  draggable: true
})
  .setLngLat([lng, lat])
  .addTo(mapRef.current);

// ✅ DEBUG drag confirmation
marker.on("dragend", () => {
  console.log("DRAG WORKING ✅");
});


    new mapboxgl.Popup({ offset: 20 })
      .setText(node.name)
      .setLngLat([lng, lat])
      .addTo(mapRef.current);

    nodesRef.current.push(node);
  }

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      
      <div style={{ width: 250, padding: 12 }}>
        <h3>RF Planner - NEW VERSION</h3>

        <button onClick={() => setMode("gateway")}>Gateway</button>
        <button onClick={() => setMode("lra")}>LRA</button>
        <button onClick={() => setMode("sra")}>SRA</button>

        <p>Mode: {mode}</p>
      </div>

      <div ref={containerRef} style={{ flex: 1 }} />

    </div>
  );
}
