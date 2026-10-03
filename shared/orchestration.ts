import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const orchestrationSchedule = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(["active", "paused", "completed"]),
  cadence: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
});

export const listOrchestrationSchedules = defineRpc({
  name: "orchestration.schedules",
  input: z.object({}),
  output: z.object({
    schedules: z.array(orchestrationSchedule),
  }),
});

export const orchestrationParentLink = z.object({
  agentId: z.string(),
  parentAgentId: z.string().nullable(),
});

export const listOrchestrationParents = defineRpc({
  name: "orchestration.parents",
  input: z.object({
    agentIds: z.array(z.string()),
  }),
  output: z.object({
    links: z.array(orchestrationParentLink),
  }),
});
