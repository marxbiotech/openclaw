// Distribution identity is separate from the shared openclaw CLI and plugin SDK names.
export const DEFAULT_OPENCLAW_PACKAGE_NAME = "openclaw";
export const OPENCLAW_PACKAGE_NAMES = [
  DEFAULT_OPENCLAW_PACKAGE_NAME,
  "@marxbiotech/openclaw",
] as const;

export function isOpenClawPackageName(
  value: unknown,
): value is (typeof OPENCLAW_PACKAGE_NAMES)[number] {
  return OPENCLAW_PACKAGE_NAMES.some((name) => name === value);
}
