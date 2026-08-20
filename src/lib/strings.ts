// First char only (RefreshToken → refreshToken); toLowerCase would flatten the rest.
export const lowerFirst = (s: string): string =>
  s.charAt(0).toLowerCase() + s.slice(1)
