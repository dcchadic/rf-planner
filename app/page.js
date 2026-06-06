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

  }, []);

  function addNode(lng, lat, type) {

    const node = {
      lng,
      lat,
      type,
      name: type + "-" + (nodesRef.current.length + 1)
    };

    let color =
      type === "gateway" ? "blue" :
      type === "lra" ? "orange" :
      "green";

    new mapboxgl.Marker({ color })
      .setLngLat([lng, lat])
      .addTo(mapRef.current);

    nodesRef.current.push(node);

    drawLines();
  }

  function drawLines() {

    const map = mapRef.current;

    // remove old lines
    const layers = map.getStyle().layers || [];

    layers.forEach(l => {
      if (l.id.startsWith("line")) {
        if (map.getLayer(l.id)) map.removeLayer(l.id);
        if (map.getSource(l.id)) map.removeSource(l.id);
      }
    });

    for (let i = 0; i < nodesRef.current.length; i++) {
      for (let j = i + 1; j < nodesRef.current.length; j++) {

        const a = nodesRef.current[i];
        const b = nodesRef.current[j];

        const id = `line-${i}-${j}`;

        map.addSource(id, {
          type: "geojson",
          data: {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [
                [a.lng, a.lat],
                [b.lng, b.lat]
              ]
            }
          }
        });

        map.addLayer({
          id,
          type: "line",
          source: id,
          paint: {
            "line-color": "cyan",
            "line-width": 2
          }
        });
      }
    }

  }

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      
      <div style={{ width: 250, padding: 10 }}>
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