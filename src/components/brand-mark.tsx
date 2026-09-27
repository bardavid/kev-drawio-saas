import Image from "next/image";
import Link from "next/link";

export function BrandMark() {
  return (
    <Link href="/" className="flex min-w-0 items-center gap-2 text-sm font-medium tracking-tight text-foreground">
      <Image src="/logo.svg" alt="" width={72} height={48} priority unoptimized className="h-8 w-auto shrink-0" />
      <span className="truncate">draw.ai</span>
    </Link>
  );
}
