/**
 * Bindings (section 4): extra authenticated data that is never sent, because both sides
 * already know it. A packet sealed with one binding fails its tag check under any other.
 */
import { ByteWriter, concatBytes } from "../bytes.ts";
import { CONNECTION_RANDOM_LENGTH } from "../messages/gateway.ts";

/** For packets section 4 lists under "everything else". */
export const NO_BINDING: Uint8Array = new Uint8Array(0);

const COUNTER_BINDING_LENGTH = 4;
const SESSION_BINDING_LENGTH = 2 * CONNECTION_RANDOM_LENGTH;

/** The lengths a binding can have: none, a counter, a gateway random, a session value. */
export function isValidBindingLength(length: number): boolean {
  return [0, COUNTER_BINDING_LENGTH, CONNECTION_RANDOM_LENGTH, SESSION_BINDING_LENGTH].includes(
    length,
  );
}

/**
 * For any packet from the hub to a sensor: the counter of the sensor packet it answers, as 4
 * bytes little-endian. A disarmed notice uses the door report that started the countdown.
 */
export function counterBinding(answeredCounter: number): Uint8Array {
  return new ByteWriter().u32(answeredCounter).finish();
}

/** For the gateway's welcome: the gateway random from its hello. */
export function welcomeBinding(gatewayRandom: Uint8Array): Uint8Array {
  checkRandom(gatewayRandom);
  return gatewayRandom.slice();
}

/** For every later packet on a gateway connection, both ways: gateway random then hub random. */
export function sessionBinding(gatewayRandom: Uint8Array, hubRandom: Uint8Array): Uint8Array {
  checkRandom(gatewayRandom);
  checkRandom(hubRandom);
  return concatBytes(gatewayRandom, hubRandom);
}

function checkRandom(random: Uint8Array): void {
  if (random.length !== CONNECTION_RANDOM_LENGTH) {
    throw new RangeError(`connection random values are ${CONNECTION_RANDOM_LENGTH} bytes`);
  }
}
