/* Runs in the Electron welcome window before the backend is up.
 * Has access to `window.controller` exposed by electron/preload.ts.
 */

const MIN_PORT = 1024;
const MAX_PORT = 65535;
const STORAGE_KEY = "controller.port";
const DEFAULT_PORT = 4500;
const FEEDBACK_DEBOUNCE_MS = 250;
const CHECK_PORT_TIMEOUT_MS = 5000;
const AUTO_START_TIMEOUT_MS = 5000;
const AUTO_START_SHOW_WINDOW_MS = 1500;

declare const window: Window & {
  controller?: {
    isElectron: true;
    checkPort: (port: number) => Promise<{
      available: boolean;
      suggestion?: number;
      error?: string;
    }>;
    startServer: (port: number) => Promise<{ port: number; url: string }>;
    onStatus: (cb: (status: unknown) => void) => () => void;
    navigateToApp: (url: string) => void;
    showWindow: () => void;
    quit: () => void;
  };
};

interface DomRefs {
  form: HTMLFormElement;
  input: HTMLInputElement;
  continueBtn: HTMLButtonElement;
  feedback: HTMLElement;
}

function getDomRefs(): DomRefs {
  const form = document.getElementById("welcome-form") as HTMLFormElement | null;
  const input = document.getElementById("port-input") as HTMLInputElement | null;
  const continueBtn = document.getElementById("continue-btn") as HTMLButtonElement | null;
  const feedback = document.getElementById("port-feedback") as HTMLElement | null;
  if (!form || !input || !continueBtn || !feedback) {
    throw new Error("Welcome UI: required DOM nodes are missing");
  }
  return { form, input, continueBtn, feedback };
}

function parsePort(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) return null;
  return parsed;
}

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

function readSavedPort(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return isValidPort(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeSavedPort(port: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(port));
  } catch {
    // Ignore quota / private mode errors; the welcome screen will show again
    // on next launch but the user's port choice is still applied for this run.
  }
}

function clearFeedbackClasses(feedback: HTMLElement): void {
  feedback.classList.remove(
    "welcome__feedback--error",
    "welcome__feedback--success",
    "welcome__feedback--warning"
  );
}

function setFeedback(
  feedback: HTMLElement,
  text: string,
  variant: "neutral" | "error" | "success" | "warning"
): void {
  clearFeedbackClasses(feedback);
  feedback.textContent = text;
  if (variant === "error") feedback.classList.add("welcome__feedback--error");
  else if (variant === "success") feedback.classList.add("welcome__feedback--success");
  else if (variant === "warning") feedback.classList.add("welcome__feedback--warning");
}

function setInputValidity(input: HTMLInputElement, invalid: boolean): void {
  if (invalid) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

function setContinueEnabled(button: HTMLButtonElement, enabled: boolean): void {
  button.disabled = !enabled;
}

function appendSuggestionButton(
  feedback: HTMLElement,
  suggestion: number,
  onAccept: (port: number) => void
): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "welcome__button welcome__button--link";
  button.textContent = `Use ${suggestion} instead`;
  button.addEventListener("click", () => onAccept(suggestion));
  feedback.appendChild(button);
}

let checkSeq = 0;

async function refreshPortCheck(
  refs: DomRefs,
  raw: string,
  onSuggestion: (port: number) => void
): Promise<void> {
  const seq = ++checkSeq;
  const parsed = parsePort(raw);

  if (parsed === null) {
    setInputValidity(refs.input, true);
    setContinueEnabled(refs.continueBtn, false);
    setFeedback(
      refs.feedback,
      "Enter a number between 1024 and 65535.",
      "error"
    );
    return;
  }

  if (!isValidPort(parsed)) {
    setInputValidity(refs.input, true);
    setContinueEnabled(refs.continueBtn, false);
    if (parsed < MIN_PORT) {
      setFeedback(
        refs.feedback,
        "Use a port ≥ 1024.",
        "error"
      );
    } else {
      setFeedback(
        refs.feedback,
        "Enter a number between 1024 and 65535.",
        "error"
      );
    }
    return;
  }

  // After this point, `parsed` is a valid port in [1024, 65535]. Capture it
  // in a new const so the narrowing survives across the awaited calls below.
  const port = parsed;

  if (!window.controller) {
    setInputValidity(refs.input, true);
    setContinueEnabled(refs.continueBtn, false);
    setFeedback(
      refs.feedback,
      "Controller bridge is not available. Please restart the app.",
      "error"
    );
    return;
  }

  setInputValidity(refs.input, false);
  setContinueEnabled(refs.continueBtn, false);
  setFeedback(refs.feedback, "Checking port...", "neutral");

  let result: { available: boolean; suggestion?: number; error?: string };
  try {
    result = await withTimeout(
      window.controller.checkPort(port),
      CHECK_PORT_TIMEOUT_MS,
      "Port check timed out"
    );
  } catch (err) {
    if (seq !== checkSeq) return;
    setInputValidity(refs.input, true);
    setContinueEnabled(refs.continueBtn, false);
    const message = err instanceof Error ? err.message : String(err);
    setFeedback(
      refs.feedback,
      `Couldn't check port: ${message}`,
      "error"
    );
    return;
  }

  if (seq !== checkSeq) return;

  if (result.available) {
    setInputValidity(refs.input, false);
    setContinueEnabled(refs.continueBtn, true);
    setFeedback(refs.feedback, `✓ Port ${port} is available.`, "success");
    return;
  }

  if (result.suggestion && isValidPort(result.suggestion)) {
    setInputValidity(refs.input, false);
    setContinueEnabled(refs.continueBtn, false);
    setFeedback(
      refs.feedback,
      `Port ${port} is in use. `,
      "warning"
    );
    appendSuggestionButton(refs.feedback, result.suggestion, (suggested) => {
      onSuggestion(suggested);
    });
    return;
  }

  setInputValidity(refs.input, true);
  setContinueEnabled(refs.continueBtn, false);
  setFeedback(
    refs.feedback,
    result.error
      ? `Port ${port} is not available: ${result.error}`
      : `Port ${port} is not available.`,
    "error"
  );
}

