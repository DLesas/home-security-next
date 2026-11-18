/**
 * Installs the platform's `crypto.getRandomValues` (`random.ts`) when this file loads: the entry
 * (`src/entry.ts`) imports it before anything else, so no module finds the phone without one.
 */
import { installRandom } from "./random";

installRandom();
