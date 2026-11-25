export function isWindowsHello(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

export function biometricLabel(): string {
  return isWindowsHello() ? "Windows Hello" : "Touch ID";
}
