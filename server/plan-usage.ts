import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { type PlanUsageResult, providerUsage } from "../shared/plan-usage";

type PaseoApi = PluginHandlerContext["paseo"];

// The plan usage RPC's body: the daemon's provider usage, parsed to the subset the rows read (extra
// fields dropped). A rejected call (e.g. a host without provider usage) gives `providers: null`.
export async function readPlanUsage(paseo: Pick<PaseoApi, "providers">): Promise<PlanUsageResult> {
  try {
    const { providers } = await paseo.providers.listUsage();
    return { providers: providerUsage.array().parse(providers), error: null };
  } catch (error) {
    return { providers: null, error: error instanceof Error ? error.message : String(error) };
  }
}
