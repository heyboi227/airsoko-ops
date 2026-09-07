import { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Stack, Typography } from "@mui/material";
import { Map as LibreMap, Marker, NavigationControl, type GeoJSONSource } from "maplibre-gl";
import type { FeatureCollection, MultiLineString, Point } from "geojson";
import { greatCirclePath } from "@airsoko/domain";
import type { LiveFlight } from "@airsoko/contracts";
import "maplibre-gl/dist/maplibre-gl.css";
import "./live.css";

export interface MapStation {
  iataCode: string;
  name: string;
  latitude: number;
  longitude: number;
  isHub: boolean;
}

const EMPTY_ROUTES: FeatureCollection<MultiLineString> = {
  type: "FeatureCollection",
  features: [],
};

const EMPTY_STATIONS: FeatureCollection<Point> = {
  type: "FeatureCollection",
  features: [],
};

/**
 * Below this zoom the network is a cluster of overlapping markers, so labels
 * step back: the selected flight and its two airports keep theirs, everything
 * else is identified by its dot or icon and its tooltip. Hubs included -- the
 * two bases are 130 km apart, which at zoom 1 is one label's width.
 */
const LABELS_STEP_BACK_BELOW_ZOOM = 2.5;

/**
 * Hand the current zoom to the stylesheet. Markers are HTML, so they cannot
 * scale with the map the way a GL layer does; the CSS reads `--live-zoom` to
 * shrink them as the view widens, and `data-zoom-band` to declutter labels.
 */
function applyZoom(map: LibreMap, element: HTMLElement) {
  const zoom = map.getZoom();
  element.style.setProperty("--live-zoom", zoom.toFixed(2));
  element.dataset.zoomBand = zoom < LABELS_STEP_BACK_BELOW_ZOOM ? "far" : "near";
}

/** Flag the station labels the stylesheet must keep when the others step back. */
function markSelectedEndpoints(labels: Map<string, HTMLElement>, endpoints: Set<string>) {
  labels.forEach((label, iata) => {
    label.setAttribute("data-selected-endpoint", String(endpoints.has(iata)));
  });
}

function aircraftButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "live-marker";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    "M12 1 10 4 10 9 2 14 2 17 10 14 10 19 7 21 7 23 12 21 17 23 17 21 14 19 14 14 22 17 22 14 14 9 14 4Z",
  );
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  const label = document.createElement("span");
  label.className = "live-marker-label";
  button.append(svg, label);
  return button;
}

function fitFlight(map: LibreMap, item: LiveFlight) {
  // Opening the drawer changes the grid width in this same commit. Read the
  // new container size before fitting, instead of waiting for ResizeObserver.
  map.resize();
  // Unwrap the arc before fitting it: a Pacific crossing must not frame the
  // long way round the world. GeoJSON itself remains split at the dateline.
  const points = greatCirclePath(item.flight.origin, item.flight.destination).flat();
  let previous = item.flight.origin.longitude;
  const unwrapped = points.map(([longitude = 0, latitude = 0]) => {
    let lon = longitude;
    while (lon - previous > 180) lon -= 360;
    while (lon - previous < -180) lon += 360;
    previous = lon;
    return [lon, latitude] as const;
  });
  map.fitBounds(
    [
      [Math.min(...unwrapped.map((p) => p[0])), Math.min(...unwrapped.map((p) => p[1]))],
      [Math.max(...unwrapped.map((p) => p[0])), Math.max(...unwrapped.map((p) => p[1]))],
    ],
    { padding: 75, maxZoom: 7, duration: 600 },
  );
}

