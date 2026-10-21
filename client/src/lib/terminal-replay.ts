// Replaying old output can repeat terminal identification queries. Their
// answers belong to the old interaction and must not reach the live shell.
export function isReplayDeviceResponse(data: string): boolean {
  return /^(?:\x1b\[[?>][0-9;]*c)+$/.test(data);
}
