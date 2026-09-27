/** Read server env at runtime. Dynamic access avoids Next inlining values at build time. */
export function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
