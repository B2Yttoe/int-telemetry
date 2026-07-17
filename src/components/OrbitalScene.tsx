import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  calculatePosition,
  circularOrbitVelocityKmS,
  orbitalPeriodMinutes,
  planeRaanDeg,
  planeSpacingDeg,
} from "../simulation/walker";
import type { NetworkSlice, OrbitModel, SatelliteLink, SatelliteNode, WalkerNetworkConfig } from "../simulation/types";

type Selection =
  | { type: "node"; id: string }
  | { type: "link"; id: string };

interface OrbitalSceneProps {
  slice: NetworkSlice;
  config: WalkerNetworkConfig;
  selection: Selection;
  snapshotMode: boolean;
  showOrbitPlanes: boolean;
  showNodes: boolean;
  showLinks: boolean;
  onSelect: (selection: Selection) => void;
}

type NodeVisual = {
  node: SatelliteNode;
  mesh: THREE.Mesh;
  halo: THREE.Mesh;
  label: THREE.Sprite;
};

type LinkVisual = {
  link: SatelliteLink;
  line: THREE.Line;
};

type DynamicNodeState = {
  scenePosition: THREE.Vector3;
  latitudeDeg: number;
  eci: {
    x: number;
    y: number;
    z: number;
  };
};

const EARTH_RADIUS_UNITS = 2.55;
const ORBIT_VISUAL_EXPANSION = 1.12;
const SIM_MINUTES_PER_SECOND = 1.8;
const EARTH_ROTATION_PERIOD_MINUTES = 1440;
const PLANE_COLORS = ["#72c6ff", "#f6b44b", "#8bd17c", "#d782ff", "#ff7c7c", "#65d8c8", "#c8d66a", "#9ea7ff"];

const modeColor = {
  nominal: "#dff7ff",
  warning: "#ffd38a",
  degraded: "#ff7770",
};

const statusColor = {
  up: "#78d6ff",
  warning: "#ffbf55",
  down: "#ff625b",
};

const restrictionColor = {
  "distance-threshold": "#ff625b",
  "polar-region": "#ffbf55",
  "earth-occluded": "#9ea7ff",
  "antenna-range": "#f97316",
  "pointing-switch": "#a855f7",
  "doppler-shift": "#22d3ee",
  "solar-interference": "#fde047",
  "link-budget": "#f43f5e",
  "capacity-limit": "#fb7185",
  "experiment8-controlled-dynamicity": "#ef4444",
};

function scalePosition(position: { x: number; y: number; z: number }, config: WalkerNetworkConfig) {
  const scale = EARTH_RADIUS_UNITS / config.constellation.earthRadiusKm;
  return new THREE.Vector3(position.x * scale, position.z * scale, position.y * scale).multiplyScalar(
    ORBIT_VISUAL_EXPANSION,
  );
}

function distanceKm(a: DynamicNodeState, b: DynamicNodeState) {
  const dx = a.eci.x - b.eci.x;
  const dy = a.eci.y - b.eci.y;
  const dz = a.eci.z - b.eci.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function segmentMinimumRadiusKm(a: DynamicNodeState, b: DynamicNodeState) {
  const abx = b.eci.x - a.eci.x;
  const aby = b.eci.y - a.eci.y;
  const abz = b.eci.z - a.eci.z;
  const ab2 = abx * abx + aby * aby + abz * abz;
  const t =
    ab2 === 0
      ? 0
      : Math.max(0, Math.min(1, -(a.eci.x * abx + a.eci.y * aby + a.eci.z * abz) / ab2));
  const px = a.eci.x + abx * t;
  const py = a.eci.y + aby * t;
  const pz = a.eci.z + abz * t;
  return Math.sqrt(px * px + py * py + pz * pz);
}

function dynamicInterPlaneLinkActive(source: DynamicNodeState, target: DynamicNodeState, config: WalkerNetworkConfig) {
  if (
    config.polarRegion.enabled &&
    (Math.abs(source.latitudeDeg) >= config.polarRegion.latitudeDeg ||
      Math.abs(target.latitudeDeg) >= config.polarRegion.latitudeDeg)
  ) {
    return false;
  }

  if (distanceKm(source, target) > config.interPlane.maxDistanceKm) {
    return false;
  }

  if (config.earthOcclusion.enabled) {
    return (
      segmentMinimumRadiusKm(source, target) >
      config.constellation.earthRadiusKm + config.earthOcclusion.clearanceKm
    );
  }

  return true;
}

function createEarthTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext("2d")!;
  const ocean = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  ocean.addColorStop(0, "#174d7a");
  ocean.addColorStop(0.5, "#256d91");
  ocean.addColorStop(1, "#0d355e");
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "#4c9a68";
  const continents = [
    [160, 150, 120, 70],
    [300, 245, 95, 120],
    [500, 165, 155, 75],
    [650, 280, 130, 105],
    [780, 140, 90, 70],
    [860, 320, 110, 60],
  ];
  continents.forEach(([x, y, w, h], index) => {
    ctx.beginPath();
    for (let i = 0; i < 18; i += 1) {
      const angle = (Math.PI * 2 * i) / 18;
      const wobble = 0.72 + 0.22 * Math.sin(i * 1.7 + index);
      const px = x + Math.cos(angle) * w * wobble;
      const py = y + Math.sin(angle) * h * wobble;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  });

  ctx.globalAlpha = 0.2;
  ctx.strokeStyle = "#d8f5ff";
  ctx.lineWidth = 1;
  for (let x = 0; x <= canvas.width; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y <= canvas.height; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function createTextSprite(text: string, color = "#dff7ff") {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "700 30px Inter, Microsoft YaHei, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 7;
  ctx.strokeStyle = "rgba(8, 17, 24, 0.82)";
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    }),
  );
  sprite.scale.set(0.72, 0.27, 1);
  return sprite;
}

