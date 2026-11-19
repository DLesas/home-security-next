/**
 * `@hsn/ble-bench`: scripted Bluetooth boards behind the phone's `BleCentral`, for the app's
 * pairing and update code under `bun test` (P4), the simulators' bridge, and the desk page
 * (tools/ble-bench/README.md). The bridge's client for a development build is `./client`
 * (`bridge/client.ts`), kept apart: nothing else here may reach a phone's bundle.
 */
export { BleAir, type AirOptions } from "./air/air.ts";
export { ScriptedCentral, type CentralOptions } from "./air/central.ts";
export {
  type Crossing,
  corruptNthData,
  type Faults,
  flipLastBit,
  isFrame,
  nthFrame,
  TransferKind,
} from "./air/faults.ts";
export { type AdvertData, MAX_ATTRIBUTE_BYTES, MIN_MTU, type Peripheral } from "./air/gatt.ts";
export {
  type BoardEvents,
  type BoardOptions,
  type BoardRole,
  DEFAULT_CAPACITY,
  MAX_WRONG_CODES,
  placeBoard,
  ScriptedBoard,
  UPDATE_SERVICE,
} from "./boards/board.ts";
export {
  type PairingSecurityServer,
  type SessionRefusal,
  STAND_IN_LABEL,
  standInSecurity,
  type StartPairingSecurity,
  unjoinedSecurity,
} from "./boards/pairing-security.ts";
export { endpointUuid, PAIRING_SERVICE, PAIRING_UUIDS } from "./boards/protocomm.ts";
export { answerSetup, identityOf } from "./boards/setup.ts";
export {
  type BluetoothOffer,
  UPDATE_SESSION,
  UpdateService,
  type UpdateStatusReport,
} from "./boards/update-service.ts";
export { type BridgeServer, startBridge } from "./bridge/server.ts";
export { type Clock, ManualClock, realClock, settle } from "./clock.ts";
export { guardProblems } from "./release-guard.ts";
export { type PhoneSession, ScriptPhone, type ScriptPhoneOptions } from "./script-phone.ts";
export { openStandInSession, readPairVersion } from "./stand-in-client.ts";
export { TEST_SIGNING_KEY, TEST_SIGNING_SCALAR, testImage, testPairing } from "./test-keys.ts";
