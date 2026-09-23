import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export function trainingPython(root) {
  const bundled = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return process.env.LIGHT_TRACK_PYTHON || (existsSync(bundled) ? bundled : 'python');
}

export function runTrainingCommand(command, args, { cwd, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let stderr = '', failure = null;
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.resume(); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const stop = message => { failure = new Error(message); child.kill(); };
    const aborted = () => stop('Training cancelled');
    const timer = setTimeout(() => stop('Training exceeded its configured time limit'), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      if (failure || code !== 0) reject(failure || new Error(stderr || `Training command exited with ${code}`));
      else resolve();
    });
  });
}
