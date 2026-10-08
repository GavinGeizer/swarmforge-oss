import type { InferEnv, UnwrapConfig } from "cf/config";
import type configuration from "../cloudflare.config.ts";

// Infer the real binding contract from the same typed configuration used by cf
// and its generated declarations. These imports are erased from Worker bundles.
type Config = UnwrapConfig<typeof configuration>;
type Worker = UnwrapConfig<Config["worker"]>;
export type CloudBindings = InferEnv<Worker>;
