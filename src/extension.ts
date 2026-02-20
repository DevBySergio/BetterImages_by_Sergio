import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "betterimages" is now active!');

  const sidebarProvider = new BetterImagesSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "betterImages.toolboxView",
      sidebarProvider,
    ),
  );

  let processImageCommand = vscode.commands.registerCommand(
    "betterImages.processImage",
    (uri: vscode.Uri) => {
      if (uri) {
        vscode.commands
          .executeCommand("betterImages.toolboxView.focus")
          .then(() => {
            sidebarProvider.loadImage(uri);
          });
      } else {
        vscode.window.showErrorMessage("BetterImages: No image selected.");
      }
    },
  );

  context.subscriptions.push(processImageCommand);
}

export function deactivate() {}

class BetterImagesSidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _currentImagePath?: string;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    const workspaceRoots = vscode.workspace.workspaceFolders
      ? vscode.workspace.workspaceFolders.map((f) => f.uri)
      : [];

    this._view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri, ...workspaceRoots],
    };

    this._view.webview.html = this._getHtmlForWebview();

    this._view.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "onInfo":
          vscode.window.showInformationMessage(data.value);
          break;
        case "onError":
          vscode.window.showErrorMessage(data.value);
          break;
        case "batchProcess":
          await this.handleBatchProcess(data.payload);
          break;
        case "generateFavicons":
          await this.handleGenerateFavicons();
          break;
        case "copyBase64":
          this.handleCopyBase64();
          break;
        case "copyToClipboard":
          vscode.env.clipboard.writeText(data.value);
          vscode.window.showInformationMessage(
            "BetterImages: Copied to clipboard!",
          );
          break;
        case "generateDummy":
          this.handleGenerateDummy(data.payload);
          break;
        case "cropImage":
          await this.handleCrop(data.payload);
          break;
      }
    });
  }

  public async loadImage(uri: vscode.Uri) {
    if (!this._view) {
      vscode.window.showErrorMessage(
        "BetterImages: Sidebar is not ready. Open it first.",
      );
      return;
    }

    const filePath = uri.fsPath;
    this._currentImagePath = filePath;

    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();

    const stats = fs.statSync(filePath);
    const sizeKB = (stats.size / 1024).toFixed(2);

    let width = 0,
      height = 0,
      hasExif = false;

    try {
      const sharp = require("sharp");
      const metadata = await sharp(filePath).metadata();
      width = metadata.width || 0;
      height = metadata.height || 0;

      if (metadata.exif || metadata.icc || metadata.xmp || metadata.iptc) {
        hasExif = true;
      }
    } catch (error) {
      console.error("BetterImages: Could not read metadata", error);
    }

    const webviewUri = this._view.webview.asWebviewUri(uri);

    this._view.webview.postMessage({
      type: "imageSelected",
      data: {
        fileName,
        filePath,
        webviewUri: webviewUri.toString(),
        extension: ext,
        sizeKB,
        width,
        height,
        hasExif,
      },
    });
  }

  private async handleBatchProcess(payload: {
    w: number;
    h: number;
    format: string;
    quality: number;
    clean: boolean;
  }) {
    if (!this._currentImagePath) {
      vscode.window.showErrorMessage("BetterImages: No image selected.");
      return;
    }

    try {
      const sharp = require("sharp");
      const parsedPath = path.parse(this._currentImagePath);
      let img = sharp(this._currentImagePath);

      if (!payload.clean) {
        img = img.withMetadata();
      }

      if (payload.w && payload.h) {
        img = img.resize(payload.w, payload.h, { fit: "fill" });
      }

      let outExt = parsedPath.ext;
      if (payload.format === "webp") {
        img = img.webp({ quality: payload.quality });
        outExt = ".webp";
      } else if (payload.format === "avif") {
        img = img.avif({ quality: payload.quality });
        outExt = ".avif";
      } else {
        const metadata = await sharp(this._currentImagePath).metadata();
        if (metadata.format === "jpeg" || metadata.format === "jpg") {
          img = img.jpeg({ quality: payload.quality, mozjpeg: true });
        } else if (metadata.format === "png") {
          img = img.png({ quality: payload.quality });
        }
      }

      let modifiers = [];
      if (payload.w && payload.h) modifiers.push(`${payload.w}x${payload.h}`);
      if (payload.clean) modifiers.push("clean");
      if (payload.format !== "original") modifiers.push(`q${payload.quality}`);

      const modStr =
        modifiers.length > 0 ? `-${modifiers.join("-")}` : "-processed";
      const newFilePath = path.join(
        parsedPath.dir,
        `${parsedPath.name}${modStr}${outExt}`,
      );

      await img.toFile(newFilePath);
      vscode.window.showInformationMessage(
        `BetterImages: Saved as ${path.basename(newFilePath)}`,
      );
    } catch (error) {
      console.error(error);
      vscode.window.showErrorMessage(
        `BetterImages: Failed to process image pipeline.`,
      );
    }
  }

  private async handleCrop(payload: {
    x: number;
    y: number;
    w: number;
    h: number;
  }) {
    if (!this._currentImagePath) return;
    try {
      const sharp = require("sharp");
      const parsedPath = path.parse(this._currentImagePath);
      const newFilePath = path.join(
        parsedPath.dir,
        `${parsedPath.name}-cropped${parsedPath.ext}`,
      );

      await sharp(this._currentImagePath)
        .extract({
          left: Math.round(payload.x),
          top: Math.round(payload.y),
          width: Math.round(payload.w),
          height: Math.round(payload.h),
        })
        .toFile(newFilePath);

      vscode.window.showInformationMessage(
        `BetterImages: Cropped image saved!`,
      );
    } catch (error) {
      console.error(error);
      vscode.window.showErrorMessage(`BetterImages: Failed to crop image.`);
    }
  }

  private async handleGenerateFavicons() {
    if (!this._currentImagePath) return;
    try {
      const sharp = require("sharp");
      const parsedPath = path.parse(this._currentImagePath);
      const dir = parsedPath.dir;
      const sizes = [
        { name: "favicon-16x16.png", size: 16 },
        { name: "favicon-32x32.png", size: 32 },
        { name: "apple-touch-icon.png", size: 180 },
      ];

      for (const s of sizes) {
        await sharp(this._currentImagePath)
          .resize(s.size, s.size, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .png()
          .toFile(path.join(dir, s.name));
      }
      const htmlSnippet = `<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">\n<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">\n<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">`;
      vscode.env.clipboard.writeText(htmlSnippet);
      vscode.window.showInformationMessage(
        "BetterImages: Favicons generated & HTML copied!",
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        "BetterImages: Failed to generate favicons.",
      );
    }
  }

  private handleCopyBase64() {
    if (!this._currentImagePath) return;
    try {
      const parsedPath = path.parse(this._currentImagePath);
      const ext = parsedPath.ext.substring(1).toLowerCase();
      const validExts = ["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];
      let mimeExt = ext === "jpg" ? "jpeg" : ext;
      mimeExt = mimeExt === "svg" ? "svg+xml" : mimeExt;
      if (!validExts.includes(ext)) return;
      const base64Str = fs.readFileSync(this._currentImagePath, {
        encoding: "base64",
      });
      vscode.env.clipboard.writeText(
        `data:image/${mimeExt};base64,${base64Str}`,
      );
      vscode.window.showInformationMessage("BetterImages: Base64 copied!");
    } catch (error) {
      vscode.window.showErrorMessage("BetterImages: Failed to copy Base64.");
    }
  }

  private handleGenerateDummy(payload: any) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return;
    const rootPath = workspaceFolders[0].uri.fsPath;
    const w = payload.w || 800,
      h = payload.h || 600;
    const fontSize = Math.max(12, Math.min(w, h) * 0.15);
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
            <rect width="${w}" height="${h}" fill="${payload.bg || "#cccccc"}" />
            <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif, Arial" font-weight="bold" font-size="${fontSize}px" fill="${payload.color || "#333333"}">${payload.text || `${w} x ${h}`}</text>
        </svg>`;
    try {
      fs.writeFileSync(
        path.join(rootPath, `dummy-${w}x${h}.svg`),
        svgContent,
        "utf8",
      );
      vscode.window.showInformationMessage(
        `BetterImages: Generated dummy-${w}x${h}.svg`,
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        "BetterImages: Failed to save dummy image.",
      );
    }
  }

  private _getHtmlForWebview(): string {
    return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-webview-resource: https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Better Images</title>
                <style>
                    body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); padding-bottom: 40px; }
                    
                    .section-title { font-size: 0.9em; text-transform: uppercase; letter-spacing: 1px; color: var(--vscode-descriptionForeground); margin: 20px 0 10px 0; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 4px; }
                    .card { background: var(--vscode-editor-inactiveSelectionBackground); border: 1px solid var(--vscode-widget-border); border-radius: 4px; padding: 12px; margin-bottom: 12px; }
                    
                    .preview-container { background: var(--vscode-editor-background); border: 1px dashed var(--vscode-widget-border); border-radius: 4px; padding: 10px; display: flex; justify-content: center; position: relative; margin-bottom: 15px; }
                    .image-wrapper { position: relative; max-width: 100%; display: inline-block; }
                    #imagePreview { display: block; max-width: 100%; max-height: 250px; border-radius: 2px; pointer-events: none; }
                    #mainCanvas { position: absolute; top: 0; left: 0; cursor: crosshair; }

                    .info-row { display: flex; justify-content: space-between; font-size: 0.85em; margin-bottom: 5px; }
                    .info-label { opacity: 0.7; }
                    .info-value { font-weight: bold; }
                    .text-danger { color: var(--vscode-errorForeground); }
                    .text-success { color: var(--vscode-testing-iconPassed); }

                    .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; border-radius: 2px; cursor: pointer; font-weight: bold; width: 100%; margin-bottom: 6px; text-align: center; box-sizing: border-box; }
                    .btn:hover { background: var(--vscode-button-hoverBackground); }
                    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
                    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
                    .btn-accent { background: var(--vscode-editorInfo-foreground); color: white; }
                    
                    .btn-icon { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); cursor: pointer; border-radius: 2px; padding: 5px; display: flex; align-items: center; justify-content: center; }
                    .btn-icon:hover { background: var(--vscode-button-secondaryHoverBackground); }

                    .input-field { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 5px; border-radius: 2px; margin-bottom: 10px; margin-top: 4px; font-family: inherit; font-size: 0.9em; }
                    textarea.input-field { white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word; resize: vertical; }
                    
                    label { font-size: 0.85em; font-weight: bold; opacity: 0.9; }
                    
                    .flex-row { display: flex; gap: 8px; align-items: center; }
                    .flex-1 { flex: 1; min-width: 0; }

                    .radio-group { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; font-size: 0.85em; background: var(--vscode-editor-background); padding: 8px; border-radius: 4px; border: 1px solid var(--vscode-widget-border); }
                    .radio-group label { font-weight: normal; cursor: pointer; display: flex; align-items: center; gap: 4px; opacity: 0.8; }
                    .radio-group input[type="radio"]:checked + span { font-weight: bold; color: var(--vscode-textLink-foreground); }

                    #emptyState { text-align: center; margin-top: 40px; opacity: 0.7; }
                    #activeState { display: none; }
                </style>
            </head>
            <body>
                <div id="emptyState">
                    <p>No image selected.</p>
                    <p>Right-click an image and select <b>"Process with BetterImages"</b>.</p>
                </div>

                <div id="activeState">
                    <div class="preview-container">
                        <div class="image-wrapper">
                            <img id="imagePreview" src="">
                            <canvas id="mainCanvas"></canvas>
                        </div>
                    </div>

                    <div class="card">
                        <div class="info-row"><span class="info-label">Name:</span> <span class="info-value" id="valName">-</span></div>
                        <div class="info-row"><span class="info-label">Size:</span> <span class="info-value" id="valSize">-</span></div>
                        <div class="info-row"><span class="info-label">Dimensions:</span> <span class="info-value" id="valDim">-</span></div>
                        <div class="info-row"><span class="info-label">Metadata:</span> <span class="info-value" id="valExif">-</span></div>
                    </div>

                    <div class="section-title">Canvas Tools</div>
                    <div class="card">
                        <div class="radio-group">
                            <label><input type="radio" name="tool" value="off" checked> <span>Off</span></label>
                            <label><input type="radio" name="tool" value="mapRect"> <span>Map (Rect)</span></label>
                            <label><input type="radio" name="tool" value="mapCirc"> <span>Map (Circle)</span></label>
                            <label><input type="radio" name="tool" value="crop"> <span>Crop</span></label>
                        </div>

                        <div id="panelMap" style="display: none;">
                            <p style="font-size: 0.8em; margin:0 0 10px 0; opacity:0.8;">Draw areas on the image. The code generator below will update automatically.</p>
                            <button class="btn btn-secondary" id="btnClearCanvas">Clear Areas</button>
                        </div>

                        <div id="panelCrop" style="display: none;">
                            <p style="font-size: 0.8em; margin:0 0 10px 0; opacity:0.8;">Draw a box to crop the image.</p>
                            <button class="btn btn-accent" id="btnApplyCrop" disabled>Apply Crop</button>
                        </div>
                    </div>

                    <div class="section-title">Code Generator</div>
                    <div class="card">
                        <select id="fwSelect" class="input-field" style="margin-top:0;">
                            <option value="html">HTML5</option>
                            <option value="react">React (JSX)</option>
                            <option value="next">Next.js (next/image)</option>
                            <option value="vue">Vue</option>
                            <option value="nuxt">Nuxt (NuxtImg)</option>
                            <option value="angular">Angular</option>
                            <option value="astro">Astro</option>
                        </select>
                        <input type="text" id="altInput" class="input-field" placeholder="Alt text..." />
                        <label style="display: flex; align-items: center; gap: 5px; margin-bottom: 10px; cursor: pointer;">
                            <input type="checkbox" id="respCheck" /> <span>Responsive &lt;picture&gt;</span>
                        </label>
                        <textarea id="codeOutput" rows="5" class="input-field" readonly></textarea>
                        <button class="btn btn-secondary" id="btnCopyCode">Copy Code</button>
                    </div>

                    <div class="section-title">Batch Export & Optimize</div>
                    <div class="card">
                        <label>Resize</label>
                        <div class="flex-row" style="margin-bottom: 10px;">
                            <input type="number" id="resW" class="input-field flex-1" style="margin:0;" placeholder="W" />
                            <button id="btnLockRatio" class="btn-icon" title="Toggle Aspect Ratio Lock">🔒</button>
                            <input type="number" id="resH" class="input-field flex-1" style="margin:0;" placeholder="H" />
                        </div>
                        
                        <label>Format</label>
                        <select id="exportFormat" class="input-field">
                            <option value="original">Keep Original</option>
                            <option value="webp">WebP</option>
                            <option value="avif">AVIF</option>
                        </select>
                        
                        <div class="flex-row" style="justify-content: space-between;">
                            <label>Quality:</label>
                            <span id="qualValue" style="font-weight:bold; font-size:0.85em;">80%</span>
                        </div>
                        <input type="range" id="qualSlider" min="1" max="100" value="80" style="width:100%; margin-bottom:10px;" />
                        
                        <label style="display: flex; align-items: center; gap: 5px; margin-bottom: 15px; cursor: pointer;">
                            <input type="checkbox" id="exportClean" /> <span>Strip Metadata (Clean)</span>
                        </label>

                        <button class="btn btn-accent" id="btnBatchProcess">Export Processed Image</button>
                    </div>

                    <div class="flex-row">
                        <button class="btn btn-secondary flex-1" id="btnGenFavicons">Gen Favicons</button>
                        <button class="btn btn-secondary flex-1" id="btnBase64">Copy Base64</button>
                    </div>
                </div>

                <div class="section-title" style="margin-top:30px;">Global Tools</div>
                <div class="card">
                    <label>Dummy Placeholder</label>
                    <div class="flex-row">
                        <input type="number" id="dummyW" class="input-field" value="800" placeholder="W" />
                        <input type="number" id="dummyH" class="input-field" value="600" placeholder="H" />
                    </div>
                    <div class="flex-row">
                        <input type="color" id="dummyBg" class="input-field flex-1" value="#cccccc" style="padding:0; height:28px;" />
                        <input type="color" id="dummyColor" class="input-field flex-1" value="#333333" style="padding:0; height:28px;" />
                    </div>
                    <input type="text" id="dummyText" class="input-field" placeholder="Custom text (optional)" />
                    <button class="btn btn-secondary" id="btnGenerateDummy">Save Dummy to Project</button>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    
                    const emptyState = document.getElementById('emptyState');
                    const activeState = document.getElementById('activeState');
                    const imagePreview = document.getElementById('imagePreview');
                    const valName = document.getElementById('valName');
                    const valSize = document.getElementById('valSize');
                    const valDim = document.getElementById('valDim');
                    const valExif = document.getElementById('valExif');

                    // Batch Processing Elements
                    const resW = document.getElementById('resW');
                    const resH = document.getElementById('resH');
                    const btnLockRatio = document.getElementById('btnLockRatio');
                    const exportFormat = document.getElementById('exportFormat');
                    const qualSlider = document.getElementById('qualSlider');
                    const qualValue = document.getElementById('qualValue');
                    const exportClean = document.getElementById('exportClean');
                    const btnBatchProcess = document.getElementById('btnBatchProcess');

                    // Canvas Tools
                    const canvas = document.getElementById('mainCanvas');
                    const ctx = canvas.getContext('2d');
                    const radioTools = document.getElementsByName('tool');
                    const panelMap = document.getElementById('panelMap');
                    const panelCrop = document.getElementById('panelCrop');
                    const btnApplyCrop = document.getElementById('btnApplyCrop');

                    let currentImg = null;
                    let activeTool = 'off'; 
                    let isDrawing = false;
                    let startX = 0, startY = 0;
                    
                    let mapAreas = []; 
                    let cropRect = null;
                    
                    // Ratio Logic
                    let isRatioLocked = true;
                    let originalRatio = 1;

                    qualSlider.addEventListener('input', (e) => { qualValue.textContent = e.target.value + '%'; });

                    btnLockRatio.addEventListener('click', () => {
                        isRatioLocked = !isRatioLocked;
                        btnLockRatio.textContent = isRatioLocked ? '🔒' : '🔓';
                        if (isRatioLocked && resW.value) {
                            resH.value = Math.round(parseInt(resW.value) / originalRatio);
                        }
                    });

                    resW.addEventListener('input', () => {
                        if (isRatioLocked && originalRatio && resW.value) {
                            resH.value = Math.round(parseInt(resW.value) / originalRatio);
                        }
                    });

                    resH.addEventListener('input', () => {
                        if (isRatioLocked && originalRatio && resH.value) {
                            resW.value = Math.round(parseInt(resH.value) * originalRatio);
                        }
                    });

                    window.addEventListener('message', event => {
                        if (event.data.type === 'imageSelected') {
                            currentImg = event.data.data;
                            emptyState.style.display = 'none';
                            activeState.style.display = 'block';
                            
                            imagePreview.src = currentImg.webviewUri;
                            valName.textContent = currentImg.fileName;
                            valSize.textContent = currentImg.sizeKB + ' KB';
                            valDim.textContent = currentImg.width ? \`\${currentImg.width}x\${currentImg.height}px\` : 'Unknown';
                            
                            // Initialize Batch UI
                            resW.value = currentImg.width || '';
                            resH.value = currentImg.height || '';
                            if (currentImg.width && currentImg.height) {
                                originalRatio = currentImg.width / currentImg.height;
                            }

                            if (currentImg.hasExif) {
                                valExif.textContent = 'Detected (Adds Size)';
                                valExif.className = 'info-value text-danger';
                                exportClean.checked = true; // Auto-check if metadata is found
                            } else {
                                valExif.textContent = 'Clean';
                                valExif.className = 'info-value text-success';
                                exportClean.checked = false;
                            }

                            updateCode();
                            resetCanvas();
                        }
                    });

                    // --- CANVAS LOGIC ---
                    radioTools.forEach(radio => {
                        radio.addEventListener('change', (e) => {
                            activeTool = e.target.value;
                            panelMap.style.display = activeTool.startsWith('map') ? 'block' : 'none';
                            panelCrop.style.display = activeTool === 'crop' ? 'block' : 'none';
                            
                            if (activeTool === 'off') {
                                canvas.style.pointerEvents = 'none';
                                ctx.clearRect(0,0,canvas.width,canvas.height);
                            } else {
                                canvas.style.pointerEvents = 'auto';
                                resizeCanvas();
                                drawCanvas();
                            }
                        });
                    });

                    function resizeCanvas() { canvas.width = imagePreview.clientWidth; canvas.height = imagePreview.clientHeight; }
                    window.addEventListener('resize', resizeCanvas);

                    canvas.addEventListener('mousedown', (e) => {
                        if(activeTool === 'off') return;
                        const rect = canvas.getBoundingClientRect();
                        startX = e.clientX - rect.left; startY = e.clientY - rect.top; isDrawing = true;
                    });

                    canvas.addEventListener('mousemove', (e) => {
                        if(!isDrawing) return;
                        const rect = canvas.getBoundingClientRect();
                        const curX = e.clientX - rect.left; const curY = e.clientY - rect.top;
                        drawCanvas();
                        ctx.lineWidth = 2;
                        if (activeTool === 'mapRect' || activeTool === 'crop') {
                            ctx.strokeStyle = activeTool === 'crop' ? '#007acc' : '#00ff00';
                            ctx.setLineDash(activeTool === 'crop' ? [5,5] : []);
                            ctx.strokeRect(startX, startY, curX - startX, curY - startY);
                        } else if (activeTool === 'mapCirc') {
                            const r = Math.sqrt(Math.pow(curX - startX, 2) + Math.pow(curY - startY, 2));
                            ctx.strokeStyle = '#00ff00'; ctx.setLineDash([]);
                            ctx.beginPath(); ctx.arc(startX, startY, r, 0, 2*Math.PI); ctx.stroke();
                        }
                    });

                    canvas.addEventListener('mouseup', (e) => {
                        if(!isDrawing) return;
                        isDrawing = false;
                        const rect = canvas.getBoundingClientRect();
                        const endX = e.clientX - rect.left; const endY = e.clientY - rect.top;
                        const scaleX = currentImg.width / canvas.width; const scaleY = currentImg.height / canvas.height;
                        
                        if (activeTool === 'mapRect') {
                            const x1 = Math.round(Math.min(startX, endX) * scaleX); const y1 = Math.round(Math.min(startY, endY) * scaleY);
                            const x2 = Math.round(Math.max(startX, endX) * scaleX); const y2 = Math.round(Math.max(startY, endY) * scaleY);
                            if(x2-x1>5) mapAreas.push({ type: 'rect', coords: \`\${x1},\${y1},\${x2},\${y2}\` });
                        } 
                        else if (activeTool === 'mapCirc') {
                            const rCanvas = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2));
                            const rReal = Math.round(rCanvas * ((scaleX+scaleY)/2));
                            const x = Math.round(startX * scaleX); const y = Math.round(startY * scaleY);
                            if(rReal>5) mapAreas.push({ type: 'circle', coords: \`\${x},\${y},\${rReal}\` });
                        }
                        else if (activeTool === 'crop') {
                            const x = Math.round(Math.min(startX, endX) * scaleX); const y = Math.round(Math.min(startY, endY) * scaleY);
                            const w = Math.round(Math.abs(endX - startX) * scaleX); const h = Math.round(Math.abs(endY - startY) * scaleY);
                            if(w>10 && h>10) { cropRect = {x, y, w, h, drawX: Math.min(startX,endX), drawY: Math.min(startY,endY), drawW: Math.abs(endX-startX), drawH: Math.abs(endY-startY)}; btnApplyCrop.disabled = false; }
                        }
                        updateCode(); drawCanvas();
                    });

                    function drawCanvas() {
                        ctx.clearRect(0,0,canvas.width,canvas.height); ctx.setLineDash([]);
                        const scaleX = canvas.width / currentImg.width; const scaleY = canvas.height / currentImg.height;

                        if (activeTool.startsWith('map')) {
                            mapAreas.forEach((area, i) => {
                                ctx.fillStyle = 'rgba(0,255,0,0.3)'; ctx.strokeStyle = '#00ff00'; ctx.lineWidth=2; ctx.beginPath();
                                if(area.type === 'rect'){
                                    const [x1,y1,x2,y2] = area.coords.split(',').map(Number);
                                    ctx.rect(x1*scaleX, y1*scaleY, (x2-x1)*scaleX, (y2-y1)*scaleY);
                                } else {
                                    const [x,y,r] = area.coords.split(',').map(Number);
                                    ctx.arc(x*scaleX, y*scaleY, r*((scaleX+scaleY)/2), 0, 2*Math.PI);
                                }
                                ctx.fill(); ctx.stroke(); ctx.fillStyle='white'; ctx.fillText(i+1, (area.coords.split(',')[0]*scaleX)+5, (area.coords.split(',')[1]*scaleY)+15);
                            });
                        } else if (activeTool === 'crop' && cropRect) {
                            ctx.fillStyle = 'rgba(0,122,204,0.3)'; ctx.strokeStyle = '#007acc'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
                            ctx.fillRect(cropRect.drawX, cropRect.drawY, cropRect.drawW, cropRect.drawH);
                            ctx.strokeRect(cropRect.drawX, cropRect.drawY, cropRect.drawW, cropRect.drawH);
                        }
                    }

                    function resetCanvas() { mapAreas = []; cropRect = null; btnApplyCrop.disabled = true; if(activeTool !== 'off') drawCanvas(); updateCode(); }
                    
                    document.getElementById('btnClearCanvas').addEventListener('click', resetCanvas);
                    btnApplyCrop.addEventListener('click', () => { if(cropRect) vscode.postMessage({type:'cropImage', payload: cropRect}); });

                    // --- UNIFIED CODE GEN ---
                    const fw = document.getElementById('fwSelect'), alt = document.getElementById('altInput'), resp = document.getElementById('respCheck');
                    [fw, alt, resp].forEach(el => el.addEventListener('change', updateCode)); alt.addEventListener('input', updateCode);

                    function updateCode() {
                        if(!currentImg) return;
                        
                        const w = currentImg.width || ''; 
                        const h = currentImg.height || '';
                        const src = './' + currentImg.fileName; 
                        const mSrc = src.replace('.','-mobile.'); 
                        const altText = alt.value || 'description';
                        
                        const isJSX = ['react', 'next', 'astro'].includes(fw.value);
                        const mapName = currentImg.fileName.split('.')[0] + '-map';
                        const hasMap = mapAreas.length > 0;
                        const useMapAttr = hasMap ? (isJSX ? \` useMap="#\${mapName}"\` : \` usemap="#\${mapName}"\`) : '';

                        let tag = '';
                        let final = '';
                        let imports = '';
                        let mapBlock = '';

                        // 1. Generate Map Block
                        if (hasMap) {
                            mapBlock = \`\\n<map name="\${mapName}">\\n\`;
                            mapAreas.forEach((a, i) => { 
                                const close = isJSX ? ' />' : '>';
                                mapBlock += \`  <area shape="\${a.type}" coords="\${a.coords}" href="#" alt="Area \${i+1}"\${close}\\n\`; 
                            });
                            mapBlock += \`</map>\`;
                        }

                        // 2. Generate Image Tag and wrap based on Framework
                        if (fw.value === 'react') { 
                            const dimJ = (w && h) ? \` width={\${w}} height={\${h}}\` : ''; 
                            tag = \`<img src="\${src}" alt="\${altText}"\${dimJ}\${useMapAttr} loading="lazy" />\`; 
                            final = resp.checked ? \`<picture>\\n  <source media="(max-width: 768px)" srcSet="\${mSrc}" />\\n  \${tag}\\n</picture>\` : tag; 
                            final += mapBlock;
                        } 
                        else if (fw.value === 'next') { 
                            const dimJ = (w && h) ? \` width={\${w}} height={\${h}}\` : ' fill style={{ objectFit: "contain" }}'; 
                            tag = \`<Image src="\${src}" alt="\${altText}"\${dimJ}\${useMapAttr} />\`; 
                            imports = \`import Image from 'next/image';\\n\\n\`;
                            final = imports + (resp.checked ? \`<picture>\\n  <source media="(max-width: 768px)" srcSet="\${mSrc}" />\\n  \${tag}\\n</picture>\` : tag) + mapBlock; 
                        } 
                        else if (fw.value === 'vue') { 
                            const dim = (w && h) ? \` width="\${w}" height="\${h}"\` : ''; 
                            tag = \`<img src="\${src}" alt="\${altText}"\${dim}\${useMapAttr} loading="lazy" />\`; 
                            let inner = resp.checked ? \`<picture>\\n  <source media="(max-width: 768px)" srcset="\${mSrc}">\\n  \${tag}\\n</picture>\` : tag; 
                            inner += mapBlock;
                            final = \`<template>\\n  \${inner.split('\\n').join('\\n  ')}\\n</template>\`; 
                        } 
                        else if (fw.value === 'nuxt') { 
                            const dim = (w && h) ? \` width="\${w}" height="\${h}"\` : ''; 
                            tag = \`<NuxtImg src="\${src}" alt="\${altText}"\${dim}\${useMapAttr} loading="lazy" format="webp" />\`; 
                            let inner = tag + mapBlock;
                            final = \`<template>\\n  \${inner.split('\\n').join('\\n  ')}\\n</template>\`; 
                        } 
                        else if (fw.value === 'angular') { 
                            const dim = (w && h) ? \` width="\${w}" height="\${h}"\` : ''; 
                            tag = \`<img [src]="'\${src}'" alt="\${altText}"\${dim}\${useMapAttr} loading="lazy">\`; 
                            final = (resp.checked ? \`<picture>\\n  <source media="(max-width: 768px)" [srcset]="'\${mSrc}'">\\n  \${tag}\\n</picture>\` : tag) + mapBlock; 
                        } 
                        else if (fw.value === 'astro') { 
                            const dimJ = (w && h) ? \` width={\${w}} height={\${h}}\` : ''; 
                            if (resp.checked) {
                                imports = \`---\\nimport { Picture } from 'astro:assets';\\nimport localImg from '\${src}';\\n---\\n\`;
                                tag = \`<Picture src={localImg} formats={['avif', 'webp']} alt="\${altText}" pictureAttributes={{ usemap: "#\${mapName}" }} />\`;
                            } else {
                                imports = \`---\\nimport { Image } from 'astro:assets';\\nimport localImg from '\${src}';\\n---\\n\`;
                                tag = \`<Image src={localImg} alt="\${altText}"\${dimJ}\${useMapAttr} />\`; 
                            }
                            final = imports + tag + mapBlock;
                        } 
                        else { 
                            // HTML5
                            const dim = (w && h) ? \` width="\${w}" height="\${h}"\` : ''; 
                            tag = \`<img src="\${src}" alt="\${altText}"\${dim}\${useMapAttr} loading="lazy">\`; 
                            final = (resp.checked ? \`<picture>\\n  <source media="(max-width: 768px)" srcset="\${mSrc}">\\n  \${tag}\\n</picture>\` : tag) + mapBlock; 
                        }
                        
                        document.getElementById('codeOutput').value = final;
                    }
                    
                    document.getElementById('btnCopyCode').addEventListener('click', () => vscode.postMessage({type:'copyToClipboard', value:document.getElementById('codeOutput').value}));

                    // --- BATCH PROCESS EXPORT ---
                    btnBatchProcess.addEventListener('click', () => {
                        vscode.postMessage({
                            type: 'batchProcess',
                            payload: {
                                w: parseInt(resW.value),
                                h: parseInt(resH.value),
                                format: exportFormat.value,
                                quality: parseInt(qualSlider.value),
                                clean: exportClean.checked
                            }
                        });
                    });

                    // --- TOOLS ---
                    document.getElementById('btnGenFavicons').addEventListener('click', () => { vscode.postMessage({type:'generateFavicons'}) });
                    document.getElementById('btnBase64').addEventListener('click', () => { vscode.postMessage({type:'copyBase64'}) });
                    document.getElementById('btnGenerateDummy').addEventListener('click', () => {
                        vscode.postMessage({type:'generateDummy', payload:{w: document.getElementById('dummyW').value, h: document.getElementById('dummyH').value, bg: document.getElementById('dummyBg').value, color: document.getElementById('dummyColor').value, text: document.getElementById('dummyText').value}});
                    });
                </script>
            </body>
            </html>`;
  }
}
