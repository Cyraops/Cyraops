import { NextRequest, NextResponse } from "next/server";
import { userFromRequest } from "@/lib/auth";
import { jsonError } from "@/lib/validators";
import { db } from "@/lib/db";

export async function GET(request: NextRequest) {
  const user = await userFromRequest(request);
  if (!user) return jsonError("Unauthorized", 401);

  try {
    const isAdmin = user.role === "OWNER" || user.role === "ADMIN";
    const routines = await db.aiRoutine.findMany({
      // Never ship the webhook token to a MEMBER: it is the only credential on
      // the public hook, and members are denied routine control by policy.
      select: {
        id: true,
        name: true,
        description: true,
        cronExpression: true,
        isEnabled: true,
        lastRunAt: true,
        lastStatus: true,
        nextRunAt: true,
        triggerType: true,
        emailSenders: true,
        watchModel: true,
        watchField: true,
        createdAt: true,
        ...(isAdmin ? { webhookToken: true, watchValue: true } : {}),
        skill: { select: { id: true, slug: true, name: true } },
        agent: { select: { id: true, slug: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ routines });
  } catch (err: any) {
    console.error("[API:routines] Failed:", err);
    return jsonError("Failed to load routines", 500);
  }
}
