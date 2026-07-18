/* ════════════════════════════════════════════════════════════════════════
   Shared SSRF guard for store/ERP connectors that fetch a caller-supplied host.
   Blocks localhost, link-local (cloud metadata 169.254.169.254), and every
   private/internal IP range so a connector can't be turned into a proxy to
   read internal services or cloud credentials. https-only.
   Files prefixed with "_" are bundled as dependencies, not treated as
   deployable functions.
   ════════════════════════════════════════════════════════════════════════ */
const isPrivateHost = (host) => {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true; // IPv6 loopback/ULA/link-local
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) { const o = m.slice(1).map(Number); if (o[0] === 10 || o[0] === 127 || o[0] === 0 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 169 && o[1] === 254) || (o[0] === 100 && o[1] >= 64 && o[1] <= 127)) return true; }
  return false;
};
/* Returns a normalized https URL string, or null if the input is unsafe/malformed.
   Use this on any caller-supplied base URL before fetching it. */
const safeExternalUrl = (u) => {
  let x; try { x = new URL(String(u || "").trim()); } catch { return null; }
  if (x.protocol !== "https:") return null;
  if (isPrivateHost(x.hostname)) return null;
  return x;
};
module.exports = { isPrivateHost, safeExternalUrl };
