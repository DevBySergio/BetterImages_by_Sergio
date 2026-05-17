import * as fs from "fs";
import * as path from "path";

export const supportedFormats = ["original", "webp", "avif"] as const;
export const supportedFilters = [
  "none",
  "grayscale",
  "sepia",
  "blur",
  "negate",
] as const;
export const supportedResizeFits = ["inside", "contain", "cover", "fill"] as const;

export type ExportFormat = (typeof supportedFormats)[number];
export type ExportFilter = (typeof supportedFilters)[number];
export type ResizeFit = (typeof supportedResizeFits)[number];
export type PathMode = "relative" | "public" | "alias";
export type Framework =
  | "html"
  | "react"
  | "next"
  | "vue"
  | "nuxt"
  | "angular"
  | "astro";

export interface BatchPayload {
  w?: number;
  h?: number;
  format: ExportFormat;
  quality: number;
  clean: boolean;
  filter: ExportFilter;
  fit: ResizeFit;
}

export interface CropPayload {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapArea {
  type: "rect" | "circle";
  coords: string;
}

export interface CodeGenerationInput {
  framework: Framework;
  fileName: string;
  width?: number;
  height?: number;
  altText?: string;
  responsive?: boolean;
  pathMode?: PathMode;
  aliasPrefix?: string;
  mapAreas?: MapArea[];
}

export interface GeneratedCode {
  full: string;
  imports: string;
  component: string;
  markdown: string;
  cssBackground: string;
  html: string;
}

export interface ExportSavings {
  originalBytes: number;
  outputBytes: number;
  savedBytes: number;
  savedPercent: number;
  originalLabel: string;
  outputLabel: string;
  summary: string;
}

const maxDimension = 50_000;

export function escapeHtmlText(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeHtmlAttribute(value: unknown): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function sanitizeSvgColor(value: unknown, fallback: string): string {
  const color = String(value ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}

export function sanitizeDimension(value: unknown): number | undefined {
  if (value === "" || value === null || value === undefined) {
    return undefined;
  }
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 1 || numberValue > maxDimension) {
    return undefined;
  }
  return numberValue;
}

export function normalizeBatchPayload(payload: Partial<BatchPayload>): BatchPayload {
  const w = sanitizeDimension(payload.w);
  const h = sanitizeDimension(payload.h);
  const format = isOneOf(payload.format, supportedFormats) ? payload.format : "original";
  const filter = isOneOf(payload.filter, supportedFilters) ? payload.filter : "none";
  const fit = isOneOf(payload.fit, supportedResizeFits) ? payload.fit : "inside";
  const parsedQuality = Number(payload.quality);
  const quality = Number.isInteger(parsedQuality)
    ? Math.min(100, Math.max(1, parsedQuality))
    : 80;

  return {
    w,
    h,
    format,
    quality,
    clean: Boolean(payload.clean),
    filter,
    fit,
  };
}

export function normalizeCropPayload(payload: CropPayload): CropPayload {
  const x = Math.max(0, Math.round(Number(payload.x)));
  const y = Math.max(0, Math.round(Number(payload.y)));
  const w = Math.round(Number(payload.w));
  const h = Math.round(Number(payload.h));

  if (!Number.isFinite(x) || !Number.isFinite(y) || w < 1 || h < 1) {
    throw new Error("Invalid crop area. Draw a larger crop box and try again.");
  }

  return { x, y, w, h };
}

export function createUniqueFilePath(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return filePath;
  }

  const parsedPath = path.parse(filePath);
  let index = 1;
  let candidate = path.join(parsedPath.dir, `${parsedPath.name}-${index}${parsedPath.ext}`);

  while (fs.existsSync(candidate)) {
    index += 1;
    candidate = path.join(parsedPath.dir, `${parsedPath.name}-${index}${parsedPath.ext}`);
  }

  return candidate;
}

export function buildProcessedFilePath(imagePath: string, payload: BatchPayload): string {
  const parsedPath = path.parse(imagePath);
  const outExt = payload.format === "original" ? parsedPath.ext : `.${payload.format}`;
  const modifiers: string[] = [];

  if (payload.w && payload.h) {
    modifiers.push(`${payload.w}x${payload.h}`);
    if (payload.fit !== "inside") {
      modifiers.push(payload.fit);
    }
  }
  if (payload.filter !== "none") {
    modifiers.push(payload.filter);
  }
  if (payload.clean) {
    modifiers.push("clean");
  }

  const modStr =
    modifiers.length > 0
      ? `-${modifiers.join("-")}`
      : payload.format !== "original"
        ? "-optimized"
        : "-processed";

  return createUniqueFilePath(path.join(parsedPath.dir, `${parsedPath.name}${modStr}${outExt}`));
}

export function buildCropFilePath(imagePath: string): string {
  const parsedPath = path.parse(imagePath);
  return createUniqueFilePath(path.join(parsedPath.dir, `${parsedPath.name}-cropped${parsedPath.ext}`));
}

export function buildDummySvg(payload: {
  w?: unknown;
  h?: unknown;
  bg?: unknown;
  color?: unknown;
  text?: unknown;
}): { fileName: string; content: string } {
  const w = sanitizeDimension(payload.w) ?? 800;
  const h = sanitizeDimension(payload.h) ?? 600;
  const bg = sanitizeSvgColor(payload.bg, "#cccccc");
  const color = sanitizeSvgColor(payload.color, "#333333");
  const text = escapeHtmlText(payload.text || `${w} x ${h}`);
  const fontSize = Math.max(12, Math.round(Math.min(w, h) * 0.15));

  return {
    fileName: `dummy-${w}x${h}.svg`,
    content: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${bg}" />
  <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif, Arial" font-weight="bold" font-size="${fontSize}px" fill="${color}">${text}</text>
</svg>`,
  };
}

export function buildImageCode(input: CodeGenerationInput): GeneratedCode {
  const framework = input.framework || "html";
  const width = sanitizeDimension(input.width);
  const height = sanitizeDimension(input.height);
  const src = buildSource(input.fileName, input.pathMode ?? "relative", input.aliasPrefix);
  const mobileSrc = buildMobileSource(src);
  const altText = escapeHtmlAttribute(input.altText || "description");
  const escapedSrc = escapeHtmlAttribute(src);
  const escapedMobileSrc = escapeHtmlAttribute(mobileSrc);
  const isJSX = ["react", "next", "astro"].includes(framework);
  const mapAreas = input.mapAreas ?? [];
  const hasMap = mapAreas.length > 0;
  const mapName = sanitizeMapName(input.fileName);
  const useMapAttr = hasMap ? (isJSX ? ` useMap="#${mapName}"` : ` usemap="#${mapName}"`) : "";
  const mapBlock = hasMap ? buildMapBlock(mapName, mapAreas, isJSX) : "";
  const htmlDim = width && height ? ` width="${width}" height="${height}"` : "";
  const jsxDim = width && height ? ` width={${width}} height={${height}}` : "";

  let imports = "";
  let component = "";

  if (framework === "react") {
    const image = `<img src="${escapedSrc}" alt="${altText}"${jsxDim}${useMapAttr} loading="lazy" />`;
    component = input.responsive
      ? `<picture>\n  <source media="(max-width: 768px)" srcSet="${escapedMobileSrc}" />\n  ${image}\n</picture>`
      : image;
  } else if (framework === "next") {
    imports = `import Image from "next/image";\n\n`;
    const sizes = input.responsive ? ` sizes="(max-width: 768px) 100vw, ${width || 1200}px"` : "";
    component = `<Image src="${escapedSrc}" alt="${altText}"${jsxDim || " fill"}${sizes}${useMapAttr} />`;
  } else if (framework === "vue") {
    const image = `<img src="${escapedSrc}" alt="${altText}"${htmlDim}${useMapAttr} loading="lazy" />`;
    const inner = input.responsive
      ? `<picture>\n  <source media="(max-width: 768px)" srcset="${escapedMobileSrc}">\n  ${image}\n</picture>`
      : image;
    component = `<template>\n  ${(inner + mapBlock).split("\n").join("\n  ")}\n</template>`;
  } else if (framework === "nuxt") {
    component = `<template>\n  <NuxtImg src="${escapedSrc}" alt="${altText}"${htmlDim}${useMapAttr} loading="lazy" format="webp" />${indentMap(mapBlock)}\n</template>`;
  } else if (framework === "angular") {
    const image = `<img [src]="'${escapeSingleQuotedAngular(src)}'" alt="${altText}"${htmlDim}${useMapAttr} loading="lazy">`;
    component = input.responsive
      ? `<picture>\n  <source media="(max-width: 768px)" [srcset]="'${escapeSingleQuotedAngular(mobileSrc)}'">\n  ${image}\n</picture>`
      : image;
  } else if (framework === "astro") {
    imports = `---\nimport { ${input.responsive ? "Picture" : "Image"} } from "astro:assets";\nimport localImg from "${escapeJsString(src)}";\n---\n\n`;
    const mapAttribute = hasMap ? ` useMap="#${mapName}"` : "";
    component = input.responsive
      ? `<Picture src={localImg} formats={["avif", "webp"]} alt="${altText}"${mapAttribute} />`
      : `<Image src={localImg} alt="${altText}"${jsxDim}${useMapAttr} />`;
  } else {
    const image = `<img src="${escapedSrc}" alt="${altText}"${htmlDim}${useMapAttr} loading="lazy">`;
    component = input.responsive
      ? `<picture>\n  <source media="(max-width: 768px)" srcset="${escapedMobileSrc}">\n  ${image}\n</picture>`
      : image;
  }

  const full = imports + component + mapBlock;
  return {
    full,
    imports: imports.trimEnd(),
    component: (component + mapBlock).trim(),
    markdown: `![${altText}](${escapedSrc})`,
    cssBackground: `background-image: url("${escapedSrc}");`,
    html: `<img src="${escapedSrc}" alt="${altText}"${htmlDim} loading="lazy">`,
  };
}

export function calculateExportSavings(originalBytes: number, outputBytes: number): ExportSavings {
  const savedBytes = originalBytes - outputBytes;
  const savedPercent = originalBytes > 0 ? Math.round((savedBytes / originalBytes) * 100) : 0;
  const originalLabel = formatBytes(originalBytes);
  const outputLabel = formatBytes(outputBytes);
  const direction = savedBytes >= 0 ? "saved" : "larger";
  const absPercent = Math.abs(savedPercent);

  return {
    originalBytes,
    outputBytes,
    savedBytes,
    savedPercent,
    originalLabel,
    outputLabel,
    summary: `${originalLabel} -> ${outputLabel} (${direction} ${absPercent}%)`,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${formatNumber(kb)} KB`;
  }
  return `${formatNumber(kb / 1024)} MB`;
}

function isOneOf<T extends readonly string[]>(value: unknown, options: T): value is T[number] {
  return options.includes(String(value) as T[number]);
}

function buildSource(fileName: string, mode: PathMode, aliasPrefix = "@/assets/"): string {
  const cleanFileName = path.basename(fileName);
  if (mode === "public") {
    return `/${cleanFileName}`;
  }
  if (mode === "alias") {
    return `${aliasPrefix || "@/assets/"}${cleanFileName}`;
  }
  return `./${cleanFileName}`;
}

function buildMobileSource(src: string): string {
  const parsedPath = path.parse(src);
  if (!parsedPath.dir || parsedPath.dir === ".") {
    return src.startsWith("./")
      ? `./${parsedPath.name}-mobile${parsedPath.ext}`
      : `${parsedPath.name}-mobile${parsedPath.ext}`;
  }
  return path.join(parsedPath.dir, `${parsedPath.name}-mobile${parsedPath.ext}`).replace(/\\/g, "/");
}

function sanitizeMapName(fileName: string): string {
  return `${path.parse(fileName).name.replace(/[^a-zA-Z0-9_-]/g, "-")}-map`;
}

function buildMapBlock(mapName: string, areas: MapArea[], isJSX: boolean): string {
  const lines = [`\n<map name="${mapName}">`];
  areas.forEach((area, index) => {
    const shape = area.type === "circle" ? "circle" : "rect";
    const coords = escapeHtmlAttribute(area.coords);
    lines.push(`  <area shape="${shape}" coords="${coords}" href="#" alt="Area ${index + 1}"${isJSX ? " />" : ">"}`);
  });
  lines.push("</map>");
  return lines.join("\n");
}

function indentMap(mapBlock: string): string {
  return mapBlock ? mapBlock.split("\n").join("\n  ") : "";
}

function escapeSingleQuotedAngular(value: string): string {
  return escapeHtmlAttribute(value).replace(/'/g, "\\'");
}

function escapeJsString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}
