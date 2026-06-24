require("dotenv").config();
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;
const IS_PROD = process.env.NODE_ENV === "production";

// ─── Middleware ───────────────────────────────────────────────────────────────

// Trust Railway/Render proxy so req.secure works correctly
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
    store: new FileStore({
      path: path.join(__dirname, "sessions"),
      retries: 1,
      ttl: 86400, // 24 hours in seconds
    }),
    secret: process.env.SESSION_SECRET || "strava-globe-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: IS_PROD,        // HTTPS only in production
      sameSite: IS_PROD ? "none" : "lax", // "none" needed for cross-origin in prod
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

// ─── Access log (persisted to disk) ──────────────────────────────────────────

const ACCESS_LOG_FILE = path.join(__dirname, "access-log.json");

function loadAccessLog() {
  try {
    if (fs.existsSync(ACCESS_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(ACCESS_LOG_FILE, "utf8"));
    }
  } catch {}
  return { totalLogins: 0, athletes: {} };
}

function saveAccessLog(log) {
  try { fs.writeFileSync(ACCESS_LOG_FILE, JSON.stringify(log, null, 2)); } catch {}
}

const accessLog = loadAccessLog();

function recordAccess(athlete) {
  const id = String(athlete.id);
  accessLog.totalLogins++;
  if (!accessLog.athletes[id]) {
    accessLog.athletes[id] = {
      id,
      name: `${athlete.firstname} ${athlete.lastname}`.trim(),
      profile: athlete.profile_medium || athlete.profile || null,
      city: athlete.city || null,
      country: athlete.country || null,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      loginCount: 0,
    };
  }
  accessLog.athletes[id].lastSeen = new Date().toISOString();
  accessLog.athletes[id].loginCount++;
  saveAccessLog(accessLog);
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

app.get("/admin/stats", requireAdmin, (req, res) => {
  const athletes = Object.values(accessLog.athletes).sort(
    (a, b) => new Date(b.lastSeen) - new Date(a.lastSeen)
  );
  res.json({
    totalLogins: accessLog.totalLogins,
    uniqueUsers: athletes.length,
    athletes,
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
