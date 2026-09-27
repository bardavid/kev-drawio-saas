import Link from "next/link";

export function BrandMark({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 text-sm font-medium tracking-tight text-foreground">
      <span className="grid size-5 place-items-center rounded-sm border border-foreground/80" aria-hidden>
        <span className="size-1.5 rounded-[1px] border border-foreground/80" />
      </span>
      Kev Diagram
    </Link>
  );
}
