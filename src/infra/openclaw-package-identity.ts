// Distribution identity is separate from the shared openclaw CLI and plugin SDK names.
export const OPENCLAW_PACKAGE_NAMES = ["openclaw", "@marxbiotech/openclaw"] as const;

export function isOpenClawPackageName(
  value: unknown,
): value is (typeof OPENCLAW_PACKAGE_NAMES)[number] {
  return OPENCLAW_PACKAGE_NAMES.some((name) => name === value);
}
