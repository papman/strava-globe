/**
 * SummaryPage
 *
 * Shows a stats summary: total activities, distance, countries visited,
 * cities visited — with a flag wall and a downloadable share card.
 */
import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useActivities } from "../hooks/useActivities.js";
import { geocodeActivities, countryCodeToFlag } from "../utils/geocode.js";

// ─── Share card canvas generator ─────────────────────────────────────────────

function generateShareCard({ athlete, totalActivities, totalKm, countries, cities }) {
  const W = 1080;
  const H = 1920;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0f172a");
  bg.addColorStop(1, "#1e1b4b");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Subtle grid pattern
  ctx.strokeStyle = "rgba(255,255,255,0.03)";
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Top accent bar
  const accent = ctx.createLinearGradient(0, 0, W, 0);
  accent.addColorStop(0, "#fc4c02");
  accent.addColorStop(1, "#ff8c42");
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, W, 8);

  // Brand label
  ctx.fillStyle = "#fc4c02";
  ctx.font = "bold 36px 'Arial'";
  ctx.letterSpacing = "8px";
  ctx.textAlign = "center";
  ctx.fillText("STRAVA GLOBE", W / 2, 100);

  // User name
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 72px 'Arial'";
  ctx.letterSpacing = "0px";
  const name = athlete ? `${athlete.firstname} ${athlete.lastname}` : "My Stats";
  ctx.fillText(name, W / 2, 200);

  // Divider
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(80, 230); ctx.lineTo(W - 80, 230); ctx.stroke();

  // Stats — 2x2 grid
  const stats = [
    { value: totalActivities.toLocaleString(), label: "Activities" },
    { value: `${totalKm.toLocaleString(undefined, { maximumFractionDigits: 0 })} km`, label: "Total Distance" },
    { value: countries.length.toString(), label: "Countries" },
    { value: cities.length.toString(), label: "Cities" },
  ];

  const statW = W / 2;
  const statH = 220;
  const statTop = 270;

  stats.forEach(({ value, label }, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const cx = col * statW + statW / 2;
    const cy = statTop + row * statH + 60;

    // Stat box background
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    roundRect(ctx, col * statW + 20, statTop + row * statH + 10, statW - 40, statH - 20, 20);
    ctx.fill();

    // Value
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 80px 'Arial'";
    ctx.textAlign = "center";
    ctx.fillText(value, cx, cy + 20);

    // Label
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "32px 'Arial'";
    ctx.fillText(label.toUpperCase(), cx, cy + 72);
  });

  // Flag wall section
  const flagTop = statTop + 2 * statH + 60;

  ctx.fillStyle = "rgba(255,255,255,0.07)";
  roundRect(ctx, 40, flagTop, W - 80, H - flagTop - 160, 24);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.font = "28px 'Arial'";
  ctx.textAlign = "center";
  ctx.fillText("COUNTRIES VISITED", W / 2, flagTop + 50);

  // Draw flag emojis in a grid
  const flagSize = 80;
  const flagCols = Math.floor((W - 120) / (flagSize + 16));
  const flagPad = 16;
  const flagStartX = 60 + ((W - 120) - flagCols * (flagSize + flagPad) + flagPad) / 2;
  const flagStartY = flagTop + 80;

  ctx.font = `${flagSize}px 'Apple Color Emoji', 'Noto Color Emoji', serif`;
  countries.slice(0, 36).forEach(({ code }, i) => {
    const col = i % flagCols;
    const row = Math.floor(i / flagCols);
    const x = flagStartX + col * (flagSize + flagPad);
    const y = flagStartY + row * (flagSize + flagPad + 10) + flagSize;
    ctx.fillText(countryCodeToFlag(code), x, y);
  });

  // Footer
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.font = "30px 'Arial'";
  ctx.textAlign = "center";
  ctx.fillText("strava-globe.vercel.app", W / 2, H - 60);

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
      const canvas = generateShareCard({ athlete, totalActivities, totalKm, countries, cities });
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
            <div style={styles.flagGrid}>
              {countries.map(({ name, code, count }) => (
                <div key={name} style={styles.flagCard} title={`${name} — ${count} activities`}>
                  <div style={styles.flagEmoji}>{countryCodeToFlag(code)}</div>
                  <div style={styles.flagName}>{name}</div>
                  <div style={styles.flagCount}>{count}</div>
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
            <div style={styles.citiesGrid}>
              {cities.slice(0, 50).map(({ name, countryCode, count }) => (
                <div key={`${name}-${countryCode}`} style={styles.cityRow}>
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
  flagCard: {
    background: "#fff",
    border: "1px solid #e0e0e2",
    borderRadius: 12,
    padding: "14px 8px 10px",
    textAlign: "center",
    cursor: "default",
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