type AnyAsyncFn = (raw: string) => Promise<void> | void;

function debounce(
  fn: AnyAsyncFn,
  delay: number
): (raw: string) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (raw: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void fn(raw);
    }, delay);
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function handleSubmit(
  refs: DomRefs,
  event: Event
): Promise<void> {
  event.preventDefault();
  const parsed = parsePort(refs.input.value);
  if (parsed === null || !isValidPort(parsed)) {
    setInputValidity(refs.input, true);
    setFeedback(
      refs.feedback,
      "Enter a number between 1024 and 65535.",
      "error"
    );
    return;
  }
  // Capture the narrowed value so the `number` type survives across awaits.
  const port = parsed;

  if (!window.controller) {
    setFeedback(
      refs.feedback,
      "Controller bridge is not available. Please restart the app.",
      "error"
    );
    return;
  }

  setContinueEnabled(refs.continueBtn, false);
  refs.input.disabled = true;
  setFeedback(refs.feedback, "Starting backend...", "neutral");

  try {
    const result = await window.controller.startServer(port);
    writeSavedPort(result.port);
    window.controller.navigateToApp(result.url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setInputValidity(refs.input, true);
    refs.input.disabled = false;
    setContinueEnabled(refs.continueBtn, true);
    setFeedback(
      refs.feedback,
      `Failed to start: ${message}`,
      "error"
    );
  }
}

function applySuggestion(refs: DomRefs, port: number): void {
  refs.input.value = String(port);
  void refreshPortCheck(refs, refs.input.value, (suggested) => {
    applySuggestion(refs, suggested);
  });
}

async function tryAutoStart(refs: DomRefs, port: number): Promise<boolean> {
  if (!window.controller) {
    console.error("[welcome] tryAutoStart: no controller bridge");
    return false;
  }
  console.log(`[welcome] tryAutoStart: checkPort(${port})`);
  let check: { available: boolean; suggestion?: number; error?: string };
  try {
    check = await window.controller.checkPort(port);
  } catch (err) {
    console.error("[welcome] tryAutoStart: checkPort failed:", err);
    return false;
  }
  console.log(`[welcome] tryAutoStart: checkPort(${port}) ->`, check);
  if (!check.available) return false;
  console.log(`[welcome] tryAutoStart: startServer(${port})`);
  try {
    const result = await window.controller.startServer(port);
    console.log(`[welcome] tryAutoStart: startServer ->`, result);
    window.controller.navigateToApp(result.url);
    return true;
  } catch (err) {
    console.error("[welcome] tryAutoStart: startServer failed:", err);
    return false;
  }
}

function init(): void {
  console.log("[welcome] init() start");
  const refs = getDomRefs();
  const saved = readSavedPort();
  const initialPort = saved ?? DEFAULT_PORT;
  refs.input.value = String(initialPort);
  console.log(`[welcome] initial port = ${initialPort} (saved=${saved})`);

  const handleSuggestion = (port: number) => {
    applySuggestion(refs, port);
  };

  const debouncedCheck = debounce(
    (raw: string) => {
      void refreshPortCheck(refs, raw, handleSuggestion);
    },
    FEEDBACK_DEBOUNCE_MS
  );

  refs.input.addEventListener("input", () => {
    debouncedCheck(refs.input.value);
  });

  refs.form.addEventListener("submit", (event) => {
    void handleSubmit(refs, event);
  });

  // First-run: show the window immediately so the user sees the welcome screen.
  // Subsequent runs: try to auto-start on the saved port without showing the UI.
  if (saved === null) {
    console.log("[welcome] first run, showing window");
    window.controller?.showWindow();
    void refreshPortCheck(refs, refs.input.value, handleSuggestion);
    return;
  }

  console.log(`[welcome] attempting auto-start on saved port ${saved}`);
  // Show the window after a short delay regardless, so the user always sees
  // *something* even if the auto-start IPC hangs. This is a hard fallback
  // in addition to the per-IPC timeouts in the main process.
  const showWindowTimeout = setTimeout(() => {
    console.warn("[welcome] auto-start taking too long, showing window");
    window.controller?.showWindow();
    setFeedback(
      refs.feedback,
      "Auto-start is taking a while. You can pick a different port.",
      "warning"
    );
  }, AUTO_START_SHOW_WINDOW_MS);

  void (async () => {
    try {
      const started = await withTimeout(
        tryAutoStart(refs, saved),
        AUTO_START_TIMEOUT_MS,
        "Auto-start timed out"
      );
      clearTimeout(showWindowTimeout);
      if (started) {
        console.log("[welcome] auto-start succeeded");
        return;
      }
      console.log("[welcome] auto-start returned false, showing window");
      window.controller?.showWindow();
      void refreshPortCheck(refs, refs.input.value, handleSuggestion);
    } catch (err) {
      clearTimeout(showWindowTimeout);
      console.error("[welcome] auto-start threw:", err);
      window.controller?.showWindow();
      setFeedback(
        refs.feedback,
        `Auto-start failed: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
      void refreshPortCheck(refs, refs.input.value, handleSuggestion);
    }
  })();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
