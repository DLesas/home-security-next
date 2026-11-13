/** drizzle-kit's settings: SQL migrations for `src/db/schema.ts` into `drizzle/` (hub-design.md section 6). */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
