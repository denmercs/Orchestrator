// The recap pill, as data (see CONTEXT.md, "Recap pill"). Kept free of React and the Paseo client
// so it can be tested on its own.

// Claude Code's own session recap, the same one ⌘K offers.
export const RECAP_COMMAND = "/recap";

export type RecapPillView = { title: string; label: string; disabled: boolean };

// Only Claude sessions know `/recap`. It waits for the turn to end so it does not queue behind it.
export function recapPill(agent: { provider: string; status: string }): RecapPillView | null {
  if (agent.provider !== "claude") return null;
  const running = agent.status === "running";
  return {
    title: running ? "Recap: wait for this turn to finish" : "Recap this session (/recap)",
    label: "Recap",
    disabled: running,
  };
}
