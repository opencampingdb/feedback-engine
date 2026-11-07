/**
 * The text of each element of the array under `key` in a JSON object, as it
 * was sent: spaces, escapes and all. `text` must be JSON that `JSON.parse`
 * has already read, so it is not checked again. When the object has `key`
 * more than once, the last one counts, as `JSON.parse` does. Undefined when
 * `text` is not an object or `key` is not an array in it.
 */
export function arrayElementTexts(text: string, key: string): string[] | undefined {
  let i = 0;
  const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";
  const skipSpace = () => {
    while (isSpace(text[i])) i++;
  };
  // At a string's opening quote: moves past its closing quote.
  const skipString = () => {
    i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
  };
  // At the start of a value: moves past its end.
  const skipValue = () => {
    const c = text[i];
    if (c === '"') return skipString();
    if (c === "{" || c === "[") {
      let depth = 0;
      do {
        const here = text[i];
        if (here === '"') {
          skipString();
          continue;
        }
        if (here === "{" || here === "[") depth++;
        else if (here === "}" || here === "]") depth--;
        i++;
      } while (depth > 0);
      return;
    }
    // A number, true, false or null.
    while (i < text.length && !isSpace(text[i]) && text[i] !== "," && text[i] !== "}" && text[i] !== "]") i++;
  };

  skipSpace();
  if (text[i] !== "{") return undefined;
  i++;
  let found: string[] | undefined;
  for (;;) {
    skipSpace();
    if (text[i] === "}") break;
    const nameStart = i;
    skipString();
    const name: unknown = JSON.parse(text.slice(nameStart, i));
    skipSpace();
    i++; // the colon
    skipSpace();
    if (name === key) {
      if (text[i] === "[") {
        const elements: string[] = [];
        i++;
        for (;;) {
          skipSpace();
          if (text[i] === "]") {
            i++;
            break;
          }
          const start = i;
          skipValue();
          elements.push(text.slice(start, i));
          skipSpace();
          if (text[i] === ",") i++;
        }
        found = elements;
      } else {
        skipValue();
        found = undefined;
      }
    } else {
      skipValue();
    }
    skipSpace();
    if (text[i] === ",") i++;
  }
  return found;
}
