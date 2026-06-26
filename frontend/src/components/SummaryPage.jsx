/**
 * SummaryPage
 *
 * Shows a stats summary: total activities, distance, countries visited,
 * cities visited — with a flag wall and a downloadable share card.
 */
import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useActivities } from "../hooks/useActivities.js";
import { geocodeActivities, countryCodeToFlag, decodePolylineStart } from "../utils/geocode.js";

// ─── Share card canvas generator ─────────────────────────────────────────────

/**
 * Layout (1080 × 1920) — dark premium design:
 *   0–10     Orange gradient bar
 *   10–130   Brand
 *   130–230  User name
 *   230–350  Stats row (3 inline columns)
 *   350–400  Map section label
 *   400–970  World map (570px)
 *   970–1030 Cities section label
 *   1030–1900 10 city rows × 87px
 *   1900–1920 Footer
 */
async function generateShareCard({ athlete, totalActivities, totalKm, countries, cities, activities, worldGeo, projection, geoPath }) {
  const W = 1080;
  const H = 1920;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // ── Background — deep dark blue-black ──────────────────────────────────────
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, "#12121f");
  bgGrad.addColorStop(1, "#0a0a15");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // ── Orange top bar ──────────────────────────────────────────────────────────
  const barGrad = ctx.createLinearGradient(0, 0, W, 0);
  barGrad.addColorStop(0, "#fc4c02");
  barGrad.addColorStop(1, "#ff7a30");
  ctx.fillStyle = barGrad;
  ctx.fillRect(0, 0, W, 10);

  // ── Brand ───────────────────────────────────────────────────────────────────
  ctx.textAlign = "center";
  ctx.fillStyle = "#fc4c02";
  ctx.font = "bold 30px 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText("STRAVA GLOBE", W / 2, 82);

  // User name
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 72px 'Helvetica Neue', Arial, sans-serif";
  const name = athlete ? `${athlete.firstname} ${athlete.lastname}` : "My Stats";
  ctx.fillText(name, W / 2, 180);

  // ── Stats row — 3 columns, vertical dividers ────────────────────────────────
  const stats = [
    { value: totalActivities.toLocaleString(), label: "Activities" },
    { value: `${totalKm.toLocaleString()} km`, label: "Distance" },
    { value: countries.length.toString(), label: "Countries" },
  ];
  const statColW = W / 3;
  const statTop = 225;

  // Subtle surface behind stats
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  roundRect(ctx, 0, statTop, W, 115, 0);
  ctx.fill();

  stats.forEach(({ value, label }, i) => {
    const cx = i * statColW + statColW / 2;

    // Vertical divider between columns
    if (i > 0) {
      ctx.strokeStyle = "rgba(255,255,255,0.1)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(i * statColW, statTop + 20);
      ctx.lineTo(i * statColW, statTop + 95);
      ctx.stroke();
    }

    // Value
    ctx.fillStyle = "#fc4c02";
    ctx.font = "bold 44px 'Helvetica Neue', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(value, cx, statTop + 58);

    // Label
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "22px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillText(label.toUpperCase(), cx, statTop + 88);
  });

  // ── Section label — heatmap ─────────────────────────────────────────────────
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.font = "22px 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText("YOUR ACTIVITY HEATMAP", 56, 386);

  // ── World map panel ─────────────────────────────────────────────────────────
  const MAP_X = 0, MAP_Y = 400, MAP_W = W, MAP_H = 570;

  ctx.fillStyle = "#060c18";
  ctx.fillRect(MAP_X, MAP_Y, MAP_W, MAP_H);

  ctx.save();
  ctx.rect(MAP_X, MAP_Y, MAP_W, MAP_H);
  ctx.clip();

  if (worldGeo && projection && geoPath) {
    const path = geoPath(projection, ctx);

    // Ocean
    ctx.beginPath();
    path({ type: "Sphere" });
    ctx.fillStyle = "#060c18";
    ctx.fill();

    // Land — blue-slate, clearly distinct from ocean
    ctx.beginPath();
    path(worldGeo);
    ctx.fillStyle = "#1e3d5c";
    ctx.fill();
    ctx.strokeStyle = "rgba(90,160,240,0.4)";
    ctx.lineWidth = 0.7;
    ctx.stroke();

    // Graticule
    const { geoGraticule } = await import("d3-geo");
    const graticule = geoGraticule().step([30, 30])();
    ctx.beginPath();
    path(graticule);
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  // Activity glow dots
  const GRID = 1.5;
  const heatGrid = {};
  for (const act of activities) {
    if (!act.polyline) continue;
    try {
      const [lat, lng] = decodePolylineStart(act.polyline);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const key = `${Math.round(lat / GRID)},${Math.round(lng / GRID)}`;
      if (!heatGrid[key]) heatGrid[key] = { lat, lng, count: 0 };
      heatGrid[key].count++;
    } catch { /* skip */ }
  }
  const clusters = Object.values(heatGrid);
  const maxCount = Math.max(...clusters.map(c => c.count), 1);

  for (const { lat, lng, count } of clusters) {
    let px, py;
    if (projection) {
      [px, py] = projection([lng, lat]);
    } else {
      px = MAP_X + ((lng + 180) / 360) * MAP_W;
      py = MAP_Y + ((90 - lat) / 180) * MAP_H;
    }
    if (!isFinite(px) || !isFinite(py)) continue;

    const scale = 0.25 + 0.75 * Math.sqrt(count / maxCount);
    const r = Math.max(5, scale * 28);

    const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
    grad.addColorStop(0,    `rgba(255,255,255,${Math.min(1, 0.9 * scale + 0.1)})`);
    grad.addColorStop(0.15, `rgba(255,100,30,${Math.min(1, 0.85 * scale + 0.05)})`);
    grad.addColorStop(0.5,  `rgba(252,76,2,${0.45 * scale})`);
    grad.addColorStop(1,    "rgba(252,76,2,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();

  // Thin orange line at bottom of map panel
  ctx.fillStyle = "rgba(252,76,2,0.25)";
  ctx.fillRect(0, MAP_Y + MAP_H, W, 1);

  // ── Section label — cities ──────────────────────────────────────────────────
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.font = "22px 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText("TOP CITIES", 56, 1008);

  // ── City rows ───────────────────────────────────────────────────────────────
  const CITY_TOP = 1024;
  const CITY_ROW_H = 87;
  const topCities = cities.slice(0, 10);

  topCities.forEach(({ name, country, countryCode, count }, i) => {
    const rowY = CITY_TOP + i * CITY_ROW_H;
    const isLast = i === topCities.length - 1;

    // Subtle alternating row tint
    if (i % 2 === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.025)";
      ctx.fillRect(0, rowY, W, CITY_ROW_H);
    }

    // Rank — orange, small
    ctx.fillStyle = "#fc4c02";
    ctx.font = "bold 24px 'Helvetica Neue', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(i + 1, 44, rowY + 50);

    // Flag
    ctx.font = "44px 'Apple Color Emoji','Noto Color Emoji',serif";
    ctx.textAlign = "left";
    ctx.fillText(countryCodeToFlag(countryCode), 72, rowY + 56);

    // City name
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 32px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillText(name, 148, rowY + 42);

    // Country
    ctx.fillStyle = "rgba(255,255,255,0.38)";
    ctx.font = "22px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillText(country || "", 148, rowY + 70);

    // Activity count — right side, orange
    ctx.fillStyle = "#fc4c02";
    ctx.font = "bold 26px 'Helvetica Neue', Arial, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`${count}`, W - 56, rowY + 50);

    ctx.fillStyle = "rgba(252,76,2,0.5)";
    ctx.font = "18px 'Helvetica Neue', Arial, sans-serif";
    ctx.fillText(count === 1 ? "activity" : "activities", W - 56, rowY + 72);

    // Divider
    if (!isLast) {
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(56, rowY + CITY_ROW_H);
      ctx.lineTo(W - 56, rowY + CITY_ROW_H);
      ctx.stroke();
    }
  });

  // ── Footer ──────────────────────────────────────────────────────────────────
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  ctx.font = "22px 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText("strava-globe.vercel.app", W / 2, H - 14);

  return canvas;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SummaryPage({ athlete }) {
  const navigate = useNavigate();
  const { activities, loading: activitiesLoading } = useActivities();

  const [countries, setCountries] = useState([]);
  const [cities, setCities] = useState([]);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoProgress, setGeoProgress] = useState({ done: 0, total: 0 });
  const [geoError, setGeoError] = useState(null);
  const [downloading, setDownloading] = useState(false);

  const totalActivities = activities.length;
  const totalKm = Math.round(activities.reduce((s, a) => s + (a.distance || 0), 0) / 1000);

  useEffect(() => {
    if (activitiesLoading || activities.length === 0) return;
    setGeoLoading(true);
    setGeoError(null);
    geocodeActivities(activities, (done, total) => {
      setGeoProgress({ done, total });
    })
      .then(({ countries: c, cities: ci }) => {
        setCountries(c);
        setCities(ci);
      })
      .catch((err) => setGeoError(err.message))
      .finally(() => setGeoLoading(false));
  }, [activities, activitiesLoading]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      // Lazy-load world map data + d3-geo — only downloaded when user clicks Share
      const [
        { feature },
        { geoEquirectangular, geoPath },
        worldRaw,
      ] = await Promise.all([
        import("topojson-client"),
        import("d3-geo"),
        import("world-atlas/countries-110m.json"),
      ]);

      const MAP_X = 0, MAP_Y = 400, MAP_W = 1080, MAP_H = 570;
      const worldGeo = feature(worldRaw, worldRaw.objects.countries);

      // Build an equirectangular projection fitted exactly to the map panel
      const projection = geoEquirectangular().fitExtent(
        [[MAP_X, MAP_Y], [MAP_X + MAP_W, MAP_Y + MAP_H]],
        { type: "Sphere" }
      );

      const canvas = await generateShareCard({
        athlete, totalActivities, totalKm, countries, cities, activities,
        worldGeo, projection, geoPath,
      });

      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "strava-globe-stats.png";
        a.click();
        URL.revokeObjectURL(url);
        setDownloading(false);
      }, "image/png");
    } catch (e) {
      console.error("Share card error:", e);
      setDownloading(false);
    }
  };

  const isLoading = activitiesLoading || geoLoading;

  return (
    <div style={styles.root}>
      {/* Header */}
      <header style={styles.header}>
        <button onClick={() => navigate("/map")} style={styles.backBtn}>
          ← Map
        </button>
        <div style={styles.headerTitle}>My Stats</div>
        <button
          onClick={handleDownload}
          disabled={downloading || isLoading || countries.length === 0}
          style={{
            ...styles.downloadBtn,
            opacity: (downloading || isLoading || countries.length === 0) ? 0.4 : 1,
          }}
        >
          {downloading ? "Saving…" : "⬇ Share"}
        </button>
      </header>

      <div style={styles.content}>

        {/* Stats row */}
        <div style={styles.statsGrid}>
          <StatCard value={totalActivities.toLocaleString()} label="Activities" color="#fc4c02" loading={activitiesLoading} />
          <StatCard value={`${totalKm.toLocaleString()} km`} label="Total Distance" color="#4a9eff" loading={activitiesLoading} />
          <StatCard value={countries.length} label="Countries" color="#a8d44a" loading={isLoading} />
          <StatCard value={cities.length} label="Cities" color="#f5a623" loading={isLoading} />
        </div>

        {/* Geocoding progress */}
        {geoLoading && geoProgress.total > 0 && (
          <div style={styles.geoProgress}>
            <div style={styles.geoProgressBar}>
              <div style={{
                ...styles.geoProgressFill,
                width: `${Math.round((geoProgress.done / geoProgress.total) * 100)}%`,
              }} />
            </div>
            <span style={styles.geoProgressLabel}>
              Mapping locations… {geoProgress.done}/{geoProgress.total}
            </span>
          </div>
        )}

        {geoError && (
          <div style={styles.errorBanner}>⚠️ Location lookup failed: {geoError}</div>
        )}

        {/* Flag wall */}
        {countries.length > 0 && (
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>
              🌍 Countries Visited
              <span style={styles.sectionCount}>{countries.length}</span>
            </h2>
            <p style={styles.clickHint}>Tap a country to see your activities there</p>
            <div style={styles.flagGrid}>
              {countries.map(({ name, code, count, lat, lng }) => (
                <div
                  key={name}
                  style={styles.flagCard}
                  title={`${name} — ${count} activities`}
                  onClick={() => navigate("/map", { state: { center: { lat, lng }, zoom: 5 } })}
                >
                  <div style={styles.flagEmoji}>{countryCodeToFlag(code)}</div>
                  <div style={styles.flagName}>{name}</div>
                  <div style={styles.flagCount}>{count} activit{count === 1 ? "y" : "ies"}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Cities */}
        {cities.length > 0 && (
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>
              🏙 Cities
              <span style={styles.sectionCount}>{cities.length}</span>
            </h2>
            <p style={styles.clickHint}>Tap a city to see your activities there</p>
            <div style={styles.citiesGrid}>
              {cities.slice(0, 50).map(({ name, countryCode, count, lat, lng }) => (
                <div
                  key={`${name}-${countryCode}`}
                  style={styles.cityRow}
                  onClick={() => navigate("/map", { state: { center: { lat, lng }, zoom: 11 } })}
                >
                  <span style={styles.cityFlag}>{countryCodeToFlag(countryCode)}</span>
                  <span style={styles.cityName}>{name}</span>
                  <span style={styles.cityCount}>{count}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Empty state */}
        {!isLoading && activities.length === 0 && (
          <div style={styles.emptyState}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🏃</div>
            <p>No activities found. Make sure your Strava is connected.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ value, label, color, loading }) {
  return (
    <div style={styles.statCard}>
      {loading ? (
        <div style={{ ...styles.statValue, color: "#ccc" }}>—</div>
      ) : (
        <div style={{ ...styles.statValue, color }}>{value}</div>
      )}
      <div style={styles.statLabel}>{label}</div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100vh",
    background: "#f4f4f5",
    fontFamily: "Inter, -apple-system, sans-serif",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 20px",
    background: "#ffffff",
    borderBottom: "1px solid #e0e0e2",
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  backBtn: {
    background: "none",
    border: "1px solid #e0e0e2",
    borderRadius: 8,
    padding: "6px 14px",
    fontSize: 13,
    color: "#555",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: "#111",
  },
  downloadBtn: {
    background: "#fc4c02",
    border: "none",
    borderRadius: 8,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 600,
    color: "#fff",
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "opacity 0.15s",
  },
  content: {
    maxWidth: 800,
    margin: "0 auto",
    width: "100%",
    padding: "24px 20px 60px",
    boxSizing: "border-box",
  },
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, 1fr)",
    gap: 12,
    marginBottom: 24,
  },
  statCard: {
    background: "#fff",
    border: "1px solid #e0e0e2",
    borderRadius: 14,
    padding: "20px 16px",
    textAlign: "center",
  },
  statValue: {
    fontSize: 32,
    fontWeight: 700,
    lineHeight: 1.1,
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
    color: "#999",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  geoProgress: {
    marginBottom: 20,
  },
  geoProgressBar: {
    height: 4,
    background: "#e0e0e2",
    borderRadius: 2,
    overflow: "hidden",
    marginBottom: 6,
  },
  geoProgressFill: {
    height: "100%",
    background: "#fc4c02",
    borderRadius: 2,
    transition: "width 0.3s ease",
  },
  geoProgressLabel: {
    fontSize: 12,
    color: "#888",
  },
  errorBanner: {
    background: "#fff0f0",
    border: "1px solid #ffcccc",
    borderRadius: 10,
    padding: "10px 16px",
    fontSize: 13,
    color: "#cc2222",
    marginBottom: 20,
  },
  section: {
    marginBottom: 32,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: "#111",
    marginBottom: 16,
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  sectionCount: {
    fontSize: 13,
    fontWeight: 500,
    color: "#888",
    background: "#f0f0f1",
    border: "1px solid #e0e0e2",
    borderRadius: 20,
    padding: "2px 10px",
  },
  flagGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))",
    gap: 10,
  },
  clickHint: {
    fontSize: 12,
    color: "#aaa",
    marginTop: -10,
    marginBottom: 12,
  },
  flagCard: {
    background: "#fff",
    border: "1px solid #e0e0e2",
    borderRadius: 12,
    padding: "14px 8px 10px",
    textAlign: "center",
    cursor: "pointer",
    transition: "border-color 0.15s, box-shadow 0.15s",
  },
  flagEmoji: {
    fontSize: 36,
    lineHeight: 1.2,
    marginBottom: 6,
  },
  flagName: {
    fontSize: 11,
    color: "#444",
    fontWeight: 500,
    lineHeight: 1.3,
    marginBottom: 2,
  },
  flagCount: {
    fontSize: 10,
    color: "#aaa",
  },
  citiesGrid: {
    background: "#fff",
    border: "1px solid #e0e0e2",
    borderRadius: 14,
    overflow: "hidden",
  },
  cityRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 16px",
    borderBottom: "1px solid #f0f0f1",
    fontSize: 14,
    cursor: "pointer",
  },
  cityFlag: {
    fontSize: 20,
    flexShrink: 0,
  },
  cityName: {
    flex: 1,
    color: "#222",
    fontWeight: 500,
  },
  cityCount: {
    fontSize: 12,
    color: "#aaa",
    flexShrink: 0,
  },
  emptyState: {
    textAlign: "center",
    color: "#888",
    padding: "60px 20px",
    fontSize: 15,
  },
};
