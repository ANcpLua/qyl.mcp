import packageMetadata from "../package.json" with { type: "json" };
import "./mcp-home.css";

const endpoint = "https://mcp.qyl.at/mcp";
const configurations = {
  codex: {
    title: "terminal",
    value: `codex mcp add qyl --url ${endpoint}`,
  },
  claude: {
    title: "terminal",
    value: `claude mcp add --transport http qyl ${endpoint}`,
  },
  cursor: {
    title: "mcp.json",
    value: `{
  "mcpServers": {
    "qyl": {
      "url": "${endpoint}"
    }
  }
}`,
  },
} as const;

type ClientName = keyof typeof configurations;

const installCommand = document.getElementById("install-command")!;
const terminalTitle = document.getElementById("terminal-title")!;
const copyStatus = document.getElementById("copy-status")!;
const copyInstall = document.getElementById("copy-install") as HTMLButtonElement;
let selectedClient: ClientName = "codex";
let statusTimer: ReturnType<typeof setTimeout> | undefined;

function renderConfiguration(): void {
  const configuration = configurations[selectedClient];
  terminalTitle.textContent = configuration.title;
  installCommand.textContent = configuration.value;
}

function reportCopy(message: string): void {
  copyStatus.textContent = message;
  copyStatus.classList.add("visible");
  if (statusTimer !== undefined) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => copyStatus.classList.remove("visible"), 1800);
}

async function copy(value: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    reportCopy(`${label} copied`);
  } catch {
    reportCopy("Select the text and copy it manually");
  }
}

for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-client]")) {
  tab.addEventListener("click", () => {
    selectedClient = tab.dataset.client as ClientName;
    for (const candidate of document.querySelectorAll<HTMLButtonElement>("[data-client]")) {
      candidate.setAttribute("aria-selected", String(candidate === tab));
    }
    renderConfiguration();
  });
}

document.getElementById("copy-endpoint")!.addEventListener("click", () => {
  void copy(endpoint, "Endpoint");
});

copyInstall.addEventListener("click", () => {
  void copy(configurations[selectedClient].value, "Configuration");
});

document.getElementById("release-version")!.textContent = `v${packageMetadata.version}`;
renderConfiguration();
