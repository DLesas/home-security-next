import { describe, expect, test } from "bun:test";
import {
  type BlockCipher,
  counterBinding,
  createAesCcm,
  Direction,
  fromHex,
  headerByte,
  isValidBindingLength,
  MaxPacketLength,
  type Message,
  messageDirection,
  MessageType,
  MIN_PACKET_LENGTH,
  NO_BINDING,
  nodeAes128,
  openPacket,
  packetNonce,
  readPacketHeader,
  sealPacket,
  sessionBinding,
  toHex,
  welcomeBinding,
} from "../src/index.ts";

const key = fromHex("000102030405060708090a0b0c0d0e0f");
const address = 0x1a2b3c4d;
const disarmed: Message = { type: MessageType.DisarmedNotice };
const command: Message = { type: MessageType.SirenCommand, action: 2, soundSeconds: 5 };
const seal = (message: Message, counter = 1, binding = NO_BINDING): Uint8Array =>
  sealPacket(message, {
    key,
    direction: Direction.FromHub,
    address,
    counter,
    binding,
    maxLength: MaxPacketLength.Radio,
  });
const open = (packet: Uint8Array, binding = NO_BINDING, maxLength: MaxPacketLength = 255) =>
  openPacket(packet, { key, expectedDirection: Direction.FromHub, binding, maxLength });

describe("header", () => {
  test("header bytes for version 1", () => {
    expect(headerByte(Direction.ToHub)).toBe(0x10);
    expect(headerByte(Direction.FromHub)).toBe(0x18);
  });

  test("reads the clear header without the key", () => {
    const packet = seal(command, 0x01020304);
    expect(readPacketHeader(packet, MaxPacketLength.Radio)).toEqual({
      ok: true,
      value: { direction: Direction.FromHub, address, counter: 0x01020304 },
    });
  });

  test("ignores the three low header bits", () => {
    for (let low = 0; low < 8; low++) {
      const packet = fromHex("1" + low.toString(16) + "4d3c2b1a01000000" + "00".repeat(9));
      const header = readPacketHeader(packet, MaxPacketLength.Radio);
      expect(header.ok && header.value.direction).toBe(low & 0x08 ? 1 : 0);
    }
  });

  test("rejects other versions", () => {
    for (const first of [0x00, 0x08, 0x20, 0x28, 0xf1, 0xff]) {
      const packet = new Uint8Array(MIN_PACKET_LENGTH).fill(1);
      packet[0] = first;
      expect(readPacketHeader(packet, 255)).toEqual({ ok: false, error: { code: "badVersion" } });
    }
  });

  test("rejects addresses 0 and 0xFFFFFFFF and counter 0", () => {
    const withHeader = (hex: string) => fromHex(hex + "00".repeat(9));
    expect(readPacketHeader(withHeader("100000000001000000"), 255).ok).toBe(false);
    expect(readPacketHeader(withHeader("10ffffffff01000000"), 255)).toEqual({
      ok: false,
      error: { code: "badAddress" },
    });
    expect(readPacketHeader(withHeader("104d3c2b1a00000000"), 255)).toEqual({
      ok: false,
      error: { code: "badCounter" },
    });
    expect(readPacketHeader(withHeader("10feffffffffffffff"), 255).ok).toBe(true);
  });

  test("checks the size limits", () => {
    expect(readPacketHeader(new Uint8Array(17), 255)).toEqual({
      ok: false,
      error: { code: "truncated" },
    });
    const big = new Uint8Array(256).fill(1);
    big[0] = 0x10;
    expect(readPacketHeader(big, MaxPacketLength.Radio)).toEqual({
      ok: false,
      error: { code: "tooLong" },
    });
    expect(readPacketHeader(big, MaxPacketLength.Link).ok).toBe(true);
    const tooBig = new Uint8Array(1025).fill(1);
    tooBig[0] = 0x10;
    expect(readPacketHeader(tooBig, MaxPacketLength.Link)).toEqual({
      ok: false,
      error: { code: "tooLong" },
    });
  });
});

