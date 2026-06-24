import { Routes, Route, Navigate } from "react-router-dom";
import { useState, useEffect } from "react";
import Landing from "./components/Landing.jsx";
import MapView from "./components/MapView.jsx";
import Admin from "./components/Admin.jsx";

import API from "./api.js";
const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";

const MOCK_ATHLETE = {
  firstname: "Luke",
  lastname: "(mock)",
  profile_medium: "https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&s=60",
};

export default function App() {
  const [athlete, setAthlete] = useState(USE_MOCK ? MOCK_ATHLETE : null);
  const [authChecked, setAuthChecked] = useState(USE_MOCK);

  useEffect(() => {
    if (USE_MOCK) return;
    fetch(`${API}/api/me`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.athlete) setAthlete(data.athlete);
      })
      .catch(() => {})
      .finally(() => setAuthChecked(true));
  }, []);

  const handleLogout = async () => {
    await fetch(`${API}/auth/logout`, { method: "POST", credentials: "include" });
    setAthlete(null);
  };

  if (!authChecked) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        <Spinner />
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/"
        element={
          athlete ? (
            <Navigate to="/map" replace />
          ) : (
            <Landing />
          )
        }
      />
      <Route
        path="/map"
        element={
          athlete ? (
            <MapView athlete={athlete} onLogout={handleLogout} />
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route path="/admin" element={<Admin />} />
    </Routes>
  );
}

function Spinner() {
  return (
    <div style={{
      width: 32, height: 32, borderRadius: "50%",
      border: "3px solid #2e2e2e",
      borderTopColor: "#fc4c02",
      animation: "spin 0.8s linear infinite",
    }} />
  );
}
