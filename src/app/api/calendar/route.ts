import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { userFromRequest } from "@/lib/auth";
import { jsonError } from "@/lib/validators";

export async function GET(request: NextRequest) {
  const user = await userFromRequest(request);
  if (!user) return jsonError("Unauthorized", 401);
  const availableProjects = await db.project.findMany({ where: { archivedAt: null, ...(user.role === "OWNER" || user.role === "ADMIN" ? {} : { members: { some: { userId: user.id } } }) }, select: { id: true } });
  const projectIds = availableProjects.map((project) => project.id);
  const from = request.nextUrl.searchParams.get("from");
  const to = request.nextUrl.searchParams.get("to");
  const projectId = request.nextUrl.searchParams.get("projectId");
  const memberId = request.nextUrl.searchParams.get("memberId");
  const range = from && to ? { gte: new Date(from), lte: new Date(to) } : { gte: new Date(Date.now() - 30 * 86400000), lte: new Date(Date.now() + 120 * 86400000) };
  if (projectId && !projectIds.includes(projectId)) return Response.json({ events: [] });
  const [tasks, projects] = await Promise.all([
    db.task.findMany({ where: { archivedAt: null, dueDate: range, projectId: projectId ?? { in: projectIds }, ...(memberId ? { assigneeId: memberId } : {}) }, select: { id: true, title: true, dueDate: true, status: true, priority: true, project: { select: { id: true, name: true } } }, orderBy: { dueDate: "asc" } }),
    db.project.findMany({ where: { ...((user.role === "OWNER" || user.role === "ADMIN") ? {} : { members: { some: { userId: user.id } } }), ...(projectId ? { id: projectId } : {}), deadline: range, archivedAt: null }, select: { id: true, name: true, deadline: true, status: true }, orderBy: { deadline: "asc" } }),
  ]);
  return Response.json({ events: [...tasks.map((task) => ({ id: task.id, title: task.title, date: task.dueDate, kind: "task", status: task.status, priority: task.priority, project: task.project })), ...projects.map((project) => ({ id: project.id, title: project.name, date: project.deadline, kind: "project", status: project.status, priority: null, project: { id: project.id, name: project.name } }))] });
}
