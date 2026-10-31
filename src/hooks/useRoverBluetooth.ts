import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ROVER_BLE_CONFIG, ROVER_COMMANDS } from "../roverConfig";

type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "failed";

export type LogTone =
  | "muted"
  | "success"
  | "default"
  | "info"
  | "danger";

export type DriveCommand = "F" | "B" | "L" | "R";

export interface RoverTelemetry {
  motorA_rpm?: number;
  motorB_rpm?: number;
  depth_cm?: number;
  obstacle_cm?: number;
  battery_percent?: number;
  status?: string;
}

export interface RoverLog {
  id: number;
  time: string;
  text: string;
  tone: LogTone;
}

interface BluetoothCharacteristicLike extends EventTarget {
  properties?: {
    write?: boolean;
    writeWithoutResponse?: boolean;
  };
  value?: DataView;
  startNotifications(): Promise<BluetoothCharacteristicLike>;
  stopNotifications(): Promise<BluetoothCharacteristicLike>;
  writeValue?(value: BufferSource): Promise<void>;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
}

interface BluetoothServiceLike {
  getCharacteristic(uuid: string): Promise<BluetoothCharacteristicLike>;
}

interface BluetoothServerLike {
  connected: boolean;
  getPrimaryService(uuid: string): Promise<BluetoothServiceLike>;
  disconnect(): void;
}

interface BluetoothDeviceLike extends EventTarget {
  name?: string;
  gatt?: {
    connect(): Promise<BluetoothServerLike>;
  };
}

interface BluetoothApiLike {
  requestDevice(options: {
    filters: Array<{ services: string[] }>;
  }): Promise<BluetoothDeviceLike>;
}

interface QueueItem {
  command: string;
  movement: boolean;
  generation: number;
  resolve?: () => void;
  reject?: (error: unknown) => void;
}

// Web Bluetooth expects lowercase UUID strings.
const SERVICE_UUID = ROVER_BLE_CONFIG.serviceUuid.toLowerCase();
const RX_UUID = ROVER_BLE_CONFIG.rxCharacteristicUuid.toLowerCase();
const TX_UUID = ROVER_BLE_CONFIG.txCharacteristicUuid.toLowerCase();

const nowTime = () =>
  new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const describeBluetoothError = (error: unknown) => {
  if (!(error instanceof DOMException)) {
    return error instanceof Error
      ? error.message
      : "Unknown Bluetooth error.";
  }

  if (error.name === "NotFoundError") {
    return "Device selection was cancelled or no matching rover was found.";
  }

  if (error.name === "SecurityError") {
    return "Bluetooth permission was denied or blocked by the browser.";
  }

  if (error.name === "NotSupportedError") {
    return "The required BLE service or characteristic is unavailable.";
  }

  return `${error.name}: ${error.message}`;
};

