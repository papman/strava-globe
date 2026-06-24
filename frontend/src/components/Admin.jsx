import { useState, useEffect } from "react";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export default function Admin() {
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);

  // Try to load stats on mount (in case session is already active)
  useEffect(() => {
    fetchStats();
  }, []);

  async function fetchStats() {
    const res = await fetch(`${API}/admin/stats`, { credentials: "include" });
    if (res.ok) {
      setStats(await res.json());
      setAuthed(true);
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API}/admin/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        await fetchStats();
      } else {
        setError("Incorrect password.");
      }
    } catch {
      setError("Could not reach server.");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    await fetch(`${API}/admin/logout`, { method: "POST", credentials: "include" });
    setAuthed(false);
    setStats(null);
    setPassword("");
  }

  if (!authed) {
    return (
      <div style={styles.page}>
        <div style={styles.loginCard}>
          <div style={styles.logo}>🌍</div>
          <h1 style={styles.title}>Admin</h1>
          <p style={styles.subtitle}>Strava Globe</p>
          <form onSubmit={handleLogin} style={styles.form}>
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={styles.input}
              autoFocus
            />
            {error && <p style={styles.error}>{error}</p>}
            <button type="submit" style={styles.loginBtn} disabled={loading}>
              {loading ? "Checking…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.dashboard}>
        {/* Header */}
        <div style={styles.header}>
          <div>
            <h1 style={styles.title}>Admin Dashboard</h1>
            <p style={styles.subtitle}>Strava Globe</p>
          </div>
          <button onClick={handleLogout} style={styles.logoutBtn}>Sign out</button>
        </div>

        {/* Stats cards */}
        <div style={styles.cards}>
          <StatCard label="Total logins" value={stats.totalLogins} />
          <StatCard label="Unique users" value={stats.uniqueUsers} />
        </div>

        {/* User list */}
        <div style={styles.tableWrap}>
          <h2 style={styles.tableTitle}>Users</h2>
          <table style={styles.table}>
            <thead>
              <tr>
                {["", "Name", "Location", "Logins", "First seen", "Last seen"].map((h) => (
                  <th key={h} style={styles.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.athletes.map((a) => (
                <tr key={a.id} style={styles.tr}>
                  <td style={styles.td}>
                    {a.profile ? (
                      <img src={a.profile} alt={a.name} style={styles.avatar} />
                    ) : (
                      <div style={{ ...styles.avatar, background: "#e0e0e0" }} />
                    )}
                  </td>
                  <td style={{ ...styles.td, fontWeight: 500 }}>{a.name}</td>
                  <td style={styles.td}>
                    {[a.city, a.country].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td style={{ ...styles.td, textAlign: "center" }}>{a.loginCount}</td>
                  <td style={styles.td}>{fmtDate(a.firstSeen)}</td>
                  <td style={styles.td}>{fmtDate(a.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {stats.athletes.length === 0 && (
            <p style={{ color: "#999", padding: "24px", textAlign: "center" }}>
              No users yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardValue}>{value?.toLocaleString()}</div>
      <div style={styles.cardLabel}>{label}</div>
    </div>
  );
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#f4f4f5",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    padding: "48px 24px",
    fontFamily: "Inter, sans-serif",
  },
  loginCard: {
    background: "#fff",
    border: "1px solid #e0e0e2",
    borderRadius: "20px",
    padding: "48px 40px",
    width: "100%",
    maxWidth: 380,
    boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    marginTop: 80,
  },
  logo: { fontSize: 40 },
  title: {
    fontSize: 26,
    fontWeight: 700,
    color: "#111",
    letterSpacing: "-0.5px",
    margin: 0,
  },
  subtitle: { fontSize: 13, color: "#aaa", margin: 0 },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    width: "100%",
    marginTop: 8,
  },
  input: {
    border: "1px solid #e0e0e2",
    borderRadius: 10,
    padding: "10px 14px",
    fontSize: 14,
    outline: "none",
    fontFamily: "Inter, sans-serif",
    color: "#111",
    background: "#fafafa",
  },
  error: { fontSize: 13, color: "#cc2222", margin: 0 },
  loginBtn: {
    background: "#fc4c02",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "11px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "Inter, sans-serif",
  },
  dashboard: {
    width: "100%",
    maxWidth: 900,
    display: "flex",
    flexDirection: "column",
    gap: 24,
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  logoutBtn: {
    background: "none",
    border: "1px solid #e0e0e2",
    borderRadius: 8,
    padding: "6px 14px",
    fontSize: 13,
    color: "#777",
    cursor: "pointer",
    fontFamily: "Inter, sans-serif",
  },
  cards: { display: "flex", gap: 16 },
  card: {
    background: "#fff",
    border: "1px solid #e0e0e2",
    borderRadius: 14,
    padding: "20px 28px",
    flex: 1,
    boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
  },
  cardValue: { fontSize: 36, fontWeight: 700, color: "#fc4c02", letterSpacing: "-1px" },
  cardLabel: { fontSize: 13, color: "#888", marginTop: 4 },
  tableWrap: {
    background: "#fff",
    border: "1px solid #e0e0e2",
    borderRadius: 14,
    overflow: "hidden",
    boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
  },
  tableTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: "#111",
    padding: "16px 20px",
    borderBottom: "1px solid #f0f0f0",
    margin: 0,
  },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    fontSize: 11,
    fontWeight: 600,
    color: "#aaa",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    padding: "10px 16px",
    textAlign: "left",
    borderBottom: "1px solid #f0f0f0",
    background: "#fafafa",
  },
  tr: { borderBottom: "1px solid #f5f5f5" },
  td: { padding: "12px 16px", fontSize: 14, color: "#333", verticalAlign: "middle" },
  avatar: { width: 32, height: 32, borderRadius: "50%", display: "block" },
};
