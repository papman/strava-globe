import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import {
  APIProvider,
  Map,
  useMap,
  useMapsLibrary,
} from "@vis.gl/react-google-maps";
import { useActivities } from "../hooks/useActivities.js";

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return isMobile;
}

// Color map by sport type
const SPORT_COLORS = {
  Run: "#fc4c02",
  Ride: "#4a9eff",
  Swim: "#00d4aa",
  Hike: "#a8d44a",
  Walk: "#f5a623",
  NordicSki: "#b0c4de",
  AlpineSki: "#dda0dd",
  Kayaking: "#20b2aa",
  Rowing: "#87ceeb",
  Workout: "#888",
};

function sportColor(activity) {
  return (
    SPORT_COLORS[activity.sport_type] ||
    SPORT_COLORS[activity.type] ||
    "#fc4c02"
  );
}

const ZOOM_THRESHOLD = 11; // below this: heatmap; at or above: polylines

// ─── Custom canvas heatmap (replaces deprecated HeatmapLayer) ────────────────

function ActivityHeatmap({ activities }) {
  const map = useMap();
  const mapsLib = useMapsLibrary("maps");
  const geometryLib = useMapsLibrary("geometry");

  useEffect(() => {
    if (!map || !mapsLib || !geometryLib) return;

    // Use the midpoint of each activity as its representative location,
    // then cluster into ~15km grid cells so nearby activities stack up.
    const GRID_DEG = 0.15;
    const grid = {};
    for (const activity of activities) {
      const path = geometryLib.encoding.decodePath(activity.polyline);
      if (!path.length) continue;
      const mid = path[Math.floor(path.length / 2)];
      const key = `${Math.round(mid.lat() / GRID_DEG)},${Math.round(mid.lng() / GRID_DEG)}`;
      if (!grid[key]) grid[key] = { pts: [], count: 0 };
      grid[key].pts.push(mid);
      grid[key].count++;
    }

    // Build cluster list: centroid + count
    const clusters = Object.values(grid).map(cell => ({
      latLng: { lat: cell.pts.reduce((s, p) => s + p.lat(), 0) / cell.count,
                lng: cell.pts.reduce((s, p) => s + p.lng(), 0) / cell.count },
      count: cell.count,
    }));
    const maxCount = Math.max(...clusters.map(c => c.count), 1);

    // Build a custom OverlayView that draws the heatmap on a canvas
    class CanvasHeatmap extends mapsLib.OverlayView {
      constructor(clusters, maxCount) {
        super();
        this._clusters = clusters;
        this._maxCount = maxCount;
        this._canvas = null;
      }

      onAdd() {
        const canvas = document.createElement("canvas");
        canvas.style.position = "absolute";
        canvas.style.pointerEvents = "none";
        this._canvas = canvas;
        this.getPanes().overlayLayer.appendChild(canvas);
      }

      draw() {
        const proj = this.getProjection();
        const bounds = map.getBounds();
        if (!proj || !bounds) return;

        const ne = proj.fromLatLngToDivPixel(bounds.getNorthEast());
        const sw = proj.fromLatLngToDivPixel(bounds.getSouthWest());
        if (!ne || !sw) return;

        const w = Math.abs(ne.x - sw.x);
        const h = Math.abs(sw.y - ne.y);
        const left = Math.min(ne.x, sw.x);
        const top = Math.min(ne.y, sw.y);

        const canvas = this._canvas;
        canvas.width = w;
        canvas.height = h;
        canvas.style.left = `${left}px`;
        canvas.style.top = `${top}px`;

        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, w, h);

        const zoom = map.getZoom() ?? 5;
        // Radius large at all zoom levels — radial gradient handles softness, no CSS blur
        const radius = zoom < 6
          ? Math.max(100, 380 / zoom)  // zoomed out
          : Math.max(100, zoom * 16);  // zoomed in: scales up as you drill down
        const opacity = 0.2;
        canvas.style.filter = "none";

        // World width in pixels at this zoom — used to draw tiled copies
        const worldWidth = Math.pow(2, zoom) * 256;

        const drawCluster = (cx, cy, r) => {
          if (cx < -r || cx > w + r || cy < -r || cy > h + r) return;
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0,    `rgba(252, 76, 2, ${opacity})`);
          g.addColorStop(0.4,  `rgba(252, 76, 2, ${opacity * 0.7})`);
          g.addColorStop(0.75, `rgba(252, 76, 2, ${opacity * 0.3})`);
          g.addColorStop(1,    "rgba(252, 76, 2, 0)");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
        };

        for (const cluster of this._clusters) {
          // Radius proportional to sqrt of relative count (sqrt prevents huge differences)
          const scale = 0.55 + 0.45 * Math.sqrt(cluster.count / this._maxCount);
          const r = radius * scale;

          const px = proj.fromLatLngToDivPixel(cluster.latLng);
          if (!px) continue;
          const x = px.x - left;
          const y = px.y - top;

          drawCluster(x, y, r);
          drawCluster(x - worldWidth, y, r);
          drawCluster(x + worldWidth, y, r);
        }
      }

      onRemove() {
        this._canvas?.parentNode?.removeChild(this._canvas);
        this._canvas = null;
      }
    }

    const overlay = new CanvasHeatmap(clusters, maxCount);
    overlay.setMap(map);

    return () => { overlay.setMap(null); };
  }, [map, mapsLib, geometryLib, activities]);

  return null;
}

