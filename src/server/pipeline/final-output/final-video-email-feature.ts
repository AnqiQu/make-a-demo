export function finalVideoEmailsEnabled(
  env: Record<string, string | undefined>,
) {
  const value = env.FINAL_VIDEO_EMAILS_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true";
}
