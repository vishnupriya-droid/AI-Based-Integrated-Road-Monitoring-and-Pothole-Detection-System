export const ROVER_BLE_CONFIG = {
  deviceName: "POTHOLE_ROVER",
  serviceUuid:"6e400001-b5a3-f393-e0a9-e50e24dcca9e",
  rxCharacteristicUuid: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
  txCharacteristicUuid: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
  driveRepeatMs: 150,
  firmwareWatchdogMs: 500,
  telemetryStaleMs: 5_000,
} as const;

export const ROVER_COMMANDS = {
  forward: "F",
  reverse: "B",
  left: "L",
  right: "R",
  stop: "S",
  horn: "H",
  depth: "D",
} as const;


