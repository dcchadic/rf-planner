"use client";

import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useRef, useState } from "react";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

export default function Page() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);

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
      new mapboxgl.Marker()
        .setLngLat([e.lngLat.lng, e.lngLat.lat])
        .addTo(map);
    });

    return () => map.remove();
  }, []);

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      
      {/* Sidebar */}
      <div style={{ width: 300, padding: 12 }}>
        <h3>RF Planner</h3>

        <button onClick={() => setMode("gateway")}>Gateway</button>
        <button onClick={() => setMode("lra")}>LRA</button>
        <button onClick={() => setMode("sra")}>SRA</button>

        <p>Mode: {mode}</p>
      </div>

      {/* Map */}
      <div ref={containerRef} style={{ flex: 1 }} />

    </div>
  );
}