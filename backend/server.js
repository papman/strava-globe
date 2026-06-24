require("dotenv").config();
const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3001;
const IS_PROD = process.env.NODE_ENV === "production";

// ─── Database ─────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Create tables if they don't exist
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);

    CREATE TABLE IF NOT EXISTS access_log (
      athlete_id VARCHAR PRIMARY KEY,
      name VARCHAR,
      profile VARCHAR,
      city VARCHAR,
      country VARCHAR,
      first_seen TIMESTAMP DEFAULT NOW(),
      last_seen TIMESTAMP DEFAULT NOW(),
      login_count INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS access_totals (
      id INTEGER PRIMARY KEY DEFAULT 1,
      total_logins INTEGER DEFAULT 0
    );
    INSERT INTO access_totals (id, total_logins) VALUES (1, 0) ON CONFLICT DO NOTHING;
  `);
}
initDb().catch(console.error);

// ─── Middleware ───────────────────────────────────────────────────────────────

app.set("trust proxy", 1);

app.use(
  cors({
    origin: (origin, cb) => {
      const allowed = process.env.FRONTEND_URL || "http://localhost:5173";
      if (!origin || origin === allowed) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(express.json());

app.use(
  session({
    store: new pgSession({
      pool,
      tableName: "session",
      pruneSessionInterval: 60 * 15, // prune expired sessions every 15 min
    }),
    secret: process.env.SESSION_SECRET || "strava-globe-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: IS_PROD,
      sameSite: IS_PROD ? "none" : "lax",
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

// ─── Strava OAuth ─────────────────────────────────────────────────────────────

const STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_API_BASE = "https://www.strava.com/api/v3";

// Step 1: Redirect user to Strava
app.get("/auth/strava", (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    redirect_uri: process.env.STRAVA_REDIRECT_URI || "http://localhost:3001/auth/callback",
    response_type: "code",
    approval_prompt: "auto",
    scope: "activity:read_all",
  });
  res.redirect(`${STRAVA_AUTH_URL}?${params}`);
});

// Step 2: Exchange code for tokens
app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}?error=access_denied`);
  }

  try {
    const response = await axios.post(STRAVA_TOKEN_URL, {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    });

    const { access_token, refresh_token, expires_at, athlete } = response.data;

    req.session.strava = { access_token, refresh_token, expires_at, athlete };
    recordAccess(athlete);

    req.session.save(() => {
      res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/map`);
    });
  } catch (err) {
    console.error("Token exchange error:", err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}?error=token_exchange`);
  }
});

// Step 3: Logout
app.post("/auth/logout", (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ─── Token refresh helper ─────────────────────────────────────────────────────

async function getValidToken(session) {
  const { access_token, refresh_token, expires_at } = session.strava;
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Refresh if token expires within 5 minutes
  if (expires_at - nowSeconds < 300) {
    const response = await axios.post(STRAVA_TOKEN_URL, {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token,
      grant_type: "refresh_token",
    });

    const { access_token: newToken, refresh_token: newRefresh, expires_at: newExpiry } = response.data;
    session.strava.access_token = newToken;
    session.strava.refresh_token = newRefresh;
    session.strava.expires_at = newExpiry;

    return newToken;
  }

  return access_token;
}

// ─── Auth guard middleware ────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session?.strava) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

// ─── Access log (persisted to Postgres) ──────────────────────────────────────

async function recordAccess(athlete) {
  const id = String(athlete.id);
  const name = `${athlete.firstname} ${athlete.lastname}`.trim();
  const profile = athlete.profile_medium || athlete.profile || null;
  const city = athlete.city || null;
  const country = athlete.country || null;

  await pool.query(`
    INSERT INTO access_log (athlete_id, name, profile, city, country, first_seen, last_seen, login_count)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 1)
    ON CONFLICT (athlete_id) DO UPDATE
      SET name = EXCLUDED.name,
          profile = EXCLUDED.profile,
          city = EXCLUDED.city,
          country = EXCLUDED.country,
          last_seen = NOW(),
          login_count = access_log.login_count + 1
  `, [id, name, profile, city, country]);

  await pool.query(`
    UPDATE access_totals SET total_logins = total_logins + 1 WHERE id = 1
  `);
}

// ─── Activity cache ───────────────────────────────────────────────────────────
// Keyed by athlete ID. Survives page refreshes as long as the server is running.

const activityCache = {};
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getCached(athleteId) {
  const entry = activityCache[athleteId];
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    delete activityCache[athleteId];
    return null;
  }
  return entry;
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Check auth status + athlete info
app.get("/api/me", requireAuth, (req, res) => {
  res.json({ athlete: req.session.strava.athlete });
});

// ─── Admin routes ─────────────────────────────────────────────────────────────

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

app.post("/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: "Wrong password" });
  }
});

