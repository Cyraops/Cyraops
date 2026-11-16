import { db } from "@/lib/db";
import { isValidCron, nextCronRun } from "./cron";

/**
 * Creating a routine, in one place.
 *
 * Both the assistant tool and POST /api/routines go through this, so a routine
 * created by asking the bot and one created from the UI cannot diverge — the
 * same failure mode as the ticket desk having two write paths.
 */
export interface CreateRoutineInput {
  name: string;
  cron: string;
  agentSlug?: string;
  agentId?: string;
  instructions?: string;
  skillId?: string;
  userId: string;
  triggerType?: "SCHEDULE" | "WEBHOOK" | "EMAIL" | "RECORD_CHANGE";
}

export async function createRoutine(input: CreateRoutineInput) {
  const cron = (input.cron ?? "").trim();
  if (!isValidCron(cron)) {
    return { ok: false as const, error: `"${cron}" is not a valid cron expression.` };
  }

  const agent = input.agentId
    ? await db.aiAgent.findFirst({ where: { id: input.agentId, status: "ACTIVE" }, select: { id: true, name: true } })
    : await db.aiAgent.findFirst({ where: { slug: input.agentSlug ?? "", status: "ACTIVE" }, select: { id: true, name: true } });
  if (!agent) {
    return { ok: false as const, error: `No active agent with the slug "${input.agentSlug ?? input.agentId}".` };
  }

  let skillId = input.skillId;
  if (skillId) {
    const exists = await db.aiSkill.findUnique({ where: { id: skillId }, select: { id: true } });
    if (!exists) return { ok: false as const, error: "That skill does not exist." };
  } else {
    const first = await db.aiSkill.findFirst({ select: { id: true } });
    skillId = first?.id ?? (await db.aiSkill.create({
      data: {
        name: "Scheduled work",
        slug: `scheduled_${Date.now()}`,
        description: "Work defined by a routine.",
        instructions: "Carry out the routine's instructions and report what happened.",
        createdById: input.userId,
      },
      select: { id: true },
    })).id;
  }

  const routine = await db.aiRoutine.create({
    data: {
      name: input.name.trim().slice(0, 120),
      description: (input.instructions ?? "").slice(0, 500),
      cronExpression: cron,
      skillId,
      agentId: agent.id,
      isEnabled: true,
      triggerType: input.triggerType ?? "SCHEDULE",
      nextRunAt: nextCronRun(cron, new Date()),
    },
    select: { id: true, name: true, cronExpression: true, nextRunAt: true },
  });

  return { ok: true as const, routine: { ...routine, agentName: agent.name } };
}
