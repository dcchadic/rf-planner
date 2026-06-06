"use client";

import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useRef, useState } from "react";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

export default function Page() {

  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const nodesRef = useRef([]);

  const [mode, setMode] = useState("sra");

  useEffect(() => {

    if (!containerRef.current) return;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [-97.3964, 27.8006],
      zoom: 10
    });

    mapRef.current = map;

    map.on("click", (e) => {
      addNode(e.lngLat.lng, e.lngLat.lat, mode);
    });

    return () => map.remove();

  }, [mode]);

  function addNode(lng, lat, type) {

    const node = {
      lng,
      lat,
      type,
      name: `${type}-${nodesRef.current.length + 1}`
    };

    const el = document.createElement("div");

    el.style.width = "14px";
    el.style.height = "14px";
    el.style.borderRadius = "50%";
    el.style.cursor = "pointer";

    el.style.background =
      type === "gateway" ? "blue" :
      type === "lra" ? "orange" :
      "green";

    const marker = new mapboxgl.Marker({
      element: el,
      draggable: true
    })
      .setLngLat([lng, lat])
      .addTo(mapRef.current);

    marker.on("dragend", () => {
      const p = marker.getLngLat();
      node.lng = p.lng;
      node.lat = p.lat;
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
        <h3>RF Planner</h3>

        <button onClick={() => setMode("gateway")}>Gateway</button>
        <button onClick={() => setMode("lra")}>LRA</button>
        <button onClick={() => setMode("sra")}>SRA</button>

        <p>Mode: {mode}</p>
      </div>

      <div ref={containerRef} style={{ flex: 1 }} />

    </div>
  );
}