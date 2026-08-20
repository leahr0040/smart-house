// Lowercase the first character only (PascalCase → camelCase, e.g.
// "RefreshToken" → "refreshToken"). Not the same as toLowerCase(), which would
// flatten multi-word names ("refreshtoken").
export const lowerFirst = (s: string): string =>
  s.charAt(0).toLowerCase() + s.slice(1)