export function LiveMap({
  items,
  stations,
  selectedId,
  onSelect,
  stale,
}: {
  items: LiveFlight[];
  stations: MapStation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  stale: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const markers = useRef(new Map<string, Marker>());
  const stationLabels = useRef(new Map<string, HTMLElement>());
  // The two airports the selected flight flies between. Kept in a ref because
  // both the station effect and the selection effect need it, and neither
  // should re-run for the other's reasons.
  const selectedEndpoints = useRef(new Set<string>());
  const lastSelection = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allRoutes, setAllRoutes] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    let map: LibreMap;
    try {
      map = new LibreMap({
        container: container.current,
        center: [20.3, 45],
        zoom: 3.4,
        minZoom: 1,
        maxZoom: 12,
        // A north-up 2D view keeps compass headings consistent with the icons.
        dragRotate: false,
        touchPitch: false,
        maxPitch: 0,
        attributionControl: false,
        style: {
          version: 8,
          sources: { land: { type: "geojson", data: "/map/land.geojson" } },
          layers: [
            { id: "water", type: "background", paint: { "background-color": "#0a1c2b" } },
            { id: "land", type: "fill", source: "land", paint: { "fill-color": "#1b3341" } },
            {
              id: "coast",
              type: "line",
              source: "land",
              paint: { "line-color": "#365362", "line-width": 1 },
            },
          ],
        },
      });
    } catch {
      // Report failed renderer startup after the external setup has settled,
      // and cancel the report if Strict Mode immediately unmounts this map.
      const report = window.setTimeout(
        () =>
          setError(
            "Map unavailable: this browser could not start WebGL. Use the flight list to open records.",
          ),
        0,
      );
      return () => window.clearTimeout(report);
    }
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    const element = container.current;
    applyZoom(map, element);
    map.on("zoom", () => applyZoom(map, element));
    map.on("error", () =>
      setError(
        "A map layer could not load. Flight records remain available; the offline map is used when possible.",
      ),
    );
    map.on("load", () => {
      const tiles = import.meta.env.VITE_MAP_TILE_URL as string | undefined;
      if (tiles) {
        map.addSource("tiles", { type: "raster", tiles: [tiles], tileSize: 256 });
        map.addLayer({ id: "tiles", type: "raster", source: "tiles" });
      }
      map.addSource("routes", { type: "geojson", data: EMPTY_ROUTES });
      map.addLayer({
        id: "routes",
        type: "line",
        source: "routes",
        paint: {
          "line-color": ["case", ["get", "selected"], "#7fd2ff", "#607e92"],
          "line-width": ["case", ["get", "selected"], 2.5, 1],
          "line-opacity": ["case", ["get", "selected"], 1, 0.5],
        },
      });
      // Station dots are drawn by the GL renderer, in the same layer stack and
      // the same projection as the arcs, so a dot sits on the coordinate an arc
      // ends at whatever the zoom. An HTML marker cannot make that promise: any
      // offset given to it is a fixed number of screen pixels, which at zoom 1
      // is a few hundred kilometres. Added after the routes so a dot caps the
      // line rather than the line crossing the dot.
      map.addSource("stations", { type: "geojson", data: EMPTY_STATIONS });
      map.addLayer({
        id: "stations",
        type: "circle",
        source: "stations",
        paint: {
          "circle-radius": ["case", ["get", "hub"], 4.5, 3],
          "circle-color": ["case", ["get", "hub"], "#e9f0f4", "#8faab9"],
          "circle-stroke-color": "#071b28",
          "circle-stroke-width": 1,
        },
      });
      setReady(true);
    });
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(container.current);
    const markerStore = markers.current;
    return () => {
      resize.disconnect();
      markerStore.forEach((marker) => marker.remove());
      markerStore.clear();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("stations") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: stations.map((station) => ({
        type: "Feature",
        properties: { iata: station.iataCode, hub: station.isHub },
        geometry: { type: "Point", coordinates: [station.longitude, station.latitude] },
      })),
    });
    // The label is the only HTML part of a station, and it carries no dot of
    // its own: text needs glyphs the offline style does not have (decision 16),
    // so it stays in the DOM, anchored by its left edge just clear of the dot
    // the layer above draws at the coordinate itself.
    const registry = stationLabels.current;
    const labels = stations.map((station) => {
      const element = document.createElement("span");
      element.className = "live-station";
      element.textContent = station.iataCode;
      element.title = station.name;
      element.dataset.hub = String(station.isHub);
      element.dataset.selectedEndpoint = String(
        selectedEndpoints.current.has(station.iataCode),
      );
      registry.set(station.iataCode, element);
      return new Marker({ element, anchor: "left", offset: [8, 0] })
        .setLngLat([station.longitude, station.latitude])
        .addTo(map);
    });
    return () => {
      labels.forEach((label) => label.remove());
      registry.clear();
    };
  }, [ready, stations]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const shown = new Set<string>();
    const animations: {
      marker: Marker;
      fromLon: number;
      fromLat: number;
      lon: number;
      lat: number;
    }[] = [];
    for (const item of items) {
      const { flight, telemetry } = item;
      if (!telemetry.position || telemetry.quality !== "current") continue;
      shown.add(flight.id);
      let marker = markers.current.get(flight.id);
      if (!marker) {
        marker = new Marker({ element: aircraftButton() })
          .setLngLat([telemetry.position.longitude, telemetry.position.latitude])
          .addTo(map);
        markers.current.set(flight.id, marker);
      }
      const button = marker.getElement();
      button.setAttribute("aria-label", `Select ${flight.flightNumber} on map`);
      button.setAttribute("aria-pressed", String(flight.id === selectedId));
      button.dataset.flightId = flight.id;
      button.dataset.delayed = String(flight.delayed);
      button.dataset.status = flight.status;
      button.dataset.longitude = String(telemetry.position.longitude);
      button.dataset.latitude = String(telemetry.position.latitude);
      button.dataset.heading = String(telemetry.heading ?? 0);
      button.title = `${flight.flightNumber} · ${flight.origin.iataCode}–${flight.destination.iataCode} · ${telemetry.phase?.replaceAll("_", " ") ?? "Position"}${flight.delayed ? " · Delayed" : ""}`;
      button.onclick = () => onSelect(flight.id);
      const svg = button.querySelector("svg");
      if (svg) svg.style.transform = `rotate(${telemetry.heading ?? 0}deg)`;
      const label = button.querySelector("span");
      if (label) label.textContent = flight.flightNumber;
      const from = marker.getLngLat();
      let lon = telemetry.position.longitude;
      while (lon - from.lng > 180) lon -= 360;
      while (lon - from.lng < -180) lon += 360;
      animations.push({
        marker,
        fromLon: from.lng,
        fromLat: from.lat,
        lon,
        lat: telemetry.position.latitude,
      });
    }
    for (const [id, marker] of markers.current) {
      if (!shown.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
    const routes: FeatureCollection<MultiLineString> = {
      type: "FeatureCollection",
      features: items
        .filter((item) => allRoutes || item.flight.id === selectedId)
        .map(({ flight }) => ({
          type: "Feature",
          properties: { selected: flight.id === selectedId },
          geometry: {
            type: "MultiLineString",
            coordinates: greatCirclePath(flight.origin, flight.destination),
          },
        })),
    };
    (map.getSource("routes") as GeoJSONSource | undefined)?.setData(routes);
    const selected = items.find((item) => item.flight.id === selectedId);
    selectedEndpoints.current = new Set(
      selected ? [selected.flight.origin.iataCode, selected.flight.destination.iataCode] : [],
    );
    markSelectedEndpoints(stationLabels.current, selectedEndpoints.current);
    if (selected && lastSelection.current !== selectedId) fitFlight(map, selected);
    lastSelection.current = selectedId;
    const start = performance.now();
    const duration =
      stale || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1000;
    let frame = 0;
    function animate(now: number) {
      const fraction = duration === 0 ? 1 : Math.min(1, (now - start) / duration);
      for (const a of animations)
        a.marker.setLngLat([
          a.fromLon + (a.lon - a.fromLon) * fraction,
          a.fromLat + (a.lat - a.fromLat) * fraction,
        ]);
      if (fraction < 1) frame = requestAnimationFrame(animate);
    }
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [items, selectedId, onSelect, ready, allRoutes, stale]);

  return (
    <Box
      sx={{
        position: "relative",
        minWidth: 0,
        minHeight: 430,
        height: "100%",
        bgcolor: "#0a1c2b",
      }}
    >
      <div
        ref={container}
        className="live-map"
        role="region"
        aria-label="Live flight map"
        data-map-ready={ready}
        data-selected-flight={selectedId ?? ""}
        style={{ position: "absolute", inset: 0 }}
      />
      <Stack direction="row" spacing={1} sx={{ position: "absolute", top: 12, left: 12 }}>
        <Button
          size="small"
          variant="contained"
          onClick={() => {
            const map = mapRef.current;
            const selected = items.find((item) => item.flight.id === selectedId);
            if (map && selected) fitFlight(map, selected);
            else map?.flyTo({ center: [20.3, 45], zoom: 3.4, duration: 600 });
          }}
        >
          {selectedId ? "Fit selected route" : "Home network"}
        </Button>
        <Button
          size="small"
          variant="contained"
          aria-pressed={allRoutes}
          onClick={() => setAllRoutes((value) => !value)}
        >
          {allRoutes ? "Hide other routes" : "Show all routes"}
        </Button>
      </Stack>
      {error && (
        <Alert
          severity="warning"
          sx={{ position: "absolute", bottom: 40, left: 12, right: 12 }}
        >
          {error}
        </Alert>
      )}
      <Typography
        variant="caption"
        sx={{
          position: "absolute",
          bottom: 6,
          left: 12,
          color: "#bacad5",
          bgcolor: "#0a1c2bcc",
          px: 1,
        }}
      >
        Made with Natural Earth · Routes are great-circle estimates
      </Typography>
    </Box>
  );
}
