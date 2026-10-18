/** Escape label characters that would otherwise terminate a follow-up marker. */
export function escapeFollowUpMarkerLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}
