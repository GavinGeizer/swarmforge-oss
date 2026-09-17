import { test } from "bun:test";
import { smoke } from "../scripts/smoke";

test.skipIf(process.env.SWARMFORGE_RUN_SMOKE !== "true")(
  "optional real Freestyle/OpenCode/model smoke flow",
  smoke,
  900000,
);
