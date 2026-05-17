(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const emptyState = $("emptyState");
  const activeState = $("activeState");
  const statusBar = $("statusBar");
  const imagePreview = $("imagePreview");
  const canvas = $("mainCanvas");
  const ctx = canvas.getContext("2d");

  let currentImg = null;
  let generatedCode = { full: "", imports: "", component: "" };
  let activeTool = "off";
  let isDrawing = false;
  let startX = 0;
  let startY = 0;
  let mapAreas = [];
  let cropRect = null;
  let isRatioLocked = true;
  let originalRatio = 1;

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "imageSelected") {
      setCurrentImage(message.data);
    } else if (message.type === "operationState") {
      setBusy(message.data.isBusy, message.data.message);
    } else if (message.type === "codeGenerated") {
      generatedCode = message.data;
      $("codeOutput").value = generatedCode.full;
    }
  });

  function setCurrentImage(image) {
    currentImg = image;
    emptyState.hidden = true;
    activeState.hidden = false;
    imagePreview.src = currentImg.webviewUri;

    $("valName").textContent = currentImg.fileName;
    $("valSize").textContent = `${currentImg.sizeKB} KB`;
    $("valDim").textContent = currentImg.width ? `${currentImg.width}x${currentImg.height}px` : "Unknown";
    $("valExif").textContent = currentImg.hasExif ? "Detected" : "Clean";
    $("valExif").className = currentImg.hasExif ? "is-danger" : "is-success";

    $("resW").value = currentImg.width || "";
    $("resH").value = currentImg.height || "";
    $("exportFilter").value = "none";
    $("exportFormat").value = "original";
    $("resizeFit").value = "inside";
    $("exportClean").checked = Boolean(currentImg.hasExif);
    originalRatio = currentImg.width && currentImg.height ? currentImg.width / currentImg.height : 1;

    resetCanvas();
    updateExportPreview();
    requestCode();
    imagePreview.onload = () => {
      resizeCanvas();
      drawCanvas();
    };
  }

  function setBusy(isBusy, message) {
    statusBar.hidden = !isBusy;
    statusBar.textContent = message || "";
    document.querySelectorAll("button, input, select").forEach((control) => {
      control.disabled = Boolean(isBusy);
    });
    if (!isBusy) {
      $("btnApplyCrop").disabled = !cropRect;
    }
  }

  $("qualSlider").addEventListener("input", (event) => {
    $("qualValue").textContent = `${event.target.value}%`;
  });

  $("btnLockRatio").addEventListener("click", () => {
    isRatioLocked = !isRatioLocked;
    $("btnLockRatio").textContent = isRatioLocked ? "Lock" : "Free";
    if (isRatioLocked && $("resW").value) {
      $("resH").value = Math.round(Number($("resW").value) / originalRatio);
    }
    updateExportPreview();
  });

  $("resW").addEventListener("input", () => {
    if (isRatioLocked && originalRatio && $("resW").value) {
      $("resH").value = Math.round(Number($("resW").value) / originalRatio);
    }
    updateExportPreview();
  });

  $("resH").addEventListener("input", () => {
    if (isRatioLocked && originalRatio && $("resH").value) {
      $("resW").value = Math.round(Number($("resH").value) * originalRatio);
    }
    updateExportPreview();
  });

  ["exportFormat", "exportFilter", "resizeFit", "exportClean"].forEach((id) => {
    $(id).addEventListener("change", updateExportPreview);
  });

  function updateExportPreview() {
    if (!currentImg) {
      return;
    }
    const parts = [];
    if ($("resW").value && $("resH").value) {
      parts.push(`${$("resW").value}x${$("resH").value}`);
    }
    if ($("exportFormat").value !== "original") {
      parts.push($("exportFormat").value.toUpperCase());
    }
    if ($("exportFilter").value !== "none") {
      parts.push($("exportFilter").value);
    }
    $("exportPreview").textContent = parts.length
      ? `Will save a unique processed copy using ${parts.join(", ")}.`
      : "Will save a unique processed copy next to the source image.";
  }

  $("btnBatchProcess").addEventListener("click", () => {
    vscode.postMessage({
      type: "batchProcess",
      payload: {
        w: $("resW").value,
        h: $("resH").value,
        format: $("exportFormat").value,
        filter: $("exportFilter").value,
        fit: $("resizeFit").value,
        quality: $("qualSlider").value,
        clean: $("exportClean").checked,
      },
    });
  });

  document.getElementsByName("tool").forEach((radio) => {
    radio.addEventListener("change", (event) => {
      activeTool = event.target.value;
      canvas.style.pointerEvents = activeTool === "off" ? "none" : "auto";
      $("canvasHint").textContent = getCanvasHint(activeTool);
      resizeCanvas();
      drawCanvas();
    });
  });

  function getCanvasHint(tool) {
    if (tool === "crop") {
      return "Drag a crop box over the image, then apply it.";
    }
    if (tool === "mapRect" || tool === "mapCirc") {
      return "Draw image-map areas. The code generator updates automatically.";
    }
    return "Choose a canvas tool, then drag over the image preview.";
  }

  function resizeCanvas() {
    canvas.width = imagePreview.clientWidth;
    canvas.height = imagePreview.clientHeight;
  }

  window.addEventListener("resize", () => {
    resizeCanvas();
    drawCanvas();
  });

  canvas.addEventListener("mousedown", (event) => {
    if (activeTool === "off" || !currentImg) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    startX = event.clientX - rect.left;
    startY = event.clientY - rect.top;
    isDrawing = true;
  });

  canvas.addEventListener("mousemove", (event) => {
    if (!isDrawing) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const curX = event.clientX - rect.left;
    const curY = event.clientY - rect.top;
    drawCanvas();
    ctx.lineWidth = 2;
    if (activeTool === "mapRect" || activeTool === "crop") {
      ctx.strokeStyle = activeTool === "crop" ? "#007acc" : "#2ea043";
      ctx.setLineDash(activeTool === "crop" ? [5, 5] : []);
      ctx.strokeRect(startX, startY, curX - startX, curY - startY);
    } else if (activeTool === "mapCirc") {
      const radius = Math.hypot(curX - startX, curY - startY);
      ctx.strokeStyle = "#2ea043";
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(startX, startY, radius, 0, 2 * Math.PI);
      ctx.stroke();
    }
  });

  canvas.addEventListener("mouseup", (event) => {
    if (!isDrawing || !currentImg || !canvas.width || !canvas.height) {
      return;
    }
    isDrawing = false;
    const rect = canvas.getBoundingClientRect();
    const endX = event.clientX - rect.left;
    const endY = event.clientY - rect.top;
    const scaleX = currentImg.width / canvas.width;
    const scaleY = currentImg.height / canvas.height;

    if (activeTool === "mapRect") {
      const x1 = Math.round(Math.min(startX, endX) * scaleX);
      const y1 = Math.round(Math.min(startY, endY) * scaleY);
      const x2 = Math.round(Math.max(startX, endX) * scaleX);
      const y2 = Math.round(Math.max(startY, endY) * scaleY);
      if (x2 - x1 > 5 && y2 - y1 > 5) {
        mapAreas.push({ type: "rect", coords: `${x1},${y1},${x2},${y2}` });
      }
    } else if (activeTool === "mapCirc") {
      const radiusCanvas = Math.hypot(endX - startX, endY - startY);
      const radiusReal = Math.round(radiusCanvas * ((scaleX + scaleY) / 2));
      const x = Math.round(startX * scaleX);
      const y = Math.round(startY * scaleY);
      if (radiusReal > 5) {
        mapAreas.push({ type: "circle", coords: `${x},${y},${radiusReal}` });
      }
    } else if (activeTool === "crop") {
      const x = Math.round(Math.min(startX, endX) * scaleX);
      const y = Math.round(Math.min(startY, endY) * scaleY);
      const w = Math.round(Math.abs(endX - startX) * scaleX);
      const h = Math.round(Math.abs(endY - startY) * scaleY);
      if (w > 10 && h > 10) {
        cropRect = {
          x,
          y,
          w,
          h,
          drawX: Math.min(startX, endX),
          drawY: Math.min(startY, endY),
          drawW: Math.abs(endX - startX),
          drawH: Math.abs(endY - startY),
        };
        $("btnApplyCrop").disabled = false;
      }
    }
    requestCode();
    drawCanvas();
  });

  function drawCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setLineDash([]);
    if (!currentImg || !currentImg.width || !currentImg.height) {
      return;
    }
    const scaleX = canvas.width / currentImg.width;
    const scaleY = canvas.height / currentImg.height;

    if (activeTool.startsWith("map")) {
      mapAreas.forEach((area, index) => {
        ctx.fillStyle = "rgba(46, 160, 67, 0.25)";
        ctx.strokeStyle = "#2ea043";
        ctx.lineWidth = 2;
        ctx.beginPath();
        const coords = area.coords.split(",").map(Number);
        if (area.type === "rect") {
          const [x1, y1, x2, y2] = coords;
          ctx.rect(x1 * scaleX, y1 * scaleY, (x2 - x1) * scaleX, (y2 - y1) * scaleY);
        } else {
          const [x, y, radius] = coords;
          ctx.arc(x * scaleX, y * scaleY, radius * ((scaleX + scaleY) / 2), 0, 2 * Math.PI);
        }
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(String(index + 1), coords[0] * scaleX + 5, coords[1] * scaleY + 15);
      });
    } else if (activeTool === "crop" && cropRect) {
      ctx.fillStyle = "rgba(0, 122, 204, 0.25)";
      ctx.strokeStyle = "#007acc";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.fillRect(cropRect.drawX, cropRect.drawY, cropRect.drawW, cropRect.drawH);
      ctx.strokeRect(cropRect.drawX, cropRect.drawY, cropRect.drawW, cropRect.drawH);
    }
  }

  function resetCanvas() {
    mapAreas = [];
    cropRect = null;
    $("btnApplyCrop").disabled = true;
    drawCanvas();
    requestCode();
  }

  $("btnClearCanvas").addEventListener("click", resetCanvas);
  $("btnApplyCrop").addEventListener("click", () => {
    if (cropRect) {
      vscode.postMessage({ type: "cropImage", payload: cropRect });
    }
  });

  ["fwSelect", "pathMode", "respCheck"].forEach((id) => $(id).addEventListener("change", requestCode));
  $("altInput").addEventListener("input", requestCode);

  function requestCode() {
    if (!currentImg) {
      return;
    }
    vscode.postMessage({
      type: "generateCode",
      payload: {
        framework: $("fwSelect").value,
        fileName: currentImg.fileName,
        width: currentImg.width,
        height: currentImg.height,
        altText: $("altInput").value,
        responsive: $("respCheck").checked,
        pathMode: $("pathMode").value,
        aliasPrefix: "@/assets/",
        mapAreas,
      },
    });
  }

  function copyValue(value) {
    if (value) {
      vscode.postMessage({ type: "copyToClipboard", value });
    }
  }

  $("btnCopyCode").addEventListener("click", () => copyValue(generatedCode.full));
  $("btnCopyImports").addEventListener("click", () => copyValue(generatedCode.imports));
  $("btnCopyComponent").addEventListener("click", () => copyValue(generatedCode.component));
  $("btnGenFavicons").addEventListener("click", () => vscode.postMessage({ type: "generateFavicons" }));
  $("btnBase64").addEventListener("click", () => vscode.postMessage({ type: "copyBase64" }));
  $("btnGenerateDummy").addEventListener("click", () => {
    vscode.postMessage({
      type: "generateDummy",
      payload: {
        w: $("dummyW").value,
        h: $("dummyH").value,
        bg: $("dummyBg").value,
        color: $("dummyColor").value,
        text: $("dummyText").value,
      },
    });
  });

  $("btnEyedropper").addEventListener("click", async () => {
    if (!window.EyeDropper) {
      vscode.postMessage({ type: "onError", value: "EyeDropper is not supported in this version of VS Code." });
      return;
    }
    try {
      const eyeDropper = new EyeDropper();
      const result = await eyeDropper.open();
      const hex = result.sRGBHex;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      $("colorSwatch").style.background = hex;
      $("colorHexOut").value = hex;
      $("colorRgbOut").value = `rgb(${r}, ${g}, ${b})`;
    } catch (_error) {
      // User cancelled the picker.
    }
  });

  $("colorHexOut").addEventListener("click", (event) => copyValue(event.target.value));
  $("colorRgbOut").addEventListener("click", (event) => copyValue(event.target.value));
})();
