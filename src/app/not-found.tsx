import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-sm text-muted-foreground">Not found.</p>
      <Link href="/" className={buttonVariants({ variant: "outline" })}>
        draw.ai
      </Link>
    </div>
  );
}
