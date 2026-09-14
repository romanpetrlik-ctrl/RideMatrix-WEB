import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

function loadMapsBundle() {
  const source = fs.readFileSync(path.join(process.cwd(), "public/js/google-map-preview.js"), "utf8");
  const scripts: Array<{ src: string; async?: boolean; onerror?: () => void }> = [];
  const sandbox: {
    window: Record<string, any>;
    document: Record<string, any>;
  } = {
    window: {},
    document: {
      createElement() {
        return { src: "", async: false, onerror: undefined };
      },
      head: {
        appendChild(script: { src: string; async?: boolean; onerror?: () => void }) {
          scripts.push(script);
          return script;
        }
      },
      addEventListener() {
        // ignored in tests
      },
      querySelectorAll() {
        return [];
      }
    }
  };

  vm.runInNewContext(source, sandbox);
  return {
    maps: sandbox.window.RideMatrixMaps,
    window: sandbox.window,
    scripts
  };
}

test("map preview loader includes requested libraries in script URL and resolves after callback", async () => {
  const loaded = loadMapsBundle();
  const promise = loaded.maps.load("browser-key", [], { libraries: ["places"] });

  assert.equal(loaded.scripts.length, 1);
  const script = loaded.scripts[0];
  assert.match(script.src, /maps\.googleapis\.com\/maps\/api\/js\?/);
  assert.match(script.src, /key=browser-key/);
  assert.match(script.src, /libraries=places/);

  const callbackParam = new URL(script.src).searchParams.get("callback");
  assert.ok(callbackParam);
  loaded.window.google = {
    maps: {
      importLibrary: async () => ({})
    }
  };
  loaded.window[callbackParam]();

  assert.equal(await promise, true);
});

test("map preview loader exits early without browser key", async () => {
  const loaded = loadMapsBundle();
  const result = await loaded.maps.load("", [], { libraries: ["places"] });

  assert.equal(result, false);
  assert.equal(loaded.scripts.length, 0);
});

test("map preview loader rejects when requested libraries are unavailable", async () => {
  const loaded = loadMapsBundle();
  loaded.window.google = { maps: {} };

  await assert.rejects(
    loaded.maps.load("browser-key", [], { libraries: ["places"] }),
    /Google Maps libraries unavailable/
  );
});

test("map preview loader shares one script load across concurrent library requests", async () => {
  const loaded = loadMapsBundle();
  const first = loaded.maps.load("browser-key", [], { libraries: [] });
  const second = loaded.maps.load("browser-key", [], { libraries: ["places"] });

  assert.equal(loaded.scripts.length, 1);
  const callbackParam = new URL(loaded.scripts[0].src).searchParams.get("callback");
  assert.ok(callbackParam);
  loaded.window.google = {
    maps: {
      importLibrary: async () => ({})
    }
  };
  loaded.window[callbackParam]();

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});
