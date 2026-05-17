import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildDummySvg,
  buildImageCode,
  buildProcessedFilePath,
  calculateExportSavings,
  createUniqueFilePath,
  normalizeBatchPayload,
  normalizeCropPayload,
} from "../core";

suite("BetterImages core", () => {
  test("normalizes invalid batch payloads to safe defaults", () => {
    const payload = normalizeBatchPayload({
      w: -10,
      h: 999999,
      format: "tiff" as never,
      filter: "oil" as never,
      fit: "stretch" as never,
      quality: 500,
      clean: true,
    });

    assert.deepStrictEqual(payload, {
      w: undefined,
      h: undefined,
      format: "original",
      quality: 100,
      clean: true,
      filter: "none",
      fit: "inside",
    });
  });

  test("rejects invalid crop areas", () => {
    assert.throws(
      () => normalizeCropPayload({ x: 0, y: 0, w: 0, h: 20 }),
      /Invalid crop area/,
    );
  });

  test("generates unique file names when an output exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "betterimages-"));
    try {
      const existing = path.join(tmpDir, "photo-processed.png");
      fs.writeFileSync(existing, "");

      assert.strictEqual(createUniqueFilePath(existing), path.join(tmpDir, "photo-processed-1.png"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("builds processed output names without overwriting", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "betterimages-"));
    try {
      const existing = path.join(tmpDir, "hero-120x80-clean.webp");
      fs.writeFileSync(existing, "");

      const output = buildProcessedFilePath(
        path.join(tmpDir, "hero.png"),
        normalizeBatchPayload({
          w: 120,
          h: 80,
          format: "webp",
          quality: 80,
          clean: true,
          filter: "none",
          fit: "inside",
        }),
      );

      assert.strictEqual(output, path.join(tmpDir, "hero-120x80-clean-1.webp"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("sanitizes dummy SVG text and colors", () => {
    const svg = buildDummySvg({
      w: "300",
      h: "200",
      bg: "url(bad)",
      color: "#123abc",
      text: '<script>alert("x")</script>',
    });

    assert.strictEqual(svg.fileName, "dummy-300x200.svg");
    assert.match(svg.content, /fill="#cccccc"/);
    assert.match(svg.content, /fill="#123abc"/);
    assert.match(svg.content, /&lt;script&gt;alert\("x"\)&lt;\/script&gt;/);
  });

  test("generates escaped React code with map areas", () => {
    const generated = buildImageCode({
      framework: "react",
      fileName: "hero image.png",
      width: 640,
      height: 480,
      altText: 'Sergio "hero" <image>',
      responsive: true,
      pathMode: "relative",
      mapAreas: [{ type: "rect", coords: "1,2,3,4" }],
    });

    assert.match(generated.full, /src="\.\/hero image\.png"/);
    assert.match(generated.full, /srcSet="\.\/hero image-mobile\.png"/);
    assert.match(generated.full, /alt="Sergio &quot;hero&quot; &lt;image&gt;"/);
    assert.match(generated.full, /useMap="#hero-image-map"/);
    assert.match(generated.component, /<map name="hero-image-map">/);
    assert.strictEqual(generated.markdown, "![Sergio &quot;hero&quot; &lt;image&gt;](./hero image.png)");
    assert.strictEqual(generated.cssBackground, 'background-image: url("./hero image.png");');
    assert.match(generated.html, /<img src="\.\/hero image\.png"/);
  });

  test("generates framework-specific snippets", () => {
    const next = buildImageCode({
      framework: "next",
      fileName: "card.png",
      width: 300,
      height: 200,
      pathMode: "public",
      responsive: true,
    });
    const astro = buildImageCode({
      framework: "astro",
      fileName: "card.png",
      width: 300,
      height: 200,
      pathMode: "alias",
    });

    assert.match(next.imports, /next\/image/);
    assert.match(next.full, /src="\/card\.png"/);
    assert.match(next.full, /sizes=/);
    assert.match(astro.imports, /astro:assets/);
    assert.match(astro.imports, /@\/assets\/card\.png/);
  });

  test("calculates export savings labels and percentage", () => {
    const savings = calculateExportSavings(4096, 1024);

    assert.strictEqual(savings.originalLabel, "4.0 KB");
    assert.strictEqual(savings.outputLabel, "1.0 KB");
    assert.strictEqual(savings.savedPercent, 75);
    assert.strictEqual(savings.summary, "4.0 KB -> 1.0 KB (saved 75%)");
  });
});
