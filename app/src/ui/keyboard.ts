/**
 * The keyboard on a phone (docs/app-design.md, "On a phone", rule 5): while a person types, the
 * field and the action that saves it stay visible above the keyboard. The shell's scroll view
 * shrinks to the space above the keyboard (`KeyboardAvoidingView`); this says where to scroll it
 * so the field, and the room under it where its form's action sits, are in that space. Pure, so it
 * is tested at its edges.
 */

/** Room kept under a field: the 24 px between it and its form's action, the 48 px action, 24 more. */
export const REVEAL_BELOW = 96;

/** Room kept above a field scrolled up to. */
export const REVEAL_ABOVE = 24;

/**
 * The scroll offset that shows the field from `top` (in the scrolled content) `height` tall with
 * `below` under it, in a view `visible` tall now scrolled to `offset`; null when already shown.
 * When both cannot fit, the field's top wins over the room under it.
 */
export function revealOffset(at: {
  readonly top: number;
  readonly height: number;
  readonly offset: number;
  readonly visible: number;
  readonly below: number;
}): number | null {
  const above = Math.max(0, at.top - REVEAL_ABOVE);
  if (above < at.offset) return above;
  const bottom = at.top + at.height + at.below;
  if (bottom <= at.offset + at.visible) return null;
  return Math.min(above, bottom - at.visible);
}
