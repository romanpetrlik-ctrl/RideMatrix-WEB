(function stagedVehicleRecordDocumentUpload() {
  const form = document.getElementById("recordDocumentBatchForm");
  if (!form) return;
  const categorySelect = document.getElementById("recordDocumentCategory");
  const fileInput = document.getElementById("recordDocumentFiles");
  const addButton = document.getElementById("addRecordDocumentsToQueue");
  const queueContainer = document.getElementById("recordDocumentQueue");
  const feedback = document.getElementById("recordDocumentQueueFeedback");
  const submitButton = document.getElementById("submitRecordDocumentQueue");
  const csrfInput = form.querySelector('input[name="_csrf"]');
  if (!categorySelect || !fileInput || !addButton || !queueContainer || !feedback || !submitButton || !csrfInput) return;

  const queue = new Map();
  const toLabel = (category) => categorySelect.querySelector(`option[value="${category}"]`)?.textContent || category;
  const queuedFiles = () => Array.from(queue.values()).reduce((count, files) => count + files.length, 0);
  const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (match) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[match] || match);

  function setFeedback(message, warning) {
    feedback.innerHTML = message
      ? `<p class="form-help${warning ? " notice--warning" : ""}">${escapeHtml(message)}</p>`
      : "";
  }

  function updateSubmitState() {
    submitButton.disabled = queuedFiles() === 0;
  }
  function emitQueueChange() {
    document.dispatchEvent(new CustomEvent("vehicle-record-document-queue-change", {
      detail: { pendingCategories: Array.from(queue.keys()) }
    }));
  }

  function removeQueueItem(category, index) {
    const files = queue.get(category) || [];
    files.splice(index, 1);
    if (!files.length) queue.delete(category);
    else queue.set(category, files);
    renderQueue();
  }

  function renderQueue() {
    if (!queuedFiles()) {
      queueContainer.innerHTML = '<p class="muted">No files staged yet.</p>';
      updateSubmitState();
      emitQueueChange();
      return;
    }
    const groups = Array.from(queue.entries()).map(([category, files]) => {
      const items = files.map((file, index) => (
        `<li>${escapeHtml(file.name)} <button class="button button--secondary" type="button" data-queue-category="${escapeHtml(category)}" data-queue-index="${index}">Remove</button></li>`
      )).join("");
      return `<div class="vehicle-document-queue__group"><strong>${escapeHtml(toLabel(category))}</strong><ul>${items}</ul></div>`;
    }).join("");
    queueContainer.innerHTML = groups;
    updateSubmitState();
    emitQueueChange();
  }

  addButton.addEventListener("click", () => {
    const category = String(categorySelect.value || "").trim();
    const files = Array.from(fileInput.files || []);
    if (!category) {
      setFeedback("Select a category before adding files.", true);
      return;
    }
    if (!files.length) {
      setFeedback("Select at least one file to add to the upload queue.", true);
      return;
    }
    const current = queue.get(category) || [];
    queue.set(category, current.concat(files));
    fileInput.value = "";
    setFeedback("", false);
    renderQueue();
  });

  queueContainer.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const category = target.getAttribute("data-queue-category");
    const index = Number(target.getAttribute("data-queue-index"));
    if (!category || Number.isNaN(index)) return;
    removeQueueItem(category, index);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!queuedFiles()) {
      setFeedback("Add files to the upload queue before uploading.", true);
      return;
    }
    const body = new FormData();
    body.append("_csrf", String(csrfInput.value || ""));
    for (const [category, files] of queue.entries()) {
      for (const file of files) {
        body.append(`documentsByCategory[${category}]`, file, file.name);
      }
    }
    submitButton.disabled = true;
    addButton.setAttribute("disabled", "disabled");
    setFeedback("Uploading selected documents…", false);
    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { accept: "application/json" },
        body
      });
      const result = await response.json().catch(() => ({}));
      const statuses = Array.isArray(result.statuses) ? result.statuses : [];
      if (!statuses.length && !response.ok) {
        setFeedback("Upload failed. Please try again.", true);
        return;
      }
      const nextQueue = new Map(queue);
      for (const status of statuses) {
        if (status.status !== "success") continue;
        const category = String(status.category || "");
        const files = nextQueue.get(category) || [];
        const index = files.findIndex((file) => file.name === status.name);
        if (index >= 0) files.splice(index, 1);
        if (!files.length) nextQueue.delete(category);
        else nextQueue.set(category, files);
      }
      queue.clear();
      for (const [category, files] of nextQueue.entries()) queue.set(category, files);
      const summary = statuses.map((item) => `${item.categoryLabel || item.category || "Category"} · ${item.name || "File"}: ${item.status}${item.reason ? ` (${item.reason})` : ""}`).join(" | ");
      setFeedback(summary || (response.ok ? "Upload complete." : "Upload completed with errors."), !response.ok);
      renderQueue();
      if (response.ok) window.location.href = `${window.location.pathname}?notice=document-added`;
    } catch {
      setFeedback("Upload failed. Please try again.", true);
    } finally {
      addButton.removeAttribute("disabled");
      updateSubmitState();
    }
  });

  renderQueue();
})();