export function useRoverBluetooth() {
  const [status, setStatus] =
    useState<ConnectionStatus>("disconnected");

  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [activeDrive, setActiveDrive] =
    useState<DriveCommand | null>(null);

  const [telemetry, setTelemetry] = useState<RoverTelemetry>({});
  const [lastTelemetryAt, setLastTelemetryAt] =
    useState<number | null>(null);

  const [clock, setClock] = useState(Date.now());
  const [logs, setLogs] = useState<RoverLog[]>([]);

  const mountedRef = useRef(true);
  const deviceRef = useRef<BluetoothDeviceLike | null>(null);
  const serverRef = useRef<BluetoothServerLike | null>(null);
  const rxRef = useRef<BluetoothCharacteristicLike | null>(null);
  const txRef = useRef<BluetoothCharacteristicLike | null>(null);

  const queueRef = useRef<QueueItem[]>([]);
  const writingRef = useRef(false);
  const movementGenerationRef = useRef(0);

  const driveTimerRef =
    useRef<ReturnType<typeof setInterval> | null>(null);

  const activeDriveRef = useRef<DriveCommand | null>(null);
  const notificationBufferRef = useRef("");
  const notificationDecoderRef = useRef(new TextDecoder());

  const panTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);

  const pendingPanRef = useRef(90);
  const disconnectingRef = useRef(false);
  const logIdRef = useRef(0);

  const addLog = useCallback(
    (text: string, tone: LogTone = "default") => {
      if (!mountedRef.current) return;

      const entry: RoverLog = {
        id: ++logIdRef.current,
        time: nowTime(),
        text,
        tone,
      };

      setLogs((current) => [...current.slice(-99), entry]);
    },
    [],
  );

  const clearLocalMovement = useCallback(() => {
    movementGenerationRef.current += 1;

    queueRef.current = queueRef.current.filter(
      (item) => !item.movement,
    );

    if (driveTimerRef.current) {
      clearInterval(driveTimerRef.current);
    }

    driveTimerRef.current = null;
    activeDriveRef.current = null;

    if (mountedRef.current) {
      setActiveDrive(null);
    }
  }, []);

  const disableConnection = useCallback(() => {
    clearLocalMovement();

    if (panTimerRef.current) {
      clearTimeout(panTimerRef.current);
      panTimerRef.current = null;
    }

    rxRef.current = null;
    txRef.current = null;
    serverRef.current = null;
    queueRef.current = [];
    writingRef.current = false;
  }, [clearLocalMovement]);

  const handleWriteFailure = useCallback(
    (error: unknown) => {
      const server = serverRef.current;
      disconnectingRef.current = true;

      addLog(
        `BLE write failed: ${describeBluetoothError(error)}`,
        "danger",
      );

      disableConnection();

      if (mountedRef.current) {
        setStatus("failed");
        setDeviceName(null);
      }

      try {
        if (server?.connected) {
          server.disconnect();
        }
      } catch {
        // The GATT server may already be disconnected.
      }
    },
    [addLog, disableConnection],
  );

  const processQueue = useCallback(async () => {
    if (writingRef.current) return;

    writingRef.current = true;

    while (queueRef.current.length > 0 && rxRef.current) {
      const item = queueRef.current.shift()!;

      if (
        item.movement &&
        item.generation !== movementGenerationRef.current
      ) {
        item.resolve?.();
        continue;
      }

      try {
        const bytes = new TextEncoder().encode(
          `${item.command}\n`,
        );

        const characteristic = rxRef.current;

        if (
          characteristic.properties?.writeWithoutResponse &&
          characteristic.writeValueWithoutResponse
        ) {
          await characteristic.writeValueWithoutResponse(bytes);
        } else if (
          characteristic.properties?.write &&
          characteristic.writeValueWithResponse
        ) {
          await characteristic.writeValueWithResponse(bytes);
        } else if (
          characteristic.properties?.write &&
          characteristic.writeValue
        ) {
          await characteristic.writeValue(bytes);
        } else {
          throw new Error(
            "RX characteristic does not support writes.",
          );
        }

        addLog(`Command sent: ${item.command}`, "info");
        item.resolve?.();
      } catch (error) {
        item.reject?.(error);
        handleWriteFailure(error);
        break;
      }
    }

    writingRef.current = false;
  }, [addLog, handleWriteFailure]);

  const enqueueCommand = useCallback(
    (
      command: string,
      options: {
        movement?: boolean;
        priority?: boolean;
      } = {},
    ) =>
      new Promise<void>((resolve, reject) => {
        if (!rxRef.current) {
          const error = new Error(
            "Rover controls are not ready.",
          );

          addLog(error.message, "danger");
          reject(error);
          return;
        }

        const item: QueueItem = {
          command,
          movement: options.movement ?? false,
          generation: movementGenerationRef.current,
          resolve,
          reject,
        };

        if (options.priority) {
          queueRef.current.unshift(item);
        } else {
          queueRef.current.push(item);
        }

        void processQueue();
      }),
    [addLog, processQueue],
  );

  const emergencyStop = useCallback(() => {
    clearLocalMovement();

    if (rxRef.current) {
      void enqueueCommand(ROVER_COMMANDS.stop, {
        priority: true,
      }).catch(() => {
        // The queue reports write failures.
      });
    }
  }, [clearLocalMovement, enqueueCommand]);

  const stopDrive = useCallback(() => {
    if (!activeDriveRef.current) return;
    emergencyStop();
  }, [emergencyStop]);

  const startDrive = useCallback(
    (command: DriveCommand) => {
      if (!rxRef.current || status !== "connected") return;

      clearLocalMovement();
      activeDriveRef.current = command;
      setActiveDrive(command);

      const send = () => {
        if (
          activeDriveRef.current !== command ||
          !rxRef.current
        ) {
          return;
        }

        void enqueueCommand(command, {
          movement: true,
        }).catch(() => {
          // The queue reports write failures.
        });
      };

      send();

      driveTimerRef.current = setInterval(
        send,
        ROVER_BLE_CONFIG.driveRepeatMs,
      );
    },
    [clearLocalMovement, enqueueCommand, status],
  );

  const updateTelemetry = useCallback(
    (value: unknown) => {
      if (!mountedRef.current) return;

      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        addLog(
          "Ignored telemetry: expected a JSON object.",
          "danger",
        );
        return;
      }

      const input = value as Record<string, unknown>;
      const next: RoverTelemetry = {};

      const numericFields = [
        "motorA_rpm",
        "motorB_rpm",
        "depth_cm",
        "obstacle_cm",
        "battery_percent",
      ] as const;

      for (const field of numericFields) {
        const fieldValue = input[field];

        if (
          typeof fieldValue === "number" &&
          Number.isFinite(fieldValue)
        ) {
          next[field] = fieldValue;
        }
      }

      if (typeof input.status === "string") {
        next.status = input.status;
      }

      if (Object.keys(next).length === 0) {
        addLog(
          "Telemetry received with no supported fields.",
          "muted",
        );
        return;
      }

      setTelemetry((current) => ({ ...current, ...next }));
      setLastTelemetryAt(Date.now());

      addLog(
        `Reading received: ${JSON.stringify(next)}`,
        "success",
      );
    },
    [addLog],
  );

  const handleNotification = useCallback(
    (event: Event) => {
      const target =
        event.target as BluetoothCharacteristicLike | null;

      if (!target?.value) return;

      const chunk = notificationDecoderRef.current.decode(
        target.value,
        { stream: true },
      );

      notificationBufferRef.current += chunk;

      const lines = notificationBufferRef.current.split("\n");
      notificationBufferRef.current = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          updateTelemetry(JSON.parse(trimmed));
        } catch {
          addLog(
            `Invalid telemetry JSON: ${trimmed}`,
            "danger",
          );
        }
      }
    },
    [addLog, updateTelemetry],
  );

  const handleUnexpectedDisconnect = useCallback(() => {
    if (disconnectingRef.current) return;

    disableConnection();

    if (mountedRef.current) {
      setStatus("disconnected");
      setDeviceName(null);
    }

    addLog(
      "Rover disconnected unexpectedly. Motors must stop via firmware watchdog.",
      "danger",
    );
  }, [addLog, disableConnection]);

  const disconnect = useCallback(async () => {
    disconnectingRef.current = true;

    const server = serverRef.current;

    if (mountedRef.current) {
      setStatus("disconnected");
    }

    emergencyStop();

    const tx = txRef.current;

    if (tx) {
      tx.removeEventListener(
        "characteristicvaluechanged",
        handleNotification,
      );

      try {
        await tx.stopNotifications();
      } catch {
        // Continue if notifications have already stopped.
      }
    }

    disableConnection();

    deviceRef.current?.removeEventListener(
      "gattserverdisconnected",
      handleUnexpectedDisconnect,
    );

    try {
      if (server?.connected) {
        server.disconnect();
      }
    } catch {
      // The server may already be disconnected.
    }

    deviceRef.current = null;

    if (mountedRef.current) {
      setStatus("disconnected");
      setDeviceName(null);
    }

    addLog(
      "Bluetooth disconnected by operator.",
      "muted",
    );

    disconnectingRef.current = false;
  }, [
    addLog,
    disableConnection,
    emergencyStop,
    handleNotification,
    handleUnexpectedDisconnect,
  ]);

  const connect = useCallback(async () => {
    const bluetooth = (
      navigator as Navigator & {
        bluetooth?: BluetoothApiLike;
      }
    ).bluetooth;

    if (!bluetooth) {
      setStatus("failed");

      addLog(
        "Web Bluetooth is unavailable in this browser.",
        "danger",
      );
      return;
    }

    setStatus("connecting");
    setTelemetry({});
    setLastTelemetryAt(null);

    addLog(
      `Opening Bluetooth picker for ${ROVER_BLE_CONFIG.deviceName}...`,
      "info",
    );

    disconnectingRef.current = false;

    try {
      // Must remain directly triggered by the Connect click.
      const device = await bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
      });

      deviceRef.current = device;
      setDeviceName(device.name || "Unnamed BLE device");

      device.addEventListener(
        "gattserverdisconnected",
        handleUnexpectedDisconnect,
      );

      if (!device.gatt) {
        throw new Error(
          "Selected device has no GATT server.",
        );
      }

      addLog("Connecting to GATT server...", "info");

      const server = await device.gatt.connect();
      serverRef.current = server;

      const service =
        await server.getPrimaryService(SERVICE_UUID);

      const [rx, tx] = await Promise.all([
        service.getCharacteristic(RX_UUID),
        service.getCharacteristic(TX_UUID),
      ]);

      rxRef.current = rx;
      txRef.current = tx;

      notificationBufferRef.current = "";
      notificationDecoderRef.current = new TextDecoder();

      tx.addEventListener(
        "characteristicvaluechanged",
        handleNotification,
      );

      await tx.startNotifications();

      // Every connection starts with a stop command.
      await enqueueCommand(ROVER_COMMANDS.stop, {
        priority: true,
      });

      if (mountedRef.current) {
        setStatus("connected");
      }

      addLog(
        `Bluetooth ready: ${device.name || "Unnamed BLE device"}.`,
        "success",
      );
    } catch (error) {
      const server = serverRef.current;

      disableConnection();

      deviceRef.current?.removeEventListener(
        "gattserverdisconnected",
        handleUnexpectedDisconnect,
      );

      try {
        server?.disconnect();
      } catch {
        // Ignore cleanup errors after connection failure.
      }

      if (mountedRef.current) {
        setStatus("failed");
        setDeviceName(null);
      }

      addLog(
        `Connection failed: ${describeBluetoothError(error)}`,
        "danger",
      );
    }
  }, [
    addLog,
    disableConnection,
    enqueueCommand,
    handleNotification,
    handleUnexpectedDisconnect,
  ]);

  const sendAction = useCallback(
    (command: "H" | "D") => {
      void enqueueCommand(command).catch(() => {
        // The queue reports write failures.
      });
    },
    [enqueueCommand],
  );

  const setCameraPan = useCallback(
    (angle: number, final = false) => {
      if (!Number.isFinite(angle)) return;

      pendingPanRef.current = Math.max(
        0,
        Math.min(180, Math.round(angle)),
      );

      if (panTimerRef.current) {
        clearTimeout(panTimerRef.current);
      }

      const send = () => {
        panTimerRef.current = null;

        void enqueueCommand(
          `P:${pendingPanRef.current}`,
        ).catch(() => {
          // The queue reports write failures.
        });
      };

      if (final) {
        send();
      } else {
        panTimerRef.current = setTimeout(send, 120);
      }
    },
    [enqueueCommand],
  );

  useEffect(() => {
    const stopForSafety = () => stopDrive();

    const stopWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        stopDrive();
      }
    };

    window.addEventListener("blur", stopForSafety);
    document.addEventListener(
      "visibilitychange",
      stopWhenHidden,
    );

    const tick = setInterval(
      () => setClock(Date.now()),
      1_000,
    );

    return () => {
      window.removeEventListener("blur", stopForSafety);

      document.removeEventListener(
        "visibilitychange",
        stopWhenHidden,
      );

      clearInterval(tick);
    };
  }, [stopDrive]);

  // Fixed: React Strict Mode runs setup, cleanup, then setup.
  // Restore the mounted flag on every setup.
  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      clearLocalMovement();

      if (panTimerRef.current) {
        clearTimeout(panTimerRef.current);
        panTimerRef.current = null;
      }

      txRef.current?.removeEventListener(
        "characteristicvaluechanged",
        handleNotification,
      );

      void txRef.current
        ?.stopNotifications()
        .catch(() => undefined);

      deviceRef.current?.removeEventListener(
        "gattserverdisconnected",
        handleUnexpectedDisconnect,
      );

      try {
        serverRef.current?.disconnect();
      } catch {
        // Component cleanup must not throw.
      }
    };
  }, [
    clearLocalMovement,
    handleNotification,
    handleUnexpectedDisconnect,
  ]);

  const supportIssue = useMemo(() => {
    if (!window.isSecureContext) {
      return "Web Bluetooth requires HTTPS or localhost. Open this dashboard in a standalone secure tab.";
    }

    const bluetooth = (
      navigator as Navigator & {
        bluetooth?: BluetoothApiLike;
      }
    ).bluetooth;

    if (!bluetooth) {
      return "Web Bluetooth is unavailable here. Try Chrome on Android or a supported desktop browser. Open the dashboard in a standalone HTTPS or localhost tab.";
    }

    return null;
  }, []);

  const telemetryStale =
    lastTelemetryAt !== null &&
    clock - lastTelemetryAt >
      ROVER_BLE_CONFIG.telemetryStaleMs;

  return {
    status,
    deviceName,
    controlsReady:
      status === "connected" &&
      Boolean(rxRef.current && txRef.current),
    supportIssue,
    activeDrive,
    telemetry,
    lastTelemetryAt,
    telemetryStale,
    logs,
    connect,
    disconnect,
    startDrive,
    stopDrive,
    emergencyStop,
    sendAction,
    setCameraPan,
    addLog,
    clearLogs: () => setLogs([]),
  };
}