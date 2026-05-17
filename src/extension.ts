import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  BatchPayload,
  CropPayload,
  buildCropFilePath,
  buildDummySvg,
  buildImageCode,
  buildProcessedFilePath,
  calculateExportSavings,
  createUniqueFilePath,
  normalizeBatchPayload,
  normalizeCropPayload,
} from "./core";

export function activate(context: vscode.ExtensionContext) {
  const sidebarProvider = new BetterImagesSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("betterImages.toolboxView", sidebarProvider),
  );

  const processImageCommand = vscode.commands.registerCommand(
    "betterImages.processImage",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage("BetterImages: Select an image from the Explorer first.");
        return;
      }

      await vscode.commands.executeCommand("betterImages.toolboxView.focus");
      await sidebarProvider.loadImage(uri);
    },
  );

  context.subscriptions.push(processImageCommand);
}

export function deactivate() {}

class BetterImagesSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private currentImagePath?: string;

  constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;

    const workspaceRoots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ?? [];
    this.view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri, ...workspaceRoots],
    };
    this.view.webview.html = this.getHtmlForWebview(this.view.webview);

    this.view.webview.onDidReceiveMessage(async (data) => {
      try {
        switch (data.type) {
          case "batchProcess":
            await this.handleBatchProcess(data.payload);
            break;
          case "generateFavicons":
            await this.handleGenerateFavicons();
            break;
          case "copyBase64":
            await this.handleCopyBase64();
            break;
          case "copyToClipboard":
            await vscode.env.clipboard.writeText(String(data.value ?? ""));
            vscode.window.showInformationMessage("BetterImages: Copied to clipboard.");
            break;
          case "generateDummy":
            await this.handleGenerateDummy(data.payload);
            break;
          case "cropImage":
            await this.handleCrop(data.payload);
            break;
          case "generateCode":
            await this.handleGenerateCode(data.payload);
            break;
          case "onError":
            vscode.window.showErrorMessage(String(data.value ?? "BetterImages: Unknown error."));
            break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected error.";
        vscode.window.showErrorMessage(`BetterImages: ${message}`);
        this.postOperationState(false);
      }
    });
  }

  public async loadImage(uri: vscode.Uri) {
    if (!this.view) {
      vscode.window.showErrorMessage("BetterImages: Open the BetterImages sidebar first.");
      return;
    }

    const filePath = uri.fsPath;
    if (!fs.existsSync(filePath)) {
      vscode.window.showErrorMessage("BetterImages: The selected image no longer exists.");
      return;
    }

    this.currentImagePath = filePath;
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const stats = fs.statSync(filePath);

    let width = 0;
    let height = 0;
    let hasExif = false;

    try {
      const sharp = require("sharp");
      const metadata = await sharp(filePath).metadata();
      width = metadata.width || 0;
      height = metadata.height || 0;
      hasExif = Boolean(metadata.exif || metadata.xmp || metadata.iptc);
    } catch (error) {
      console.error("BetterImages: Could not read metadata", error);
    }

    const webviewUri = this.view.webview.asWebviewUri(uri);
    this.view.webview.postMessage({
      type: "imageSelected",
      data: {
        fileName,
        filePath,
        webviewUri: webviewUri.toString(),
        extension: ext,
        sizeKB: (stats.size / 1024).toFixed(2),
        width,
        height,
        hasExif,
      },
    });
  }

  private async handleBatchProcess(payload: Partial<BatchPayload>) {
    const imagePath = this.requireSelectedImage();
    const normalizedPayload = normalizeBatchPayload(payload);
    const sharp = require("sharp");
    const metadata = await sharp(imagePath).metadata();
    const newFilePath = buildProcessedFilePath(imagePath, normalizedPayload);
    const originalBytes = fs.statSync(imagePath).size;

    this.postOperationState(true, `Exporting ${path.basename(newFilePath)}...`);

    let img = sharp(imagePath);
    if (!normalizedPayload.clean) {
      img = img.withMetadata();
    }

    if (normalizedPayload.filter === "grayscale") {
      img = img.grayscale();
    } else if (normalizedPayload.filter === "sepia") {
      img = img.recomb([
        [0.393, 0.769, 0.189],
        [0.349, 0.686, 0.168],
        [0.272, 0.534, 0.131],
      ]);
    } else if (normalizedPayload.filter === "negate") {
      img = img.negate();
    } else if (normalizedPayload.filter === "blur") {
      img = img.blur(5);
    }

    if (normalizedPayload.w && normalizedPayload.h) {
      img = img.resize(normalizedPayload.w, normalizedPayload.h, {
        fit: normalizedPayload.fit,
        withoutEnlargement: normalizedPayload.fit === "inside",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });
    }

    if (normalizedPayload.format === "webp") {
      img = img.webp({ quality: normalizedPayload.quality });
    } else if (normalizedPayload.format === "avif") {
      img = img.avif({ quality: normalizedPayload.quality });
    } else if (metadata.format === "jpeg" || metadata.format === "jpg") {
      img = img.jpeg({ quality: normalizedPayload.quality, mozjpeg: true });
    } else if (metadata.format === "png") {
      img = img.png({ quality: normalizedPayload.quality });
    }

    await img.toFile(newFilePath);
    const outputBytes = fs.statSync(newFilePath).size;
    const savings = calculateExportSavings(originalBytes, outputBytes);
    this.postOperationState(false);
    this.view?.webview.postMessage({
      type: "exportComplete",
      data: {
        fileName: path.basename(newFilePath),
        ...savings,
      },
    });
    vscode.window.showInformationMessage(`BetterImages: Saved ${path.basename(newFilePath)}. ${savings.summary}.`);
  }

  private async handleCrop(payload: CropPayload) {
    const imagePath = this.requireSelectedImage();
    const crop = normalizeCropPayload(payload);
    const sharp = require("sharp");
    const newFilePath = buildCropFilePath(imagePath);

    this.postOperationState(true, `Saving ${path.basename(newFilePath)}...`);
    await sharp(imagePath).extract(crop).toFile(newFilePath);
    this.postOperationState(false);
    vscode.window.showInformationMessage(`BetterImages: Cropped image saved as ${path.basename(newFilePath)}.`);
  }

  private async handleGenerateFavicons() {
    const imagePath = this.requireSelectedImage();
    const sharp = require("sharp");
    const dir = path.dirname(imagePath);
    const sizes = [
      { name: "favicon-16x16.png", size: 16 },
      { name: "favicon-32x32.png", size: 32 },
      { name: "apple-touch-icon.png", size: 180 },
    ];

    this.postOperationState(true, "Generating favicons...");
    const savedFiles: string[] = [];
    for (const size of sizes) {
      const outPath = createUniqueFilePath(path.join(dir, size.name));
      await sharp(imagePath)
        .resize(size.size, size.size, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toFile(outPath);
      savedFiles.push(path.basename(outPath));
    }

    const htmlSnippet = [
      '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
      '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
      '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
    ].join("\n");
    await vscode.env.clipboard.writeText(htmlSnippet);
    this.postOperationState(false);
    vscode.window.showInformationMessage(`BetterImages: Generated ${savedFiles.join(", ")} and copied HTML.`);
  }

  private async handleCopyBase64() {
    const imagePath = this.requireSelectedImage();
    const ext = path.extname(imagePath).substring(1).toLowerCase();
    const validExts = ["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];
    if (!validExts.includes(ext)) {
      throw new Error("Base64 export supports PNG, JPG, GIF, SVG, WebP and AVIF.");
    }

    this.postOperationState(true, "Copying Base64...");
    let mimeExt = ext === "jpg" ? "jpeg" : ext;
    mimeExt = mimeExt === "svg" ? "svg+xml" : mimeExt;
    const base64Str = fs.readFileSync(imagePath, { encoding: "base64" });
    await vscode.env.clipboard.writeText(`data:image/${mimeExt};base64,${base64Str}`);
    this.postOperationState(false);
    vscode.window.showInformationMessage("BetterImages: Base64 copied.");
  }

  private async handleGenerateDummy(payload: unknown) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error("Open a workspace before generating a dummy image.");
    }

    const dummy = buildDummySvg((payload ?? {}) as Record<string, unknown>);
    const rootPath = workspaceFolders[0].uri.fsPath;
    const outputPath = createUniqueFilePath(path.join(rootPath, dummy.fileName));
    fs.writeFileSync(outputPath, dummy.content, "utf8");
    vscode.window.showInformationMessage(`BetterImages: Generated ${path.basename(outputPath)}.`);
  }

  private async handleGenerateCode(payload: Parameters<typeof buildImageCode>[0]) {
    const generated = buildImageCode(payload);
    this.view?.webview.postMessage({ type: "codeGenerated", data: generated });
  }

  private requireSelectedImage(): string {
    if (!this.currentImagePath) {
      throw new Error("Select an image before using this action.");
    }
    if (!fs.existsSync(this.currentImagePath)) {
      throw new Error("The selected image no longer exists.");
    }
    return this.currentImagePath;
  }

  private postOperationState(isBusy: boolean, message = "") {
    this.view?.webview.postMessage({ type: "operationState", data: { isBusy, message } });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const htmlPath = vscode.Uri.joinPath(this.extensionUri, "media", "toolbox.html");
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "toolbox.css"));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "toolbox.js"));
    const nonce = getNonce();

    return fs
      .readFileSync(htmlPath.fsPath, "utf8")
      .replace(/{{cspSource}}/g, webview.cspSource)
      .replace(/{{styleUri}}/g, cssUri.toString())
      .replace(/{{scriptUri}}/g, jsUri.toString())
      .replace(/{{nonce}}/g, nonce);
  }
}

function getNonce() {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
