export type DataSourceState = "connecting" | "live" | "snapshot" | "demo";

export function dataSourceLabel(source: DataSourceState): string {
  if (source === "live") return "LIVE SIMULATION DATA";
  if (source === "snapshot") return "API SNAPSHOT";
  if (source === "connecting") return "CONNECTING";
  return "DEMO DATA";
}

export function formatHeartbeat(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (elapsedSeconds < 5) return "just now";
  if (elapsedSeconds < 60) return `${elapsedSeconds} sec ago`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes} min ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} h ago`;
  return `${Math.floor(elapsedHours / 24)} d ago`;
}

export function dataSourceDetail(source: DataSourceState): string {
  if (source === "live") return "REST snapshot with an active WebSocket stream";
  if (source === "snapshot") return "API snapshot available; realtime stream is unavailable or reconnecting";
  if (source === "connecting") return "Waiting for API and realtime stream confirmation";
  return "Local seeded data; no control-plane connection is confirmed";
}

export function spatialStreamStatus(source: DataSourceState): "connecting" | "live" | "demo" {
  return source === "snapshot" ? "connecting" : source;
}
