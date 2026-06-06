"use client";

import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// ---------- CACHES ----------
const elevationCache = {};
const fresnelCache = {};

export default function Map() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const nodesRef = useRef([]);
  const linksRef = useRef({});

  const [mode, setMode] = useState("sra");
  const [inputCoords, setInputCoords] = useState("");
  const [recommendations, setRecommendations] = useState([]);

  const [selectedNode, setSelectedNode] = useState(null);
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState("");
  const [useFresnel, setUseFresnel] = useState(true);

  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