// ─── Polyline renderer ────────────────────────────────────────────────────────

function ActivityPolylines({ activities, onHover, onHoverEnd, onTap, isMobile }) {
  const map = useMap();
  const mapsLib = useMapsLibrary("maps");
  const geometryLib = useMapsLibrary("geometry");
  const polylinesRef = useRef([]);

  useEffect(() => {
    if (!map || !mapsLib || !geometryLib) return;

    polylinesRef.current.forEach((p) => p.setMap(null));

    const allPolylines = [];

    activities.forEach((activity) => {
      const path = geometryLib.encoding.decodePath(activity.polyline);

      // Outline layer — white stroke drawn slightly thicker underneath
      const outline = new mapsLib.Polyline({
        path,
        map,
        strokeColor: "#ffffff",
        strokeOpacity: 0.9,
        strokeWeight: 7,
        zIndex: 1,
      });

      // Color layer on top
      const polyline = new mapsLib.Polyline({
        path,
        map,
        strokeColor: sportColor(activity),
        strokeOpacity: 0.9,
        strokeWeight: 4,
        zIndex: 2,
      });

      const highlight = () => {
        outline.setOptions({ strokeWeight: 10, strokeOpacity: 1 });
        polyline.setOptions({ strokeOpacity: 1, strokeWeight: 6, zIndex: 10 });
      };
      const unhighlight = () => {
        outline.setOptions({ strokeWeight: 7, strokeOpacity: 0.9 });
        polyline.setOptions({ strokeOpacity: 0.9, strokeWeight: 4, zIndex: 2 });
      };

      if (isMobile) {
        const onTapRoute = () => {
          highlight();
          onTap?.(activity);
        };
        polyline.addListener("click", onTapRoute);
        outline.addListener("click", onTapRoute);
      } else {
        const onOver = (e) => {
          highlight();
          onHover?.(activity, { x: e.domEvent.clientX, y: e.domEvent.clientY });
        };
        const onMove = (e) => {
          onHover?.(activity, { x: e.domEvent.clientX, y: e.domEvent.clientY });
        };
        const onOut = () => { unhighlight(); onHoverEnd?.(); };

        polyline.addListener("mouseover", onOver);
        polyline.addListener("mousemove", onMove);
        polyline.addListener("mouseout", onOut);
        outline.addListener("mouseover", onOver);
        outline.addListener("mousemove", onMove);
        outline.addListener("mouseout", onOut);
      }

      allPolylines.push(outline, polyline);
    });

    polylinesRef.current = allPolylines;

    return () => { polylinesRef.current.forEach((p) => p.setMap(null)); };
  }, [map, mapsLib, geometryLib, activities]);

  return null;
}

// ─── Search box ───────────────────────────────────────────────────────────────
// SearchControl lives inside <Map> to access useMap/useMapsLibrary,
// but the actual input is rendered outside via a ref passed in as a prop.

