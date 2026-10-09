/// <reference lib="dom" />

import { ScrollbarController } from "./scrollbar/scrollbar-controller.ts";

import { TabStripController } from "./tab-strip/tab-strip-controller.ts";

import { MarkdownDiffController } from "./markdown/markdown-diff-controller.ts";
import { PerimeterButtonController } from "./perimeter-button/perimeter-button-controller.ts";
import { WarningBannersController } from "./warning-banner/warning-banner-controller.ts";
import { ManagedListController } from "./managed-list/managed-list-controller.ts";

import type { Application } from "@hotwired/stimulus";
import { ContentRowActionsController } from "./content-row/content-row-actions-controller.ts";
import { ContentRowController } from "./content-row/content-row-controller.ts";
import { ButtonConfirmationController } from "./button-confirmation/button-confirmation-controller.ts";
import { CopyButtonController } from "./copy-button/copy-button-controller.ts";
import { DestructiveConfirmationController } from "./destructive-confirmation/destructive-confirmation-controller.ts";
import { DialogController } from "./dialog/dialog-controller.ts";
import { HelpTipController } from "./help-tip/help-tip-controller.ts";
import { LinearNavigationController } from "./linear-navigation/linear-navigation-controller.ts";
import { PopupController, PopupSelectController } from "./popup/popup-controller.ts";
import { TransientFeedbackController } from "./transient-feedback/transient-feedback-controller.ts";
import { ToggleController } from "./toggle/toggle-controller.ts";

export function registerDesignSystemControllers(application: Pick<Application, "register">): void {
  application.register("scrollbars", ScrollbarController);
  application.register("tab-strip", TabStripController);
  application.register("markdown-diff", MarkdownDiffController);
  application.register("perimeter-button", PerimeterButtonController);
  application.register("warning-banners", WarningBannersController);
  application.register("content-rows", ContentRowController);
  application.register("content-row-actions", ContentRowActionsController);
  application.register("button-confirmation", ButtonConfirmationController);
  application.register("copy-button", CopyButtonController);
  application.register("destructive-confirmation", DestructiveConfirmationController);
  application.register("dialog", DialogController);
  application.register("help-tip", HelpTipController);
  application.register("linear-navigation", LinearNavigationController);
  application.register("managed-list", ManagedListController);
  application.register("popup-menu", PopupController);
  application.register("popup-select", PopupSelectController);
  application.register("toggle", ToggleController);
  application.register("transient-feedback", TransientFeedbackController);
}
