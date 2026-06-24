const API = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export default function Landing() {
  return (
    <div style={styles.container}>
      <div style={styles.card}>
        {/* Logo / Hero */}
        <div style={styles.logoWrapper}>
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true">
            {/* Globe outline */}
            <circle cx="28" cy="28" r="24" stroke="#fc4c02" strokeWidth="2" fill="none" />
            {/* Latitude lines */}
            <ellipse cx="28" cy="28" rx="24" ry="10" stroke="#fc4c02" strokeWidth="1" fill="none" opacity="0.4" />
            <line x1="4" y1="28" x2="52" y2="28" stroke="#fc4c02" strokeWidth="1" opacity="0.4" />
            {/* Longitude lines */}
            <ellipse cx="28" cy="28" rx="10" ry="24" stroke="#fc4c02" strokeWidth="1" fill="none" opacity="0.4" />
            {/* Route squiggle */}
            <path
              d="M14 36 Q18 22 24 28 Q30 34 36 20 Q40 12 44 18"
              stroke="#fc4c02"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <h1 style={styles.title}>Strava Globe</h1>
        <p style={styles.subtitle}>
          See every GPS workout you've ever logged on Strava — all at once, on one map.
        </p>

        <ul style={styles.features}>
          <li>🗺️ All your GPS routes rendered on a world map</li>
          <li>🏃 Runs, rides, hikes, swims &amp; more</li>
          <li>🔒 Read-only access — we never modify your data</li>
        </ul>

        <a href={`${API}/auth/strava`} style={styles.connectBtn}>
          <StravaIcon />
          Connect with Strava
        </a>

        <p style={styles.disclaimer}>
          Only <strong>activity:read_all</strong> scope is requested. Your data stays between you and Strava.
        </p>
      </div>
    </div>
  );
}

function StravaIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 40 40" fill="white" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M17.5 28.5L22.5 18h5L17.5 35 7.5 18h5z" />
      <path d="M27.5 28.5L32.5 18h-5L22.5 35z" opacity="0.7" />
    </svg>
  );
}

const styles = {
  container: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#f4f4f5",
    padding: "24px",
  },
  card: {
    background: "#ffffff",
    border: "1px solid #e0e0e2",
    borderRadius: "20px",
    padding: "48px 40px",
    maxWidth: "440px",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "20px",
    boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
  },
  logoWrapper: {
    marginBottom: "4px",
  },
  title: {
    fontSize: "32px",
    fontWeight: 700,
    letterSpacing: "-0.5px",
    color: "#111111",
  },
  subtitle: {
    fontSize: "15px",
    color: "#666",
    textAlign: "center",
    lineHeight: 1.6,
  },
  features: {
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    alignSelf: "stretch",
    background: "#f4f4f5",
    borderRadius: "12px",
    padding: "16px 20px",
    fontSize: "14px",
    color: "#444",
    lineHeight: 1.5,
  },
  connectBtn: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    background: "#fc4c02",
    color: "white",
    border: "none",
    borderRadius: "12px",
    padding: "14px 28px",
    fontSize: "15px",
    fontWeight: 600,
    textDecoration: "none",
    width: "100%",
    justifyContent: "center",
    transition: "background 0.15s",
  },
  disclaimer: {
    fontSize: "12px",
    color: "#999",
    textAlign: "center",
    lineHeight: 1.5,
  },
};