function SearchControl({ inputRef }) {
  const map = useMap();
  const placesLib = useMapsLibrary("places");

  useEffect(() => {
    if (!map || !placesLib || !inputRef.current) return;

    const autocomplete = new placesLib.Autocomplete(inputRef.current, {
      fields: ["geometry", "name"],
    });

    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (!place.geometry) return;
      if (place.geometry.viewport) {
        map.fitBounds(place.geometry.viewport);
      } else {
        map.setCenter(place.geometry.location);
        map.setZoom(13);
      }
      inputRef.current.value = "";
      inputRef.current.blur();
    });

    return () => {
      window.google?.maps.event.clearInstanceListeners(autocomplete);
    };
  }, [map, placesLib, inputRef]);

  return null;
}

// ─── Map content (zoom tracking + click-to-zoom) ──────────────────────────────

function MapContent({ activities, onHover, onHoverEnd, onTap, isMobile }) {
  return (
    <>
      <ActivityHeatmap activities={activities} />
      <ActivityPolylines activities={activities} onHover={onHover} onHoverEnd={onHoverEnd} onTap={onTap} isMobile={isMobile} />
    </>
  );
}

// ─── MapView page ─────────────────────────────────────────────────────────────

export default function MapView({ athlete, onLogout }) {
  const { activities, loading, progress, error, rateLimitWait, cachedAt, refresh } = useActivities();
  const isMobile = useIsMobile();
  const [hiddenTypes, setHiddenTypes] = useState(new Set());
  const [hoveredActivity, setHoveredActivity] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [tappedActivity, setTappedActivity] = useState(null);
  const searchInputRef = useRef(null);

  const handleHover = useCallback((activity, pos) => {
    setHoveredActivity(activity);
    setTooltipPos(pos);
  }, []);
  const handleHoverEnd = useCallback(() => setHoveredActivity(null), []);
  const handleTap = useCallback((activity) => setTappedActivity(activity), []);

  const sportTypes = useMemo(() => {
    const types = new Set(activities.map((a) => a.sport_type || a.type).filter(Boolean));
    return Array.from(types).sort();
  }, [activities]);

  // When new sport types appear (data streaming in), make sure they start visible
  const prevTypesRef = useRef(new Set());
  useEffect(() => {
    sportTypes.forEach((t) => prevTypesRef.current.add(t));
  }, [sportTypes]);

  const toggleType = (type) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const toggleAll = () => {
    if (hiddenTypes.size === 0) {
      setHiddenTypes(new Set(sportTypes));
    } else {
      setHiddenTypes(new Set());
    }
  };

  const visibleActivities = useMemo(() => {
    if (hiddenTypes.size === 0) return activities;
    return activities.filter((a) => !hiddenTypes.has(a.sport_type || a.type));
  }, [activities, hiddenTypes]);

  const filteredCount = visibleActivities.length;

  return (
    <div style={styles.root}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <GlobeIcon />
          <span style={styles.headerTitle}>Strava Globe</span>
        </div>

        <div style={styles.headerCenter}>
          {loading ? (
            <LoadingBadge progress={progress} />
          ) : (
            <span style={styles.countBadge}>
              {filteredCount.toLocaleString()} GPS{" "}
              {filteredCount === 1 ? "activity" : "activities"}
              {hiddenTypes.size > 0 ? ` · ${activities.length - filteredCount} hidden` : ""}
            </span>
          )}
        </div>

        <div style={styles.headerRight}>
          {!isMobile && cachedAt && !loading && (
            <span style={styles.cachedLabel}>
              Synced {timeAgo(cachedAt)}
            </span>
          )}
          <button onClick={refresh} style={styles.refreshBtn} title="Re-sync from Strava">
            ↻
          </button>
          <img
            src={athlete.profile_medium || athlete.profile}
            alt={athlete.firstname}
            style={styles.avatar}
          />
          {!isMobile && (
            <span style={styles.athleteName}>{athlete.firstname} {athlete.lastname}</span>
          )}
          <button onClick={onLogout} style={styles.logoutBtn}>
            {isMobile ? "Out" : "Sign out"}
          </button>
        </div>
      </header>

      {/* Filter bar */}
      {!loading && sportTypes.length > 0 && (
        <div style={styles.filterBar}>
          {/* All / None toggle */}
          <button
            style={{
              ...styles.filterChip,
              ...(hiddenTypes.size === 0 ? styles.filterChipActive : {}),
            }}
            onClick={toggleAll}
          >
            {hiddenTypes.size === 0 ? "All" : "None"}
          </button>

          <div style={styles.filterDivider} />

          {sportTypes.map((type) => {
            const visible = !hiddenTypes.has(type);
            const color = sportColor({ sport_type: type });
            return (
              <button
                key={type}
                style={{
                  ...styles.filterChip,
                  borderLeftColor: color,
                  opacity: visible ? 1 : 0.38,
                  ...(visible ? styles.filterChipActive : {}),
                }}
                onClick={() => toggleType(type)}
              >
                <span style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: color,
                  marginRight: 6,
                  flexShrink: 0,
                }} />
                {type}
              </button>
            );
          })}
        </div>
      )}

      {/* Strava loading banner */}
      {loading && !cachedAt && (
        <div style={styles.loadingBanner}>
          <SmallSpinner />
          <span>
            {rateLimitWait
              ? `Strava rate limit — resuming in ${rateLimitWait}s…`
              : "Gathering all activities from Strava… this may take a few moments."}
          </span>
        </div>
      )}

      {/* Map */}
      <div style={styles.mapWrapper}>
        {/* Search input */}
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search locations…"
          style={isMobile ? {
            position: "absolute",
            top: 10, left: 10,
            width: "calc(100% - 20px)",
            zIndex: 10,
            height: 44,
            padding: "0 14px",
            fontSize: 15,
            boxSizing: "border-box",
            border: "1px solid #e0e0e2",
            borderRadius: 10,
            boxShadow: "0 2px 8px rgba(0,0,0,0.14)",
            outline: "none",
            fontFamily: "Inter, sans-serif",
            background: "#fff",
            color: "#111",
          } : {
            position: "absolute",
            top: 10, left: 200,
            zIndex: 10,
            width: 220, height: 40,
            padding: "0 12px",
            fontSize: 13,
            boxSizing: "border-box",
            border: "1px solid #e0e0e2",
            borderRadius: 8,
            boxShadow: "0 1px 6px rgba(0,0,0,0.12)",
            outline: "none",
            fontFamily: "Inter, sans-serif",
            background: "#fff",
            color: "#111",
          }}
        />

        {error === "reauth_required" && (
          <div style={{
            position: "absolute", inset: 0, zIndex: 200,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(244,244,245,0.85)", backdropFilter: "blur(4px)",
          }}>
            <div style={{
              background: "#fff", border: "1px solid #e0e0e2", borderRadius: 16,
              padding: "32px 40px", textAlign: "center", maxWidth: 380,
              boxShadow: "0 4px 24px rgba(0,0,0,0.1)",
            }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>🔗</div>
              <h2 style={{ fontSize: 18, fontWeight: 600, color: "#111", marginBottom: 8 }}>
                Reconnect to Strava
              </h2>
              <p style={{ fontSize: 14, color: "#666", marginBottom: 24, lineHeight: 1.6 }}>
                Your Strava connection is missing activity permissions. Please disconnect and reconnect to grant the required access.
              </p>
              <a
                href="https://www.strava.com/settings/apps"
                target="_blank"
                rel="noreferrer"
                style={{
                  display: "block", background: "#fc4c02", color: "#fff",
                  borderRadius: 10, padding: "11px 20px", fontSize: 14,
                  fontWeight: 600, textDecoration: "none", marginBottom: 10,
                }}
              >
                Disconnect on Strava
              </a>
              <button
                onClick={onLogout}
                style={{
                  background: "none", border: "1px solid #e0e0e2", borderRadius: 10,
                  padding: "10px 20px", fontSize: 14, color: "#777",
                  cursor: "pointer", width: "100%",
                }}
              >
                Sign out
              </button>
            </div>
          </div>
        )}

        {error && error !== "reauth_required" && (
          <div style={styles.errorBanner}>
            ⚠️ {error}
          </div>
        )}

        <APIProvider apiKey={MAPS_KEY} libraries={["geometry", "places"]}>
          <Map
            style={{ width: "100%", height: "100%" }}
            defaultCenter={{ lat: 30, lng: 0 }}
            defaultZoom={3}
            minZoom={2}
            mapId="strava-globe"
            colorScheme="LIGHT"
            disableDefaultUI={false}
            gestureHandling="greedy"
          >
            <SearchControl inputRef={searchInputRef} />
            <MapContent activities={visibleActivities} onHover={handleHover} onHoverEnd={handleHoverEnd} onTap={handleTap} isMobile={isMobile} />
          </Map>
        </APIProvider>

        {/* Desktop: hover tooltip */}
        {!isMobile && hoveredActivity && (
          <ActivityTooltip activity={hoveredActivity} x={tooltipPos.x} y={tooltipPos.y} />
        )}

        {/* Mobile: tap bottom card */}
        {isMobile && tappedActivity && (
          <MobileActivityCard activity={tappedActivity} onClose={() => setTappedActivity(null)} />
        )}

        {/* Loading overlay */}
        {loading && activities.length === 0 && (
          <div style={styles.loadingOverlay}>
            <div style={styles.loadingCard}>
              <Spinner />
              <p style={styles.loadingText}>Fetching your activities…</p>
              <p style={styles.loadingSubtext}>This may take a moment if you have a lot of activities.</p>
            </div>
          </div>
        )}

        {/* Legend — inside mapWrapper so position:absolute is relative to the map */}
        {!loading && activities.length > 0 && (
          <Legend sportTypes={sportTypes.filter((t) => t !== "All")} />
        )}
      </div>
    </div>
  );
}

