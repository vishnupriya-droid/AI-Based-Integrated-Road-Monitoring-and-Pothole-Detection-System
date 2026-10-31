import { useEffect, useRef, useState } from "react";
import {
  type DriveCommand,
  useRoverBluetooth,
} from "./hooks/useRoverBluetooth";

type IconName =
  | "arrow-up"
  | "arrow-down"
  | "arrow-left"
  | "arrow-right"
  | "camera"
  | "signal"
  | "horn"
  | "measure"
  | "fullscreen";

const icons: Record<IconName, React.ReactNode> = {
  "arrow-up": <path d="m6 10 6-6 6 6M12 4v16" />,
  "arrow-down": <path d="m6 14 6 6 6-6M12 20V4" />,
  "arrow-left": <path d="m10 6-6 6 6 6M4 12h16" />,
  "arrow-right": <path d="m14 6 6 6-6 6M20 12H4" />,
  camera: (
    <>
      <path d="M14.5 5 13 3H7L5.5 5H3a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-6.5Z" />
      <circle cx="10" cy="12" r="4" />
    </>
  ),
  signal: (
    <>
      <path d="M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M12 20h.01" />
    </>
  ),
  horn: (
    <>
      <path d="M11 5 6 9H2v6h4l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a9 9 0 0 1 0 12" />
    </>
  ),
  measure: (
    <>
      <path d="M3 17 17 3l4 4L7 21H3v-4Z" />
      <path d="m13 7 2 2m-5 1 2 2m-5 1 2 2" />
    </>
  ),
  fullscreen: (
    <>
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
    </>
  ),
};

function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
        {icons[name]}
      </g>
    </svg>
  );
}

function SectionLabel({ index, children }: { index: string; children: React.ReactNode }) {
  return (
    <div className="section-label">
      <span>{index}</span>
      <h2>{children}</h2>
    </div>
  );
}

type CameraStatus = "disconnected" | "loading" | "connected" | "error";
type CameraSource = "raw" | "ai";

const driveControls = {
  up: { label: "FORWARD", command: "F" as DriveCommand },
  left: { label: "LEFT", command: "L" as DriveCommand },
  right: { label: "RIGHT", command: "R" as DriveCommand },
  down: { label: "REVERSE", command: "B" as DriveCommand },
};

const keyCommands: Record<string, DriveCommand> = {
  ArrowUp: "F",
  w: "F",
  W: "F",
  ArrowDown: "B",
  s: "B",
  S: "B",
  ArrowLeft: "L",
  a: "L",
  A: "L",
  ArrowRight: "R",
  d: "R",
  D: "R",
};

const valueOrDash = (value: number | undefined, suffix = "") =>
  value === undefined ? "—" : `${value}${suffix}`;

const loadSavedCameraUrl = () => {
  try {
    return localStorage.getItem("rover-camera-url") ?? "";
  } catch {
    return "";
  }
};

