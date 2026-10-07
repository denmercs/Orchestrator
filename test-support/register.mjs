// Test-only: lets `node --test` load the repo's extensionless TypeScript imports.
import { register } from "node:module";

register("./resolve-ts.mjs", import.meta.url);
