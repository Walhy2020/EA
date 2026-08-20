"use strict";

const panes = [...document.querySelectorAll(".pane")];
const refreshAllButton = document.getElementById("refreshAllButton");

function paneUrl(pane) {
  const params = new URLSearchParams({
    userName: pane.dataset.person || "",
    panel: pane.dataset.panel || "create",
    embed: "1",
    ts: String(Date.now())
  });
  return `./demand-h5.html?${params.toString()}`;
}

function refreshPane(pane) {
  const frame = pane.querySelector("iframe");
  if (!frame) {
    return;
  }
  frame.src = paneUrl(pane);
}

function refreshAll() {
  for (const pane of panes) {
    refreshPane(pane);
  }
}

if (refreshAllButton) {
  refreshAllButton.addEventListener("click", refreshAll);
}

refreshAll();
