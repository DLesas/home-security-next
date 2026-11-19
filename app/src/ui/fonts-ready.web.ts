/**
 * The faces in a browser: `global.css`'s `@font-face` rules name the files the hub serves, and the
 * browser loads each as text first needs it (`font-display: swap`). Nothing to wait for.
 */
export function useFontsReady(): boolean {
  return true;
}
