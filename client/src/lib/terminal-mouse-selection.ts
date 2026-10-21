export function handleTerminalMouseDown(event: MouseEvent): void {
  if (event.button === 2) {
    // Keep xterm from forwarding the press to tmux, which otherwise opens a
    // second menu. The separate contextmenu event still reaches xterm and
    // Electron so selected text can be copied through the native menu.
    event.stopPropagation();
    return;
  }
  if (event.button !== 0) return;

  // Preserve the existing forced-selection behavior when tmux mouse mode is
  // active: xterm sees a selection modifier instead of sending the drag.
  Object.defineProperties(event, {
    altKey: { configurable: true, value: true },
    shiftKey: { configurable: true, value: true },
  });
}
