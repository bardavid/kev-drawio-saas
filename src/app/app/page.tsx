import type { Metadata } from "next";
import { Workspace } from "@/components/workspace/workspace";

export const metadata: Metadata = {
  title: "Workspace",
  description: "Chat with Kev and watch the draw.io diagram update.",
};

export default function AppPage() {
  return <Workspace />;
}
