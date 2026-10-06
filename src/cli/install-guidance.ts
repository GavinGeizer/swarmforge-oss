import { basename } from "node:path";
import { shellQuote } from "./init";

export function pathGuidance(binDir: string, shell = process.env.SHELL ?? "") {
  const name = basename(shell);
  if (name === "fish")
    return `Add the executable directory to PATH:\n  fish_add_path ${shellQuote(binDir)}\n\nOpen a new terminal. In an editor workspace, run Developer: Reload Window and open a new terminal.`;
  const profile =
    name === "zsh" ? ".zshrc" : name === "bash" ? ".bashrc" : ".profile";
  const line = `export PATH=${shellQuote(binDir)}:"$PATH"`;
  return `If ${binDir} is not already on PATH, run:\n  printf '%s\\n' ${shellQuote(line)} >> "$HOME/${profile}"\n  . "$HOME/${profile}"\n  hash -r\n\nIn an editor workspace, run Developer: Reload Window and open a new terminal so it picks up PATH.`;
}
