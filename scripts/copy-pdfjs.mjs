import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, "node_modules", "pdfjs-dist");
const target = path.join(root, "media", "pdfjs");

await mkdir(target, { recursive: true });
await cp(path.join(source, "build", "pdf.min.mjs"), path.join(target, "pdf.min.mjs"));
await cp(path.join(source, "build", "pdf.worker.min.mjs"), path.join(target, "pdf.worker.min.mjs"));
await cp(path.join(source, "cmaps"), path.join(target, "cmaps"), { recursive: true });
await cp(path.join(source, "standard_fonts"), path.join(target, "standard_fonts"), { recursive: true });
await cp(path.join(source, "LICENSE"), path.join(target, "LICENSE"));

console.log("PDF.js 运行资源已复制到 media/pdfjs。");
