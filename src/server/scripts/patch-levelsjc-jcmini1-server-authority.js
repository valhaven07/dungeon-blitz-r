const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'LevelsJC.swf');

const ROOM_PATCHES = [
  {
    className: 'a_Room_JCMini1_01',
    hostileFields: ['__id282_', '__id299_']
  },
  {
    className: 'a_Room_JCMini1_02',
    hostileFields: ['__id310_', '__id313_']
  },
  {
    className: 'a_Room_JCMini1_03',
    bossField: 'am_Boss',
    addsField: 'am_Adds'
  },
  {
    className: 'a_Room_JCMini1_04',
    hostileFields: ['__id321_', '__id322_']
  }
];

function parseArgs(argv) {
  const args = {
    swf: DEFAULT_SWF,
    ffdec: '',
    verify: false
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--swf' || arg === '--swf-path') {
      args.swf = argv[++index] || args.swf;
    } else if (arg === '--ffdec' || arg === '-f') {
      args.ffdec = argv[++index] || '';
    } else if (arg === '--verify' || arg === '--dry-run') {
      args.verify = true;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  console.log([
    'Usage:',
    '  node src/server/scripts/patch-levelsjc-jcmini1-server-authority.js [--verify] [--swf <path>] [--ffdec <path>]',
    '',
    'Patches LevelsJC a_Room_JCMini1_01..04 for the Dread West Wing',
    'client-proxy/server-canonical model. Baked hostiles stay visible for AI,',
    'animation, and boss bars; server code owns HP, death, and progress.'
  ].join('\n'));
}

function resolveRepoRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(repoRoot, maybeRelative) {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.join(repoRoot, maybeRelative);
}

function detectFfdec(repoRoot, preferred) {
  const candidates = [];
  if (preferred) {
    candidates.push(resolvePath(repoRoot, preferred));
  }

  candidates.push(
    path.join(repoRoot, 'build', 'tools', 'ffdec_25.0.0', 'ffdec-cli.exe'),
    path.join(repoRoot, 'build', 'tools', 'ffdec_25.0.0', 'ffdec-cli.jar'),
    path.join(repoRoot, 'build', 'tools', 'ffdec_25.0.0', 'ffdec.jar'),
    path.join(repoRoot, 'build', 'ffdec_24.0.1', 'ffdec-cli.exe'),
    path.join(repoRoot, 'build', 'ffdec_24.0.1', 'ffdec-cli.jar')
  );

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function ensureFfdecHome(repoRoot) {
  const ffdecHome = path.join(repoRoot, 'build', 'ffdec-home');
  fs.mkdirSync(path.join(ffdecHome, 'JPEXS', 'FFDec', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(ffdecHome, 'LocalAppData'), { recursive: true });
  fs.mkdirSync(path.join(ffdecHome, 'Library', 'Application Support', 'FFDec', 'logs'), { recursive: true });
  return ffdecHome;
}

function runFfdec(ffdecPath, args) {
  const resolved = path.resolve(ffdecPath);
  const basename = path.basename(resolved).toLowerCase();
  const repoRoot = resolveRepoRoot();
  const ffdecHome = ensureFfdecHome(repoRoot);
  const env = {
    ...process.env,
    APPDATA: ffdecHome,
    HOME: ffdecHome,
    LOCALAPPDATA: path.join(ffdecHome, 'LocalAppData'),
    USERPROFILE: ffdecHome
  };

  if (basename.endsWith('.jar')) {
    execFileSync('java', [`-Duser.home=${ffdecHome}`, '-jar', resolved, '-cli', ...args], { env, stdio: 'inherit' });
    return;
  }

  execFileSync(resolved, ['-cli', ...args], { env, stdio: 'inherit' });
}

function exportRoomScripts(ffdecPath, workRoot, swfPath) {
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });

  for (const roomPatch of ROOM_PATCHES) {
    runFfdec(ffdecPath, ['-selectclass', roomPatch.className, '-export', 'script', workRoot, swfPath]);
  }

  const scriptDir = path.join(workRoot, 'scripts');
  for (const roomPatch of ROOM_PATCHES) {
    const scriptPath = path.join(scriptDir, `${roomPatch.className}.as`);
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`FFDec export did not produce ${scriptPath}`);
    }
  }

  return scriptDir;
}

