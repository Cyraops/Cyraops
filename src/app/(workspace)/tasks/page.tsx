import { TasksBoard } from "@/components/modules/tasks-board";

export const metadata = {
  title: "Tasks | Cyraops CRM",
  description: "Every ticket in one place: what exists, who owns it, and what needs a decision.",
};

export default function TasksPage() {
  return <TasksBoard />;
}
