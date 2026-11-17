import { agentsInTheCloudObservableTerminalTheme, createObservableTerminalViewer, observableWebSocketUrl, type ObservableTerminalViewer } from "@agents-in-the-cloud/observable-terminal/client";

export function createProvisionTerminalController(Controller: new (...args: never[]) => { element: Element }) {
  return class ProvisionTerminalController extends Controller {
    static values = { url: String };
    declare readonly element: HTMLElement;
    declare readonly urlValue: string;
    private viewer?: ObservableTerminalViewer;

    connect(): void {
      this.start();
    }

    disconnect(): void {
      this.viewer?.dispose();
      this.viewer = undefined;
    }

    theme(): void {
      this.viewer?.setTheme(agentsInTheCloudObservableTerminalTheme());
    }

    private start(): void {
      if (this.viewer) return;
      const style = getComputedStyle(this.element);
      this.viewer = createObservableTerminalViewer({
        host: this.element,
        websocketUrl: observableWebSocketUrl(`${this.urlValue}?cols=120&rows=30`),
        mode: "fixed-readonly",
        cols: 120,
        rows: 30,
        fontFamily: style.getPropertyValue("--font-mono"),
        fontSize: Number.parseFloat(style.getPropertyValue("--text-code")),
        theme: agentsInTheCloudObservableTerminalTheme(),
        disconnectedMessage: "\r\n[provision terminal disconnected]\r\n",
        errorMessage: "\r\n[provision terminal websocket error]\r\n",
      });
    }
  };
}