function clearGroup(group: THREE.Group) {
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else if (material) material.dispose();
  });
  group.clear();
}

const orbitModelLabel: Record<OrbitModel, string> = {
  "analytic-walker": "解析 Walker",
  "tle-sgp4": "TLE + SGP4",
  "real-tle-sgp4": "真实 TLE + SGP4",
};

function createOrbitLine(plane: number, orbitModel: OrbitModel, config: WalkerNetworkConfig) {
  const points: THREE.Vector3[] = [];
  const period = orbitalPeriodMinutes(config);
  for (let i = 0; i <= 192; i += 1) {
    const minute = (period * i) / 192;
    points.push(scalePosition(calculatePosition(plane, 0, minute, config, orbitModel), config));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const color = PLANE_COLORS[plane % PLANE_COLORS.length];
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.62 });
  return new THREE.Line(geometry, material);
}

function createLatitudeRing(latitudeDeg: number) {
  const latitudeRad = (latitudeDeg * Math.PI) / 180;
  const radius = EARTH_RADIUS_UNITS * Math.cos(latitudeRad);
  const y = EARTH_RADIUS_UNITS * Math.sin(latitudeRad);
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= 192; i += 1) {
    const angle = (Math.PI * 2 * i) / 192;
    points.push(new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius));
  }
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: "#ffbf55", transparent: true, opacity: 0.58 }),
  );
}

