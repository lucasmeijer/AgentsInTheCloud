import type { WorkspaceClientControllerConstructor } from "@agents-in-the-cloud/shared";

interface CommitLinkLabel { found: boolean; html: string }
const labels = new Map<string, Promise<CommitLinkLabel>>();

function label(url: string): Promise<CommitLinkLabel> {
  let loaded = labels.get(url);
  if (!loaded) {
    loaded = fetch(url, { headers: { Accept: "text/html" } }).then(async result => {
      if (!result.ok && result.status !== 404) throw new Error(`Couldn’t load commit label: ${result.status}`);
      return { found: result.ok, html: await result.text() };
    });
    labels.set(url, loaded);
    loaded.catch(() => labels.delete(url));
  }
  return loaded;
}

export function createCommitLinkController(Controller: WorkspaceClientControllerConstructor) {
  return class CommitLinkController extends Controller {
    declare readonly element: HTMLAnchorElement;
    static targets = ["label"];
    static values = { url: String };
    declare readonly labelTarget: HTMLElement;
    declare readonly urlValue: string;
    private shown?: string;

    async urlValueChanged(): Promise<void> {
      const url = this.urlValue;
      const { found, html } = await label(url);
      if (url !== this.urlValue || !this.element.isConnected) return;
      this.labelTarget.innerHTML = html;
      if (!found) {
        this.element.removeAttribute("href");
        this.element.dataset.missing = "true";
      }
      this.shown = url;
    }

    preserve(event: CustomEvent<{ newElement: Element }>): void {
      const incoming = event.detail.newElement;
      if (event.target === this.element && incoming instanceof HTMLElement && incoming.dataset.commitLinkUrlValue === this.shown) event.preventDefault();
    }
  };
}
