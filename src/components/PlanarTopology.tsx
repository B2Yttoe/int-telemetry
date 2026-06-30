import { useMemo } from "react";
import { GitBranch, RadioTower } from "lucide-react";
import { walkerNetworkConfig } from "../config/walkerNetworkConfig";
import type { NetworkSlice, SatelliteLink, SatelliteNode } from "../simulation/types";

type Selection =
  | { type: "node"; id: string }
  | { type: "link"; id: string };

interface PlanarTopologyProps {
  slices: NetworkSlice[];
  slice: NetworkSlice;
  snapshotMode: boolean;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onTimeSelect: (index: number) => void;
  onResumeMotion: () => void;
}

type Point = {
  x: number;
  y: number;
};

const VIEWBOX_WIDTH = 960;
const VIEWBOX_HEIGHT = 460;
const GRID_LEFT = 70;
const GRID_RIGHT = 44;
const GRID_TOP = 68;
const GRID_BOTTOM = 48;

const nodeStatusLabel = {
  nominal: "正常",
  warning: "告警",
  degraded: "降级",
};

function linkPath(link: SatelliteLink, source: SatelliteNode, target: SatelliteNode, points: Map<string, Point>) {
  const start = points.get(link.source);
  const end = points.get(link.target);
  if (!start || !end) return "";

  const wrapInPlane =
    link.kind === "intra-plane" &&
    Math.abs(source.slot - target.slot) > 1;

  if (wrapInPlane) {
    const direction = source.plane % 2 === 0 ? -1 : 1;
    const controlX = start.x + direction * 28;
    return `M ${start.x} ${start.y} C ${controlX} ${start.y}, ${controlX} ${end.y}, ${end.x} ${end.y}`;
  }

  return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
}

function activeLinkCount(slice: NetworkSlice, kind?: SatelliteLink["kind"]) {
  return slice.links.filter((link) => link.state.isActive && (!kind || link.kind === kind)).length;
}

