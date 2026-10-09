const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let lastShot = { t: 0, buf: null };
let capturing = false;

function captureScreen() {
  return new Promise((resolve, reject) => {
    if (lastShot.buf && Date.now() - lastShot.t < 700) {
      return resolve(lastShot.buf);
    }
    if (capturing && lastShot.buf) return resolve(lastShot.buf);
    capturing = true;
    const tmp = path.join(os.tmpdir(), 'kyte-screen.jpg');
    execFile('screencapture', ['-x', '-t', 'jpg', tmp], (err) => {
      if (err) {
        capturing = false;
        return reject(err);
      }
      execFile('sips', ['-Z', '1280', tmp], () => {
        try {
          const buf = fs.readFileSync(tmp);
          lastShot = { t: Date.now(), buf };
          resolve(buf);
        } catch (e) {
          reject(e);
        } finally {
          capturing = false;
        }
      });
    });
  });
}

function captureScreenFull() {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), 'kyte-screen-full.jpg');
    execFile('screencapture', ['-x', '-t', 'jpg', tmp], (err) => {
      if (err) return reject(err);
      try {
        resolve(fs.readFileSync(tmp));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function imageSize(buf) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), 'kyte-size.jpg');
    fs.writeFileSync(tmp, buf);
    execFile('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', tmp], (err, stdout) => {
      const w = Number((/pixelWidth:\s+(\d+)/.exec(stdout || '') || [])[1]) || 0;
      const h = Number((/pixelHeight:\s+(\d+)/.exec(stdout || '') || [])[1]) || 0;
      resolve({ w, h });
    });
  });
}

module.exports = { captureScreen, captureScreenFull, imageSize };