export default function OrbitalScene({
  slice,
  config,
  selection,
  snapshotMode,
  showOrbitPlanes,
  showNodes,
  showLinks,
  onSelect,
}: OrbitalSceneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sliceRef = useRef(slice);
  const selectionRef = useRef(selection);
  const snapshotModeRef = useRef(snapshotMode);
  const showOrbitPlanesRef = useRef(showOrbitPlanes);
  const showNodesRef = useRef(showNodes);
  const showLinksRef = useRef(showLinks);
  const onSelectRef = useRef(onSelect);
  const baseTimeRef = useRef(performance.now());
  const motionStartMinuteRef = useRef(slice.minute);
  const nodeVisualsRef = useRef<NodeVisual[]>([]);
  const linkVisualsRef = useRef<LinkVisual[]>([]);
  const dynamicLinkActiveRef = useRef(new Map<string, boolean>());

  useEffect(() => {
    sliceRef.current = slice;
    if (snapshotModeRef.current) {
      baseTimeRef.current = performance.now();
    }
  }, [slice]);

  useEffect(() => {
    snapshotModeRef.current = snapshotMode;
    baseTimeRef.current = performance.now();
    if (!snapshotMode) {
      motionStartMinuteRef.current = sliceRef.current.minute;
    }
  }, [snapshotMode]);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    showOrbitPlanesRef.current = showOrbitPlanes;
  }, [showOrbitPlanes]);

  useEffect(() => {
    showNodesRef.current = showNodes;
  }, [showNodes]);

  useEffect(() => {
    showLinksRef.current = showLinks;
  }, [showLinks]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const hostElement = host;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#08141c");

    const camera = new THREE.PerspectiveCamera(42, hostElement.clientWidth / hostElement.clientHeight, 0.1, 80);
    camera.position.set(0, 6.2, 8.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(hostElement.clientWidth, hostElement.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    hostElement.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 4.2;
    controls.maxDistance = 18;
    controls.autoRotate = false;

    scene.add(new THREE.AmbientLight("#b8d6ff", 1.15));
    const sun = new THREE.DirectionalLight("#ffffff", 2.6);
    sun.position.set(8, 4, 5);
    scene.add(sun);
    const rim = new THREE.DirectionalLight("#78c8ff", 1.1);
    rim.position.set(-6, -3, -5);
    scene.add(rim);

    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_RADIUS_UNITS, 96, 64),
      new THREE.MeshPhongMaterial({
        map: createEarthTexture(),
        shininess: 20,
        specular: new THREE.Color("#7db8d9"),
      }),
    );
    scene.add(earth);

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_RADIUS_UNITS * 1.035, 96, 64),
      new THREE.MeshBasicMaterial({
        color: "#76ceff",
        transparent: true,
        opacity: 0.12,
        side: THREE.BackSide,
      }),
    );
    scene.add(atmosphere);

    const polarGroup = new THREE.Group();
    if (config.polarRegion.enabled) {
      polarGroup.add(createLatitudeRing(config.polarRegion.latitudeDeg));
      polarGroup.add(createLatitudeRing(-config.polarRegion.latitudeDeg));
    }
    scene.add(polarGroup);

    const networkGroup = new THREE.Group();
    const orbitGroup = new THREE.Group();
    const satelliteGroup = new THREE.Group();
    const linkGroup = new THREE.Group();
    networkGroup.add(linkGroup, orbitGroup, satelliteGroup);
    scene.add(networkGroup);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    function rebuildSceneObjects() {
      clearGroup(orbitGroup);
      clearGroup(satelliteGroup);
      clearGroup(linkGroup);

      for (let plane = 0; plane < config.constellation.planes; plane += 1) {
        orbitGroup.add(createOrbitLine(plane, sliceRef.current.orbitModel, config));
        const label = createTextSprite(
          `P${plane + 1} ${Math.round(planeRaanDeg(plane, config))}°`,
          PLANE_COLORS[plane % PLANE_COLORS.length],
        );
        const labelPosition = scalePosition(
          calculatePosition(plane, 0, 11, config, sliceRef.current.orbitModel),
          config,
        ).multiplyScalar(1.04);
        label.position.copy(labelPosition);
        orbitGroup.add(label);
      }

      nodeVisualsRef.current = sliceRef.current.nodes.map((node) => {
        const color = modeColor[node.state.mode];
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.075, 24, 16),
          new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: 0.25,
            roughness: 0.42,
          }),
        );
        mesh.userData = { type: "node", id: node.id };
        const halo = new THREE.Mesh(
          new THREE.SphereGeometry(0.125, 24, 16),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0,
            depthWrite: false,
          }),
        );
        const label = createTextSprite(node.label, color);
        label.visible = false;
        satelliteGroup.add(mesh, halo, label);
        return { node, mesh, halo, label };
      });

      linkVisualsRef.current = sliceRef.current.links.map((link) => {
        const material = new THREE.LineBasicMaterial({
          color: statusColor[link.state.status],
          transparent: true,
          opacity: link.state.status === "down" ? 0.22 : link.kind === "inter-plane" ? 0.52 : 0.76,
        });
        const line = new THREE.Line(new THREE.BufferGeometry(), material);
        line.userData = { type: "link", id: link.id };
        linkGroup.add(line);
        return { link, line };
      });
    }

    function applySelectionStyles() {
      const selectionValue = selectionRef.current;
      nodeVisualsRef.current.forEach(({ node, mesh, halo, label }) => {
        const selected = selectionValue.type === "node" && selectionValue.id === node.id;
        mesh.scale.setScalar(selected ? 1.75 : 1);
        const haloMaterial = halo.material as THREE.MeshBasicMaterial;
        haloMaterial.opacity = selected ? 0.42 : 0;
        label.visible = selected;
      });
    }

    function applyLinkStyles() {
      linkVisualsRef.current.forEach(({ link, line }) => {
        const material = line.material as THREE.LineBasicMaterial;
        if (!snapshotModeRef.current) {
          line.visible = dynamicLinkActiveRef.current.get(link.id) ?? link.state.isActive;
          material.color.set(link.kind === "inter-plane" ? "#7fc9ff" : "#b8e6ff");
          material.opacity = link.kind === "inter-plane" ? 0.28 : 0.48;
          return;
        }

        line.visible = link.state.isActive;
        const color =
          link.state.status === "down" && link.state.restrictionReason
            ? restrictionColor[link.state.restrictionReason]
            : statusColor[link.state.status];
        material.color.set(color);
        material.opacity =
          link.state.status === "down"
            ? link.state.restrictionReason === "polar-region"
              ? 0.5
              : 0.24
            : link.kind === "inter-plane"
              ? 0.58
              : 0.78;
      });
    }

    function positionObjects() {
      const elapsedSeconds = (performance.now() - baseTimeRef.current) / 1000;
      const minute = snapshotModeRef.current
        ? sliceRef.current.minute
        : motionStartMinuteRef.current + elapsedSeconds * SIM_MINUTES_PER_SECOND;
      const dynamicNodes = new Map<string, DynamicNodeState>();
      const dynamicLinks = new Map<string, boolean>();

      nodeVisualsRef.current.forEach((visual) => {
        const position = calculatePosition(
          visual.node.plane,
          visual.node.slot,
          minute,
          config,
          sliceRef.current.orbitModel,
        );
        const scenePosition = scalePosition(position, config);
        dynamicNodes.set(visual.node.id, {
          scenePosition,
          latitudeDeg: position.latitudeDeg,
          eci: { x: position.x, y: position.y, z: position.z },
        });
        visual.mesh.position.copy(scenePosition);
        visual.halo.position.copy(scenePosition);
        visual.label.position.copy(scenePosition.clone().multiplyScalar(1.08));
      });

      linkVisualsRef.current.forEach(({ link, line }) => {
        const source = dynamicNodes.get(link.source);
        const target = dynamicNodes.get(link.target);
        if (!source || !target) return;
        line.geometry.dispose();
        line.geometry = new THREE.BufferGeometry().setFromPoints([source.scenePosition, target.scenePosition]);
        dynamicLinks.set(
          link.id,
          link.kind === "inter-plane" ? dynamicInterPlaneLinkActive(source, target, config) : link.state.isActive,
        );
      });

      dynamicLinkActiveRef.current = dynamicLinks;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!showNodesRef.current) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const intersections = raycaster.intersectObjects(nodeVisualsRef.current.map((visual) => visual.mesh), false);
      const hit = intersections[0]?.object;
      if (hit?.userData?.type === "node") {
        onSelectRef.current({ type: "node", id: hit.userData.id });
      }
    }

    function resize() {
      const width = hostElement.clientWidth;
      const height = hostElement.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(hostElement);
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    rebuildSceneObjects();

    let frameId = 0;
    function animate() {
      frameId = requestAnimationFrame(animate);
      const elapsedSeconds = (performance.now() - baseTimeRef.current) / 1000;
      const minute = snapshotModeRef.current
        ? sliceRef.current.minute
        : motionStartMinuteRef.current + elapsedSeconds * SIM_MINUTES_PER_SECOND;
      networkGroup.rotation.y = -((Math.PI * 2 * minute) / EARTH_ROTATION_PERIOD_MINUTES);
      orbitGroup.visible = showOrbitPlanesRef.current;
      satelliteGroup.visible = showNodesRef.current;
      linkGroup.visible = showLinksRef.current;
      positionObjects();
      applySelectionStyles();
      applyLinkStyles();
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    const sceneObjectRebuilder = () => rebuildSceneObjects();
    hostElement.addEventListener("telemetry-rebuild-scene", sceneObjectRebuilder);

    return () => {
      cancelAnimationFrame(frameId);
      hostElement.removeEventListener("telemetry-rebuild-scene", sceneObjectRebuilder);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      resizeObserver.disconnect();
      controls.dispose();
      clearGroup(orbitGroup);
      clearGroup(satelliteGroup);
      clearGroup(linkGroup);
      clearGroup(polarGroup);
      networkGroup.clear();
      earth.geometry.dispose();
      (earth.material as THREE.Material).dispose();
      atmosphere.geometry.dispose();
      (atmosphere.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [config]);

  useEffect(() => {
    hostRef.current?.dispatchEvent(new Event("telemetry-rebuild-scene"));
  }, [slice]);

  return (
    <section className="orbital-panel" aria-label="LEO Walker 三维卫星网络拓扑">
      <div ref={hostRef} className="orbital-canvas" />
      <div className="scene-badges">
        <span>LEO</span>
        <span>{orbitModelLabel[slice.orbitModel]}</span>
        <span>{config.constellation.planes} 个轨道面</span>
        <span>RAAN 间隔 {planeSpacingDeg(config).toFixed(1)}°</span>
        <span>高度 {config.constellation.altitudeKm} km</span>
        <span>周期 {orbitalPeriodMinutes(config).toFixed(1)} 分钟</span>
        <span>速度 {circularOrbitVelocityKmS(config).toFixed(2)} km/s</span>
        <span>极区 ±{config.polarRegion.latitudeDeg}°</span>
        <span>{snapshotMode ? `快照 T${slice.index.toString().padStart(2, "0")}` : "连续运动"}</span>
        {snapshotMode ? <span>仅显示已连接链路</span> : null}
        <span>地球自转参考系</span>
      </div>
      {showOrbitPlanes ? (
        <div className="plane-legend" aria-label="轨道面图例">
          {Array.from({ length: config.constellation.planes }, (_, plane) => (
            <span key={plane}>
              <i style={{ backgroundColor: PLANE_COLORS[plane % PLANE_COLORS.length] }} />
              P{plane + 1}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