export default function PlanarTopology({
  slices,
  slice,
  snapshotMode,
  selection,
  onSelect,
  onTimeSelect,
  onResumeMotion,
}: PlanarTopologyProps) {
  const planeCount = walkerNetworkConfig.constellation.planes;
  const slotCount = walkerNetworkConfig.constellation.satellitesPerPlane;
  const gridWidth = VIEWBOX_WIDTH - GRID_LEFT - GRID_RIGHT;
  const gridHeight = VIEWBOX_HEIGHT - GRID_TOP - GRID_BOTTOM;

  const { pointByNodeId, nodeById } = useMemo(() => {
    const points = new Map<string, Point>();
    const nodes = new Map<string, SatelliteNode>();

    slice.nodes.forEach((node) => {
      const x = planeCount === 1 ? GRID_LEFT + gridWidth / 2 : GRID_LEFT + (node.plane / (planeCount - 1)) * gridWidth;
      const y = slotCount === 1 ? GRID_TOP + gridHeight / 2 : GRID_TOP + (node.slot / (slotCount - 1)) * gridHeight;
      points.set(node.id, { x, y });
      nodes.set(node.id, node);
    });

    return { pointByNodeId: points, nodeById: nodes };
  }, [gridHeight, gridWidth, planeCount, slice.nodes, slotCount]);

  const activeLinks = slice.links.filter((link) => link.state.isActive);
  const polarDownLinks = slice.links.filter((link) => link.state.restrictionReason === "polar-region").length;

  return (
    <section className="planar-panel" aria-label="二维时间片卫星拓扑">
      <div className="planar-header">
        <div className="section-heading">
          <GitBranch size={18} />
          <h2>二维时间片拓扑</h2>
        </div>
        <div className="topology-metrics">
          <span>活动链路 {activeLinks.length}/{slice.links.length}</span>
          <span>轨间 {activeLinkCount(slice, "inter-plane")}</span>
          <span>极区断开 {polarDownLinks}</span>
        </div>
      </div>

      <div className="topology-timebar" aria-label="二维拓扑时间点">
        <button type="button" className={!snapshotMode ? "active" : ""} onClick={onResumeMotion}>
          运动
        </button>
        {slices.map((item) => (
          <button
            type="button"
            key={item.index}
            className={slice.index === item.index && snapshotMode ? "active" : ""}
            onClick={() => onTimeSelect(item.index)}
          >
            T{item.index.toString().padStart(2, "0")}
          </button>
        ))}
      </div>

      <div className="topology-canvas-wrap">
        <svg className="topology-svg" viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`} role="img">
          <title>按轨道面和槽位展开的二维卫星网络拓扑</title>

          {Array.from({ length: slotCount }, (_, slot) => {
            const y = slotCount === 1 ? GRID_TOP + gridHeight / 2 : GRID_TOP + (slot / (slotCount - 1)) * gridHeight;
            return (
              <g key={`slot-${slot}`}>
                <line className="topology-slot-line" x1={GRID_LEFT - 20} y1={y} x2={VIEWBOX_WIDTH - GRID_RIGHT + 10} y2={y} />
                <text className="topology-slot-label" x={28} y={y + 4}>
                  S{slot + 1}
                </text>
              </g>
            );
          })}

          {Array.from({ length: planeCount }, (_, plane) => {
            const x = planeCount === 1 ? GRID_LEFT + gridWidth / 2 : GRID_LEFT + (plane / (planeCount - 1)) * gridWidth;
            const raan = ((plane * 180) / planeCount).toFixed(1);
            return (
              <g key={`plane-${plane}`}>
                <line className="topology-plane-line" x1={x} y1={GRID_TOP - 20} x2={x} y2={VIEWBOX_HEIGHT - GRID_BOTTOM + 18} />
                <text className="topology-plane-label" x={x} y={30}>
                  P{plane + 1}
                </text>
                <text className="topology-raan-label" x={x} y={50}>
                  {raan}°
                </text>
              </g>
            );
          })}

          <g className="topology-links">
            {activeLinks.map((link) => {
              const source = nodeById.get(link.source);
              const target = nodeById.get(link.target);
              if (!source || !target) return null;
              const d = linkPath(link, source, target, pointByNodeId);
              const selected = selection.type === "link" && selection.id === link.id;
              return (
                <g key={link.id} className={`topology-link ${link.kind} ${link.state.status} ${selected ? "selected" : ""}`}>
                  <path d={d} />
                  <path
                    className="topology-link-hit"
                    d={d}
                    onClick={() => onSelect({ type: "link", id: link.id })}
                  />
                </g>
              );
            })}
          </g>

          <g className="topology-nodes">
            {slice.nodes.map((node) => {
              const point = pointByNodeId.get(node.id);
              if (!point) return null;
              const selected = selection.type === "node" && selection.id === node.id;
              const inPolarRegion = Math.abs(node.timeState.latitudeDeg) >= walkerNetworkConfig.polarRegion.latitudeDeg;
              return (
                <g
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  className={`topology-node ${node.state.mode} ${selected ? "selected" : ""} ${inPolarRegion ? "polar" : ""}`}
                  transform={`translate(${point.x} ${point.y})`}
                  onClick={() => onSelect({ type: "node", id: node.id })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect({ type: "node", id: node.id });
                    }
                  }}
                >
                  <circle r={10} />
                  <text y={4}>{node.slot + 1}</text>
                  <title>
                    {node.id} / {nodeStatusLabel[node.state.mode]} / 纬度 {node.timeState.latitudeDeg.toFixed(2)}° / 经度 {node.timeState.longitudeDeg.toFixed(2)}°
                  </title>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      <div className="topology-legend" aria-label="二维拓扑图例">
        <span><i className="legend-node nominal" />正常节点</span>
        <span><i className="legend-node warning" />告警节点</span>
        <span><i className="legend-node degraded" />降级节点</span>
        <span><i className="legend-link intra" />轨内链路</span>
        <span><i className="legend-link inter" />轨间链路</span>
        <span><RadioTower size={14} />仅绘制当前已连接链路</span>
      </div>
    </section>
  );
}
