import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-2xl font-medium tracking-tight">That page is not on the diagram.</p>
      <Link href="/" className={buttonVariants()}>
        Back home
      </Link>
    </div>
  );
}
