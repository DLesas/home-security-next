import { Direction } from "../packet/header.ts";

/** Message type bytes (section 5). Types from the hub have the top bit set. */
export const MessageType = {
  Heartbeat: 0x01,
  DoorChanged: 0x02,
  CoverChanged: 0x03,
  Button: 0x04,
  Started: 0x05,
  SirenReport: 0x10,
  Hello: 0x20,
  ForwardedPacket: 0x21,
  GatewayStatus: 0x22,
  TransmitResult: 0x23,
  Interference: 0x24,
  LogEntries: 0x30,
  Reply: 0x81,
  DisarmedNotice: 0x82,
  SirenCommand: 0x90,
  SirenSettings: 0x91,
  Welcome: 0xa0,
  TransmitRequest: 0xa1,
  GatewaySettings: 0xa2,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

const FIRST_FROM_HUB_TYPE = 0x80;

/** Section 5: types 0x80 and above come from the hub; lower types go to the hub. */
export function messageDirection(type: number): Direction {
  return type >= FIRST_FROM_HUB_TYPE ? Direction.FromHub : Direction.ToHub;
}
