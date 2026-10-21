// Parses Spotify exports off the main thread so big histories don't freeze the record.
import { readFiles } from './data.js';

self.onmessage = async (e) => {
  try {
    const records = await readFiles(e.data, (done, total) => self.postMessage({ type: 'progress', done, total }));
    self.postMessage({ type: 'done', records });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err) });
  }
};
