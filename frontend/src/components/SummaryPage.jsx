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
 * Layout (1080 × 1920):
 *   0–8      Orange accent bar
 *   8–240    Brand + user name
 *   240–310  Stats row (3 pills)
 *   310–360  "Your Heatmap" label
 *   360–870  World heatmap (equirectangular projection, drawn on canvas)
 *   870–940  "Top Cities" label
 *   940–1840 10 city rows × 90px
 *   1840–1920 Footer
 */
function generateShareCard({ athlete, totalActivities, totalKm, countries, cities, activities }) {
  const W = 1080;
  const H = 1920;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // ── Background (warm cream) ─────────────────────────────────────────────────
  ctx.fillStyle = "#faf7f2";
  ctx.fillRect(0, 0, W, H);

  // ── Orange top bar ──────────────────────────────────────────────────────────
  const barGrad = ctx.createLinearGradient(0, 0, W, 0);
  barGrad.addColorStop(0, "#fc4c02");
  barGrad.addColorStop(1, "#ff8c42");
  ctx.fillStyle = barGrad;
  ctx.fillRect(0, 0, W, 10);

  // ── Brand ───────────────────────────────────────────────────────────────────
  ctx.textAlign = "center";
  ctx.fillStyle = "#fc4c02";
  ctx.font = "bold 32px Arial";
  ctx.fillText("STRAVA GLOBE", W / 2, 76);

  ctx.fillStyle = "#111111";
  ctx.font = "bold 68px Arial";
  const name = athlete ? `${athlete.firstname} ${athlete.lastname}` : "My Stats";
  ctx.fillText(name, W / 2, 162);

  // Thin divider under name
  ctx.strokeStyle = "rgba(0,0,0,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(80, 185); ctx.lineTo(W - 80, 185); ctx.stroke();

  // ── Stats pills ─────────────────────────────────────────────────────────────
  const pills = [
    { value: totalActivities.toLocaleString(), label: "Activities" },
    { value: `${totalKm.toLocaleString()}km`, label: "Distance" },
    { value: countries.length.toString(), label: "Countries" },
  ];
  const pillW = 300, pillH = 60, pillY = 202, pillGap = 20;
  const pillsTotal = pills.length * pillW + (pills.length - 1) * pillGap;
  const pillStartX = (W - pillsTotal) / 2;
  pills.forEach(({ value, label }, i) => {
    const px = pillStartX + i * (pillW + pillGap);
    // Pill border
    ctx.strokeStyle = "rgba(252,76,2,0.25)";
    ctx.lineWidth = 1.5;
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, px, pillY, pillW, pillH, 30);
    ctx.fill();
    ctx.stroke();
    // Value
    ctx.fillStyle = "#fc4c02";
    ctx.font = "bold 28px Arial";
    ctx.textAlign = "center";
    ctx.fillText(value, px + pillW / 2, pillY + 24);
    // Label
    ctx.fillStyle = "#999999";
    ctx.font = "20px Arial";
    ctx.fillText(label, px + pillW / 2, pillY + 48);
  });

  // ── "Your Heatmap" label ────────────────────────────────────────────────────
  const mapLabelY = 298;
  ctx.textAlign = "left";
  ctx.fillStyle = "#999999";
  ctx.font = "24px Arial";
  ctx.fillText("YOUR HEATMAP", 60, mapLabelY);

  // ── World heatmap (equirectangular projection) ──────────────────────────────
  const MAP_X = 40, MAP_Y = 300, MAP_W = W - 80, MAP_H = 520;

  // Map background
  ctx.fillStyle = "#060d1a";
  roundRect(ctx, MAP_X, MAP_Y, MAP_W, MAP_H, 20);
  ctx.fill();

  // Graticule — subtle lat/lng grid every 30°
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let lat = -90; lat <= 90; lat += 30) {
    const py = MAP_Y + ((90 - lat) / 180) * MAP_H;
    ctx.beginPath(); ctx.moveTo(MAP_X, py); ctx.lineTo(MAP_X + MAP_W, py); ctx.stroke();
  }
  for (let lng = -180; lng <= 180; lng += 30) {
    const px = MAP_X + ((lng + 180) / 360) * MAP_W;
    ctx.beginPath(); ctx.moveTo(px, MAP_Y); ctx.lineTo(px, MAP_Y + MAP_H); ctx.stroke();
  }

  // Equator + prime meridian slightly brighter
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  const eqY = MAP_Y + MAP_H / 2;
  ctx.beginPath(); ctx.moveTo(MAP_X, eqY); ctx.lineTo(MAP_X + MAP_W, eqY); ctx.stroke();
  const pmX = MAP_X + MAP_W / 2;
  ctx.beginPath(); ctx.moveTo(pmX, MAP_Y); ctx.lineTo(pmX, MAP_Y + MAP_H); ctx.stroke();

  // Cluster activities into 1.5° grid cells
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

  // Draw glowing dots
  for (const { lat, lng, count } of clusters) {
    const px = MAP_X + ((lng + 180) / 360) * MAP_W;
    const py = MAP_Y + ((90 - lat) / 180) * MAP_H;
    const scale = 0.25 + 0.75 * Math.sqrt(count / maxCount);
    const r = Math.max(5, scale * 28);

    const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
    grad.addColorStop(0,   `rgba(252,76,2,${Math.min(1, 0.65 + 0.35 * scale)})`);
    grad.addColorStop(0.35, `rgba(255,120,50,${0.5 * scale})`);
    grad.addColorStop(1,   "rgba(252,76,2,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── "Top Cities" label ──────────────────────────────────────────────────────
  ctx.textAlign = "left";
  ctx.fillStyle = "#999999";
  ctx.font = "24px Arial";
  ctx.fillText("TOP CITIES", 60, 876);

  // ── City rows ───────────────────────────────────────────────────────────────
  const CITY_TOP = 894;
  const CITY_ROW_H = 95;
  const topCities = cities.slice(0, 10);

  topCities.forEach(({ name, country, countryCode, count }, i) => {
    const rowY = CITY_TOP + i * CITY_ROW_H;

    // Row background (alternating — light cream tones)
    ctx.fillStyle = i % 2 === 0 ? "rgba(0,0,0,0.025)" : "rgba(255,255,255,0.6)";
    ctx.fillRect(40, rowY, W - 80, CITY_ROW_H);

    // Rank number
    ctx.fillStyle = "#cccccc";
    ctx.font = "bold 28px Arial";
    ctx.textAlign = "right";
    ctx.fillText(`${i + 1}`, 96, rowY + 58);

    // Flag
    ctx.font = "48px 'Apple Color Emoji','Noto Color Emoji',serif";
    ctx.textAlign = "left";
    ctx.fillText(countryCodeToFlag(countryCode), 108, rowY + 64);

    // City name
    ctx.fillStyle = "#111111";
    ctx.font = "bold 34px Arial";
    ctx.textAlign = "left";
    ctx.fillText(name, 186, rowY + 48);

    // Country name
    ctx.fillStyle = "#888888";
    ctx.font = "24px Arial";
    ctx.fillText(country || "", 186, rowY + 78);

    // Activity count (right-aligned, orange)
    const countStr = `${count} activit${count === 1 ? "y" : "ies"}`;
    ctx.font = "bold 26px Arial";
    ctx.textAlign = "right";
    ctx.fillStyle = "#fc4c02";
    ctx.fillText(countStr, W - 60, rowY + 58);

    // Divider
    if (i < topCities.length - 1) {
      ctx.strokeStyle = "rgba(0,0,0,0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(40, rowY + CITY_ROW_H);
      ctx.lineTo(W - 40, rowY + CITY_ROW_H);
      ctx.stroke();
    }
  });

  // ── Footer ──────────────────────────────────────────────────────────────────
  ctx.fillStyle = "#bbbbbb";
  ctx.font = "28px Arial";
  ctx.textAlign = "center";
  ctx.fillText("strava-globe.vercel.app", W / 2, H - 52);

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

  const handleDownload = () => {
    setDownloading(true);
    try {
      const canvas = generateShareCard({ athlete, totalActivities, totalKm, countries, cities, activities });
      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "strava-globe-stats.png";
        a.click();
        URL.revokeObjectURL(url);
        setDownloading(false);
      }, "image/png");
    } catch {
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
