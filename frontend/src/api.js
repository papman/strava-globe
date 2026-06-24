// Use relative URLs in production (proxied through Vercel to Railway),
// and localhost in development.
const IS_LOCAL = window.location.hostname === "localhost" ||
                 window.location.hostname === "127.0.0.1";

const API = IS_LOCAL ? "http://localhost:3001" : "";

export default API;