describe("nonce and bindings", () => {
  test("nonce layout", () => {
    expect(toHex(packetNonce(0x1a2b3c4d, Direction.FromHub, 0xfffffffe))).toBe(
      "4d3c2b1a" + "01" + "feffffff" + "00000000",
    );
  });

  test("binding bytes", () => {
    expect(toHex(counterBinding(0x01020304))).toBe("04030201");
    expect(toHex(counterBinding(0xffffffff))).toBe("ffffffff");
    const gateway = fromHex("a0a1a2a3a4a5a6a7");
    const hub = fromHex("b0b1b2b3b4b5b6b7");
    expect(toHex(welcomeBinding(gateway))).toBe("a0a1a2a3a4a5a6a7");
    expect(toHex(sessionBinding(gateway, hub))).toBe("a0a1a2a3a4a5a6a7b0b1b2b3b4b5b6b7");
    expect(() => counterBinding(-1)).toThrow(RangeError);
    expect(() => welcomeBinding(new Uint8Array(7))).toThrow(RangeError);
    expect(() => sessionBinding(gateway, new Uint8Array(9))).toThrow(RangeError);
  });

  test("only the four binding lengths are allowed", () => {
    expect([0, 4, 8, 16].every(isValidBindingLength)).toBe(true);
    expect([1, 3, 5, 12, 17, 32].some(isValidBindingLength)).toBe(false);
    expect(() => seal(command, 1, new Uint8Array(5))).toThrow(RangeError);
    expect(() => open(seal(command), new Uint8Array(3))).toThrow(RangeError);
  });

  test("a packet opens only with the binding it was sealed with", () => {
    const packet = seal(disarmed, 7, counterBinding(41));
    expect(open(packet, counterBinding(41)).ok).toBe(true);
    expect(open(packet, counterBinding(42))).toEqual({ ok: false, error: { code: "badTag" } });
    expect(open(packet, NO_BINDING)).toEqual({ ok: false, error: { code: "badTag" } });
    expect(open(seal(disarmed, 7), counterBinding(41))).toEqual({
      ok: false,
      error: { code: "badTag" },
    });
  });
});

describe("opening", () => {
  test("the smallest packet is 18 bytes: a disarmed notice", () => {
    const packet = seal(disarmed);
    expect(packet.length).toBe(18);
    expect(open(packet)).toEqual({
      ok: true,
      value: { header: { direction: Direction.FromHub, address, counter: 1 }, message: disarmed },
    });
  });

  test("wrong direction is rejected before decryption", () => {
    const packet = seal(command);
    expect(
      openPacket(packet, {
        key,
        expectedDirection: Direction.ToHub,
        binding: NO_BINDING,
        maxLength: 255,
      }),
    ).toEqual({
      ok: false,
      error: { code: "wrongDirection" },
    });
  });

  test("a packet cut short at every length is rejected", () => {
    const packet = seal(command);
    for (let length = 0; length < packet.length; length++) {
      const result = open(packet.subarray(0, length));
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error.code).toBe(
        length < MIN_PACKET_LENGTH ? "truncated" : "badTag",
      );
    }
  });

  test("every flipped bit of a packet is rejected", () => {
    const packet = seal(command, 0x00a1b2c3, counterBinding(9));
    for (let index = 0; index < packet.length; index++) {
      for (let bit = 0; bit < 8; bit++) {
        const tampered = packet.slice();
        tampered[index] = (tampered[index] ?? 0) ^ (1 << bit);
        expect(open(tampered, counterBinding(9)).ok).toBe(false);
      }
    }
  });

  test("another key fails the tag check", () => {
    const packet = seal(command);
    const other = openPacket(packet, {
      key: new Uint8Array(16),
      expectedDirection: Direction.FromHub,
      binding: NO_BINDING,
      maxLength: 255,
    });
    expect(other).toEqual({ ok: false, error: { code: "badTag" } });
  });
});

describe("sealing", () => {
  test("refuses programmer errors", () => {
    const options = {
      key,
      direction: Direction.FromHub,
      address,
      counter: 1,
      binding: NO_BINDING,
      maxLength: MaxPacketLength.Radio,
    } as const;
    expect(() => sealPacket(command, { ...options, key: new Uint8Array(15) })).toThrow(RangeError);
    expect(() => sealPacket(command, { ...options, address: 0 })).toThrow(RangeError);
    expect(() => sealPacket(command, { ...options, address: 0xffffffff })).toThrow(RangeError);
    expect(() => sealPacket(command, { ...options, counter: 0 })).toThrow(RangeError);
    expect(() => sealPacket(command, { ...options, counter: 2 ** 32 })).toThrow(RangeError);
  });

  test("enforces the size limit it is given", () => {
    const forwarded: Message = {
      type: MessageType.ForwardedPacket,
      receivedAtMicros: 0,
      rssiDbm: 0,
      snrQuarterDb: 0,
      dataRate: 0,
      siteChannel: 0,
      packet: new Uint8Array(255 - 18 - 9 + 1),
    };
    const options = {
      key,
      direction: Direction.ToHub,
      address,
      counter: 1,
      binding: NO_BINDING,
    } as const;
    expect(() => sealPacket(forwarded, { ...options, maxLength: MaxPacketLength.Radio })).toThrow(
      RangeError,
    );
    expect(sealPacket(forwarded, { ...options, maxLength: MaxPacketLength.Link }).length).toBe(256);
    const fits = { ...forwarded, packet: new Uint8Array(255 - 18 - 9) };
    expect(sealPacket(fits, { ...options, maxLength: MaxPacketLength.Radio }).length).toBe(255);
  });

  test("the largest link packet is 1,024 bytes", () => {
    const options = {
      key,
      direction: Direction.ToHub,
      address,
      counter: 1,
      binding: NO_BINDING,
      maxLength: MaxPacketLength.Link,
    } as const;
    // Thirteen 72-byte log entries, then one whose text makes up the rest.
    const logEntries = (lastTextLength: number): Message => ({
      type: MessageType.LogEntries,
      entries: [...Array<number>(13).fill(64), lastTextLength].map((length) => ({
        ageTenths: 0,
        level: 0,
        code: 0,
        text: "t".repeat(length),
      })),
    });
    const largest = sealPacket(logEntries(62), options);
    expect(largest.length).toBe(1024);
    expect(
      openPacket(largest, {
        key,
        expectedDirection: Direction.ToHub,
        binding: NO_BINDING,
        maxLength: 1024,
      }).ok,
    ).toBe(true);
    expect(() => sealPacket(logEntries(63), options)).toThrow(RangeError);
  });
});

