// Copies the text-recognition engine (used to read photos of payslips and statements) into public/ocr,
// so the app serves it itself: photos are read on your device and nothing is fetched from elsewhere.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'ocr');
mkdirSync(out, { recursive: true });
const copy = (from, to) => cpSync(join(root, 'node_modules', from), join(out, to));

copy('tesseract.js/dist/worker.min.js', 'worker.min.js');
for (const core of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']) copy(`tesseract.js-core/${core}.wasm.js`, `${core}.wasm.js`);
copy('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz');
