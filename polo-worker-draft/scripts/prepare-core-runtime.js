const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_PRIMARY = path.join(ROOT, 'core-v7.1');
const SOURCE_FALLBACK = path.resolve(ROOT, '..', '..', 'FluxSMS_Worker_V7_1_FIX');
const RUNTIME = path.join(ROOT, 'core-v7.1-runtime');

function hasFullCore(sourceDir) {
  return (
    fs.existsSync(path.join(sourceDir, 'main.py')) &&
    fs.existsSync(path.join(sourceDir, 'state.py')) &&
    fs.existsSync(path.join(sourceDir, 'modems', 'detection.py'))
  );
}

function pickSourceDir() {
  if (hasFullCore(SOURCE_PRIMARY)) return SOURCE_PRIMARY;
  if (hasFullCore(SOURCE_FALLBACK)) return SOURCE_FALLBACK;
  return SOURCE_PRIMARY;
}

function rmSafe(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  } catch (err) {
    if (!fs.existsSync(target)) return;
    const alt = `${target}.old-${Date.now()}`;
    try {
      fs.renameSync(target, alt);
      fs.rmSync(alt, { recursive: true, force: true });
      return;
    } catch {
      throw err;
    }
  }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function walkFiles(dir, cb) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, cb);
    else cb(full);
  }
}

function runCompileall(pythonCmd, args) {
  const res = spawnSync(pythonCmd, args, { cwd: ROOT, stdio: 'inherit', shell: true });
  return res.status === 0;
}

function compilePyc(runtimeDir) {
  const pyCommands = [
    ['py -3', ['-m', 'compileall', '-b', runtimeDir]],
    ['python', ['-m', 'compileall', '-b', runtimeDir]]
  ];
  for (const [cmd, args] of pyCommands) {
    if (runCompileall(cmd, args)) return true;
  }
  return false;
}

function removeVisibleNonEssentialFiles(runtimeDir) {
  const blockedNames = new Set(['LEIA-ME.txt', 'Iniciar_Codder.bat', 'requirements.txt', '.env']);
  walkFiles(runtimeDir, (file) => {
    const base = path.basename(file);
    if (blockedNames.has(base)) rmSafe(file);
  });
}

function ensureMainPycExists(runtimeDir) {
  const mainPyc = path.join(runtimeDir, 'main.pyc');
  if (!fs.existsSync(mainPyc)) {
    throw new Error('Falha ao gerar main.pyc para distribuição protegida.');
  }
}

function main() {
  const sourceDir = pickSourceDir();
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Diretório base do core não encontrado: ${sourceDir}`);
  }
  if (!hasFullCore(sourceDir)) {
    throw new Error(
      `Core incompleto em ${sourceDir}. Esperado: main.py, state.py e modems/detection.py`
    );
  }
  rmSafe(RUNTIME);
  copyDir(sourceDir, RUNTIME);
  removeVisibleNonEssentialFiles(RUNTIME);
  const ok = compilePyc(RUNTIME);
  if (!ok) {
    throw new Error('Não foi possível compilar o core para .pyc (py/python indisponível).');
  }
  // Mantém os .py no pacote: o instalador escolhe main.py em runtime quando o .pyc
  // não bate com a versão do Python do Windows (evita "Bad magic number").
  ensureMainPycExists(RUNTIME);
  console.log(`Core runtime preparado de: ${sourceDir}`);
  console.log('Core runtime preparado com .pyc e .py (fallback seguro entre versões de Python).');
}

main();