describe("type and direction (section 5)", () => {
  test("types 0x80 and above come from the hub", () => {
    for (const type of Object.values(MessageType)) {
      expect(messageDirection(type)).toBe(type >= 0x80 ? Direction.FromHub : Direction.ToHub);
    }
    expect(messageDirection(0x7f)).toBe(Direction.ToHub);
    expect(messageDirection(0x80)).toBe(Direction.FromHub);
  });

  test("sealing a type in the wrong direction is a programmer error", () => {
    const options = { key, address, counter: 1, binding: NO_BINDING, maxLength: 255 } as const;
    expect(() => sealPacket(command, { ...options, direction: Direction.ToHub })).toThrow(
      RangeError,
    );
    const heartbeat: Message = {
      type: MessageType.Heartbeat,
      settingsVersion: 0,
      flags: {
        doorOpen: false,
        coverOpen: false,
        usbPower: false,
        charging: false,
        replyWanted: false,
        localAlarmSounded: false,
        buzzing: false,
        listeningAtSendRate: false,
      },
      batteryCode: 0,
      temperatureCelsius: 0,
      doorChangeCount: 0,
      eventAgeSeconds: 0,
    };
    expect(() => sealPacket(heartbeat, { ...options, direction: Direction.FromHub })).toThrow(
      RangeError,
    );
  });

  test("an authenticated packet whose type does not match its direction is refused", () => {
    // Built below the encoder: header 0x18 (from the hub) around a heartbeat plaintext.
    const clear = fromHex("18" + "4d3c2b1a" + "05000000");
    const sealed = createAesCcm(key, 8).seal(
      packetNonce(address, Direction.FromHub, 5),
      clear,
      fromHex("010300780f000000"),
    );
    const packet = new Uint8Array([...clear, ...sealed]);
    expect(open(packet)).toEqual({ ok: false, error: { code: "wrongDirection" } });
  });
});

describe("a block cipher passed in (D94)", () => {
  /** The runtime's AES for `cipherKey`, counting the blocks it encrypts. */
  function countingCipher(cipherKey: Uint8Array): { cipher: BlockCipher; blocks: () => number } {
    const inner = nodeAes128(cipherKey);
    let blocks = 0;
    return {
      cipher: {
        encryptBlock(block) {
          blocks++;
          return inner.encryptBlock(block);
        },
      },
      blocks: () => blocks,
    };
  }
  const options = {
    key,
    direction: Direction.FromHub,
    address,
    counter: 7,
    binding: counterBinding(3),
    maxLength: MaxPacketLength.Radio,
  } as const;

  test("seals the same bytes as the built-in cipher, through the one given", () => {
    const counting = countingCipher(key);
    const sealed = sealPacket(command, { ...options, cipher: counting.cipher });
    expect(toHex(sealed)).toBe(toHex(sealPacket(command, options)));
    expect(counting.blocks()).toBeGreaterThan(0);
  });

  test("opens through the one given, and serves many packets keyed once", () => {
    const counting = countingCipher(key);
    const open = (counter: number) =>
      openPacket(sealPacket(command, { ...options, counter }), {
        key,
        expectedDirection: Direction.FromHub,
        binding: options.binding,
        maxLength: MaxPacketLength.Radio,
        cipher: counting.cipher,
      });
    expect(open(8)).toMatchObject({ ok: true, value: { message: command } });
    const afterOne = counting.blocks();
    expect(open(9)).toMatchObject({ ok: true, value: { header: { counter: 9 } } });
    expect(counting.blocks()).toBe(2 * afterOne);
  });

  test("is the cipher actually used: one keyed differently fails the tag", () => {
    const other = nodeAes128(fromHex("ffffffffffffffffffffffffffffffff"));
    const packet = sealPacket(command, options);
    const opened = openPacket(packet, {
      key,
      expectedDirection: Direction.FromHub,
      binding: options.binding,
      maxLength: MaxPacketLength.Radio,
      cipher: other,
    });
    expect(opened).toEqual({ ok: false, error: { code: "badTag" } });
    expect(toHex(sealPacket(command, { ...options, cipher: other }))).not.toBe(toHex(packet));
  });
});
