import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { WorkspaceShell } from "@/components/workspace-shell";

export default async function ProtectedLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const workspace = await db.workspace.findUnique({ where: { id: "main" }, select: { name: true } });
  return <WorkspaceShell user={user} workspaceName={workspace?.name ?? "Cyraops"}>{children}</WorkspaceShell>;
}
