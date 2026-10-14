export function daysAgo(days: number) {
  return new Date(Date.now() - days * 86_400_000);
}
