/**
 * useActivities
 *
 * Streams GPS activities from the backend via NDJSON.
 * Yields progressive updates so the map populates as data arrives.
 *
 * Set VITE_USE_MOCK=true in frontend/.env to use dummy data (no Strava needed).
 */
import { useState, useEffect, useRef } from "react";
import { mockActivities } from "../mock/activities.js";

import API from "../api.js";
const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";

export function useActivities() {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState({ pages: 0, total: 0 });
  const [error, setError] = useState(null);
  const [rateLimitWait, setRateLimitWait] = useState(null);
  const [cachedAt, setCachedAt] = useState(null); // timestamp if served from cache
  const abortRef = useRef(null);

  useEffect(() => {
    if (USE_MOCK) {
      setActivities(mockActivities);
      setProgress({ pages: 1, total: mockActivities.length });
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    async function fetchAll() {
      setLoading(true);
      setError(null);
      setActivities([]);

      try {
        const response = await fetch(`${API}/api/activities`, {
          credentials: "include",
          signal: controller.signal,
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop(); // keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const chunk = JSON.parse(line);
              if (chunk.done) break;
              if (chunk.error) {
                if (chunk.error === "reauth_required") {
                  setError("reauth_required");
                } else {
                  setError(chunk.error);
                }
                break;
              }
              if (chunk.waiting) {
                setRateLimitWait(chunk.waitSecs);
                // Count down the wait visually
                const start = Date.now();
                const interval = setInterval(() => {
                  const elapsed = Math.floor((Date.now() - start) / 1000);
                  const remaining = chunk.waitSecs - elapsed;
                  if (remaining <= 0) {
                    setRateLimitWait(null);
                    clearInterval(interval);
                  } else {
                    setRateLimitWait(remaining);
                  }
                }, 1000);
              }
              if (chunk.gps) {
                setRateLimitWait(null);
                setActivities((prev) => [...prev, ...chunk.gps]);
                setProgress((prev) => ({
                  pages: prev.pages + 1,
                  total: prev.total + chunk.fetched,
                }));
                if (chunk.fromCache && chunk.cachedAt) {
                  setCachedAt(chunk.cachedAt);
                }
              }
            } catch {
              // skip malformed line
            }
          }
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          setError(err.message);
        }
      } finally {
        setLoading(false);
      }
    }

    fetchAll();

    return () => controller.abort();
  }, []);

  const refresh = async () => {
    await fetch(`${API}/api/activities/refresh`, { method: "POST", credentials: "include" });
    setActivities([]);
    setCachedAt(null);
    setLoading(true);
    setProgress({ pages: 0, total: 0 });
    // Re-trigger the effect by incrementing a counter would be cleanest,
    // but for simplicity just reload the page
    window.location.reload();
  };

  return { activities, loading, progress, error, rateLimitWait, cachedAt, refresh };
}
