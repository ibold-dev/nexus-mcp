export function symbolSearchText(name: string): string {
  return name
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/([\p{Lu}])(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

export function toFullTextQuery(input: string): string | undefined {
  const tokens = input.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) {
    return undefined;
  }
  return tokens.map((token) => `${token}*`).join(" | ");
}
