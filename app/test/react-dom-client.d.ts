/** The part of React DOM's client API used by the screen tests. */
declare module "react-dom/client" {
  import type { ReactNode } from "react";

  export function createRoot(container: Element): {
    render(element: ReactNode): void;
    unmount(): void;
  };
}
