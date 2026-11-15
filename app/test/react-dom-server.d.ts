/** `react-dom/server`, as the screens' tests use it; `@types/react-dom` is not installed. */
declare module "react-dom/server" {
  import type { ReactNode } from "react";

  export function renderToStaticMarkup(element: ReactNode): string;
}
