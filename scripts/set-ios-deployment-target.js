#!/usr/bin/env node
/**
 * Raise the Capacitor iOS app minimum to 15.0.
 *
 * `npx cap add ios` copies the Capacitor 7 template, which still sets
 * IPHONEOS_DEPLOYMENT_TARGET / platform :ios to 14.0. App Store Connect
 * rejects that starting April 2027 (ITMS-90068). Run this after `cap add`
 * and before `cap sync` (so `pod install` compiles pods for 15.0), then
 * again after sync in case generated native files reintroduce 14.0.
 *
 * Does not change MARKETING_VERSION or CURRENT_PROJECT_VERSION.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const iosDir = path.join(root, 'ios');
const appPlist = path.join(iosDir, 'App', 'App', 'Info.plist');
const podfilePath = path.join(iosDir, 'App', 'Podfile');
const pbxprojPath = path.join(iosDir, 'App', 'App.xcodeproj', 'project.pbxproj');

function normalizeTarget(raw) {
  const value = raw == null || raw === '' ? '15.0' : String(raw).trim();
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 15) {
    console.error(
      `IPHONEOS_DEPLOYMENT_TARGET must be 15.0 or later (got ${JSON.stringify(value)}).`,
    );
    process.exit(1);
  }
  return Number.isInteger(numeric) ? `${numeric}.0` : String(numeric);
}

const target = normalizeTarget(process.env.IPHONEOS_DEPLOYMENT_TARGET || '15.0');

function postInstallBlock() {
  return `post_install do |installer|
  assertDeploymentTarget(installer)
  # enforce-ios-15 — App Store Connect requires iOS ${target}+ (ITMS-90068)
  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |config|
      deployment_target = config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'].to_f
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${target}' if deployment_target < ${target}
    end
  end
  installer.pods_project.build_configurations.each do |config|
    deployment_target = config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'].to_f
    config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${target}' if deployment_target < ${target}
  end
end`;
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'DerivedData') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function raiseNumericAssignment(text) {
  return text.replace(
    /IPHONEOS_DEPLOYMENT_TARGET = (\d+(?:\.\d+)?)(;?)/g,
    (full, ver, semi) => {
      if (Number(ver) >= 15) return full;
      return `IPHONEOS_DEPLOYMENT_TARGET = ${target}${semi}`;
    },
  );
}

function raisePodfilePlatform(text) {
  return text.replace(
    /platform\s+:ios\s*,\s*(['"])(\d+(?:\.\d+)?)\1/g,
    (full, quote, ver) => {
      if (Number(ver) >= 15) return full;
      return `platform :ios, ${quote}${target}${quote}`;
    },
  );
}

function replacePostInstallBlock(text, block) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('post_install do'));
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    depth += (line.match(/\bdo\b/g) || []).length;
    depth -= (line.match(/^\s*end\b/) || []).length;
    if (i > start && depth <= 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  return [...lines.slice(0, start), ...block.split('\n'), ...lines.slice(end + 1)].join('\n');
}

function ensurePostInstall(text) {
  const block = postInstallBlock();
  if (text.includes(block)) return text;
  const replaced = replacePostInstallBlock(text, block);
  if (replaced) return replaced;
  return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
}

function raisePodspec(text) {
  let next = text.replace(
    /(s\.ios\.deployment_target\s*=\s*['"])(\d+(?:\.\d+)?)(['"])/g,
    (full, prefix, ver, suffix) => {
      if (Number(ver) >= 15) return full;
      return `${prefix}${target}${suffix}`;
    },
  );
  next = next.replace(
    /(s\.platform\s*=\s*:ios\s*,\s*['"]?)(\d+(?:\.\d+)?)(['"]?)/g,
    (full, prefix, ver, suffix) => {
      if (Number(ver) >= 15) return full;
      return `${prefix}${target}${suffix}`;
    },
  );
  return next;
}

function raisePackageSwift(text) {
  return text.replace(/\.iOS\(\.v(\d+)\)/g, (full, major) => {
    if (Number(major) >= 15) return full;
    return `.iOS(.v${Math.trunc(Number(target))})`;
  });
}

function raiseMinimumOSVersion(text, addIfMissing) {
  const keyRe = /(<key>MinimumOSVersion<\/key>\s*<string>)([^<]*)(<\/string>)/;
  if (keyRe.test(text)) {
    return text.replace(keyRe, (full, prefix, ver, suffix) => {
      if (Number(ver) >= 15) return full;
      return `${prefix}${target}${suffix}`;
    });
  }
  if (!addIfMissing) return text;
  const insertion = `\t<key>MinimumOSVersion</key>\n\t<string>${target}</string>\n`;
  if (!text.includes('</dict>')) {
    console.error(`No </dict> in ${appPlist}; cannot set MinimumOSVersion.`);
    process.exit(1);
  }
  return text.replace('</dict>', `${insertion}</dict>`);
}

function writeIfChanged(file, next) {
  const prev = fs.readFileSync(file, 'utf8');
  if (prev === next) return false;
  fs.writeFileSync(file, next);
  console.log(`updated ${path.relative(root, file)}`);
  return true;
}

if (!fs.existsSync(pbxprojPath) || !fs.existsSync(podfilePath)) {
  console.error(
    'ios/App is missing. Run `npx cap add ios` before setting the deployment target.',
  );
  process.exit(1);
}

let changed = 0;

for (const file of walk(iosDir)) {
  const base = path.basename(file);
  if (base === 'Podfile') {
    let text = fs.readFileSync(file, 'utf8');
    text = raisePodfilePlatform(text);
    text = ensurePostInstall(text);
    if (writeIfChanged(file, text)) changed += 1;
    continue;
  }
  if (base.endsWith('.pbxproj') || base.endsWith('.xcconfig')) {
    const text = raiseNumericAssignment(fs.readFileSync(file, 'utf8'));
    if (writeIfChanged(file, text)) changed += 1;
    continue;
  }
  if (base.endsWith('.podspec')) {
    const text = raisePodspec(fs.readFileSync(file, 'utf8'));
    if (writeIfChanged(file, text)) changed += 1;
    continue;
  }
  if (base === 'Package.swift') {
    const text = raisePackageSwift(fs.readFileSync(file, 'utf8'));
    if (writeIfChanged(file, text)) changed += 1;
    continue;
  }
  if (base === 'Info.plist') {
    const addIfMissing = path.resolve(file) === appPlist;
    const text = raiseMinimumOSVersion(fs.readFileSync(file, 'utf8'), addIfMissing);
    if (writeIfChanged(file, text)) changed += 1;
  }
}

const failures = [];
for (const file of walk(iosDir)) {
  const base = path.basename(file);
  const text = fs.readFileSync(file, 'utf8');
  const checks = [];
  if (base.endsWith('.pbxproj') || base.endsWith('.xcconfig') || base === 'Podfile') {
    for (const match of text.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = (\d+(?:\.\d+)?)/g)) {
      checks.push(Number(match[1]));
    }
    for (const match of text.matchAll(/platform\s+:ios\s*,\s*['"](\d+(?:\.\d+)?)['"]/g)) {
      checks.push(Number(match[1]));
    }
  }
  if (base.endsWith('.podspec')) {
    for (const match of text.matchAll(/deployment_target\s*=\s*['"](\d+(?:\.\d+)?)['"]/g)) {
      checks.push(Number(match[1]));
    }
    for (const match of text.matchAll(/s\.platform\s*=\s*:ios\s*,\s*['"]?(\d+(?:\.\d+)?)/g)) {
      checks.push(Number(match[1]));
    }
  }
  if (base === 'Info.plist') {
    for (const match of text.matchAll(/<key>MinimumOSVersion<\/key>\s*<string>([^<]*)<\/string>/g)) {
      checks.push(Number(match[1]));
    }
  }
  if (base === 'Package.swift') {
    for (const match of text.matchAll(/\.iOS\(\.v(\d+)\)/g)) {
      checks.push(Number(match[1]));
    }
  }
  for (const value of checks) {
    if (Number.isFinite(value) && value < 15) {
      failures.push(`${path.relative(root, file)} still declares iOS ${value}`);
    }
  }
}

if (!fs.readFileSync(appPlist, 'utf8').includes(`<string>${target}</string>`)) {
  failures.push(`ios/App/App/Info.plist is missing MinimumOSVersion ${target}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(
  `iOS deployment target is ${target} (${changed} file${changed === 1 ? '' : 's'} updated).`,
);