// ─── Mobile activity bottom card ─────────────────────────────────────────────

function MobileActivityCard({ activity, onClose }) {
  return (
    <div style={mobileCardStyles.overlay} onClick={onClose}>
      <div style={mobileCardStyles.card} onClick={(e) => e.stopPropagation()}>
        <div style={mobileCardStyles.handle} />
        <div style={mobileCardStyles.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: sportColor(activity), flexShrink: 0 }} />
            <span style={mobileCardStyles.title}>{activity.name}</span>
          </div>
          <button onClick={onClose} style={mobileCardStyles.closeBtn}>✕</button>
        </div>
        <div style={mobileCardStyles.date}>{formatDate(activity.start_date)}</div>
        <div style={mobileCardStyles.grid}>
          <MobileStat label="Distance" value={formatDistance(activity.distance)} />
          <MobileStat label="Time" value={formatDuration(activity.moving_time)} />
          <MobileStat label="Avg speed" value={formatSpeed(activity.distance, activity.moving_time)} />
          <MobileStat label="Elevation" value={`${Math.round(activity.total_elevation_gain)} m`} />
        </div>
      </div>
    </div>
  );
}

function MobileStat({ label, value }) {
  return (
    <div style={mobileCardStyles.stat}>
      <div style={mobileCardStyles.statLabel}>{label}</div>
      <div style={mobileCardStyles.statValue}>{value}</div>
    </div>
  );
}

