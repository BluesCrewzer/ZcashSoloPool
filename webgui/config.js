(function loadDashboardConfig() {
  const defaults = {
    apiBase: "",
    apiKey: "",
    refreshMs: 30000,
  };

  const existing = (typeof window.DASHBOARD_CONFIG === "object" && window.DASHBOARD_CONFIG)
    ? window.DASHBOARD_CONFIG
    : {};
  const merged = { ...defaults, ...existing };

  window.DASHBOARD_CONFIG = merged;
  window.DASHBOARD_CONFIG_READY = (async () => {
    try {
      const res = await fetch(`config.json?v=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return merged;
      const fromJson = await res.json();
      if (fromJson && typeof fromJson === "object") {
        Object.assign(merged, fromJson);
      }
    } catch (_) {
      // Keep defaults when config.json is missing or invalid.
    }
    return merged;
  })();
})();
