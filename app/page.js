"use client";

import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useRef, useState } from "react";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

export default function Page() {

  console.log("NEW CODE RUNNING ✅");

  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const nodesRef = useRef([]);

  const [mode, setMode] = useState("sra");

  // ✅ keep mode updated on map
  useEffect(() => {
    if (mapRef.current) {
      mapRef.current.currentMode = mode;
    }
  }, [mode]);

  // ✅ INIT MAP ONCE
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

  // ✅ ADD NODE
  function addNode(lng, lat, type) {

    console.log("ADDING NODE ✅", type);

    const node = {
      lng,
      lat,
      type,
      name: `${type}-${nodesRef.current.length + 1}`
    };

    // ✅ CREATE CUSTOM MARKER
    const el = document.createElement("div");

    el.style.width = "30px";
    el.style.height = "30px";
    el.style.borderRadius = "50%";
    el.style.border = "3px solid black";
    el.style.cursor = "pointer";
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.color = "white";
    el.style.fontWeight = "bold";

    // ✅ COLOR BY TYPE
    if (type === "gateway") {
      el.style.background = "blue";
      el.innerHTML = "G";
    } else if (type === "lra") {
      el.style.background = "orange";
      el.innerHTML = "L";
    } else {
      el.style.background = "green";
      el.innerHTML = "S";
    }

    const marker = new mapboxgl.Marker({
      element: el,
      draggable: true
    })
      .setLngLat([lng, lat])
      .addTo(mapRef.current);

    // ✅ DRAG TEST
    marker.on("dragend", () => {
      console.log("DRAG WORKING ✅");
    });

    // ✅ LABEL
    new mapboxgl.Popup({ offset: 25 })
      .setText(node.name)
      .setLngLat([lng, lat])
      .addTo(mapRef.current);

    nodesRef.current.push(node);
  }

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      
      <div style={{ width: 260, padding: 12 }}>
        <h3>RF Planner - FIXED ✅</h3>

        <button onClick={() => setMode("gateway")}>Gateway</button>
        <button onClick={() => setMode("lra")}>LRA</button>
        <button onClick={() => setMode("sra")}>SRA</button>

        <p>Mode: {mode}</p>
      </div>

      <div ref={containerRef} style={{ flex: 1 }} />

    </div>
  );
}