const mobileCardStyles = {
  overlay: {
    position: "absolute",
    inset: 0,
    zIndex: 200,
    display: "flex",
    alignItems: "flex-end",
  },
  card: {
    background: "#fff",
    borderRadius: "20px 20px 0 0",
    width: "100%",
    padding: "12px 20px 32px",
    boxShadow: "0 -4px 24px rgba(0,0,0,0.15)",
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    background: "#e0e0e2",
    margin: "0 auto 16px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    color: "#111",
    lineHeight: 1.3,
  },
  closeBtn: {
    background: "none",
    border: "none",
    fontSize: 16,
    color: "#aaa",
    cursor: "pointer",
    padding: "4px 8px",
  },
  date: {
    fontSize: 13,
    color: "#999",
    marginBottom: 16,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
  },
  stat: {},
  statLabel: {
    fontSize: 11,
    color: "#aaa",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    marginBottom: 2,
  },
  statValue: {
    fontSize: 18,
    fontWeight: 600,
    color: "#111",
  },
};

// ─── Activity tooltip ─────────────────────────────────────────────────────────

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}h ${m.toString().padStart(2, "0")}m`
    : `${m}m ${s.toString().padStart(2, "0")}s`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function formatDistance(meters) {
  return (meters / 1000).toFixed(1) + " km";
}

function formatSpeed(meters, seconds) {
  const kmh = (meters / seconds) * 3.6;
  return kmh.toFixed(1) + " km/h";
}

function ActivityTooltip({ activity, x, y }) {
  // Keep tooltip on screen
  const offsetX = x + 16;
  const offsetY = y - 12;

  return (
    <div style={{
      position: "fixed",
      left: offsetX,
      top: offsetY,
      background: "#ffffff",
      border: "1px solid #e0e0e2",
      borderRadius: "12px",
      padding: "12px 16px",
      boxShadow: "0 4px 20px rgba(0,0,0,0.12)",
      pointerEvents: "none",
      zIndex: 1000,
      minWidth: 200,
      maxWidth: 260,
    }}>
      {/* Sport type dot + name */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{
          width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
          background: sportColor(activity),
        }} />
        <span style={{ fontWeight: 600, fontSize: 14, color: "#111", lineHeight: 1.3 }}>
          {activity.name}
        </span>
      </div>

      <div style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>
        {formatDate(activity.start_date)}
      </div>

      {/* Stats grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 0" }}>
        <Stat label="Distance" value={formatDistance(activity.distance)} />
        <Stat label="Time" value={formatDuration(activity.moving_time)} />
        <Stat label="Avg speed" value={formatSpeed(activity.distance, activity.moving_time)} />
        <Stat label="Elevation" value={`${Math.round(activity.total_elevation_gain)} m`} />
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.5px" }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#222", marginTop: 1 }}>
        {value}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function LoadingBadge({ progress }) {
  return (
    <div style={styles.loadingBadge}>
      <SmallSpinner />
      <span>
        Fetching page {progress.pages}
        {progress.total > 0 ? ` · ${progress.total.toLocaleString()} scanned` : ""}…
      </span>
    </div>
  );
}

function Legend({ sportTypes }) {
  const known = sportTypes.filter((t) => SPORT_COLORS[t]);
  if (known.length === 0) return null;
  return (
    <div style={styles.legend}>
      {known.map((type) => (
        <div key={type} style={styles.legendItem}>
          <div style={{ ...styles.legendDot, background: SPORT_COLORS[type] }} />
          <span>{type}</span>
        </div>
      ))}
    </div>
  );
}

function GlobeIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 56 56" fill="none" aria-hidden="true">
      <circle cx="28" cy="28" r="22" stroke="#fc4c02" strokeWidth="2" fill="none" />
      <ellipse cx="28" cy="28" rx="22" ry="9" stroke="#fc4c02" strokeWidth="1" fill="none" opacity="0.5" />
      <line x1="6" y1="28" x2="50" y2="28" stroke="#fc4c02" strokeWidth="1" opacity="0.5" />
      <ellipse cx="28" cy="28" rx="9" ry="22" stroke="#fc4c02" strokeWidth="1" fill="none" opacity="0.5" />
      <path d="M14 34 Q18 22 24 28 Q30 34 36 20 Q40 12 44 18" stroke="#fc4c02" strokeWidth="2" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function timeAgo(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function Spinner() {
  return (
    <div style={{
      width: 36, height: 36, borderRadius: "50%",
      border: "3px solid #e0e0e2",
      borderTopColor: "#fc4c02",
      animation: "spin 0.8s linear infinite",
    }} />
  );
}

function SmallSpinner() {
  return (
    <div style={{
      width: 12, height: 12, borderRadius: "50%",
      border: "2px solid #ddd",
      borderTopColor: "#fc4c02",
      animation: "spin 0.8s linear infinite",
      flexShrink: 0,
    }} />
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: "#f4f4f5",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 20px",
    background: "#ffffff",
    borderBottom: "1px solid #e0e0e2",
    gap: "16px",
    flexShrink: 0,
    position: "relative",
    zIndex: 100,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  headerTitle: {
    fontSize: "16px",
    fontWeight: 700,
    color: "#111111",
    letterSpacing: "-0.3px",
  },
  headerCenter: {
    flex: 1,
    display: "flex",
    justifyContent: "center",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: "50%",
    border: "2px solid #e0e0e2",
  },
  athleteName: {
    fontSize: "13px",
    color: "#444",
    fontWeight: 500,
  },
  logoutBtn: {
    background: "none",
    border: "1px solid #e0e0e2",
    borderRadius: "8px",
    padding: "5px 12px",
    fontSize: "12px",
    color: "#777",
    cursor: "pointer",
  },
  cachedLabel: {
    fontSize: "12px",
    color: "#aaa",
  },
  refreshBtn: {
    background: "none",
    border: "1px solid #e0e0e2",
    borderRadius: "8px",
    padding: "4px 10px",
    fontSize: "15px",
    color: "#888",
    cursor: "pointer",
    lineHeight: 1,
  },
  countBadge: {
    fontSize: "13px",
    color: "#555",
    background: "#f0f0f1",
    border: "1px solid #e0e0e2",
    borderRadius: "20px",
    padding: "4px 14px",
  },
  loadingBadge: {
    fontSize: "13px",
    color: "#555",
    background: "#f0f0f1",
    border: "1px solid #e0e0e2",
    borderRadius: "20px",
    padding: "4px 14px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  loadingBanner: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 20px",
    background: "#fff7f3",
    borderBottom: "1px solid #fdddd0",
    fontSize: 13,
    color: "#b83d00",
    flexShrink: 0,
    position: "relative",
    zIndex: 100,
  },
  filterBar: {
    display: "flex",
    gap: "6px",
    padding: "8px 16px",
    background: "#ffffff",
    borderBottom: "1px solid #e0e0e2",
    overflowX: "auto",
    position: "relative",
    zIndex: 100,
    flexShrink: 0,
  },
  filterChip: {
    display: "flex",
    alignItems: "center",
    background: "#f4f4f5",
    border: "1px solid #e0e0e2",
    borderLeft: "3px solid #ccc",
    borderRadius: "8px",
    padding: "4px 12px",
    fontSize: "12px",
    color: "#777",
    whiteSpace: "nowrap",
    transition: "all 0.15s",
    cursor: "pointer",
  },
  filterChipActive: {
    background: "#ffffff",
    color: "#111",
    borderColor: "#ccc",
    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
  },
  filterDivider: {
    width: 1,
    height: 20,
    background: "#e0e0e2",
    flexShrink: 0,
    margin: "0 4px",
  },
  mapWrapper: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
  },
  loadingOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(244,244,245,0.75)",
    zIndex: 100,
    backdropFilter: "blur(4px)",
  },
  loadingCard: {
    background: "#ffffff",
    border: "1px solid #e0e0e2",
    borderRadius: "16px",
    padding: "32px 40px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "14px",
    textAlign: "center",
    boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
  },
  loadingText: {
    fontSize: "15px",
    color: "#111",
    fontWeight: 500,
  },
  loadingSubtext: {
    fontSize: "13px",
    color: "#888",
  },
  errorBanner: {
    position: "absolute",
    top: 12,
    left: "50%",
    transform: "translateX(-50%)",
    background: "#fff0f0",
    border: "1px solid #ffcccc",
    borderRadius: "10px",
    padding: "8px 16px",
    fontSize: "13px",
    color: "#cc2222",
    zIndex: 50,
  },
  legend: {
    position: "absolute",
    bottom: 28,
    right: 12,
    background: "rgba(255,255,255,0.9)",
    border: "1px solid #e0e0e2",
    borderRadius: "10px",
    padding: "10px 14px",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    backdropFilter: "blur(8px)",
    zIndex: 20,
    boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
  },
  legendItem: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "12px",
    color: "#444",
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    flexShrink: 0,
  },
};
