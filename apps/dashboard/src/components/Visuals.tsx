import { useId, useState } from "react";
import { AlertTriangle, BatteryMedium, Crosshair, Radio, Thermometer } from "lucide-react";
import type { Hazard, HealthStatus, MapState, RobotState, TelemetryMetric } from "../types";

export function statusClass(status: string): string {
  return `status-${status.toLowerCase().replace(/\s+/g, "-")}`;
}

export function StatusDot({ status, label }: { status: HealthStatus | string; label?: string }) {
  return (
    <span className={`status-dot-wrap ${statusClass(status)}`}>
      <span className="status-dot" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function ProgressRing({ value, label }: { value: number; label: string }) {
  const radius = 42;
  const circumference = Math.PI * 2 * radius;
  const offset = circumference - (Math.min(100, Math.max(0, value)) / 100) * circumference;
  return (
    <div className="progress-ring" aria-label={`${label}: ${value}%`} role="img">
      <svg viewBox="0 0 104 104" aria-hidden="true">
        <circle className="progress-ring-track" cx="52" cy="52" r={radius} />
        <circle
          className="progress-ring-value"
          cx="52"
          cy="52"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <span className="progress-ring-number">{value}<small>%</small></span>
    </div>
  );
}

function sparklinePath(values: number[], width = 150, height = 44): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - 5 - ((value - min) / range) * (height - 10);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function Sparkline({ metric }: { metric: TelemetryMetric }) {
  const gradientId = useId().replace(/:/g, "");
  const line = sparklinePath(metric.trend);
  const area = line ? `${line} L150,44 L0,44 Z` : "";
  return (
    <svg className="sparkline" viewBox="0 0 150 44" role="img" aria-label={`${metric.label} recent trend`}>
      <title>{metric.label} recent trend</title>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="sparkline-area" d={area} fill={`url(#${gradientId})`} />
      <path className="sparkline-line" d={line} />
      {metric.trend.length > 0 && <circle cx="150" cy={Number(line.match(/([\d.]+)$/)?.[1] ?? 22)} r="2.5" />}
    </svg>
  );
}

const metricIcons = {
  battery: BatteryMedium,
  lidar: Crosshair,
  latency: Radio,
  temperature: Thermometer,
};

export function TelemetryCard({ metric }: { metric: TelemetryMetric }) {
  const Icon = metricIcons[metric.id as keyof typeof metricIcons] ?? Radio;
  return (
    <article className="telemetry-card">
      <div className="telemetry-card-head">
        <span className="icon-box"><Icon size={16} aria-hidden="true" /></span>
        <span className="eyebrow">{metric.label}</span>
        <StatusDot status={metric.status} />
      </div>
      <div className="telemetry-value-row">
        <strong>{metric.value}<small>{metric.unit}</small></strong>
        <Sparkline metric={metric} />
      </div>
      <p>{metric.detail}</p>
    </article>
  );
}

function HazardMarker({ hazard, selected, onSelect }: { hazard: Hazard; selected: boolean; onSelect: () => void }) {
  return (
    <g
      className={`hazard-marker severity-${hazard.severity}${selected ? " is-selected" : ""}`}
      transform={`translate(${hazard.x} ${hazard.y})`}
      role="button"
      aria-label={`${hazard.type}, ${hazard.severity} severity, ${hazard.confidence}% confidence`}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect();
      }}
    >
      <circle r="15" />
      <path d="M0 -8 L8 7 L-8 7 Z" />
      <line x1="0" y1="-3" x2="0" y2="2" />
      <circle className="hazard-dot" cy="5" r="1" />
    </g>
  );
}

export function FloorMap({ map, robot, compact = false }: { map: MapState; robot: RobotState; compact?: boolean }) {
  const [selectedId, setSelectedId] = useState(map.hazards.at(-1)?.id ?? "");
  const selected = map.hazards.find((hazard) => hazard.id === selectedId);
  return (
    <div className={`floor-map ${compact ? "is-compact" : ""}`}>
      <svg viewBox="0 0 780 420" role="img" aria-labelledby="floor-map-title floor-map-desc">
        <title id="floor-map-title">{map.floor} occupancy map</title>
        <desc id="floor-map-desc">Mapped rooms, robot path, current robot pose, and detected hazards.</desc>
        <defs>
          <pattern id="map-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" className="map-grid-line" />
          </pattern>
          <filter id="robot-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <rect width="780" height="420" className="map-background" />
        <rect width="780" height="420" fill="url(#map-grid)" />

        <g className="room-layer">
          {map.rooms.map((room) => (
            <g key={room.id}>
              <rect
                x={room.x}
                y={room.y}
                width={room.width}
                height={room.height}
                className={room.explored < 50 ? "room unexplored" : "room"}
              />
              <text x={room.x + 12} y={room.y + 22} className="room-label">{room.label}</text>
              <text x={room.x + 12} y={room.y + 40} className="room-coverage">{room.explored}% mapped</text>
            </g>
          ))}
        </g>

        <polyline points={map.path.map((point) => `${point.x},${point.y}`).join(" ")} className="robot-path-shadow" />
        <polyline points={map.path.map((point) => `${point.x},${point.y}`).join(" ")} className="robot-path" />
        {map.path.slice(0, -1).map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="2" className="path-point" />)}

        {map.hazards.map((hazard) => (
          <HazardMarker
            key={hazard.id}
            hazard={hazard}
            selected={hazard.id === selectedId}
            onSelect={() => setSelectedId(hazard.id)}
          />
        ))}

        <g className="robot-marker" transform={`translate(${map.path.at(-1)?.x ?? 390} ${map.path.at(-1)?.y ?? 210}) rotate(${robot.pose.yaw})`}>
          <circle className="robot-pulse" r="22" />
          <circle className="robot-core" r="10" filter="url(#robot-glow)" />
          <path d="M0 -16 L5 -7 L-5 -7 Z" />
        </g>

        <g className="map-scale" transform="translate(48 394)">
          <line x1="0" x2="80" />
          <line x1="0" y1="-4" y2="4" />
          <line x1="80" y1="-4" y2="4" />
          <text x="34" y="-7">5 m</text>
        </g>
      </svg>

      <div className="map-overlay map-coordinates">
        <span>X {robot.pose.x.toFixed(1)} m</span>
        <span>Y {robot.pose.y.toFixed(1)} m</span>
        <span>{robot.pose.yaw} deg</span>
      </div>
      <div className="map-legend" aria-label="Map legend">
        <span><i className="legend-line" /> Robot path</span>
        <span><i className="legend-hazard" /> Hazard</span>
        <span><i className="legend-frontier" /> Frontier</span>
      </div>
      {selected && (
        <div className="hazard-detail" role="status">
          <span className={`hazard-icon severity-${selected.severity}`}><AlertTriangle size={16} aria-hidden="true" /></span>
          <span><strong>{selected.id} / {selected.type}</strong><small>{selected.detectedAt} / {selected.confidence}% confidence</small></span>
        </div>
      )}
    </div>
  );
}
