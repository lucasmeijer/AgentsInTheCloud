import { Controller } from "@hotwired/stimulus";

export class MarkdownDiffController extends Controller<HTMLElement> {
  connect(): void {
    if (this.element.shadowRoot) return;
    const template = this.element.querySelector<HTMLTemplateElement>(":scope > template[data-markdown-diff-content]")!;
    this.element.attachShadow({ mode: "open" }).append(template.content);
    template.remove();
  }
}