export default function App() {
  const rover = useRoverBluetooth();
  const [pan, setPan] = useState(90);
  const [cameraSource, setCameraSource] = useState<CameraSource>("raw");
  const [cameraUrl, setCameraUrl] = useState(loadSavedCameraUrl);
  const [activeCameraUrl, setActiveCameraUrl] = useState("");
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>("disconnected");
  const [cameraKey, setCameraKey] = useState(0);
  const videoFrameRef = useRef<HTMLDivElement>(null);
  const pressedKeysRef = useRef(new Set<string>());

  const isEditing = (target: EventTarget | null) => {
    const element = target as HTMLElement | null;
    return Boolean(
      element?.closest("input, textarea, select, [contenteditable='true']"),
    );
  };

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (isEditing(event.target)) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (!event.repeat) rover.emergencyStop();
        return;
      }
      const command = keyCommands[event.key];
      if (!command || pressedKeysRef.current.has(event.key) || event.repeat) return;
      event.preventDefault();
      pressedKeysRef.current.add(event.key);
      rover.startDrive(command);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") return;
      const command = keyCommands[event.key];
      if (!command) return;
      pressedKeysRef.current.delete(event.key);
      if (rover.activeDrive === command) rover.stopDrive();
    };
    const resetKeys = () => pressedKeysRef.current.clear();
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", resetKeys);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", resetKeys);
    };
  }, [rover]);

  const connectCamera = () => {
    const url = cameraUrl.trim();
    if (!url) {
      setCameraStatus("error");
      rover.addLog("Camera error: enter a complete MJPEG stream URL.", "danger");
      return;
    }
    try {
      localStorage.setItem("rover-camera-url", url);
    } catch {
      rover.addLog("Camera URL could not be saved in this browser context.", "muted");
    }
    setActiveCameraUrl(url);
    setCameraStatus("loading");
    setCameraKey((value) => value + 1);
    rover.addLog(
      `Opening ${cameraSource === "raw" ? "raw camera" : "AI backend"} stream...`,
      "info",
    );
  };

  const disconnectCamera = () => {
    setActiveCameraUrl("");
    setCameraStatus("disconnected");
    rover.addLog("Camera stream disconnected.", "muted");
  };

  const retryCamera = () => {
    if (!activeCameraUrl) return connectCamera();
    setCameraStatus("loading");
    setCameraKey((value) => value + 1);
  };

  const cameraMixedContent =
    window.location.protocol === "https:" &&
    activeCameraUrl.toLowerCase().startsWith("http:");

  const statusLabel = {
    disconnected: "DISCONNECTED",
    connecting: "CONNECTING",
    connected: "CONNECTED",
    failed: "CONNECTION FAILED",
  }[rover.status];

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span /><span /></div>
          <div>
            <p className="eyebrow">FIELD OPERATIONS / UNIT 01</p>
            <h1>POTHOLE DETECTION ROVER</h1>
          </div>
        </div>
        <div className="header-controls">
          <div className={`connection-summary ${rover.status}`}>
            <span className="status-light" />
            <div>
              <small>BLUETOOTH ROVER</small>
              <strong>{statusLabel}</strong>
              <em>{rover.deviceName ?? "No device"}</em>
            </div>
          </div>
          <div className="bluetooth-buttons">
            <button
              className="header-button connect-button"
              disabled={rover.status === "connecting" || rover.status === "connected" || Boolean(rover.supportIssue)}
              onClick={rover.connect}
              type="button"
            >
              {rover.status === "connecting" ? "CONNECTING..." : "CONNECT BLUETOOTH"}
            </button>
            <button
              className="header-button disconnect-button"
              disabled={rover.status !== "connected"}
              onClick={() => void rover.disconnect()}
              type="button"
            >
              DISCONNECT
            </button>
          </div>
        </div>
      </header>

      {rover.supportIssue && (
        <div className="compatibility-alert" role="alert">
          <strong>BLUETOOTH ACCESS UNAVAILABLE</strong>
          <span>{rover.supportIssue}</span>
        </div>
      )}

      <div className="control-grid">
        <section className="panel video-panel">
          <div className="panel-heading">
            <SectionLabel index="01">Live Video Feed</SectionLabel>
            <span className={`camera-indicator ${cameraStatus}`}>
              <i /> CAMERA {cameraStatus.toUpperCase()}
            </span>
          </div>

          <div className="camera-config">
            <div className="source-toggle" aria-label="Camera source">
              <button className={cameraSource === "raw" ? "selected" : ""} onClick={() => {
                if (cameraSource !== "raw") disconnectCamera();
                setCameraSource("raw");
              }} type="button">
                RAW ESP32-CAM
              </button>
              <button className={cameraSource === "ai" ? "selected" : ""} onClick={() => {
                if (cameraSource !== "ai") disconnectCamera();
                setCameraSource("ai");
              }} type="button">
                AI LAPTOP STREAM
              </button>
            </div>
            <div className="camera-url-row">
              <input
                aria-label="Camera Stream URL"
                onChange={(event) => setCameraUrl(event.target.value)}
                placeholder="http://192.168.1.100:81/stream"
                type="url"
                value={cameraUrl}
              />
              <button className="camera-connect" onClick={connectCamera} type="button">CONNECT CAMERA</button>
              <button className="camera-disconnect" disabled={cameraStatus === "disconnected"} onClick={disconnectCamera} type="button">DISCONNECT</button>
            </div>
          </div>

          <div className="video-frame" ref={videoFrameRef}>
            {activeCameraUrl && (
              <img
                alt={cameraSource === "raw" ? "Live ESP32-CAM MJPEG stream" : "AI backend MJPEG stream with backend-rendered detections"}
                className={`camera-stream ${cameraStatus === "connected" ? "visible" : ""}`}
                key={cameraKey}
                onError={() => {
                  setCameraStatus("error");
                  rover.addLog("Camera stream failed to load.", "danger");
                }}
                onLoad={() => {
                  setCameraStatus("connected");
                  rover.addLog("Camera stream loaded.", "success");
                }}
                src={activeCameraUrl}
              />
            )}
            {cameraStatus === "connected" && (
              <div className="live-badge"><span />LIVE: {cameraSource === "raw" ? "RAW CAM" : "AI BACKEND"}</div>
            )}
            {cameraStatus !== "connected" && (
              <div className="stream-message">
                <Icon name="camera" size={30} />
                <strong>
                  {cameraStatus === "loading"
                    ? "CONNECTING CAMERA..."
                    : cameraStatus === "error"
                      ? "STREAM ERROR"
                      : "CAMERA DISCONNECTED"}
                </strong>
                <span>
                  {cameraStatus === "error"
                    ? "CHECK URL, NETWORK, AND BROWSER SECURITY"
                    : "ENTER THE COMPLETE MJPEG STREAM URL"}
                </span>
                {cameraStatus === "error" && <button onClick={retryCamera} type="button">RETRY</button>}
              </div>
            )}
            <button
              aria-label="View camera fullscreen"
              className="fullscreen-button"
              onClick={() => {
                void videoFrameRef.current?.requestFullscreen().catch((error: unknown) => {
                  rover.addLog(
                    `Fullscreen unavailable: ${error instanceof Error ? error.message : "browser rejected request"}.`,
                    "danger",
                  );
                });
              }}
              type="button"
            >
              <Icon name="fullscreen" size={18} /> FULLSCREEN
            </button>
          </div>
          <p className={`camera-note ${cameraMixedContent ? "warning" : ""}`}>
            {cameraMixedContent
              ? "HTTPS may block this HTTP stream as mixed content. Use localhost/HTTP for a trusted local dashboard, or expose the stream through an HTTPS proxy."
              : "The viewing device and stream host must be on the same reachable Wi-Fi network. AI boxes are rendered only by your laptop backend."}
          </p>
        </section>

        <section className="panel pan-panel">
          <div className="pan-heading">
            <SectionLabel index="02">Camera Pan / Servo</SectionLabel>
            <output>{pan}°</output>
          </div>
          <input
            aria-label="Camera pan angle"
            disabled={!rover.controlsReady}
            max="180"
            min="0"
            onBlur={() => rover.setCameraPan(pan, true)}
            onChange={(event) => {
              const angle = Number(event.target.value);
              setPan(angle);
              rover.setCameraPan(angle);
            }}
            onKeyUp={() => rover.setCameraPan(pan, true)}
            onPointerUp={() => rover.setCameraPan(pan, true)}
            style={{ "--pan": `${(pan / 180) * 100}%` } as React.CSSProperties}
            type="range"
            value={pan}
          />
          <div className="range-labels">
            <span><b>0°</b> LEFT</span>
            <span><b>90°</b> CENTER</span>
            <span><b>180°</b> RIGHT</span>
          </div>
        </section>

        <section className="panel drive-panel">
          <SectionLabel index="03">Drive System</SectionLabel>
          <p className="panel-description">
            {rover.controlsReady ? "Hold button, WASD, or arrow keys to drive" : "Connect Bluetooth to enable hardware controls"}
          </p>
          <div className="dpad">
            {(Object.keys(driveControls) as Array<keyof typeof driveControls>).map((direction) => {
              const control = driveControls[direction];
              return (
                <button
                  aria-label={control.label}
                  className={`direction direction-${direction} ${rover.activeDrive === control.command ? "active" : ""}`}
                  disabled={!rover.controlsReady}
                  key={direction}
                  onLostPointerCapture={rover.stopDrive}
                  onPointerCancel={rover.stopDrive}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    rover.startDrive(control.command);
                  }}
                  onPointerUp={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                    rover.stopDrive();
                  }}
                  type="button"
                >
                  <Icon name={`arrow-${direction}`} size={25} />
                  <span>{control.label}</span>
                </button>
              );
            })}
            <button className="stop-button" disabled={!rover.controlsReady} onClick={rover.emergencyStop} type="button">
              <span className="stop-icon" />
              <strong>STOP</strong>
            </button>
          </div>
          <div className="motor-readout">
            <span>MOTOR A <b>{valueOrDash(rover.telemetry.motorA_rpm, " RPM")}</b></span>
            <span>MOTOR B <b>{valueOrDash(rover.telemetry.motorB_rpm, " RPM")}</b></span>
          </div>
        </section>

        <section className="panel action-panel">
          <SectionLabel index="04">Hardware Triggers</SectionLabel>
          <div className="action-buttons">
            <button className="action-button horn-button" disabled={!rover.controlsReady} onClick={() => rover.sendAction("H")} type="button">
              <span className="action-icon"><Icon name="horn" size={26} /></span>
              <span><small>AUXILIARY CONTROL</small>SOUND HORN</span>
            </button>
            <button className="action-button measure-button" disabled={!rover.controlsReady} onClick={() => rover.sendAction("D")} type="button">
              <span className="action-icon"><Icon name="measure" size={26} /></span>
              <span><small>SENSOR ARRAY</small>MEASURE DEPTH</span>
            </button>
          </div>
          <div className="telemetry-readout">
            <span>DEPTH <b>{valueOrDash(rover.telemetry.depth_cm, " cm")}</b></span>
            <span>OBSTACLE <b>{valueOrDash(rover.telemetry.obstacle_cm, " cm")}</b></span>
            <span>BATTERY <b>{valueOrDash(rover.telemetry.battery_percent, "%")}</b></span>
          </div>
          <p className="helper-text"><span>i</span> Commands sent are not proof of hardware execution; use ESP32 telemetry for confirmation.</p>
        </section>

        <aside className="panel logs-panel">
          <div className="logs-header">
            <SectionLabel index="05">System Logs &amp; Telemetry</SectionLabel>
            <span className={`telemetry-state ${rover.telemetryStale ? "stale" : ""}`}>
              <i /> {rover.lastTelemetryAt ? (rover.telemetryStale ? "TELEMETRY STALE" : "TELEMETRY LIVE") : "NO DATA"}
            </span>
          </div>
          <div className="terminal">
            <div className="terminal-top">
              <span>ROVER_SYS.LOG</span>
              <button onClick={rover.clearLogs} type="button">CLEAR</button>
            </div>
            <div className="log-list" aria-live="polite">
              {rover.logs.length === 0 ? (
                <p className="empty-log">— No data. Connect the rover to begin —</p>
              ) : (
                rover.logs.map((log, index) => (
                  <div className={`log-entry ${log.tone}`} key={log.id}>
                    <span className="log-index">{String(index + 1).padStart(2, "0")}</span>
                    <p><time>[{log.time}]</time>{log.text}</p>
                  </div>
                ))
              )}
            </div>
            <div className="terminal-status">
              <span><i /> {rover.telemetry.status ?? "NO STATUS DATA"}</span>
              <span>{rover.lastTelemetryAt ? `LAST RX ${new Date(rover.lastTelemetryAt).toLocaleTimeString()}` : "LAST RX —"}</span>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
