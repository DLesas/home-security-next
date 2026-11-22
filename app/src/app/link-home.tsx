/**
 * "Link another home", from This phone (m3-design.md section 6): the phone's link pages as a phone
 * not linked sees them (`ui/phone-link.tsx`). The new home becomes the chosen one; the shell then
 * goes back to This phone (`ui/this-phone.tsx`'s `afterLinking`). Nothing in a browser.
 */
import { PhoneLinkGate } from "../ui/phone-link";

/** Starts the existing link flow for an additional home. */
export default function Screen() {
  return <PhoneLinkGate />;
}
