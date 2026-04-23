const OVERLAY_ID = "toonflow-image-preview-overlay";

let removeKeydownListener: (() => void) | null = null;

function closeExistingOverlay() {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  if (removeKeydownListener) {
    removeKeydownListener();
    removeKeydownListener = null;
  }
}

function setStyle(element: HTMLElement, style: Partial<CSSStyleDeclaration>) {
  Object.assign(element.style, style);
}

export function openImagePreview(src?: string) {
  if (!src || typeof document === "undefined") return;

  closeExistingOverlay();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  setStyle(overlay, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "48px",
    background: "rgba(0, 0, 0, 0.82)",
    pointerEvents: "auto",
    isolation: "isolate",
    boxSizing: "border-box",
  });

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "X";
  closeButton.setAttribute("aria-label", "Close preview");
  setStyle(closeButton, {
    position: "fixed",
    top: "20px",
    right: "24px",
    zIndex: "1",
    width: "40px",
    height: "40px",
    padding: "0",
    border: "0",
    borderRadius: "50%",
    background: "rgba(255, 255, 255, 0.16)",
    color: "#fff",
    cursor: "pointer",
    fontSize: "18px",
    fontWeight: "700",
    lineHeight: "38px",
  });

  const stage = document.createElement("div");
  setStyle(stage, {
    maxWidth: "100%",
    maxHeight: "100%",
  });

  const image = document.createElement("img");
  image.src = src;
  image.draggable = false;
  setStyle(image, {
    display: "block",
    maxWidth: "92vw",
    maxHeight: "88vh",
    objectFit: "contain",
    borderRadius: "8px",
    boxShadow: "0 18px 60px rgba(0, 0, 0, 0.45)",
    userSelect: "none",
  });

  const close = () => {
    closeExistingOverlay();
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };

  overlay.addEventListener("click", close);
  closeButton.addEventListener("click", close);
  stage.addEventListener("click", (event) => event.stopPropagation());
  window.addEventListener("keydown", onKeydown);
  removeKeydownListener = () => window.removeEventListener("keydown", onKeydown);

  stage.appendChild(image);
  overlay.appendChild(closeButton);
  overlay.appendChild(stage);
  document.body.appendChild(overlay);
}
