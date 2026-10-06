export function safeTerminalText(text: string) {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 27) {
      const marker = text[index + 1];
      index += 2;
      if (marker === "[") {
        while (index < text.length) {
          const part = text.charCodeAt(index++);
          if (part >= 64 && part <= 126) break;
        }
      } else if (marker === "]") {
        while (index < text.length) {
          const part = text.charCodeAt(index++);
          if (part === 7) break;
          if (part === 27 && text[index] === "\\") {
            index++;
            break;
          }
        }
      }
      continue;
    }
    if (code >= 32 && code !== 127 && (code < 128 || code > 159))
      result += text[index];
    index++;
  }
  return result;
}
