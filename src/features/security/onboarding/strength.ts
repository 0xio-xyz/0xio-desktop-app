export const MIN_PASSWORD = 8;

export function strengthBars(password: string): number {
  if (password.length < MIN_PASSWORD) return 0;
  let score = 1;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (/[a-z]/.test(password)) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;
  if (score <= 2) return 1;
  if (score <= 4) return 2;
  if (score <= 5) return 3;
  return 4;
}
