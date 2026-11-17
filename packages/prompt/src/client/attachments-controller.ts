import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@agents-in-the-cloud/shared";

declare global {
  interface Window { Turbo?: { renderStreamMessage(html: string): void }; }
}

let dropGuardInstalled = false;

function dragHasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function clearAgentDropTargets(): void {
  document.querySelectorAll<HTMLElement>(".agent-dropping").forEach((element) => element.classList.remove("agent-dropping"));
}

function installDropGuard(): void {
  if (dropGuardInstalled) return;
  dropGuardInstalled = true;
  window.addEventListener("dragover", (event) => {
    if (dragHasFiles(event)) event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    if (dragHasFiles(event)) event.preventDefault();
    clearAgentDropTargets();
  });
  window.addEventListener("dragend", clearAgentDropTargets);
}

export function createAgentAttachmentsController(Controller: StimulusControllerConstructor) {
  return class AgentAttachmentsController extends Controller {
    static values = { uploadUrl: String };
    static targets = ["row", "status", "file"];
    declare readonly element: HTMLElement;
    declare readonly uploadUrlValue: string;
    declare readonly rowTarget: HTMLElement;
    declare readonly statusTarget: HTMLElement;
    declare readonly fileTarget: HTMLInputElement;

    connect(): void {
      installDropGuard();
    }

    openPicker(): void { this.fileTarget.click(); }

    choose(event: Event): void {
      // SAFETY: This action is attached to the host-rendered file input.
      const input = event.currentTarget as HTMLInputElement;
      for (const file of Array.from(input.files ?? [])) this.upload(file);
      input.value = "";
    }

    paste(event: ClipboardEvent): void {
      const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
      if (images.length === 0) return;
      event.preventDefault();
      this.showStatus("");
      for (const image of images) this.upload(image);
    }

    private showStatus(message: string): void {
      this.statusTarget.textContent = message;
      this.statusTarget.hidden = !message;
    }

    dragOver(event: DragEvent): void {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!this.element.classList.contains("agent-dropping")) {
        this.element.dispatchEvent(new CustomEvent("agent-attachments:files", { bubbles: true }));
      }
      this.element.classList.add("agent-dropping");
    }

    dragLeave(event: DragEvent): void {
      const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (next && this.element.contains(next)) return;
      this.element.classList.remove("agent-dropping");
    }

    drop(event: DragEvent): void {
      this.element.classList.remove("agent-dropping");
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      this.element.dispatchEvent(new CustomEvent("agent-attachments:files", { bubbles: true }));
      for (const file of Array.from(files)) this.upload(file);
    }

    remove(event: Event): void {
      const button = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
      const attachmentId = button?.dataset.attachmentId;
      if (!attachmentId) return;
      const url = new URL(this.uploadUrlValue, window.location.href);
      url.search = "";
      url.pathname = `${url.pathname}/${encodeURIComponent(attachmentId)}/delete`;
      void fetch(url, { method: "POST", headers: { Accept: "text/vnd.turbo-stream.html" } })
        .then((response) => response.text())
        .then((html) => window.Turbo?.renderStreamMessage(html));
    }

    private upload(file: File): void {
      const temp = document.createElement("span");
      temp.className = "agent-chip uploading";
      temp.innerHTML = `<span class="agent-chip-ico">⬆</span><span class="agent-chip-name"></span><span class="agent-chip-prog"><i style="width:0%"></i></span>`;
      temp.querySelector(".agent-chip-name")!.textContent = file.name;
      this.rowTarget.appendChild(temp);

      const data = new FormData();
      data.append("file", file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", this.uploadUrlValue);
      xhr.setRequestHeader("Accept", "text/vnd.turbo-stream.html");
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const bar = temp.querySelector<HTMLElement>(".agent-chip-prog i");
        if (bar) bar.style.width = `${Math.round((event.loaded / event.total) * 100)}%`;
      };
      xhr.onload = () => {
        temp.remove();
        if (xhr.status >= 200 && xhr.status < 300) window.Turbo?.renderStreamMessage(xhr.responseText);
        else this.showStatus(`Could not attach ${file.name} (HTTP ${xhr.status}). Try again.`);
      };
      xhr.onerror = () => {
        this.showStatus(`Could not attach ${file.name}. Check your connection and try again.`);
        temp.classList.add("error");
        temp.querySelector(".agent-chip-ico")!.textContent = "✕";
        setTimeout(() => temp.remove(), 4000);
      };
      xhr.send(data);
    }
  };
}

