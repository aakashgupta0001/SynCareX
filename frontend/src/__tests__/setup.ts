import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: webcrypto,
});

// jsdom's Blob predates Blob.prototype.arrayBuffer, which every supported
// browser provides. This shim only affects the test environment.
if (typeof Blob !== "undefined" && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

if (typeof Blob !== "undefined" && !Blob.prototype.text) {
  Blob.prototype.text = function text(this: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}
