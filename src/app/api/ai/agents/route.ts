import { NextRequest, NextResponse } from "next/server";
import { userFromRequest } from "@/lib/auth";
import { jsonError } from "@/lib/validators";
import { agentRegistry } from "@/lib/ai/agents/agent-registry";
import { getAllAgentsPresence } from "@/lib/ai/agents/presence";

export async function GET(request: NextRequest) {
  const user = await userFromRequest(request);
  if (!user) return jsonError("Unauthorized", 401);

  await agentRegistry.ensureDefaultAgents();
  const [agents, agentStatus] = await Promise.all([
    agentRegistry.listAgents(true),
    getAllAgentsPresence(),
  ]);

  return NextResponse.json({
    agents,
    presence: agentStatus.presence,
    providerHealth: agentStatus.providerHealth,
  });
}

export async function POST(request: NextRequest) {
  const user = await userFromRequest(request);
  if (!user) return jsonError("Unauthorized", 401);
  if (user.role === "MEMBER") {
    return jsonError("Only Owners and Admins can create agents", 403);
  }

  const body = await request.json().catch(() => ({}));
  const { name, role, description, systemPrompt, modelProfile, slug } = body;

  if (!name || !role) {
    return jsonError("Agent name and role are required", 400);
  }

  const agentSlug = `custom_${slug || name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;

  try {
    const created = await agentRegistry.createCustomAgent({
      slug: agentSlug,
      name,
      role,
      description: description || `Custom specialist: ${name}`,
      systemPrompt: systemPrompt || `You are ${name}, specializing in ${role}.`,
      modelProfile: modelProfile || "reasoning",
      temperature: 0.2,
      maxTokens: 4096,
      isMaster: false,
      tools: ["search_companies", "search_leads", "search_deals", "create_task"],
      permissions: ["tasks:write", "leads:read"],
    });

    return NextResponse.json({ success: true, agent: created }, { status: 201 });
  } catch (err: any) {
    return jsonError(err?.message || "Failed to create custom agent", 500);
  }
}