function findMethodRange(source, methodName) {
  const marker = `public function ${methodName}(`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Could not find method ${methodName}`);
  }

  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) {
    throw new Error(`Could not find method body for ${methodName}`);
  }

  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return { start, braceStart, end: index + 1 };
      }
    }
  }

  throw new Error(`Could not find end of method ${methodName}`);
}

function getMethodSource(source, methodName) {
  const range = findMethodRange(source, methodName);
  return source.slice(range.start, range.end);
}

function normalizeBlock(block, eol) {
  return block.trim().replace(/\n/g, eol);
}

function ensureDisplayObjectImport(source, eol) {
  if (
    source.includes('import flash.display.*;') ||
    source.includes('import flash.display.DisplayObject;')
  ) {
    return source;
  }

  const movieClipImport = `   import flash.display.MovieClip;${eol}`;
  if (source.includes(movieClipImport)) {
    return source.replace(movieClipImport, `   import flash.display.DisplayObject;${eol}${movieClipImport}`);
  }

  const packageOpen = `{${eol}`;
  if (source.includes(packageOpen)) {
    return source.replace(packageOpen, `${packageOpen}   import flash.display.DisplayObject;${eol}`);
  }

  throw new Error('Could not add DisplayObject import');
}

function insertIntoConstructor(source, constructorName, lines, eol) {
  const range = findMethodRange(source, constructorName);
  const method = source.slice(range.start, range.end);
  const missingLines = lines.filter(line => !method.includes(line.trim()));
  if (missingLines.length === 0) {
    return source;
  }

  const insertion = missingLines.map(line => `         ${line.trim()}`).join(eol);
  const closingLine = `${eol}      }`;
  const insertAt = source.lastIndexOf(closingLine, range.end);
  if (insertAt === -1 || insertAt < range.braceStart) {
    throw new Error(`Could not find constructor closing line for ${constructorName}`);
  }
  const insertAfter = insertAt + eol.length;
  return `${source.slice(0, insertAfter)}${insertion}${eol}${source.slice(insertAfter)}`;
}

function insertAfterConstructor(source, constructorName, helperSource, eol) {
  if (source.includes(helperSource.split(eol)[0].trim())) {
    return source;
  }

  const range = findMethodRange(source, constructorName);
  return `${source.slice(0, range.end)}${eol}      ${eol}      ${helperSource}${source.slice(range.end)}`;
}

function removeMethodIfPresent(source, methodName) {
  const marker = `function ${methodName}(`;
  const functionNameStart = source.indexOf(marker);
  if (functionNameStart === -1) {
    return source;
  }

  let methodStart = functionNameStart;
  while (methodStart > 0 && source[methodStart - 1] !== '\n') {
    methodStart -= 1;
  }
  const braceStart = source.indexOf('{', functionNameStart);
  if (braceStart === -1) {
    throw new Error(`Could not find method body for ${methodName}`);
  }

  let depth = 0;
  let methodEnd = -1;
  for (let index = braceStart; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        methodEnd = index + 1;
        break;
      }
    }
  }
  if (methodEnd === -1) {
    throw new Error(`Could not find end of method ${methodName}`);
  }

  let start = methodStart;
  while (start > 0 && /[ \t]/.test(source[start - 1])) {
    start -= 1;
  }
  if (start > 0 && source[start - 1] === '\n') {
    start -= 1;
  }
  return `${source.slice(0, start)}${source.slice(methodEnd)}`;
}

function suppressHostileHelper(eol) {
  return normalizeBlock(`
      internal function __suppressBakedHostile(param1:DisplayObject) : void
      {
         if(param1 == null)
         {
            return;
         }
         param1.visible = false;
         if(param1.parent != null)
         {
            param1.parent.removeChild(param1);
         }
      }
  `, eol);
}

function hideBossHelper(eol) {
  return normalizeBlock(`
      internal function __hideBakedBoss(param1:DisplayObject) : void
      {
         if(param1 != null)
         {
            param1.visible = false;
         }
      }
  `, eol);
}

function patchStandardHostileRoom(source, roomPatch) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  let patched = source;

  for (const fieldName of roomPatch.hostileFields) {
    patched = patched.replace(new RegExp(`\\r?\\n\\s*this\\.__suppressBakedHostile\\(this\\.${fieldName}\\);`, 'g'), '');
  }
  patched = removeMethodIfPresent(patched, '__suppressBakedHostile');
  verifyStandardHostileRoom(patched, roomPatch, 'patched source');
  return patched;
}

function patchBossRoom(source, roomPatch) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  let patched = source
    .replace(new RegExp(`\\r?\\n\\s*this\\.__hideBakedBoss\\(this\\.${roomPatch.bossField}\\);`, 'g'), '')
    .replace(new RegExp(`\\r?\\n\\s*if\\(this\\.${roomPatch.addsField} != null\\)\\s*\\{\\s*this\\.${roomPatch.addsField}\\.visible = false;\\s*\\}`, 'g'), '');

  patched = removeMethodIfPresent(patched, '__hideBakedBoss');
  patched = restoreBossAddsSummons(patched, roomPatch, eol);
  verifyBossRoom(patched, roomPatch, 'patched source');
  return patched;
}

function restoreBossAddsSummons(source, roomPatch, eol) {
  const method = getMethodSource(source, 'UpdatePhaseCombat');
  if (
    method.includes(`param1.Group(this.${roomPatch.addsField},3).QuickFirePower("MonsterPortalEffect");`) &&
    method.includes(`param1.SameGroup(this.${roomPatch.addsField},3).FirePower("TowerGuardSummon");`)
  ) {
    return source;
  }

  const restored = normalizeBlock(`
      public function UpdatePhaseCombat(param1:a_GameHook) : void
      {
         if(this.${roomPatch.bossField}.Defeated())
         {
            param1.SetPhase(null);
            return;
         }
         if(param1.AtTimeRepeat(8000,6000))
         {
            param1.Group(this.${roomPatch.addsField},3).QuickFirePower("MonsterPortalEffect");
         }
         if(param1.AtTimeRepeat(8000,8000))
         {
            param1.SameGroup(this.${roomPatch.addsField},3).FirePower("TowerGuardSummon");
         }
      }
  `, eol);
  const range = findMethodRange(source, 'UpdatePhaseCombat');
  return `${source.slice(0, range.start)}${restored}${source.slice(range.end)}`;
}

function verifyStandardHostileRoom(source, roomPatch, label) {
  const constructor = getMethodSource(source, roomPatch.className);
  for (const fieldName of roomPatch.hostileFields) {
    if (!source.includes(`public var ${fieldName}:`)) {
      throw new Error(`${label} is missing expected hostile field ${fieldName} in ${roomPatch.className}`);
    }
    if (constructor.includes(`this.__suppressBakedHostile(this.${fieldName});`)) {
      throw new Error(`${label} still suppresses baked hostile ${fieldName} in ${roomPatch.className}`);
    }
  }
  if (source.includes('internal function __suppressBakedHostile(')) {
    throw new Error(`${label} still contains baked hostile suppress helper in ${roomPatch.className}`);
  }
}

function verifyBossRoom(source, roomPatch, label) {
  const constructor = getMethodSource(source, roomPatch.className);
  if (!source.includes(`public var ${roomPatch.bossField}:`)) {
    throw new Error(`${label} is missing expected boss field ${roomPatch.bossField} in ${roomPatch.className}`);
  }
  if (!source.includes(`public var ${roomPatch.addsField}:`)) {
    throw new Error(`${label} is missing expected adds field ${roomPatch.addsField} in ${roomPatch.className}`);
  }
  if (constructor.includes(`this.__hideBakedBoss(this.${roomPatch.bossField});`)) {
    throw new Error(`${label} still hides baked boss in ${roomPatch.className}`);
  }
  if (constructor.includes(`this.${roomPatch.addsField}.visible = false;`)) {
    throw new Error(`${label} still hides baked boss adds in ${roomPatch.className}`);
  }
  if (source.includes('internal function __hideBakedBoss(')) {
    throw new Error(`${label} still contains baked boss hide helper in ${roomPatch.className}`);
  }
  if (!source.includes(`this.${roomPatch.bossField}.displayName = "Lotte, The 1st Daughter";`)) {
    throw new Error(`${label} no longer preserves boss display metadata in ${roomPatch.className}`);
  }
  if (!source.includes('param1.bossFightPhase = this.UpdatePhaseCombat;')) {
    throw new Error(`${label} no longer preserves boss room phase setup in ${roomPatch.className}`);
  }
  if (!source.includes(`param1.Group(this.${roomPatch.addsField},3).QuickFirePower("MonsterPortalEffect");`)) {
    throw new Error(`${label} no longer contains client-side boss portal cue in ${roomPatch.className}`);
  }
  if (!source.includes(`param1.SameGroup(this.${roomPatch.addsField},3).FirePower("TowerGuardSummon");`)) {
    throw new Error(`${label} no longer contains client-side boss add summon in ${roomPatch.className}`);
  }
}

function verifyRoomSource(source, roomPatch, label) {
  if (roomPatch.hostileFields) {
    verifyStandardHostileRoom(source, roomPatch, label);
  } else {
    verifyBossRoom(source, roomPatch, label);
  }
}

function patchRoomSource(source, roomPatch) {
  try {
    verifyRoomSource(source, roomPatch, 'current source');
    return source;
  } catch (_error) {
    // Continue into the source patch path below.
  }

  if (roomPatch.hostileFields) {
    return patchStandardHostileRoom(source, roomPatch);
  }

  return patchBossRoom(source, roomPatch);
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsjc-jcmini1-server-authority', path.basename(swfPath, path.extname(swfPath)));
  const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
  const scriptDir = exportRoomScripts(ffdecPath, workRoot, swfPath);
  let changed = false;

  for (const roomPatch of ROOM_PATCHES) {
    const scriptPath = path.join(scriptDir, `${roomPatch.className}.as`);
    const original = fs.readFileSync(scriptPath, 'utf8');
    const patched = patchRoomSource(original, roomPatch);
    if (patched !== original) {
      fs.writeFileSync(scriptPath, patched, 'utf8');
      changed = true;
    }
  }

  if (!changed) {
    console.log(`SWF already contains the JC_Mini1Hard client-proxy patch: ${swfPath}`);
    return;
  }

  runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, scriptDir]);
  fs.copyFileSync(patchedSwfPath, swfPath);
  console.log(`Patched JC_Mini1Hard client-proxy behavior in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsjc-jcmini1-server-authority-verify', path.basename(swfPath, path.extname(swfPath)));
  const scriptDir = exportRoomScripts(ffdecPath, workRoot, swfPath);

  for (const roomPatch of ROOM_PATCHES) {
    const scriptPath = path.join(scriptDir, `${roomPatch.className}.as`);
    verifyRoomSource(fs.readFileSync(scriptPath, 'utf8'), roomPatch, swfPath);
  }

  console.log(`Verified JC_Mini1Hard client-proxy behavior in ${swfPath}`);
}

function main() {
  const repoRoot = resolveRepoRoot();
  const args = parseArgs(process.argv);
  const swfPath = resolvePath(repoRoot, args.swf);
  const ffdecPath = detectFfdec(repoRoot, args.ffdec);

  if (!ffdecPath) {
    throw new Error('FFDec not found. Pass --ffdec or restore the repo-bundled FFDec tool.');
  }

  if (!fs.existsSync(swfPath)) {
    throw new Error(`SWF not found: ${swfPath}`);
  }

  if (args.verify) {
    verifySwf(repoRoot, ffdecPath, swfPath);
    return;
  }

  patchSwf(repoRoot, ffdecPath, swfPath);
  verifySwf(repoRoot, ffdecPath, swfPath);
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
