/** drizzle-kit's settings: SQL migrations for `schema.ts` into `migrations/` (`bun run db:generate` in `relay/`). */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/shell/storage/schema.ts",
  out: "./src/shell/storage/migrations",
});