app.post("/admin/logout", (req, res) => {
  req.session.isAdmin = false;
  res.json({ ok: true });
});

function requireAdmin(req, res, next) {
  if (!req.session?.isAdmin) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/admin/stats", requireAdmin, async (req, res) => {
  const [totalsResult, athletesResult] = await Promise.all([
    pool.query("SELECT total_logins FROM access_totals WHERE id = 1"),
    pool.query("SELECT athlete_id as id, name, profile, city, country, first_seen as \"firstSeen\", last_seen as \"lastSeen\", login_count as \"loginCount\" FROM access_log ORDER BY last_seen DESC"),
  ]);
  res.json({
    totalLogins: totalsResult.rows[0]?.total_logins || 0,
    uniqueUsers: athletesResult.rows.length,
    athletes: athletesResult.rows,
  });
});

// Force-clear cache for the current athlete
app.post("/api/activities/refresh", requireAuth, (req, res) => {
  const athleteId = req.session.strava.athlete.id;
  delete activityCache[athleteId];
  res.json({ ok: true });
});

// Fetch ALL activities (paginated), returning only those with GPS polylines
app.get("/api/activities", requireAuth, async (req, res) => {
  const athleteId = req.session.strava.athlete.id;

  // ── Serve from cache if available ──────────────────────────────────────────
  const cached = getCached(athleteId);
  if (cached) {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.write(JSON.stringify({
      page: 1,
      fetched: cached.activities.length,
      gps: cached.activities,
      fromCache: true,
      cachedAt: cached.fetchedAt,
    }) + "\n");
    res.write(JSON.stringify({ done: true }) + "\n");
    res.end();
    return;
  }

  // ── Fresh fetch from Strava ────────────────────────────────────────────────
  try {
    const token = await getValidToken(req.session);
    const allGpsActivities = [];
    let page = 1;
    const perPage = 200;

    // Stream progress back as newline-delimited JSON (NDJSON) so the
    // frontend can show a live progress indicator while we page through
    // potentially thousands of activities.
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache");

    while (true) {
      let response;
      try {
        response = await axios.get(`${STRAVA_API_BASE}/athlete/activities`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { per_page: perPage, page },
        });
      } catch (err) {
        const status = err.response?.status;
        if (status === 429) {
          // Rate limited — figure out how long to wait
          // Strava returns a 15-min window; wait it out and retry
          const retryAfter = parseInt(err.response.headers["x-ratelimit-reset"] || "0", 10);
          const waitMs = retryAfter
            ? Math.max(0, retryAfter * 1000 - Date.now()) + 2000
            : 15 * 60 * 1000; // fallback: 15 min

          const waitSecs = Math.ceil(waitMs / 1000);
          console.log(`Rate limited by Strava. Waiting ${waitSecs}s...`);
          res.write(JSON.stringify({ waiting: true, waitSecs }) + "\n");

          await new Promise((r) => setTimeout(r, waitMs));
          continue; // retry same page
        }
        throw err; // re-throw non-rate-limit errors
      }

      const activities = response.data;

      if (!activities || activities.length === 0) break;

      // Check rate limit headers proactively — slow down if getting close
      const used = parseInt(response.headers["x-ratelimit-usage"]?.split(",")?.[0] || "0", 10);
      const limit = parseInt(response.headers["x-ratelimit-limit"]?.split(",")?.[0] || "100", 10);
      const remaining = limit - used;

      // Filter to activities that have a GPS polyline
      const gpsActivities = activities
        .filter((a) => a.map?.summary_polyline && a.map.summary_polyline.length > 0)
        .map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          sport_type: a.sport_type,
          start_date: a.start_date,
          distance: a.distance,
          moving_time: a.moving_time,
          total_elevation_gain: a.total_elevation_gain,
          polyline: a.map.summary_polyline,
        }));

      // Accumulate for cache
      allGpsActivities.push(...gpsActivities);

      // Send this page's results immediately
      res.write(JSON.stringify({ page, fetched: activities.length, gps: gpsActivities }) + "\n");

      // If we got fewer than perPage, we're on the last page
      if (activities.length < perPage) break;

      page++;

      // Adaptive delay: slow down as we approach the rate limit
      let delay = 300;
      if (remaining <= 10) delay = 5000;
      else if (remaining <= 20) delay = 2000;
      else if (remaining <= 40) delay = 800;

      await new Promise((r) => setTimeout(r, delay));
    }

    // Save to cache
    activityCache[athleteId] = { activities: allGpsActivities, fetchedAt: Date.now() };

    res.write(JSON.stringify({ done: true }) + "\n");
    res.end();
  } catch (err) {
    console.error("Activities fetch error:", err.response?.data || err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to fetch activities" });
    } else {
      res.write(JSON.stringify({ error: err.message }) + "\n");
      res.end();
    }
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Strava Globe backend running at http://localhost:${PORT}`);
});
