import * as pdfjsLib from "./pdf.mjs";
import { initApp } from "./src/app-core.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.mjs", import.meta.url).href;

void initApp({ pdfjsLib });
