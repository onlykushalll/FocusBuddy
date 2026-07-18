import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

test('model libraries are statically imported so their circular exports are initialized before use', async () => {
  const preloader = await source('../src/lib/modelPreloader.ts');

  assert.match(preloader, /^import \* as faceLandmarks from '@tensorflow-models\/face-landmarks-detection';$/m);
  assert.match(preloader, /^import \* as faceDetection from '@tensorflow-models\/face-detection';$/m);
  assert.doesNotMatch(preloader, /await import\('@tensorflow-models\/face-(?:landmarks-detection|detection)'\)/);
});

test('model initialization is not restarted when an error callback changes identity', async () => {
  const engine = await source('../src/components/FaceSecurityEngine.tsx');

  assert.match(engine, /const onEngineErrorRef = useRef\(onEngineError\);/);
  assert.match(engine, /useEffect\(\(\) => \{\s*onEngineErrorRef\.current = onEngineError;\s*\}, \[onEngineError\]\);/);
  assert.match(engine, /useEffect\(\(\) => \{\s*void initModels\(\);\s*\}, \[\]\);/);
});

test('Android packages MediaPipe files at the path served by its WebView asset loader', async () => {
  const activity = await source('../android/app/src/main/java/com/focusbuddy/MainActivity.kt');

  assert.match(activity, /addPathHandler\("\/mediapipe\/", WebViewAssetLoader\.AssetsPathHandler\(this\)\)/);
  await access(new URL('../android/app/src/main/assets/mediapipe/face_mesh.js', import.meta.url));
  await access(new URL('../android/app/src/main/assets/mediapipe/face_mesh_solution_wasm_bin.wasm', import.meta.url));
});
