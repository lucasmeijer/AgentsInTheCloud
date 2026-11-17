import { Controller } from "@hotwired/stimulus";
import { setActivityButtonState } from "@agents-in-the-cloud/design-system/activity-button/client";

const quietKey = "agents-in-the-cloud.pwa-reminder.quiet";
const animationDeadline = performance.now() + 60_000;

export class PwaReminderController extends Controller<HTMLElement> {
  static targets = ["button", "dialog", "guide"];
  declare readonly buttonTarget: HTMLButtonElement;
  declare readonly dialogTarget: HTMLDialogElement;
  declare readonly guideTargets: HTMLElement[];
  private animationTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly standalone = window.matchMedia("(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)");

  connect(): void {
    const platform = installationPlatform();
    for (const guide of this.guideTargets) guide.hidden = guide.dataset.platform !== platform;
    this.standalone.addEventListener("change", this.refresh);
    this.refresh();
    this.animationTimer = setTimeout(this.refresh, Math.max(0, Math.ceil(animationDeadline - performance.now())));
  }

  disconnect(): void {
    clearTimeout(this.animationTimer);
    this.standalone.removeEventListener("change", this.refresh);
  }

  readonly refresh = (): void => {
    const installedWindow = this.standalone.matches || ("standalone" in navigator && navigator.standalone === true);
    this.element.hidden = installedWindow;
    if (installedWindow) this.dialogTarget.close();
    const quiet = performance.now() >= animationDeadline || localStorage.getItem(quietKey) === "true";
    setActivityButtonState(this.buttonTarget, quiet ? "initial" : "active");
  };

  open(): void { this.dialogTarget.showModal(); }
  quiet(): void {
    localStorage.setItem(quietKey, "true");
    this.refresh();
  }
}

function installationPlatform(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ipad";
  if (/iPhone|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Edg\//.test(ua)) return "edge";
  if (/Chrome\//.test(ua)) return "chrome";
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Firefox\//.test(ua)) return "mac";
  return "other";
}
