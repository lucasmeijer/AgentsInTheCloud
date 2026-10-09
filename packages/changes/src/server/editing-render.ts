import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { dialogHtml } from "@agents-in-the-cloud/design-system/dialog";
import { Icons } from "@agents-in-the-cloud/design-system/icons";

const action = (caption: string, method: string, variant: "primary" | "secondary" = "secondary") => buttonHtml({ type: "button", variant, content: { kind: "caption", caption }, attributesHtml: `data-action="changes-edit#${method}"` });
export function renderEditFeedback(): string {
  return `<span class="changes-edit-status" role="status" data-changes-edit-target="status"></span>
    <div class="changes-edit-stale" role="status" data-changes-edit-target="stale" hidden>Changes updated in the workspace. Save or discard your edit to refresh.</div>
    ${dialogHtml({ element: { actions: "cancel->changes-edit#stay", attributesHtml: 'data-changes-edit-target="confirmation"' }, iconHtml: Icons.Changes, titleCaption: "Save your edits?", bodyHtml: '<p>Your edits haven’t been saved. Save them to the workspace file, or discard them before leaving this edit.</p><p class="changes-edit-dialog-error" role="alert" data-changes-edit-target="dialogError" hidden></p>', footerHtml: `${action("Copy edits", "copy")}${action("Stay", "stay")}${action("Discard", "discard")}${action("Save", "saveAndContinue", "primary")}` })}`;
}

export function renderFileEditActions(): string {
  return `<span class="changes-file-edit-actions" hidden>${action("Discard", "discardFile")}${action("Save", "save", "primary")}</span>`;
}
