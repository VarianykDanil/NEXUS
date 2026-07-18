import { describe, expect, it } from "vitest";
import { dataSourceLabel, formatHeartbeat } from "./dataSource";

describe("data-source presentation", () => {
  it("labels a connected stream as simulation data", () => {
    expect(dataSourceLabel("live")).toBe("LIVE SIMULATION DATA");
  });

  it("formats ISO heartbeats without discarding the source timestamp", () => {
    const now = Date.parse("2026-07-18T12:00:00Z");
    expect(formatHeartbeat("2026-07-18T11:59:42Z", now)).toBe("18 sec ago");
    expect(formatHeartbeat("2026-07-18T10:00:00Z", now)).toBe("2 h ago");
    expect(formatHeartbeat("2 sec ago", now)).toBe("2 sec ago");
  });
});
