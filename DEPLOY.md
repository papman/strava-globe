# Deployment Guide

## Overview
- **Backend** → Railway (Node/Express)
- **Frontend** → Vercel (React/Vite)

---

## Step 1 — Push to GitHub

Create a GitHub repo and push the project:

```bash
cd ~/Claude/Projects/Strava\ Globe
git init
git add .
git commit -m "Initial commit"
# Create a new repo at github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/strava-globe.git
git push -u origin main
```

---

## Step 2 — Deploy the backend to Railway

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select your `strava-globe` repo
4. Click **Add Service** and point it to the `backend/` folder (set **Root Directory** to `backend`)
5. Railway will auto-detect Node and run `npm start`

### Set environment variables in Railway:

Go to your service → **Variables** tab and add:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `STRAVA_CLIENT_ID` | `259535` |
| `STRAVA_CLIENT_SECRET` | your secret |
| `STRAVA_REDIRECT_URI` | `https://YOUR-BACKEND.up.railway.app/auth/callback` |
| `FRONTEND_URL` | `https://YOUR-APP.vercel.app` (fill in after Step 3) |
| `SESSION_SECRET` | a long random string (run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `ADMIN_PASSWORD` | `Hallam123!` |

> Copy your Railway backend URL (e.g. `https://strava-globe-backend.up.railway.app`) — you'll need it for Step 3.

---

## Step 3 — Deploy the frontend to Vercel

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click **Add New Project → Import** your `strava-globe` repo
3. Set **Root Directory** to `frontend`
4. Vercel will auto-detect Vite

### Set environment variables in Vercel:

| Key | Value |
|-----|-------|
| `VITE_API_URL` | `https://YOUR-BACKEND.up.railway.app` |
| `VITE_GOOGLE_MAPS_API_KEY` | your Google Maps API key |
| `VITE_USE_MOCK` | `false` |

5. Click **Deploy**. Copy your Vercel URL (e.g. `https://strava-globe.vercel.app`)

---

## Step 4 — Update Strava app settings

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api)
2. Update **Authorization Callback Domain** to your Railway backend domain (e.g. `strava-globe-backend.up.railway.app`)

---

## Step 5 — Update Railway with the Vercel URL

Go back to Railway → Variables and update `FRONTEND_URL` to your Vercel URL. Railway will auto-redeploy.

---

## Step 6 — Restrict your Google Maps API key

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. APIs & Services → Credentials → click your API key
3. Under **Application restrictions**, select **HTTP referrers**
4. Add `https://YOUR-APP.vercel.app/*`
5. Save

---

## Done!

Your app is now live. Share `https://YOUR-APP.vercel.app` with users.

The admin dashboard is at `https://YOUR-APP.vercel.app/admin`.
