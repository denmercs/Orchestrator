// Where the factory's lines go. A line for the human goes to Sulti (`report`) while a Sulti session takes it, else to
// the repo's manager (`steer`), as before Sulti. A line the manager must act on goes to the manager, and Sulti hears a
// copy when the human should know too. The manager is never told a line only the human can act on while Sulti is up.
export type FactoryLine = (line: string, mission?: string) => Promise<unknown>;

// A drop-in `steer` for a line meant for the human: Sulti first; a report that resolves false (no live Sulti) or throws
// falls through to the manager, whose result and throw pass through as they did. Undefined when neither port is wired.
export function toHuman(ports: { steer?: FactoryLine; report?: FactoryLine }): FactoryLine | undefined {
  const { steer, report } = ports;
  if (!report) return steer;
  return async (line, mission) => {
    const taken = await Promise.resolve()
      .then(() => report(line, mission))
      .catch(() => false);
    if (taken !== false) return taken;
    return steer ? steer(line, mission) : false;
  };
}

// The copy Sulti gets of a manager line the human should also know about. Best effort: no Sulti, or a throw, sends nothing.
export async function alsoReport(ports: { report?: FactoryLine }, line: string, mission?: string): Promise<void> {
  await Promise.resolve()
    .then(() => ports.report?.(line, mission))
    .catch(() => undefined);
}
